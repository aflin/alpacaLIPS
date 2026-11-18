#!/usr/bin/env rampart
/* Create the §19 indexes on an imported table, after the rows are in.
 *
 *   rampart mkindex.js --db DIR [--table NAME] [--force]
 *
 * With no --table, every table named in lips_sources is indexed.
 * Existing indexes are left alone unless --force drops them first, so
 * the script is safe to re-run after adding more archives to a table.
 *
 * Separate from the importer because index maintenance per INSERT is
 * the wrong order for a bulk load: a table that takes several archives
 * (stackexchange takes 161) should receive all its rows first and be
 * indexed once.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");

function arg(n, d) {
    var a = process.argv, i = a.indexOf("--" + n);
    if (i < 0) return d;
    var v = a[i + 1];
    return (v === undefined || /^--/.test(v)) ? true : v;
}
var DB    = arg("db", null);
var ONE   = arg("table", null);
var FORCE = !!arg("force", false);

if (!DB) {
    printf("usage: mkindex.js --db DIR [--table NAME] [--force]\n");
    process.exit(1);
}
var sql = new Sql.init(String(DB), true);

var names = [];
if (ONE) names = [String(ONE)];
else {
    var seen = {};
    sql.exec("select TableName from lips_sources;", { maxRows: 1000 },
             function (r) { seen[String(r.TableName)] = 1; });
    names = Object.keys(seen).sort();
}
if (!names.length) {
    printf("no tables to index\n");
    process.exit(1);
}

/* Doc gets the metamorph fulltext index; SrcPath is the link key;
   Title is indexed because the en Wikipedia build's omission turned a
   400-title lookup into 400 full scans of a 102 GB table. */
var WANT = [ { suffix: "ftx", field: "Doc",     kind: "fulltext ", type: "F" },
             { suffix: "src", field: "SrcPath", kind: "",          type: "B" },
             { suffix: "ttl", field: "Title",   kind: "",          type: "B" } ];

names.forEach(function (TBL) {
    var rows = 0;
    try {
        sql.exec("select count(*) c from " + TBL + ";", { maxRows: 1 },
                 function (r) { rows = Number(r.c); });
    } catch (e) {
        printf("%s: no such table\n", TBL);
        return;
    }
    printf("%s (%d rows)\n", TBL, rows);

    var have = {};
    sql.exec("select NAME, FIELDS, TYPE from SYSINDEX where TBNAME = ?;",
             [TBL], { maxRows: 50 }, function (r) {
        have[String(r.FIELDS)] = { name: String(r.NAME), type: String(r.TYPE) };
    });

    WANT.forEach(function (w) {
        var cur = have[w.field];
        if (cur && !FORCE) {
            printf("  %-9s have %s\n", w.field, cur.name);
            return;
        }
        if (cur && FORCE) {
            sql.exec("drop index " + cur.name + ";");
            printf("  %-9s dropped %s\n", w.field, cur.name);
        }
        /* indexmeter 'simple', not 'percent': percent redraws in place
           with CR and BS, which a redirected log carries as control
           characters. Name the index first, or a run is unlabelled bars. */
        printf("  %-9s building %s%s\n", w.field, w.kind, TBL + "_" + w.suffix);
        fflush(stdout);
        var t0 = Date.now();
        sql.exec("create " + w.kind + "index " + TBL + "_" + w.suffix +
                 " on " + TBL + "(" + w.field + ") with indexmeter 'simple';");
        var secs = (Date.now() - t0) / 1000;
        printf("  %-9s built in %.0f s%s\n", w.field, secs,
               rows ? sprintf(" (%.0f rows/s)", rows / Math.max(secs, 0.001)) : "");
    });
});
