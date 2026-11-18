#!/usr/bin/env rampart
/* Emit the full-import work list, in the order it should run.
 *
 *   rampart worklist.js [--db DIR] [--hold NAME,NAME]
 *
 * One archive name per line, for tools/run-import.sh. Order:
 *   1. the remaining wiki archives   -- well understood, modest size
 *   2. Stack Exchange, smallest first -- the 157-site tail completes
 *      early, so a failure late in the run costs little
 *   3. Stack Overflow last            -- 107 GB on its own
 * Archives already in lips_sources are left out, and --hold drops any
 * archive pending a decision.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");
var fam = require("./families.js");

function arg(n, d) {
    var a = process.argv, i = a.indexOf("--" + n);
    if (i < 0) return d;
    var v = a[i + 1];
    return (v === undefined || /^--/.test(v)) ? true : v;
}
/* The tree this file sits in, so a clone anywhere works. */
var LIPS  = process.env.LIPS || rampart.utils.realPath(process.scriptPath + "/..");
var DB   = String(arg("db", LIPS + "/build/corpus"));
var HOLD = String(arg("hold", "")).split(",").filter(function (s) { return s.length; });

var meta = JSON.parse(readFile(LIPS + "/notes/zim-meta.json",
                               { returnString: true }));
var picked = fam.pickArchives(Object.keys(meta)).pick;

/* What is already in. */
var done = {};
try {
    var sql = new Sql.init(DB, true);
    sql.exec("select Zim from lips_sources;", { maxRows: 1000 },
             function (r) { done[String(r.Zim)] = 1; });
} catch (e) { /* no database yet */ }

var wikis = [], se = [], so = [], held = [], skipped = [];
picked.forEach(function (p) {
    var z = p.zim;
    if (done[z]) { skipped.push(z); return; }
    if (HOLD.some(function (h) { return z.indexOf(h) === 0; })) {
        held.push(z); return;
    }
    if (p.info.collection === "stackoverflow") so.push(p);
    else if (p.info.family === "sotoki") se.push(p);
    else wikis.push(p);
});

function bytes(p) { return Number(meta[p.zim].bytes || 0); }
wikis.sort(function (a, b) { return bytes(a) - bytes(b); });
se.sort(function (a, b) { return bytes(a) - bytes(b); });

var order = wikis.concat(se).concat(so);
var gb = order.reduce(function (a, p) { return a + bytes(p); }, 0) / 1073741824;

printf("# %d archives to import, %.2f GB of ZIM\n", order.length, gb);
printf("# %d already imported, %d held\n", skipped.length, held.length);
held.forEach(function (z) { printf("# held: %s\n", z); });
order.forEach(function (p) { printf("%s\n", p.zim); });
