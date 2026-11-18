#!/usr/bin/env rampart
/* Checks families.js against the archives actually on disk.
 *
 *   rampart t-families.js [notes/zim-meta.json]
 *
 * Two silent-duplication bugs were caught here once already -- six wikis
 * present as both nopic and maxi, and top1m adding 5.9M duplicate
 * entries -- so this runs before every import, not once.
 */
rampart.globalize(rampart.utils);

var f = require("./families.js");
/* Relative to this file, not to the caller's directory: the default
   resolved only when run from inside import/, so run-import.sh --list
   died on realPath from the tree root. */
var metaArg = process.argv[2] || (process.scriptPath + "/../notes/zim-meta.json");
if (!stat(metaArg)) {
    printf("no archive metadata at %s\n" +
           "Run `./build.sh meta` first: it reads each archive in the\n" +
           "pool and writes notes/zim-meta.json, which this checks against.\n",
           metaArg);
    process.exit(1);
}
var metaPath = rampart.utils.realPath(metaArg);
var meta = JSON.parse(readFile(metaPath, { returnString: true }));
var names = Object.keys(meta).sort();

var pass = 0, fail = 0;
function check(ok, what) {
    if (ok) { pass++; return true; }
    fail++;
    printf("FAIL  %s\n", what);
    return false;
}

printf("%d archives from %s\n\n", names.length, metaPath);

/* 1. Scraper and filename must agree wherever the filename rules fire.
      A disagreement means one of the two is wrong and the import would
      use the wrong selectors. */
var byScraper = {}, disagree = 0;
names.forEach(function (n) {
    var fs = f.familyFromScraper(meta[n].scraper);
    var fn = f.familyFromName(n);
    byScraper[fs || "(none)"] = (byScraper[fs || "(none)"] || 0) + 1;
    if (fn && fs && fn !== fs) {
        disagree++;
        printf("  disagree %s: scraper=%s name=%s\n", n, fs, fn);
    }
});
check(disagree === 0, "Scraper and filename family disagree on " +
                      disagree + " archives");
printf("families by Scraper:\n");
Object.keys(byScraper).sort().forEach(function (k) {
    printf("  %-14s %4d\n", k, byScraper[k]);
});

/* 2. Every archive has a Date, which becomes the table's Asof. */
var noDate = names.filter(function (n) {
    return !/^\d{4}-\d{2}(-\d{2})?$/.test(String(meta[n].date || ""));
});
check(noDate.length === 0, "archives with no usable Date: " +
                           noDate.slice(0, 5).join(", "));

/* 3. The picker: one archive per table, no duplicates, nothing dropped
      without a stated reason. */
var r = f.pickArchives(names);
var tables = {};
r.pick.forEach(function (p) {
    var k = p.info.table + "|" + (p.info.site || "");
    check(!tables[k], "duplicate pick for " + k);
    tables[k] = p;
});
check(r.pick.length + r.skipped.length === names.length,
      "picked " + r.pick.length + " + skipped " + r.skipped.length +
      " != " + names.length + " archives");

/* 4. Every picked archive must have selectors for its family. */
r.pick.forEach(function (p) {
    check(!!f.FAMILIES[p.info.family],
          p.zim + ": no selectors for family " + p.info.family);
});

/* 5. No table may draw from two different flavours of the same wiki. */
var wikiProjects = {};
r.pick.forEach(function (p) {
    if (p.info.family !== "mwoffliner") return;
    var proj = p.info.collection + "|" + p.info.table;
    check(!wikiProjects[proj], "wiki imported twice: " + proj);
    wikiProjects[proj] = p.zim;
});

/* Report. */
var dest = {};
r.pick.forEach(function (p) {
    (dest[p.info.table] = dest[p.info.table] || []).push(p);
});
printf("\n%d archives -> %d tables:\n", r.pick.length,
       Object.keys(dest).length);
Object.keys(dest).sort().forEach(function (t) {
    var v = dest[t], arts = 0, bytes = 0, dates = {};
    v.forEach(function (p) {
        arts += meta[p.zim].articles || 0;
        bytes += meta[p.zim].bytes || 0;
        dates[meta[p.zim].date] = 1;
    });
    var ds = Object.keys(dates).sort();
    printf("  %-18s %3d archive(s) %10d articles %8.2f GB  %s\n",
           t, v.length, arts, bytes / 1073741824,
           ds.length === 1 ? ds[0] : ds[0] + ".." + ds[ds.length - 1]);
});

printf("\n%d skipped:\n", r.skipped.length);
r.skipped.forEach(function (s) {
    printf("  %-62s %s\n", s.zim.substring(0, 62), s.why);
});

printf("\n%d passed, %d failed\n", pass, fail);
process.exit(fail ? 1 : 0);
