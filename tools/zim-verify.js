/* Is every archive the corpus was built from where it is served from?
 *
 *   rampart tools/zim-verify.js [--quiet]
 *
 * Replaces zim-link.js, which made a second name for every archive in
 * zim/ so that kiwix could serve them while they lived in a pool. There
 * is no pool and there are no links now: an archive is fetched into the
 * directory the web server publishes it from, the importer reads it
 * there, and kiwix builds its library from there.
 *
 * What is left worth doing is the check that linking used to carry out
 * as a side effect. lips_sources names the archives the corpus was
 * actually built from, so:
 *
 *   missing    named by the corpus, not in KIWIX. The corpus has rows
 *              whose citations point at an archive nobody can download,
 *              and kiwix will serve a library with a hole in it.
 *   wrong size present but not the length the import recorded -- a
 *              truncated download, or a different dump under the same
 *              name.
 *   extra      in KIWIX but not named by the corpus. Harmless to serve
 *              and worth knowing about: it is 2 GB to 100 GB of
 *              published bytes that nothing in the corpus cites.
 *
 * Exits non-zero when anything is missing or the wrong size, so the
 * build stops before the kiwix stage rather than after.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");

var LIPS  = process.env.LIPS || realPath(process.scriptPath + "/..");
var DB    = process.env.DB || (LIPS + "/build/corpus");
var KIWIX = process.env.KIWIX;
var QUIET = process.argv.indexOf("--quiet") !== -1;

if (!KIWIX) {
    /* Without the environment, work it out the way config.sh does. */
    var dl = process.env.DOWNLOAD_DIR;
    KIWIX = (dl ? dl : LIPS + "/downloads") + "/archives";
}
printf("archives: %s\n", KIWIX);

if (!stat(DB)) { printf("no database at %s\n", DB); process.exit(1); }
var sql = new Sql.init(DB);

/* What the corpus was built from, and how big each one was when it was
   imported. ZimBytes is what the importer recorded, so a size mismatch
   means the file changed under us. */
var want = {}, n = 0;
sql.exec("select Zim, ZimBytes from lips_sources;", { maxRows: 5000 },
         function (r) {
    var z = String(r.Zim);
    if (!z.length) return;
    want[z] = Number(r.ZimBytes || 0);
    n++;
});
if (!n) { printf("lips_sources is empty -- nothing imported yet\n");
          process.exit(1); }
printf("corpus was built from %d archive(s)\n\n", n);

var missing = [], wrong = [], extra = [], ok = 0;

Object.keys(want).sort().forEach(function (z) {
    var st = stat(KIWIX + "/" + z);
    if (!st) { missing.push(z); return; }
    var sz = Number(st.size), wantSz = want[z];
    /* ZimBytes of 0 means the importer did not record one; the file
       being present is all that can be checked then. */
    if (wantSz > 0 && sz !== wantSz) {
        wrong.push(z + " (" + sz + " on disk, " + wantSz + " imported)");
        return;
    }
    ok++;
});

var seen = readDir(KIWIX) || [];
seen.forEach(function (f) {
    f = String(f);
    if (!/\.zim$/.test(f)) return;
    if (!(f in want)) extra.push(f);
});

printf("  %-12s %d\n", "present", ok);
if (missing.length) {
    printf("  %-12s %d\n", "MISSING", missing.length);
    missing.slice(0, 10).forEach(function (z) { printf("      %s\n", z); });
    if (missing.length > 10)
        printf("      ... and %d more\n", missing.length - 10);
}
if (wrong.length) {
    printf("  %-12s %d\n", "WRONG SIZE", wrong.length);
    wrong.slice(0, 10).forEach(function (z) { printf("      %s\n", z); });
}
if (extra.length && !QUIET) {
    printf("  %-12s %d (served, not cited by the corpus)\n",
           "extra", extra.length);
    extra.slice(0, 6).forEach(function (z) { printf("      %s\n", z); });
    if (extra.length > 6)
        printf("      ... and %d more\n", extra.length - 6);
}

if (missing.length || wrong.length) {
    printf("\nThe corpus cites archives that are not servable as published."
           + "\n  ./build.sh fetch brings them in; they belong in %s\n", KIWIX);
    process.exit(1);
}
printf("\nevery archive the corpus cites is in place\n");
