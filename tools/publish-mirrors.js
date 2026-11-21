/* Publish where the archives can be had upstream.
 *
 *   rampart tools/publish-mirrors.js [--out DIR] [--db DIR] [--quick]
 *
 * The archives are mirrored by people whose job it is, and those mirrors
 * are nearer most installs than one 1 Gb port in Fremont. For an install
 * to use them it needs two things we have and it does not: which mirrors
 * exist, and where each archive sits on them.
 *
 *   archives/MIRRORS    one base URL per line
 *   archives/UPSTREAM   "<archive> <path> <indices of the mirrors that
 *                        have it>"
 *
 * Coverage is partial and has to be recorded per archive: Your.Org and
 * dumps.wikimedia 404 the whole zim/other/ directory, so an install that
 * spread one archive's ranges evenly over "the three fastest mirrors"
 * would aim a third of them at a mirror that has not got it.
 *
 * Every path is verified with a HEAD before it is published, because a
 * wrong path is worse than no path: the install would fall back to us
 * anyway, but only after waiting for a 404 per archive. On the first run
 * all 215 were found on at least one mirror, the oldest dating from
 * 2024-05, so retention is good -- but dumps are replaced eventually,
 * and an archive no mirror has is left out and served from here.
 *
 * --quick skips verification and derives paths only, for a dry run.
 */
rampart.globalize(rampart.utils);
var curl = require("rampart-curl");
var Sql  = require("rampart-sql");

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

var HERE  = (process.scriptPath || ".").replace(/[\/]tools[\/]?$/, "");
var DB    = String(arg("db", HERE + "/build/corpus"));
var OUT   = String(arg("out", HERE + "/downloads/alpacalips"));
var QUICK = flag("quick");

/* Measured from this machine, repeatedly: Kiwix's own endpoint gives
   0.2-2 MB/s while these give 12-16 each and about 39 together. The
   install probes them itself -- this is only the candidate set, with the
   slow one last so that a client which does not probe still does well. */
var MIRRORS = [
    "https://mirrors.dotsrc.org/kiwix/",
    "https://ftpmirror.your.org/pub/kiwix/",
    "https://dumps.wikimedia.org/kiwix/",
    "https://ftp.nluug.nl/pub/kiwix/",
    "https://mirror.download.kiwix.org/"
];

/* Which kiwix directory an archive lives in. Taken from the job lists
   where they exist, since those came from the metalinks, and otherwise
   from the name -- every collection follows one of these shapes. */
function dirFor(zim) {
    if (/^gutenberg_/.test(zim))              return "gutenberg";
    if (/^ifixit_/.test(zim))                 return "ifixit";
    if (/^zimgit-/.test(zim))                 return "other";
    if (/^stackoverflow\.com_/.test(zim))     return "stack_exchange";
    if (/\.stackexchange\.com_/.test(zim))    return "stack_exchange";
    if (/^(askubuntu|superuser|serverfault)\.com_/.test(zim))
                                              return "stack_exchange";
    var w = /^(wikipedia|wiktionary|wikisource|wikibooks|wikiversity|wikivoyage|wikiquote|wikinews)_/
            .exec(zim);
    if (w) return w[1];
    return "";
}

/* The job lists carry real metalink URLs, so where one exists it beats a
   guess. */
var known = {};
/* META where the build exports it, then the in-tree default. An
   absolute path belonging to one machine was here before. */
var METAD = String(process.env.META
                   || ((process.env.DATA || (HERE + "/downloads")) + "/meta"));
[METAD + "/jobs.tsv", METAD + "/jobs-maxi.tsv",
 HERE + "/downloads/meta/jobs.tsv", HERE + "/downloads/meta/jobs-maxi.tsv"]
.forEach(function (f) {
    if (!stat(f)) return;
    bufferToString(readFile(f)).split("\n").forEach(function (line) {
        var c = line.split("\t");
        for (var i = 3; i < c.length; i++) {
            var m = /(zim\/[^\/]+\/([^\/\s]+\.zim))\s*$/.exec(c[i] || "");
            if (m) { known[m[2]] = m[1]; break; }
        }
    });
});

/* The archives this corpus was built from. */
var zims = [];
var sql = new Sql.init(DB);
sql.exec("select Zim from lips_sources;", { maxRows: 5000 }, function (r) {
    zims.push(String(r.Zim));
});
zims.sort();
if (!zims.length) { printf("no archives in %s\n", DB); process.exit(1); }

var UA = "alpacaLIPS/0.1 (+https://rampart.dev)";
function head(url) {
    /* nobody, not method: rampart-curl takes libcurl's option names and
       has no "method". This is CURLOPT_NOBODY -- a HEAD. */
    var r = curl.fetch(url, { nobody: true, headers: { "User-Agent": UA },
                              "max-time": 20, location: true, "max-redirs": 3 });
    return r ? Number(r.status) : 0;
}

var lines = [], gone = [], nopath = [], n = 0;
var per = [];                      /* how many archives each mirror has */
MIRRORS.forEach(function () { per.push(0); });

zims.forEach(function (z) {
    var path = known[z];
    if (!path) {
        var d = dirFor(z);
        if (!d) { nopath.push(z); return; }
        path = "zim/" + d + "/" + z;
    }
    if (QUICK) { lines.push(z + " " + path + " 0"); return; }
    /* Ask every mirror, not just until one says yes: which of them have
       it is the whole point of the file. */
    var has = [];
    MIRRORS.forEach(function (m, i) {
        if (head(m + path) === 200) { has.push(i); per[i]++; }
    });
    if (has.length) lines.push(z + " " + path + " " + has.join(","));
    else gone.push(z);
    if ((++n % 25) === 0)
        printf("  checked %d of %d\n", n, zims.length);
});

if (!stat(OUT + "/archives")) mkdir(OUT + "/archives");
fprintf(OUT + "/archives/MIRRORS", "%s\n", MIRRORS.join("\n"));
fprintf(OUT + "/archives/UPSTREAM", "%s\n", lines.join("\n"));

printf("\n  mirrors      %d\n", MIRRORS.length);
printf("  upstream     %d of %d archives\n", lines.length, zims.length);
if (!QUICK) {
    printf("  coverage, per mirror:\n");
    MIRRORS.forEach(function (m, i) {
        printf("      %-40s %3d of %d\n",
               m.replace(/^https:\/\//, "").replace(/\/.*$/, ""),
               per[i], zims.length);
    });
}
if (gone.length) {
    printf("  not upstream %d (served from here):\n", gone.length);
    gone.slice(0, 8).forEach(function (g) { printf("      %s\n", g); });
    if (gone.length > 8) printf("      ... and %d more\n", gone.length - 8);
}
if (nopath.length)
    printf("  no path for  %d: %s\n", nopath.length, nopath.slice(0, 4).join(" "));
printf("  wrote        %s/archives/{MIRRORS,UPSTREAM}\n", OUT);
