#!/usr/bin/env rampart
/* Which staging tables are already in `corpus`, and what is still out.
 *
 *   rampart merge-status.js [--db DIR]
 *
 * lips_sources records what was IMPORTED into a per-collection table; it
 * says nothing about whether those rows were later merged into corpus.
 * Asking corpus directly by Source would scan 48M rows, because the only
 * index carrying Source is the compound fulltext one. Instead each
 * table's own SrcPath values are looked up through corpus_src, which is
 * a btree: a present SrcPath means that table is merged.
 *
 * Several paths are probed per table, not one, because a single miss
 * could be a row the importer skipped rather than an unmerged table.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");

function arg(n, d) { var i = process.argv.indexOf("--" + n);
                     return i > 0 ? process.argv[i + 1] : d; }
var LIPS = process.env.LIPS || rampart.utils.realPath(process.scriptPath + "/..");
var DB = String(arg("db", LIPS + "/build/corpus"));
var sql = new Sql.init(DB, true);

/* corpus column order is the positional contract for any INSERT. */
printf("corpus columns:\n  ");
var cols = [];
sql.exec("select NAME, TYPE from SYSCOLUMNS where TBNAME = ?;", ["corpus"],
         { maxRows: 100 }, function (r) {
    cols.push(String(r.NAME) + " " + String(r.TYPE));
});
printf("%s\n\n", cols.join(", "));

/* Candidate tables: every distinct TableName in the registry. */
var tbls = {};
sql.exec("select TableName, Collection, Docs from lips_sources;",
         { maxRows: 5000 }, function (r) {
    var t = String(r.TableName);
    if (!tbls[t]) tbls[t] = { coll: String(r.Collection), regDocs: 0 };
    tbls[t].regDocs += Number(r.Docs);
});

var names = Object.keys(tbls).sort();
var inN = 0, outN = 0, outDocs = 0, outTables = [];

printf("%-22s %-14s %10s %10s  %s\n",
       "table", "collection", "rows", "registry", "in corpus?");
names.forEach(function (t) {
    var rows = 0;
    try {
        sql.exec("select count(*) c from " + t + ";", { maxRows: 1 },
                 function (r) { rows = Number(r.c); });
    } catch (e) {
        printf("%-22s %-14s %10s %10d  TABLE MISSING\n",
               t, tbls[t].coll, "-", tbls[t].regDocs);
        return;
    }
    /* Probe a few of this table's SrcPaths against corpus_src. */
    var paths = [];
    sql.exec("select SrcPath from " + t + ";", { maxRows: 5 },
             function (r) { paths.push(String(r.SrcPath)); });
    var hits = 0;
    paths.forEach(function (p) {
        var got = 0;
        sql.exec("select Source from corpus where SrcPath = ?;", [p],
                 { maxRows: 1 }, function () { got = 1; });
        hits += got;
    });
    var merged = paths.length && hits === paths.length;
    var partial = hits > 0 && !merged;
    printf("%-22s %-14s %10d %10d  %s\n", t, tbls[t].coll, rows,
           tbls[t].regDocs,
           merged ? "yes" : (partial ? "PARTIAL " + hits + "/" + paths.length
                                     : "NO"));
    if (merged) inN++;
    else { outN++; outDocs += rows; outTables.push(t); }
});

var ctotal = 0;
sql.exec("select count(*) c from corpus;", { maxRows: 1 },
         function (r) { ctotal = Number(r.c); });

printf("\ncorpus now: %d rows\n", ctotal);
printf("merged tables: %d   unmerged: %d (%d rows)\n", inN, outN, outDocs);
printf("after merge:   %d rows\n", ctotal + outDocs);
printf("\nunmerged tables:\n  %s\n", outTables.join("\n  "));
