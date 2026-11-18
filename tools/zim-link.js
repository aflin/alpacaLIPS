/* Populate zim/ -- what kiwix serves -- from the archive pool.
 *
 *   rampart zim-link.js [--prune]
 *     --prune  also remove entries that are no longer in the manifest
 *
 * HARD LINKS, not symlinks. Everything lives in one tree now, so a hard
 * link costs nothing and behaves like the file it names: kiwix opens it,
 * tar packs it, rsync sends it, and deleting the pool copy does not
 * leave a dangling path behind. A copy would cost another 530 GB and a
 * symlink would need every consumer to dereference it.
 *
 * WHY zim/ EXISTS AT ALL, given the pool is right there: it is the
 * SELECTED set. The pool holds whatever has been downloaded, including
 * archives superseded by a newer dump; zim/ holds exactly the archives
 * the corpus was built from, read from lips_sources rather than from a
 * directory listing. A missing one is reported, not skipped, and each
 * one's size is checked against what the importer recorded.
 *
 * If the pool is on another filesystem -- config.local.sh moved it --
 * a hard link is impossible and this falls back to a symlink, which is
 * the one case where one is still used.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");
/* globalize() does not give `link` a short name worth shadowing: the
   loop below uses `link` for the path it is making. */
var link_ = rampart.utils.link;

/* The tree this file sits in, and the archive pool config.sh names. */
var LIPS  = process.env.LIPS || rampart.utils.realPath(process.scriptPath + "/..");
var paths = require("./paths.js");
var DATA = paths.dataDir(LIPS);
var DB   = LIPS + "/build/corpus";
var ZIM  = LIPS + "/zim";
var POOL = paths.pools(DATA);
var PRUNE = process.argv.indexOf("--prune") !== -1;

var sql = new Sql.init(DB);

/* manifest: one entry per imported archive */
var want = {};
sql.exec("select Zim, Collection, TableName, Site, ZimBytes from lips_sources;",
         { maxRows: 1000 }, function (r) {
    var z = String(r.Zim);
    if (z) want[z] = { bytes: Number(r.ZimBytes) || 0,
                       collection: String(r.Collection) };
});
var names = Object.keys(want).sort();
printf("manifest lists %d distinct archives\n", names.length);

try { mkdir(ZIM); printf("created %s\n", ZIM); }
catch (e) { printf("using existing %s\n", ZIM); }

/* where each archive actually is */
var found = {}, pool = 0;
POOL.forEach(function (d) {
    var list;
    try { list = readdir(d); } catch (e) { printf("  pool missing: %s\n", d); return; }
    list.forEach(function (f) {
        if (f.slice(-4) !== ".zim") return;
        pool++;
        if (!found[f]) found[f] = d + "/" + f;
    });
});
printf("pool holds %d .zim files across %d directories\n\n", pool, POOL.length);

var linked = 0, already = 0, missing = [], sizeOk = 0, sizeOdd = [];
var softlinked = 0;
names.forEach(function (z) {
    var target = found[z];
    if (!target) { missing.push(z); return; }
    var link = ZIM + "/" + z;
    /* Same inode as the pool copy means it is already the right file.
       stat() follows a symlink, so an older symlinked tree answers this
       correctly too and is left alone rather than relinked. */
    var src = stat(target), dst = null;
    try { dst = stat(link); } catch (e) {}
    if (dst && src && String(dst.ino) === String(src.ino)) { already++; }
    else {
        try { if (dst) rmFile(link); } catch (e) {}
        try { link_(target, link); linked++; }
        catch (e) {
            /* EXDEV: the pool is on another filesystem. */
            try { symlink(target, link); linked++; softlinked++; }
            catch (e2) {
                printf("  link failed %s: %s\n", z, e2.message); return;
            }
        }
    }
    var st = null;
    try { st = stat(link); } catch (e) {}
    if (!st) { sizeOdd.push(z + " (entry does not resolve)"); return; }
    var n = Number(st.size);
    if (want[z].bytes && Math.abs(n - want[z].bytes) > 1024)
        sizeOdd.push(z + " (" + n + " on disk vs " + want[z].bytes +
                     " in manifest)");
    else sizeOk++;
});

if (PRUNE) {
    var removed = 0;
    readdir(ZIM).forEach(function (f) {
        if (f.slice(-4) === ".zim" && !want[f]) {
            try { rmFile(ZIM + "/" + f); removed++; } catch (e) {}
        }
    });
    printf("pruned %d links not in the manifest\n", removed);
}

printf("linked %d new, %d already correct, %d sizes verified\n",
       linked, already, sizeOk);
if (softlinked)
    printf("  %d had to be symlinked: the pool is on another filesystem\n",
           softlinked);
if (sizeOdd.length) {
    printf("\n%d size mismatches:\n", sizeOdd.length);
    sizeOdd.slice(0, 10).forEach(function (s) { printf("  %s\n", s); });
}
if (missing.length) {
    printf("\n%d MANIFEST ARCHIVES NOT FOUND IN THE POOL:\n", missing.length);
    missing.forEach(function (s) { printf("  %s\n", s); });
}

/* what is in the pool but was never imported */
var extra = Object.keys(found).filter(function (f) { return !want[f]; });
if (extra.length) {
    printf("\n%d archives in the pool are NOT in the manifest " +
           "(not linked):\n", extra.length);
    extra.slice(0, 12).forEach(function (s) { printf("  %s\n", s); });
    if (extra.length > 12) printf("  ... and %d more\n", extra.length - 12);
}
