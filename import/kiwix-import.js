#!/usr/bin/env rampart
/* Import staged Kiwix text into a per-collection table.
 *
 *   rampart kiwix-import.js --db DIR --src FILE.jsonl
 *                           [--table NAME] [--site NAME] [--limit N]
 *                           [--index] [--no-registry] [--again]
 *
 * Input is the JSONL produced by extract/zim2jsonl.py, one
 * {"path":…,"title":…,"html":…} per line, beside its .meta.json
 * sidecar. The sidecar's zimScraper names the template family and its
 * zimDate becomes Asof, both taken from the archive rather than from
 * its filename; the table, collection and site come from the filename,
 * which is where site identity actually lives.
 *
 * Schema is DESIGN.md §19. Per-archive facts -- collection, asof, zim
 * name, counts -- live once in lips_sources, not repeated on every row.
 * Site stays on the row because stackexchange is 161 archives in one
 * table and a query needs to filter and attribute by site.
 *
 * Extraction follows §18: tables, code and headings kept; emphasis,
 * blockquote and inline links dropped (citations point at the Kiwix
 * page, so inline links are redundant). Measured at 1.21x plain text,
 * where keeping inline links would cost 1.85x.
 *
 * PARAGRAPH STRUCTURE IS LOAD-BEARING. chunkembed() splits on paragraph
 * boundaries first and only then on the model window, so blank-line
 * separation between blocks determines chunk quality later -- even
 * though this first pass stores no vectors. Getting it wrong means
 * re-extracting. t-chunks.js verifies it.
 */
rampart.globalize(rampart.utils);
var Sql  = require("rampart-sql");
var html = require("rampart-html");
var fam  = require("./families.js");

function arg(n, d) {
    var a = process.argv, i = a.indexOf("--" + n);
    if (i < 0) return d;
    var v = a[i + 1];
    return (v === undefined || /^--/.test(v)) ? true : v;
}
var DB     = arg("db",  null);
var SRC    = arg("src", null);
var LIMIT  = Number(arg("limit", 0)) || 0;
var INDEX  = !!arg("index", false);
var NOREG  = !!arg("no-registry", false);

if (!DB || !SRC) {
    printf("usage: kiwix-import.js --db DIR --src FILE.jsonl\n" +
           "       [--table NAME] [--site NAME] [--limit N] [--index]\n" +
           "       [--no-registry] [--again]\n");
    process.exit(1);
}
DB = String(DB); SRC = String(SRC);

/* --- archive identity, from the sidecar then the filename ----------- */

var meta = {};
var sidecar = SRC + ".meta.json";
if (stat(sidecar)) {
    try { meta = JSON.parse(readFile(sidecar, { returnString: true })); }
    catch (e) { printf("warning: unreadable sidecar %s\n", sidecar); }
} else {
    printf("warning: no sidecar %s; Asof and family fall back to the name\n",
           sidecar);
}

var ZIM  = String(meta.zim || SRC.replace(/^.*\//, "").replace(/\..*$/, "") + ".zim");
var info = fam.classify(ZIM, meta.zimScraper);
if (!info) {
    printf("no family for %s: nothing to import\n", ZIM);
    process.exit(1);
}
var SEL = fam.FAMILIES[info.family];
if (!SEL) {
    printf("no selectors for family %s (%s)\n", info.family, ZIM);
    process.exit(1);
}

var TBL  = String(arg("table", info.table));
var SITE = String(arg("site", info.site || ""));
var ASOF = String(meta.zimDate || "");
var PFX  = SEL.pathPrefix || "";
var PEX  = SEL.pathExclude || [];

printf("%s\n  family %s  collection %s  table %s  site %s  asof %s\n",
       ZIM, info.family, info.collection, TBL, SITE || "(none)",
       ASOF || "(unknown)");
if (PFX) printf("  keeping only paths under %s\n", PFX);
if (PEX.length) printf("  excluding paths matching %s\n", PEX.join(", "));

/* --- extraction ------------------------------------------------------ */

/* TEXT ONLY. The markdown existed so the stored text could be read
   offline with formatting and links; the Kiwix renderer now serves the
   original page (DESIGN.md §17.1, §18) and citations point at it, so
   the stored text only has to serve keyword search and the model
   reading a result. No formatting survives that trip.

   toText(), not toMarkdown() with the options off: with every option
   off toMarkdown STILL emits list markers -- measured on 150 Wikipedia
   articles, 113 carried "* item" bullets and 139 carried "1. item"
   ordered lists. Only toText is actually free of markdown syntax.

   The cost is paragraph granularity, since toText puts blank lines
   inside a table where toMarkdown kept one block: 7,131 blocks against
   4,015 over those articles, and 3,754 against 1,574 under 40
   characters. chunkembed() splits on blank lines first but packs
   adjacent small blocks up to the model window, so these merge rather
   than becoming tiny chunks -- import/t-chunks.js is what verifies
   that on the real output. */
var TXT = { concatenate: true };

/* UTF-8 bytes, the unit chunkembed() spans index. Neither JS .length
   (UTF-16 units) nor SQL length() (codepoints) is that ruler. A string
   built from a surrogate-pair source literal converts to CESU-8, six
   bytes for one astral character, so each pair over-counts by two;
   strings from C (toMarkdown, SQL reads) carry whole codepoints and
   have no pairs to correct. t-astral.js checks both forms. */
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

/* Scope to the content container, then drop the known furniture.
   Selectors are rampart-html primitives; findAttr takes ONE "k=v"
   string -- two arguments silently match every element that merely has
   the attribute. */
function find(node, s) {
    if (s.by === "class") return node.findClass(s.value);
    if (s.by === "tag")   return node.findTag(s.value);
    if (s.by === "attr")  return node.findAttr(s.value);
    throw new Error("unknown selector kind " + s.by);
}

/* A page-level veto, for generators whose navigation shares the content
   container so no positive selector can tell them apart. gutenberg2zim
   puts its template skin class on every cover, author and shelf page and
   on no book body, so one test drops all four chrome kinds; returning
   null counts them under "no content container" like any other non-page.
   Optional: families without rejectClass behave exactly as before. */
function extract(rawHtml) {
    var doc = html.newDocument(rawHtml);
    if (SEL.rejectClass) {
        var veto = doc.findClass(SEL.rejectClass);
        if (veto && veto.length) return null;
    }
    var scope = null;
    for (var i = 0; i < SEL.include.length && !scope; i++) {
        var hit = find(doc, SEL.include[i]);
        if (hit && hit.length) scope = hit;
    }
    if (!scope) return null;          /* not a content page */
    SEL.exclude.forEach(function (s) {
        var junk = find(scope, s);
        if (junk && junk.length) junk.detach();
    });
    return String(scope.toText(TXT));
}

/* --- tables ---------------------------------------------------------- */

if (!stat(DB)) mkdir(DB);
var sql = new Sql.init(DB, true);

function tableExists(name) {
    var found = false;
    sql.exec("select NAME from SYSTABLES where NAME=?;", [name],
             { maxRows: 1 }, function () { found = true; });
    return found;
}

/* The selectors used, recorded so a refresh that produces different
   text can be told apart from a selector change. */
function selText(list) {
    return (list || []).map(function (s) { return s.by + ":" + s.value; })
                       .join(" ") +
           (PFX ? " path:" + PFX : "") +
           (PEX.length ? " !path:" + PEX.join(",") : "");
}

if (!tableExists(TBL)) {
    /* varchar(N) is a per-family hint from the measured mean, not a
       limit: a 303,934-byte document stores fine against 16384. */
    sql.exec("create table " + TBL + " (" +
             "Id counter, Site varchar(64), SrcPath varchar(512), " +
             "Title varchar(256), Doc varchar(" + (SEL.docHint || 16384) +
             "), Nbytes int);");
    printf("  created table %s (Doc hint %d)\n", TBL, SEL.docHint || 16384);
}

/* One row per imported archive. Everything uniform across an archive
   lives here instead of on millions of rows. */
if (!NOREG && !tableExists("lips_sources")) {
    sql.exec("create table lips_sources (" +
             "Collection varchar(32), TableName varchar(64), " +
             "Site varchar(64), Zim varchar(160), Asof varchar(16), " +
             "Scraper varchar(40), Family varchar(32), " +
             /* double, not int: a table's byte total passes 2^31 well
                before Stack Overflow's 84 GB of text. */
             "Docs int, Nbytes double, Skipped int, Failed int, " +
             "ZimBytes double, Include varchar(256), " +
             "Exclude varchar(256), Imported varchar(24));");
    printf("  created table lips_sources\n");
}

/* Already imported? A full-corpus run takes days and will be
   interrupted; re-running an archive would silently double its rows,
   since SrcPath is unique per archive but nothing stops a second pass.
   The registry is the record of what is in, so consult it and stop.
   --again overrides, for a deliberate re-import after a delete. */
if (!NOREG && tableExists("lips_sources") && !arg("again", false)) {
    var already = null;
    sql.exec("select Docs, Imported from lips_sources where Zim = ?;",
             [ZIM], { maxRows: 1 }, function (r) { already = r; });
    if (already) {
        printf("  already imported: %d rows on %s -- skipping\n" +
               "  (use --again after deleting those rows to redo it)\n",
               already.Docs, already.Imported);
        process.exit(0);
    }
}

var ins = "insert into " + TBL +
          " (Id, Site, SrcPath, Title, Doc, Nbytes) values " +
          "(counter, ?, ?, ?, ?, ?);";

/* --- the pass -------------------------------------------------------- */

var size = stat(SRC).size, STEP = 16 * 1024 * 1024, pos = 0, tail = "";
var n = 0, skipped = 0, failed = 0, offPrefix = 0, noScope = 0;
var nbytes = 0, t0 = Date.now(), last = t0;

function one(line) {
    if (!line.length || (LIMIT && n >= LIMIT)) return;
    var rec;
    try { rec = JSON.parse(line); } catch (e) { failed++; return; }
    if (!rec.html) { skipped++; return; }

    var path = String(rec.path || "");
    if (PFX && path.substring(0, PFX.length) !== PFX) { offPrefix++; return; }
    for (var p = 0; p < PEX.length; p++) {
        if (PEX[p].test(path)) { offPrefix++; return; }
    }

    var txt;
    try { txt = extract(rec.html); } catch (e) { failed++; return; }
    if (txt === null) { noScope++; return; }
    /* /\S/.test stops at the first non-space; replacing /\s+/g built a
       stripped copy of a multi-megabyte string just to measure it. */
    if (!/\S/.test(txt)) { skipped++; return; }

    /* Normalise whitespace LINE BY LINE, never with a regex over the
       whole document. toText leaves lines of only spaces inside the
       body -- 13 of 36 sampled Wikipedia articles had them -- and they
       act as paragraph breaks without being blank, which makes the
       block layout depend on invisible characters where chunkembed()
       splits.
       
       The first version did this with .replace(/[ \t]+$/gm, ""). Under
       the m flag the engine must try the pattern at every position in
       the string, and on big rows that exceeds duktape's regexp step
       limit: it threw RangeError and aborted the whole archive, losing
       codegolf (18 KB mean rows) and Stack Overflow. One pass over the
       lines does the same work in linear time with no regex longer
       than a single line. */
    var L = txt.replace(/\r/g, "").split("\n");
    var keep = [], blanks = 0;
    for (var li = 0; li < L.length; li++) {
        var ln = L[li], e = ln.length;
        while (e > 0) {
            var cc = ln.charCodeAt(e - 1);
            if (cc === 32 || cc === 9) e--; else break;
        }
        if (e !== ln.length) ln = ln.substring(0, e);
        if (!ln.length) {
            if (++blanks > 1) continue;      /* at most one blank line */
        } else blanks = 0;
        keep.push(ln);
    }
    while (keep.length && !keep[0].length) keep.shift();
    while (keep.length && !keep[keep.length - 1].length) keep.pop();
    txt = keep.join("\n").replace(/^[ \t]+/, "");   /* anchored, cheap */

    /* The page <h1> sits outside the content container that scoping
       keeps (mw-parser-output / #mainbar), so the title is absent from
       the body. Prepend it as its own first block: it is the
       highest-value line for keyword search. Plain, with no "# ",
       because the stored text carries no markdown. */
    var ttl = String(rec.title || "").trim();
    if (ttl.length) txt = ttl + "\n\n" + txt;

    var nb = utf8Bytes(txt);
    try {
        sql.exec(ins, [SITE, path, ttl, txt, nb]);
    } catch (e) { failed++; return; }
    n++; nbytes += nb;

    if (Date.now() - last > 20000) {
        last = Date.now();
        printf("  %d rows, %.1f MB, %.0f rows/s\n", n, nbytes / 1048576,
               n / ((last - t0) / 1000));
    }
}

while (pos < size && (!LIMIT || n < LIMIT)) {
    tail += readFile(SRC, { offset: pos, length: Math.min(STEP, size - pos),
                            returnString: true });
    pos += STEP;
    var L = tail.split("\n");
    tail = L.pop();
    for (var i = 0; i < L.length; i++) one(L[i]);
}
if (tail.length) one(tail);

var secs = (Date.now() - t0) / 1000;
printf("  %d rows, %.1f MB text, %.0f s\n", n, nbytes / 1048576, secs);
printf("  dropped: %d off-prefix, %d no content container, %d empty, %d failed\n",
       offPrefix, noScope, skipped, failed);

if (!NOREG) {
    sql.exec("insert into lips_sources (Collection, TableName, Site, Zim, " +
             "Asof, Scraper, Family, Docs, Nbytes, Skipped, Failed, " +
             "ZimBytes, Include, Exclude, Imported) " +
             "values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);",
             [info.collection, TBL, SITE, ZIM, ASOF,
              String(meta.zimScraper || ""), info.family,
              n, nbytes, skipped + noScope + offPrefix, failed,
              Number(meta.zim_bytes || 0),
              selText(SEL.include) +
                (SEL.rejectClass ? " !class:" + SEL.rejectClass : ""),
              selText(SEL.exclude),
              new Date().toISOString()]);
}

/* --index is for a one-archive table. A table fed by many archives
   (stackexchange takes 161) should be loaded first and indexed once:
   use import/mkindex.js instead, since maintaining the index per INSERT
   is the wrong order for a bulk load. Existing indexes are skipped, so
   passing --index twice is harmless rather than an error. */
if (INDEX) {
    printf("  building indexes...\n");
    var have = {};
    sql.exec("select FIELDS from SYSINDEX where TBNAME = ?;", [TBL],
             { maxRows: 50 }, function (r) { have[String(r.FIELDS)] = 1; });
    [ ["Doc", "ftx", "fulltext "], ["SrcPath", "src", ""],
      /* Title is indexed deliberately: the existing en Wikipedia build
         indexes Doc and Id but not Title, which turned a 400-title
         lookup into 400 full scans of a 102 GB table. */
      ["Title", "ttl", ""] ].forEach(function (w) {
        if (have[w[0]]) { printf("    %-9s already indexed\n", w[0]); return; }
        var t1 = Date.now();
        sql.exec("create " + w[2] + "index " + TBL + "_" + w[1] +
                 " on " + TBL + "(" + w[0] + ");");
        printf("    %-9s %.0f s\n", w[0], (Date.now() - t1) / 1000);
    });
}
