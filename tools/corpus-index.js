/* Build the indexes on the merged `corpus` table.
 *
 *   rampart corpus-index.js [mem%] [--db DIR] [--only NAME] [--drop] [--list]
 *
 *     mem%     OPTIONAL first argument, passed to indexMem. Omit it and
 *              indexMem is not set at all, so texis's own default
 *              applies. Under 100 is a percent of physical memory;
 *              100 or more is a byte count.
 *     --rebuild  re-issue the SAME create for an index that already
 *              exists, WITHOUT dropping it. For a fulltext index an
 *              unchanged expression list makes this an optimize, which
 *              folds in rows inserted since the last build; it carries
 *              indexmeter, so progress is visible where `alter index
 *              corpus_cx optimize` shows nothing. Btrees are skipped,
 *              since they cannot be re-created in place.
 *     --list   report what SYSINDEX holds and do nothing
 *     --only   act on one index only (corpus_cx | corpus_src | corpus_ttl)
 *     --drop   DROP an existing index before creating it. Required to
 *              change a fulltext expression list.
 *
 * THE RULES, measured 2026-11-06:
 *   - A btree index cannot be re-created while it exists: "100 BTREE Index
 *     already exists". It must be dropped first.
 *   - A fulltext index CAN be re-created with the SAME expression list --
 *     that is silently an OPTIMIZE.
 *   - A fulltext re-create with a NEW expression list RETURNS OK AND
 *     SILENTLY KEEPS THE OLD EXPRESSIONS. Verified: the new punctuation
 *     tokens were absent afterwards. SYSINDEX does not record the
 *     expression list, so this cannot be detected automatically -- which
 *     is why changing expressions requires an explicit --drop.
 *
 * Default behaviour is therefore to SKIP any index already in SYSINDEX.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");
var argv = process.argv;
function flag(n) { return argv.indexOf("--" + n) !== -1; }
function opt(n) { var i = argv.indexOf("--" + n); return i > -1 ? argv[i+1] : null; }

/* The tree this file sits in, so a clone anywhere works. */
var LIPS = process.env.LIPS || rampart.utils.realPath(process.scriptPath + "/..");
var D   = opt("db") || (LIPS + "/build/corpus");
var sql = new Sql.init(D, true);

var DROP = flag("drop"), LIST = flag("list"), ONLY = opt("only");
var REBUILD = flag("rebuild");
var NOBATCH = flag("no-batch");
if (REBUILD && DROP) {
    printf("--rebuild and --drop are opposites: --rebuild deliberately "
           + "keeps the existing index and re-issues the same create, "
           + "which texis treats as an OPTIMIZE. Pick one.\n");
    process.exit(1);
}
/* No default: with no mem% given, indexMem is left alone and texis uses
   its own. Only an explicit argument sets it.
   Taken from ANY bare numeric argument, not just argv[2]: reading only
   the first position meant `--rebuild 70` silently ignored the 70 and
   ran on the default, with nothing but the status line to show it. */
var MEM = null;
for (var ai = 2; ai < argv.length; ai++) {
    var v = String(argv[ai]);
    if (v.indexOf("--") === 0) continue;
    if (argv[ai - 1] === "--only") continue;     /* that is a name */
    var num = Number(v);
    if (isFinite(num) && num > 0) { MEM = num; break; }
}

/* The expression list. Changing this REQUIRES --drop on corpus_cx. */
/* \ualnum not \uword: \uword admits combining marks, so decomposed text
   indexes with the mark attached and never matches a precomposed query.
   Both word expressions must use it or NFD re-enters through the second.
   Decimals: rex applies a repetition operator to the LONGEST preceding
   expression, and '=' IS the {1} operator -- so the dot needs its own
   '\.=' or {1,18} binds to the string ".<digit>" and 999.99 truncates to
   999.9. The trailing class admits dots so 4.8.5 and 192.168.1.1 survive.
   {1,99} not {1,20}: long IEEE-754 values in code discussions otherwise
   clamp and collide. This replaced \bound[0-9.]{3,24}\bound, which gave
   an identical dictionary but 10.3x the merge work by also matching bare
   integers that duplicate main-expression tokens.
   [CDR] stays uppercase: cheaper than [cCdDrR] by 2.66x, and queryable
   since the ixqrlex fix. */
var EXPRS = "'[\\ualnum]{2,99}', " +
            "'[\\ualnum$%@\\-_+#]{2,99}', " +
            "'\\digit{1,99}\\.=[0-9.]{1,99}', " +
            "'\\bound[CDR]=\\F\\space'";

var WANT = [
    { name: "corpus_cx",  kind: "fulltext ", on: "Doc, Source", exprs: EXPRS },
    { name: "corpus_src", kind: "",          on: "SrcPath" },
    { name: "corpus_ttl", kind: "",          on: "Title" }
];

/* what SYSINDEX holds */
var have = {};
sql.exec("select NAME, TBNAME, FIELDS, TYPE from SYSINDEX;", { maxRows: 200 },
         function (r) {
    if (String(r.TBNAME) !== "corpus") return;
    have[String(r.NAME)] = { fields: String(r.FIELDS), type: String(r.TYPE) };
});

printf("--- SYSINDEX, table corpus ---\n");
if (!Object.keys(have).length) printf("  (no indexes)\n");
Object.keys(have).forEach(function (k) {
    printf("  %-12s fields=%-16s type=%s\n", k, have[k].fields, have[k].type);
});
printf("\nindexMem %s   %s%s\n",
       MEM === null ? "(texis default, not set)"
                    : (MEM < 100 ? MEM + "% of RAM" : MEM + " bytes"),
       DROP ? "--drop GIVEN  " : (REBUILD ? "--rebuild GIVEN  "
                                          : "skip-if-exists  "),
       ONLY ? "only " + ONLY : "all three");
if (LIST) {
    /* Print the exact statements that would be issued. Worth seeing before
       an 11-hour run: the expression list crosses two layers of escaping. */
    printf("\n--- statements that WOULD be issued ---\n");
    WANT.forEach(function (w) {
        if (ONLY && w.name !== ONLY) return;
        if (have[w.name] && REBUILD && !w.exprs) {
            printf("  %-12s (skipped, btree cannot rebuild in place)\n",
                   w.name); return;
        }
        if (have[w.name] && !DROP && !REBUILD) {
            printf("  %-12s (skipped, exists)\n", w.name); return;
        }
        if (have[w.name] && DROP) printf("  drop index %s;\n", w.name);
        printf("  create %sindex %s on corpus(%s)%s;\n", w.kind, w.name, w.on,
               w.exprs ? " with wordexpressions (" + w.exprs + ") indexmeter 'simple'"
                       : " with indexmeter 'simple'");
    });
    printf("\n--list: nothing done\n");
    process.exit(0);
}

var rows = 0;
sql.exec("select count(*) c from corpus;", { maxRows: 1 },
         function (r) { rows = Number(r.c); });
printf("corpus: %d rows\n\n", rows);

/* indexMem under 100 is a percent of physical memory; 100 or more is a
   byte count. Set ONLY when asked for, so the texis default stands
   otherwise. Measured 2026-11-06 on this box: 80 was worse than 40 --
   it thrashed, spilled twice anyway, and ran slower per row. */
if (MEM !== null) sql.set({ indexMem: MEM });

/* A Metamorph build read-locks the table intermittently so that other
   connections can write while it runs -- two lock server requests a row.
   Nothing writes to corpus during a build, so this holds one read lock
   for the whole build instead, which also lets texis read the table with
   a larger buffer. Only corpus_cx is affected: a btree is always built
   under a continuous read lock whatever this says.

   The cost is that the table cannot be written until the build is nearly
   done, which is why --no-batch exists for a build on a table something
   else must keep writing to.

   An unknown optimization name is meant to raise, and sql.get() to
   report what differs from the defaults. On an older rampart it does
   neither -- any string is accepted silently and nothing is reported --
   so the read-back is printed either way: a value confirms it, and a
   blank means this rampart cannot say and the build time is the only
   evidence. */
if (!NOBATCH) {
    sql.set({ optimize: "indexbatchbuild" });
    var ob = "";
    try { ob = String(sql.get("optimize") || ""); } catch (e) { ob = ""; }
    printf("indexbatchbuild on (read-back: %s): the table stays "
           + "read-locked for the whole build\n",
           ob.length ? ob : "not reported by this build");
} else {
    printf("indexbatchbuild OFF (--no-batch): intermittent read locks, "
           + "so the table stays writable\n");
}


WANT.forEach(function (w) {
    if (ONLY && w.name !== ONLY) return;
    var exists = !!have[w.name];

    /* --rebuild: re-issue the SAME create for an index that already
       exists, dropping nothing. Per the rules above, a fulltext
       re-create with an unchanged expression list IS an optimize, so
       this folds in rows added since the last build -- and unlike
       `alter index corpus_cx optimize` it carries indexmeter, so
       progress is visible.

       It relies on EXPRS being untouched. If the list in this file has
       been edited, the re-create returns OK and SILENTLY KEEPS THE OLD
       EXPRESSIONS, so a changed list needs --drop and a full rebuild. */
    if (exists && REBUILD) {
        if (!w.exprs) {
            printf("%-12s EXISTS -- skipped: a btree cannot be "
                   + "re-created in place (\"100 BTREE Index already "
                   + "exists\"); use --drop for that one.\n", w.name);
            return;
        }
        printf("%-12s REBUILD: re-issuing the same create as an "
               + "optimize, no drop\n", w.name);
    } else if (exists && !DROP) {
        printf("%-12s EXISTS -- skipped. Pass --rebuild to optimize it "
               + "in place, or --drop to replace it%s.\n",
               w.name, w.exprs ? " (required to change expressions)" : "");
        return;
    }
    if (exists && DROP) {
        printf("%-12s dropping\n", w.name);
        fflush(stdout);
        sql.exec("drop index " + w.name + ";");
    }

    printf("%-12s building %son corpus(%s)\n", w.name, w.kind, w.on);
    fflush(stdout);
    var t0 = Date.now();
    sql.exec("create " + w.kind + "index " + w.name + " on corpus(" + w.on + ")" +
             (w.exprs ? " with wordexpressions (" + w.exprs + ") indexmeter 'simple'"
                      : " with indexmeter 'simple'") + ";");
    var secs = (Date.now() - t0) / 1000;
    printf("%-12s built in %.0f s (%.0f rows/s)\n\n", w.name, secs,
           rows / Math.max(secs, 0.001));
    fflush(stdout);
});

printf("--- on disk ---\n");
var fs = rampart.utils, tbl = 0, idx = 0;
fs.readdir(D).forEach(function (f) {
    if (f.indexOf("corpus_test") === 0) return;   /* experiment leftovers */
    if (f === "corpus.tbl") { tbl += Number(fs.stat(D + "/" + f).size); return; }
    if (f.indexOf("corpus_") === 0) idx += Number(fs.stat(D + "/" + f).size);
});
printf("  table   %.2f GiB\n  indexes %.2f GiB\n  total   %.2f GiB  (%.3fx of table)\n",
       tbl/1073741824, idx/1073741824, (tbl+idx)/1073741824,
       tbl ? (tbl+idx)/tbl : 0);
