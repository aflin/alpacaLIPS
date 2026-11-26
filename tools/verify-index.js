#!/usr/bin/env rampart
/* Is this corpus fit to publish? Exits non-zero if not.
 *
 *   rampart tools/verify-index.js [--db DIR]
 *
 * The gate before packaging 116 GiB. A corpus whose fulltext index did
 * not finish still packs, still hashes, still unpacks, and then answers
 * every search with nothing -- so the check has to be a search, not a
 * file listing.
 *
 * errMsg after every statement: texis reports an unusable index there
 * and returns zero rows rather than raising, which is exactly how a
 * broken index looks like an empty one.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");

function arg(n, d) {
    var i = process.argv.indexOf("--" + n);
    return i > 0 ? process.argv[i + 1] : d;
}
var DB = String(arg("db", "/usr3/alpacaLIPS/build/corpus"));
var sql = new Sql.init(DB, true);
var bad = 0;

function err(label) {
    if (sql.errMsg) {
        printf("  FAIL %-26s %s\n", label, String(sql.errMsg).split("\n")[0]);
        bad++;
        return true;
    }
    return false;
}

/* 1. the three indexes the app needs, by name */
var want = ["corpus_Doc_Source_ftx", "corpus_SrcPath_x", "corpus_Title_x"];
var have = {};
sql.exec("select NAME from SYSINDEX where TBNAME='corpus';", { maxRows: 40 },
         function (r) { have[String(r.NAME)] = 1; });
err("SYSINDEX");
want.forEach(function (n) {
    if (have[n]) printf("  ok   %-26s present\n", n);
    else { printf("  FAIL %-26s MISSING\n", n); bad++; }
});

/* 2. the row count, against what the ledger says was merged */
var rows = 0, ledger = 0;
sql.exec("select count(*) c from corpus;", { maxRows: 1 },
         function (r) { rows = Number(r.c); });
err("count");
sql.exec("select Rows from corpus_merged;", { maxRows: 400 },
         function (r) { ledger += Number(r.Rows) || 0; });
err("corpus_merged");
if (rows === ledger && rows > 0) {
    printf("  ok   %-26s %d rows, matching the ledger\n", "corpus", rows);
} else {
    printf("  FAIL %-26s %d rows, ledger says %d\n", "corpus", rows, ledger);
    bad++;
}

/* 3. searches, which is the only thing that proves the index works */
var searchOk = 0;
var QS = ["grafting fruit trees", "solar cooker construction",
          "yellow fever vaccination", "amitriptyline side effects",
          "biogas digester", "tar extract archive"];
QS.forEach(function (q) {
    var hits = 0, snip = "";
    var t0 = Date.now();
    sql.exec("select Title, abstract(Doc, 120, 'querybest', ?) s from corpus "
             + "where Doc likep ?;", [q, q], { maxRows: 10 }, function (r) {
        hits++;
        if (!snip) snip = String(r.s || "").replace(/\s+/g, " ");
    });
    var ms = Date.now() - t0;
    if (err(q)) return;
    if (hits > 0) {
        searchOk++;
        printf("  ok   %-26s %2d hits in %5d ms  %s\n", q.substring(0, 26),
               hits, ms, snip.substring(0, 34));
    } else {
        printf("  none %-26s no hits (not fatal on its own)\n", q);
    }
});
/* A finished index answers these; an unfinished one answers none of
   them. The threshold is what separates "a phrase stopped matching"
   from "search does not work". */
if (searchOk >= 4) {
    printf("  ok   %-26s %d of %d queries answered\n", "search", searchOk, QS.length);
} else {
    printf("  FAIL %-26s only %d of %d queries answered\n", "search",
           searchOk, QS.length);
    bad++;
}

/* 4. the text itself inflates: a blobz column that cannot be read would
      pass every check above, since those read Title and the index. */
var len = 0;
sql.exec("select Doc from corpus;", { maxRows: 1 },
         function (r) { len = String(r.Doc).length; });
err("Doc");
if (len > 100) printf("  ok   %-26s %d bytes from the blob store\n", "Doc", len);
else { printf("  FAIL %-26s read %d bytes\n", "Doc", len); bad++; }

/* 5. the tables the payload ships besides corpus */
["lips_sources", "corpus_merged", "lips_licenses"].forEach(function (t) {
    var c = 0;
    try {
        sql.exec("select count(*) c from " + t + ";", { maxRows: 1 },
                 function (r) { c = Number(r.c); });
        if (c > 0) printf("  ok   %-26s %d rows\n", t, c);
        else { printf("  FAIL %-26s empty\n", t); bad++; }
    } catch (e) {
        printf("  FAIL %-26s %s\n", t, String(e.message).split("\n")[0]);
        bad++;
    }
});

printf("\n  %s\n", bad === 0 ? "VERIFIED: fit to package"
                             : "NOT FIT TO PACKAGE: " + bad + " failures");
process.exit(bad === 0 ? 0 : 1);
