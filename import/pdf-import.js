#!/usr/bin/env rampart
/* Import a nautiluszim PDF collection into the corpus.
 *
 *   rampart pdf-import.js --db DIR --dir STAGEDIR
 *                         [--limit N] [--index] [--no-ocr]
 *                         [--no-registry] [--again]
 *
 * STAGEDIR is what extract/zim2pdf.py produced: the PDFs plus a
 * manifest.json carrying the archive metadata and, from the archive's
 * own database.js, a real title, description and author per file.
 *
 * Schema is the same as the HTML path (DESIGN.md §19 and §21): one row
 * per document, Site naming the collection topic, SrcPath the ZIM entry
 * path so a viewer can open the original PDF.
 *
 * One row per PDF, not per page. These are whole books -- the largest
 * is ~1 MB of text -- and excerpt()/abstract() exist to locate the
 * matching passage inside a long document, so splitting by page would
 * only destroy context.
 *
 * The collections OVERLAP: post-disaster re-ships copies from every
 * other one, so of 155 PDFs only 107 are distinct documents and 23% of
 * the bytes are redundant. Storing both copies would also hand a
 * search the same book twice, so a document already in the table is
 * skipped.
 *
 * Identity is a SHA-256 of the PDF bytes, kept in a Sha column.
 * Nothing cheaper works: the collections renumber their files, so the
 * same book is "files/Knots (1).pdf" in one archive and something else
 * in another, and each archive's catalogue gives it a DIFFERENT title
 * -- "Complete Guide to Home Canning" in food-preparation against
 * "GUIDE06_HomeCan_rev0715" in post-disaster -- which also shifts
 * Nbytes, because the title leads the stored document.
 *
 * Those differing titles are why the specific collections are imported
 * before the catch-all bundle: the surviving row then keeps both the
 * more informative Site and the better title.
 */
rampart.globalize(rampart.utils);
var Sql     = require("rampart-sql");
var crypto  = require("rampart-crypto");
var totext  = require("rampart-totext");
var cleaner = require("./pdf-clean.js");
var fam     = require("./families.js");

function arg(n, d) {
    var a = process.argv, i = a.indexOf("--" + n);
    if (i < 0) return d;
    var v = a[i + 1];
    return (v === undefined || /^--/.test(v)) ? true : v;
}
var DB    = arg("db", null);
var DIR   = arg("dir", null);
var LIMIT = Number(arg("limit", 0)) || 0;
var INDEX = !!arg("index", false);
var NOOCR = !!arg("no-ocr", false);
var NOREG = !!arg("no-registry", false);

if (!DB || !DIR) {
    printf("usage: pdf-import.js --db DIR --dir STAGEDIR\n" +
           "       [--limit N] [--index] [--no-ocr] [--no-registry] [--again]\n");
    process.exit(1);
}
DB = String(DB); DIR = String(DIR);

var man = JSON.parse(readFile(DIR + "/manifest.json", { returnString: true }));
var ZIM  = String(man.zim || "");
var info = fam.classifyPdf(ZIM, man.zimScraper);
if (!info) {
    printf("%s is not a PDF-family archive\n", ZIM);
    process.exit(1);
}
var TBL  = String(arg("table", info.table));
var SITE = String(arg("site", info.site || ""));
var ASOF = String(man.zimDate || "");

printf("%s\n  family %s  table %s  site %s  asof %s  %d PDFs",
       man.zimTitle || ZIM, info.family, TBL, SITE, ASOF, man.pdfs.length);
printf("  (%d catalogued)\n", man.catalogue || 0);

/* UTF-8 bytes, the ruler chunkembed() spans index (§21). */
function utf8Bytes(s) {
    var n = rampart.utils.stringToBuffer(s).byteLength, pairs = 0;
    for (var i = 0; i < s.length - 1; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            var d = s.charCodeAt(i + 1);
            if (d >= 0xDC00 && d <= 0xDFFF) { pairs++; i++; }
        }
    }
    return n - 2 * pairs;
}

/* OCR reader, built only if a PDF turns out to have no text layer:
   loading the models costs nothing until then. Scanned pages come back
   noticeably noisier than born-digital text ("a rurn of the cord"), so
   rows that needed it are flagged in the registry. */
var reader = null, ocrFailed = false;
function ocrReader() {
    if (reader || ocrFailed) return reader;
    try {
        var models = require("rampart-models");
        reader = require("rampart-ocr").init(models.ocrGet("ppocr-v5"));
    } catch (e) {
        printf("  OCR unavailable: %s\n", e.message.split("\n")[0]);
        ocrFailed = true;
    }
    return reader;
}

if (!stat(DB)) mkdir(DB);
var sql = new Sql.init(DB, true);

function tableExists(name) {
    var found = false;
    sql.exec("select NAME from SYSTABLES where NAME=?;", [name],
             { maxRows: 1 }, function () { found = true; });
    return found;
}

if (!NOREG && tableExists("lips_sources") && !arg("again", false)) {
    var already = null;
    sql.exec("select Docs, Imported from lips_sources where Zim = ?;",
             [ZIM], { maxRows: 1 }, function (r) { already = r; });
    if (already) {
        printf("  already imported: %d rows on %s -- skipping\n",
               already.Docs, already.Imported);
        process.exit(0);
    }
}

if (!tableExists(TBL)) {
    sql.exec("create table " + TBL + " (" +
             "Id counter, Site varchar(64), SrcPath varchar(512), " +
             "Title varchar(256), Doc varchar(" +
             (fam.PDF_FAMILIES[info.family].docHint || 65536) +
             "), Nbytes int, Sha varchar(64));");
    printf("  created table %s\n", TBL);
}
if (!NOREG && !tableExists("lips_sources")) {
    sql.exec("create table lips_sources (" +
             "Collection varchar(32), TableName varchar(64), " +
             "Site varchar(64), Zim varchar(160), Asof varchar(16), " +
             "Scraper varchar(40), Family varchar(32), " +
             "Docs int, Nbytes double, Skipped int, Failed int, " +
             "ZimBytes double, Include varchar(256), " +
             "Exclude varchar(256), Imported varchar(24));");
    printf("  created table lips_sources\n");
}

var ins = "insert into " + TBL +
          " (Id, Site, SrcPath, Title, Doc, Nbytes, Sha) values " +
          "(counter, ?, ?, ?, ?, ?, ?);";

var n = 0, failed = 0, skipped = 0, ocred = 0, nbytes = 0, deduped = 0;
var t0 = Date.now();

man.pdfs.forEach(function (p) {
    if (LIMIT && n >= LIMIT) return;
    var file = DIR + "/" + p.file;
    var raw = null, usedOcr = false;

    /* identity first: skip a document another collection already has */
    var sha = String(crypto.sha256(readFile(file), { hex: true }));
    var dupOf = null;
    sql.exec("select Site from " + TBL + " where Sha = ?;", [sha],
             { maxRows: 1 }, function (r) { dupOf = String(r.Site); });
    if (dupOf !== null) {
        deduped++;
        printf("  %-9s dup of %-16s %s\n", p.file, dupOf,
               String(p.title).substring(0, 40));
        return;
    }

    var why = null;
    try {
        raw = String(totext.convertFile(file));
        /* A scan does not always raise: "More Jerky" came back as
           "\f\f\f\f" -- four page breaks and no error -- so a
           whitespace-only result has to route to OCR as well, or the
           document is silently lost. OCR reads 7,764 characters from
           it. */
        if (!raw.replace(/\s+/g, "").length) {
            raw = null;
            why = "no text layer (whitespace only)";
        }
    } catch (e) {
        why = e.message.split("\n")[0];
        raw = null;
    }

    if (raw === null && !NOOCR && /no text layer|images only|OCR/i.test(why)) {
        var rd = ocrReader();
        if (rd) {
            try {
                var r = totext.convertFile(file, { details: true, ocr: rd });
                raw = String(r.text === undefined ? r : r.text);
                usedOcr = true;
            } catch (e2) {
                printf("  OCR failed on %s: %s\n", p.file,
                       e2.message.split("\n")[0]);
            }
        }
    }
    if (raw === null) {
        printf("  skipped %s (%s): %s\n", p.file,
               String(p.title).substring(0, 40), String(why).substring(0, 70));
        failed++;
        return;
    }

    var c = cleaner.clean(raw);
    if (!c.text.replace(/\s+/g, "").length) { skipped++; return; }

    /* The catalogue's title, description and author lead the document:
       they are hand-written, unlike anything in the PDF, and so are the
       highest-value lines for keyword search. Plain lines, no "# ":
       the stored corpus carries no markdown (see kiwix-import.js). */
    var title = String(p.title || p.file).trim();
    var head = title + "\n\n";          /* plain: the corpus is text only */
    if (p.desc && String(p.desc).trim().length)
        head += String(p.desc).trim() + "\n\n";
    if (p.author && String(p.author).trim().length)
        head += "Author: " + String(p.author).trim() + "\n\n";
    var doc = (head + c.text).replace(/\s+$/, "");

    var nb = utf8Bytes(doc);
    try {
        sql.exec(ins, [SITE, String(p.path || p.file), title, doc, nb, sha]);
    } catch (e) { failed++; return; }
    n++; nbytes += nb; if (usedOcr) ocred++;

    printf("  %-9s %6d pages? %8d B  %s%s\n", p.file, c.stats.pages, nb,
           title.substring(0, 44), usedOcr ? "  [OCR]" : "");
});

printf("  %d rows, %.2f MB text, %d via OCR, %d duplicate, %d skipped, " +
       "%d failed, %.0f s\n", n, nbytes / 1048576, ocred, deduped, skipped,
       failed, (Date.now() - t0) / 1000);

if (!NOREG) {
    sql.exec("insert into lips_sources (Collection, TableName, Site, Zim, " +
             "Asof, Scraper, Family, Docs, Nbytes, Skipped, Failed, " +
             "ZimBytes, Include, Exclude, Imported) " +
             "values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);",
             [info.collection, TBL, SITE, ZIM, ASOF,
              String(man.zimScraper || ""), info.family,
              n, nbytes, skipped + deduped, failed,
              Number(man.zim_bytes || 0),
              "pdf:files/*.pdf" + (ocred ? " ocr:" + ocred : ""),
              "", new Date().toISOString()]);
}

if (INDEX) {
    var have = {};
    sql.exec("select FIELDS from SYSINDEX where TBNAME = ?;", [TBL],
             { maxRows: 50 }, function (r) { have[String(r.FIELDS)] = 1; });
    [ ["Doc", "ftx", "fulltext "], ["SrcPath", "src", ""],
      ["Title", "ttl", ""], ["Sha", "sha", ""] ].forEach(function (w) {
        if (have[w[0]]) return;
        var t1 = Date.now();
        sql.exec("create " + w[2] + "index " + TBL + "_" + w[1] +
                 " on " + TBL + "(" + w[0] + ");");
        printf("  index %-9s %.0f s\n", w[0], (Date.now() - t1) / 1000);
    });
}
