#!/usr/bin/env rampart
/* Does a staging table deserve a place in the corpus?
 *
 *   rampart tools/assess-table.js --db DIR <table> [<table> ...]
 *   rampart tools/assess-table.js --db DIR --against wikipedia_en <table>
 *
 * Two failure modes have each already cost an import:
 *
 *   DUPLICATION  mdwiki turned out to be 96.8% the same titles as
 *                wikipedia_en_medicine -- the same text under a second
 *                Source, so every search would answer twice.
 *   BULK         a table can be large and still hold nothing: stub
 *                entries scraped from a database, a title and a line.
 *
 * The first needs --against and costs a scan of the other table, so it
 * is opt-in. The second is read off this table alone and is always
 * reported. Neither judges the content: they say how much there is and
 * whether we already have it.
 *
 * Document size comes from Nbytes, which the importer records per row.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");

function arg(n, d) {
    var i = process.argv.indexOf("--" + n);
    return i > 0 ? process.argv[i + 1] : d;
}

var LIPS = process.env.LIPS || realPath(process.scriptPath + "/..");
var DB = String(arg("db", LIPS + "/build/corpus"));
var AGAINST = arg("against", null);

var tables = process.argv.slice(2).filter(function (a, i, all) {
    if (a.substring(0, 2) === "--") return false;
    return !(i > 0 && all[i - 1].substring(0, 2) === "--");
});
if (!tables.length) {
    printf("usage: assess-table.js --db DIR [--against TABLE] <table> ...\n");
    process.exit(1);
}

var sql = new Sql.init(DB, true);

/* Percentile off a sorted array, for the shape of the distribution: a
   mean alone cannot tell a table of even articles from one of stubs
   beside a few long pages. */
function pct(sorted, p) {
    if (!sorted.length) return 0;
    var i = Math.floor((sorted.length - 1) * p);
    return sorted[i];
}

/* Titles of the comparison table, loaded once and reused for every
   table being assessed. */
var other = null, otherN = 0;
if (AGAINST) {
    printf("loading titles from %s (a full scan of it) ...\n", AGAINST);
    other = {};
    sql.exec("select Title from " + AGAINST + ";", { maxRows: 20000000 },
             function (r) { other[String(r.Title).toLowerCase()] = 1; otherN++; });
    printf("  %d titles\n\n", otherN);
}

tables.forEach(function (t) {
    var sizes = [], total = 0, n = 0, empty = 0;
    var samples = [];
    sql.exec("select Title, Nbytes from " + t + ";", { maxRows: 20000000 },
             function (r) {
        var b = Number(r.Nbytes) || 0;
        n++; total += b; sizes.push(b);
        if (b < 200) empty++;
        if (samples.length < 6 && n % 977 === 1) samples.push([String(r.Title), b]);
    });
    if (!n) { printf("%-24s no rows (table missing?)\n", t); return; }

    sizes.sort(function (a, b) { return a - b; });
    var stub1k = 0, stub500 = 0;
    for (var i = 0; i < sizes.length; i++) {
        if (sizes[i] < 1000) stub1k++;
        if (sizes[i] < 500) stub500++;
    }

    printf("%s\n", t);
    printf("  documents      %d\n", n);
    printf("  text           %.2f GB total, mean %.0f B\n",
           total / 1073741824, total / n);
    printf("  distribution   p10 %d B   median %d B   p90 %d B   max %d B\n",
           pct(sizes, 0.10), pct(sizes, 0.50), pct(sizes, 0.90),
           sizes[sizes.length - 1]);
    printf("  thin           %.1f%% under 1 kB, %.1f%% under 500 B, %.1f%% under 200 B\n",
           100 * stub1k / n, 100 * stub500 / n, 100 * empty / n);

    if (other) {
        var hit = 0;
        sql.exec("select Title from " + t + ";", { maxRows: 20000000 },
                 function (r) {
            if (other[String(r.Title).toLowerCase()]) hit++;
        });
        printf("  overlap        %d of %d titles also in %s (%.1f%%)\n",
               hit, n, AGAINST, 100 * hit / n);
    }

    printf("  sample         ");
    samples.forEach(function (s, i) {
        printf("%s%s (%d B)\n", i ? "                 " : "",
               s[0].substring(0, 54), s[1]);
    });
    printf("\n");
});
