/* Retire what a newer archive replaces, so the import can redo it.
 *
 *   rampart tools/replace-superseded.js [--db DIR] [--go]
 *
 * Two things make an imported archive obsolete:
 *
 *   SUPERSEDED  the pool holds a better archive of the same family -- a
 *               newer dump, or a better flavour. families.pickArchives
 *               decides, the same code the import plan uses.
 *   RETABLED    the staging table the naming rule gives it today is not
 *               the one recorded when it was imported, which is what
 *               happens when a shared table is split per archive.
 *
 * Either way the fix is the same and has to be complete: drop the
 * staging table, forget the archives that fed it, and delete the staged
 * JSONL. That last step is the one that bites -- the staging name comes
 * from the archive's short name, not its date, so a 2026-11 dump would
 * otherwise be "staged already" from the 2026-08 extraction and import
 * the old content under the new archive's name, which nothing downstream
 * could detect.
 *
 * Says what it would do and stops. --go does it. Dropping a staging
 * table does not touch `corpus`: the merge notices that a table it
 * recorded has been re-imported and rebuilds from scratch.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");
var fam = require("./../import/families.js");

function arg(n, d) {
    for (var i = 2; i < process.argv.length; i++)
        if (process.argv[i] === "--" + n) return process.argv[i + 1];
    return d;
}
function flag(n) {
    for (var i = 2; i < process.argv.length; i++)
        if (process.argv[i] === "--" + n) return 1;
    return 0;
}

var HERE = (process.scriptPath || ".").replace(/[\/]tools[\/]?$/, "");
var DB   = String(arg("db", HERE + "/build/corpus"));
var GO   = flag("go");

/* Where the pool and the staged JSONL live, read the way the shell
   tools read them: config.local.sh first, then the in-tree default. */
function confValue(name, dflt) {
    var f = HERE + "/config.local.sh";
    if (stat(f)) {
        var t = bufferToString(readFile(f));
        var m = new RegExp("^" + name + "=(?:\\$\\{" + name + ":-)?([^}\\n]*)",
                           "m").exec(t);
        if (m && m[1]) return m[1].replace(/["']/g, "");
    }
    return dflt;
}
var DATA  = confValue("DATA", HERE + "/downloads");
/* Where the archives are, by the same rule as config.sh. */
var KIWIX = String(process.env.KIWIX
                   || ((process.env.DOWNLOAD_DIR || DATA) + "/archives"));
var STG   = DATA + "/staging";

var sql = new Sql.init(DB);

/* The archives on disk, and which of them the import plan would pick. */
var pool = [];
readDir(KIWIX).forEach(function (f) {
    if (/\.zim$/.test(String(f))) pool.push(String(f));
});
if (!pool.length) { printf("no archives in %s\n", KIWIX); process.exit(1); }
/* pickArchives returns { pick, skipped }, not a list. */
var picked = fam.pickArchives(pool);
var chosen = {};
(picked.pick || []).forEach(function (c) { chosen[String(c.zim)] = 1; });
if (!Object.keys(chosen).length) {
    printf("pickArchives chose nothing from %d archives in %s\n",
           pool.length, KIWIX);
    process.exit(1);
}

/* The table the naming rule gives an archive today. */
function tableFor(zim) {
    var i = /^zimgit-/.test(zim) ? fam.classifyPdf(zim) : fam.classify(zim);
    return i ? String(i.table) : "";
}

/* Archives pickArchives did not even look at. It handles the
   mwoffliner and sotoki families; the zimgit archives classify through
   classifyPdf and come back as "no family/selectors", so their absence
   from the pick says nothing about whether they are current. */
var notConsidered = {};
(picked.skipped || []).forEach(function (sk) {
    if (/no family|no selectors/.test(String(sk.why || "")))
        notConsidered[String(sk.zim)] = 1;
});

/* The date in an archive's name. families.js keeps its own dateOf
   private, and this only has to order two dumps of one collection. */
function zimDate(z) {
    var m = /_(\d{4}-\d{2}(?:-\d{2})?)\.zim$/.exec(String(z));
    return m ? m[1] : "";
}

/* The latest archive the pool holds for each table, by today's naming
   rule. Used only for the archives the picker skipped. */
var newestFor = {};
pool.forEach(function (z) {
    var t = tableFor(z);
    if (!t) return;
    var cur = newestFor[t];
    if (!cur || zimDate(z) > cur.date)
        newestFor[t] = { zim: z, date: zimDate(z) };
});

/* What is imported, and why each row might be obsolete. */
var rows = [];
sql.exec("select Zim, TableName, Collection, Site, Asof from lips_sources;",
         { maxRows: 5000 }, function (r) {
    rows.push({ zim: String(r.Zim), table: String(r.TableName),
                coll: String(r.Collection || ""), asof: String(r.Asof || "") });
});

var tables = {};      /* table -> { why: {}, zims: [] } */
rows.forEach(function (r) {
    var why = "";
    var want = tableFor(r.zim);
    if (want && want !== r.table) why = "retabled -> " + want;
    else if (notConsidered[r.zim]) {
        /* The picker never ranked this one, so ask the pool whether
           anything newer for the same table is actually sitting there. */
        var n = newestFor[want || r.table];
        if (n && n.zim !== r.zim)
            why = "superseded by " + n.zim;
    }
    else if (!chosen[r.zim]) why = "superseded in the pool";
    if (!why) return;
    var t = tables[r.table] || (tables[r.table] = { why: {}, zims: [] });
    t.why[why] = 1;
    t.zims.push(r.zim);
});

var names = Object.keys(tables).sort();
if (!names.length) {
    printf("nothing to replace: every imported archive is current and in the"
           + " table the rule gives it\n");
    process.exit(0);
}

/* The staged JSONL for an archive, by the same short name run-import.sh
   derives -- kept in step with that sed chain deliberately. */
/* Unused since the staged files stopped being deleted. Kept because
   --list-staged is the obvious next thing to want from this tool. */
function stagedFor(zim) {
    var s = zim.replace(/\.zim$/, "")
               .replace(/\.stackexchange\.com_en_all_[0-9-]*$/, "")
               .replace(/\.com_en_all_[0-9-]*$/, "")
               .replace(/_all_(maxi|nopic|mini)_[0-9-]*$/, "")
               .replace(/_[0-9]{4}-[0-9]{2}$/, "");
    return STG + "/" + s + ".jsonl";
}

printf("%-34s %-26s %s\n", "table", "why", "archives");
printf("%-34s %-26s %s\n", "-".repeat(34), "-".repeat(26), "-".repeat(8));
var nz = 0;
names.forEach(function (t) {
    var e = tables[t];
    nz += e.zims.length;
    printf("%-34s %-26s %d\n", t, Object.keys(e.why).join(", ").substring(0, 26),
           e.zims.length);
});
printf("\n%d table(s), %d archive(s) to re-import\n", names.length, nz);

if (!GO) { printf("\n--go to drop them and forget the archives\n"); process.exit(0); }

names.forEach(function (t) {
    var e = tables[t];
    /* Order matters: drop the table first, so a failure leaves the
       registry pointing at something rather than rows pointing at
       nothing. */
    try { sql.exec("drop table " + t + ";"); printf("dropped table %s\n", t); }
    catch (err) { printf("could not drop %s: %s\n", t, err.message); }
    e.zims.forEach(function (z) {
        sql.exec("delete from lips_sources where Zim = ?;", [z]);
    });
    /* The staged extractions stay. Deleting them here cost 161 Stack
       Exchange extractions when the shared tables were split, because a
       retable keeps the same archives and their JSONL was still good --
       and it is not needed for a supersede either: run-import.sh reads
       the sidecar and re-stages when the archive it names is not the one
       being imported. */
    printf("  forgot %d archive(s)\n", e.zims.length);
});
printf("\nrun ./build.sh import to rebuild those tables, then merge and"
       + " index: corpus is now behind them\n");
