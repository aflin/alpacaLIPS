/* The alpacaLIPS corpus as a tool set, in OpenAI function shape.
 *
 * The MCP layer converts these to MCP shape and dispatches; nothing about
 * retrieval is decided there. Modelled on rampart-tk/lib/tools.js so the
 * two stay comparable.
 *
 * PASSAGES ARE VERBATIM. excerpt() needs a chunkembed vector column and
 * this corpus has none, so passages are located with
 * abstract(..., 'querysingleoffset', ...) -- which returns a byte offset --
 * and then sliced out of Doc directly. abstract()'s own rendering collapses
 * whitespace and is not a substring of the text; a slice is.
 *
 * A document is addressed as "source:srcpath". SrcPath alone is not unique
 * across collections, and Id has no index.
 */
rampart.globalize(rampart.utils);

/* Relocatable root. process.scriptPath is the directory of the script
 * the server was started with -- <root>/web -- and the server sets it
 * for every module it loads, apps and libs alike, so each file works
 * the tree out for itself and an unpacked tarball runs wherever it
 * lands. Nothing comes from the environment: assignments made in
 * server_conf.js do not reach app modules, and on macOS the launchd
 * plist drops all but HOME and PATH. The database directory comes from
 * confData, a plain global the generated server_conf.js declares, so
 * the data can live on a different disk from the code. */
var WEB = String(process.scriptPath);
var LIPS = WEB.replace(/[\/]web[\/]?$/, "");
var DB = ((typeof confData !== "undefined" && confData) ? String(confData)
                                                     : LIPS + "/build") + "/corpus";

/* Public base for citation links. EMPTY BY DEFAULT: links are then built
   from the host the client actually connected with, which is right on any
   machine this is unpacked on. A baked-in host is wrong everywhere except
   the one machine it names -- it shipped as moe.flin.org once and pointed
   every citation on every install back at that host. setup.sh asks for a
   public name and writes it as confBase, for when the answers are read
   somewhere else and loopback would be useless to the reader. */
/* LIKEP returns only its top `likepRows` documents by rank (texis default
   100). Raised because everything that reports on a result set -- alsoIn,
   lips_survey -- can only see inside that window, and at 100 a collection
   holding most of the best matches can be invisible.
   Measured on this corpus: the top 10 is IDENTICAL at 100/200/300/500/
   1000, so this changes coverage and not ranking. Warm latency was flat
   (e.g. "error" 341 -> 342 ms) while collections discovered rose 4 -> 7;
   cold cost was not measured, and an earlier probe using SQL `group by`
   showed a real penalty, so do not assume it is free. */
var LIKEP_ROWS = 500;

/* confBase comes from the header setup.sh writes in server_conf.js:
   a global, so every app module sees it without an environment. */
var BASE_URL = (typeof confBase !== "undefined" && confBase) ? String(confBase) : "";
BASE_URL = BASE_URL.replace(/\/+$/, "");

/* ---------- flavor detection ----------
 * Flavor 1 is the table and its index: citations link to the stored text
 * at /apps/doc. Flavor 2 adds the original archives, so a citation can
 * ALSO link to the page as it was published. The switch is the presence of
 * the zim directory with archives in it -- no flag to forget, and a
 * deployment that lacks the archives degrades to flavor 1 rather than
 * emitting links to a server that is not there.
 *
 * Checked once per thread at load. The directory does not appear and
 * disappear mid-run, and a stat per search would be wasted work.
 */
var ZIM_DIR  = (typeof confZim !== "undefined" && confZim)
               ? String(confZim) : LIPS + "/zim";
/* Empty for the same reason, and because the archives are proxied on the
   web server's own port: "/content/<book>/<path>" resolves against
   whatever host the client used. confZimBase is for a kiwix that lives
   on a different host. */
var ZIM_BASE = (typeof confZimBase !== "undefined" && confZimBase)
               ? String(confZimBase) : "";
ZIM_BASE = ZIM_BASE.replace(/\/+$/, "");

var FLAVOR2 = false, ZIM_COUNT = 0;
try {
    rampart.utils.readdir(ZIM_DIR).forEach(function (f) {
        if (f.slice(-4) === ".zim") ZIM_COUNT++;
    });
    FLAVOR2 = ZIM_COUNT > 0;
} catch (e) { FLAVOR2 = false; }

/* Which archive each collection came from. kiwix-serve answers at
 * /content/<ZIM filename without .zim> -- verified for all 171 archives
 * with `tools/zim-serve.sh verify`. It is NOT the `name` attribute in
 * library.xml, which differs (name "wikiquote_en_all" for the file
 * wikiquote_en_all_maxi_2026-10.zim); a books.json mapping once existed
 * to reconcile the two and was deleted as redundant. */
/* zimOf's map is per handle for the same reason as corpusRows. */

/* Keyed by BOTH TableName+Site and Collection+Site, because a corpus row's
   Source is sometimes one and sometimes the other. For every collection
   merged before 2026-11-08 the two coincide (Source wikipedia_en is also
   the table name). Gutenberg's 38 LCC slices were merged under a single
   Source of 'gutenberg' with the slice on Site, mirroring how
   stackexchange holds 161 archives -- so they resolve only by Collection,
   while wikibooks_en resolves only by TableName. Both keys are needed;
   neither alone covers the corpus.
   Collection+Site also fixes the mixed dump dates for free: lcc-c and
   lcc-d exist only at 2025-12 while the rest are 2026-03, and the Zim
   name comes straight from the registry row rather than being built. */
function zimOf(sql, source, site) {
    if (!sql.__zimOf) {
        var ZIM_OF = sql.__zimOf = {};
        try {
            sql.exec("select TableName, Collection, Site, Zim " +
                     "from lips_sources;",
                     { maxRows: 2000 }, function (r) {
                var s = String(r.Site || ""), z = String(r.Zim);
                ZIM_OF[String(r.TableName) + "\u0000" + s] = z;
                /* TableName wins on a clash: it is the more specific key
                   and is what every pre-Gutenberg row uses. */
                var ck = String(r.Collection) + "\u0000" + s;
                if (!ZIM_OF[ck]) ZIM_OF[ck] = z;
            });
        } catch (e) {}
    }
    var ZIM_OF = sql.__zimOf;
    return ZIM_OF[source + "\u0000" + (site || "")] ||
           ZIM_OF[source + "\u0000"] || null;
}

function bookName(zim) {
    return String(zim).replace(/\.zim$/, "");
}

/* Read once per process rather than hardcoded: the literal that used to
   sit here was 48,033,082 and went stale the moment 1.9M rows were
   merged, which made every "no document out of N" statement to the model
   wrong. The constant is only a fallback for a failed count. */
var CORPUS_ROWS_FALLBACK = 49941659;
var CORPUS_ROWS_CACHE = null;
var SOURCE_LIST_CACHE = null;
/* ---------- the news table -------------------------------------------
 * A separate database directory, so the 276 GB corpus and its index are
 * never touched by a daily refresh: replacing build/news replaces the
 * news. It carries its own catalog, which is what makes that possible.
 *
 * Opened lazily and held per context: each server thread re-initialises
 * its handles, so a module-level handle is per-thread by construction.
 */
var NEWS_DB = ((typeof confData !== "undefined" && confData) ? String(confData)
                                                             : LIPS + "/build") + "/news";
/* This module is handed the corpus handle by its caller and otherwise
   requires nothing; the news database is its own, so it opens that one
   itself. */
/* Handles come from lib/db.js, which reopens one when the files behind
   it are replaced; see the measurements there. The news table is
   replaced daily, which is what made this necessary. */
var db = require(WEB + "/lib/db.js");
var NEWS_FILES = ["news.tbl", "wikipedia_en_news.tbl"];
var newsMeta_ = null, newsWhy_ = "";

function newsSql() {
    var s = db.open(NEWS_DB, NEWS_FILES, function (h) {
        /* Per new handle: the index was built with no noiselist so short
           tokens stay searchable, and the query side has to agree or the
           term never reaches the index. */
        try { h.set({ noiseList: [] }); h.set({ qMinWordLen: 1 }); } catch (e) {}
        /* The coverage window moves with the data. */
        newsMeta_ = null;
    });
    newsWhy_ = s ? "" : ("no usable news table at " + NEWS_DB);
    return s;
}

/* Caches derived from the CORPUS, cleared when it is replaced: a stale
   collection list or row count is quoted to the model as fact. */
function corpusReopened() {
    ZIM_OF = null;
    CORPUS_ROWS_CACHE = null;
    SOURCE_LIST_CACHE = null;
}

/* What the news table claims to cover. Stated on every result: a reader
   whose copy is a month old must be told where it stops rather than be
   answered from whatever the newest row happens to be. */
function newsMeta() {
    if (newsMeta_) return newsMeta_;
    var s = newsSql();
    if (!s) return null;
    var m = {};
    try {
        s.exec("select Prop, Val from news_meta;", { maxRows: 40 },
               function (r) { m[String(r.Prop)] = String(r.Val); });
    } catch (e) { return null; }
    newsMeta_ = { from: m.firstItem || m.windowStart || "",
                  to: m.lastItem || m.windowEnd || "",
                  items: Number(m.items) || 0,
                  days: Number(m.days) || 0,
                  built: m.built || "",
                  license: m.license || "CC BY-SA 4.0, Wikipedia" };
    return newsMeta_;
}

/* The 308 event articles live in the news database, under paths of the
 * form "A/<Title>.html" as the ZIM carried them. Their ids are
 * "news:<Title>", which keeps the source:path shape every other id has
 * and routes a lookup to the right database.
 *
 * This is what was missing: the articles were imported and indexed but
 * nothing exposed them, so a model could cite the outlets an item named
 * and the older corpus article, but never the page written FOR the
 * event. Measured on a real answer: 3 corpus documents, 12 outlet urls,
 * 0 of the 308.
 */
var NEWS_SOURCE = "news";

function newsDocPath(title) { return "A/" + String(title) + ".html"; }

function newsHas(titles) {
    var s = newsSql();
    if (!s || !titles.length) return {};
    var found = {};
    titles.forEach(function (t) {
        if (found[t] !== undefined) return;
        var hit = null;
        try {
            s.exec("select Title, Nbytes from wikipedia_en_news where SrcPath = ?;",
                   [newsDocPath(t)], { maxRows: 1 }, function (r) {
                hit = { title: String(r.Title), bytes: Number(r.Nbytes) };
            });
        } catch (e) {}
        if (hit) found[t] = hit;
    });
    return found;
}

/* Search the event articles. They sit in the other database with their
 * own index, so they cannot share a ranking with the corpus -- ranks are
 * per-index and comparing them would invent an order. They are returned
 * as their own list, labelled, rather than merged into corpus hits.
 *
 * This is the path that mattered: only 8% of items link an event page in
 * their body, so without search the other 92% of those 308 pages were
 * unreachable. A real answer about the Middle East missed "September
 * 2026 United States strikes on Iran" for exactly this reason.
 */
function newsArticles(q, n) {
    var s = newsSql();
    if (!s || !q) return [];
    var out = [];
    try {
        s.exec("select Title, SrcPath, Nbytes, " +
               "abstract(Doc, 260, 'querybest', ?) snip " +
               "from wikipedia_en_news where Doc likep ?;",
               [q, q], { maxRows: n }, function (r) {
            var path = String(r.SrcPath).replace(/^A\//, "").replace(/\.html$/, "");
            if (/^Portal_Current_events/.test(path)) return;   /* the month pages */
            out.push({ id: makeId(NEWS_SOURCE, path), title: String(r.Title),
                       bytes: Number(r.Nbytes), snippet: String(r.snip || ""),
                       writtenFor: "an event inside the news window" });
        });
    } catch (e) {}
    return out;
}

var NEWS_SECTIONS = ["Armed conflicts and attacks", "Disasters and accidents",
                     "Politics and elections", "Law and crime",
                     "International relations", "Business and economy",
                     "Science and technology", "Health and environment",
                     "Sports", "Arts and culture"];

function newsRows(s, q, since, until, section, n) {
    var rows = [], where = [], args = [];
    if (q)       { where.push("Doc likep ?");  args.push(q); }
    if (since)   { where.push("Date >= ?");    args.push(since); }
    if (until)   { where.push("Date <= ?");    args.push(until); }
    if (section) { where.push("Section = ?");  args.push(section); }
    var sql = "select Date, Section, Topic, Doc, Sources, Links from news" +
              (where.length ? " where " + where.join(" and ") : "") + ";";
    /* A keyword query keeps the engine's own order, which is by
       relevance; re-sorting those by date put Ebola and a Spanish strike
       above the Strait of Hormuz items for a "Strait of Hormuz" query.
       Only a bare date-range listing is sorted, and in JS: ORDER BY on a
       likep result set is the one thing measured to cost an order of
       magnitude on this engine. */
    s.exec(sql, args, { maxRows: 4000 }, function (r) {
        rows.push({ date: String(r.Date), section: String(r.Section),
                    topic: String(r.Topic || ""), text: String(r.Doc),
                    sources: String(r.Sources || "").split("\n")
                        .filter(function (l) { return l.length; })
                        .map(function (l) {
                            var p = l.split("\t");
                            return { outlet: p[0], url: p[1] || "" };
                        }),
                    links: String(r.Links || "").split(" ")
                        .filter(function (t) { return t.length; }) });
    });
    if (!q)
        rows.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
    return rows.slice(0, n);
}

/* Cached ON THE HANDLE, not in module state: when the corpus is replaced
   the handle is closed and a new one opened, so a new handle starts with
   no count and cannot report the old corpus's size. Module state needed
   a clearing call from whichever app owned the handle, and that chain
   failed silently -- a swapped corpus kept being reported as 146 rows
   until the server was restarted. */
function corpusRows(sql) {
    if (sql.__corpusRows) return sql.__corpusRows;
    var n = 0;
    try {
        sql.exec("select count(*) c from corpus;", { maxRows: 1 },
                 function (r) { n = Number(r.c); });
    } catch (e) { /* fall through */ }
    sql.__corpusRows = n || CORPUS_ROWS_FALLBACK;
    return sql.__corpusRows;
}

/* ---------- helpers ---------- */

function splitId(id) {
    var s = String(id), i = s.indexOf(":");
    if (i < 1) return null;
    return { source: s.substring(0, i), path: s.substring(i + 1) };
}
function makeId(source, path) { return source + ":" + path; }

/* A corpus row's Source is NOT always its staging table's name, so this
   cannot be a plain tally of lips_sources.TableName -- that listed 38
   gutenberg_en_* names which match no row in corpus, while rejecting
   "gutenberg", which matches 64,000. corpus_merged records the Source
   each unit actually went in under; tables merged before that registry
   existed used Source == TableName, which is the fallback. */
function sourceList(sql) {
    var out = [], docs = {}, srcOf = {};
    try {
        sql.exec("select TableName, Source from corpus_merged;",
                 { maxRows: 5000 }, function (r) {
            srcOf[String(r.TableName)] = String(r.Source);
        });
    } catch (e) { /* no registry yet: every Source is its table name */ }
    sql.exec("select TableName, Docs, Collection from lips_sources;",
             { maxRows: 5000 }, function (r) {
        var t = String(r.TableName), s = srcOf[t] || t;
        docs[s] = (docs[s] || 0) + Number(r.Docs);
    });
    Object.keys(docs).forEach(function (k) { out.push({ name: k, docs: docs[k] }); });
    out.sort(function (a, b) { return b.docs - a.docs; });
    return out;
}

/* Corpus-wide document frequency for one term, straight from the
   metamorph index dictionary. Sub-millisecond. "Absent" is the strong
   signal: no document among 48M contains the term. Note the word
   expression splits decimals, so "138.7" is never a token -- exact
   figures need lips_locate inside a document instead. */
function termFreq(sql, w) {
    /* set() every call, never cached in a module variable: the server
       copies module state to new threads but each thread has its OWN
       connection, so a cached "already set" flag leaves later threads
       querying without indexAccess -- which failed silently and reported
       real terms as absent. State belongs on the handle, not in JS. */
    sql.set({ indexAccess: true });
    var rc = null, oc = null, err = null;
    try {
        sql.exec("select RowCount, OccurrenceCount from corpus_cx where Word = ?;",
                 [String(w).toLowerCase()], { maxRows: 1 }, function (r) {
            rc = Number(r.RowCount); oc = Number(r.OccurrenceCount);
        });
    } catch (e) { err = String(e).split("\n")[0]; }
    /* A failed lookup is NOT an absent term. Say which it was. */
    if (err) return { term: String(w), lookupFailed: err };
    return { term: String(w), documents: rc === null ? 0 : rc,
             occurrences: oc === null ? 0 : oc, present: rc !== null };
}

var STOP = ("the a an and or of in on at to for with by from as is was were be " +
            "been being that this these those it its his her their about was").split(" ");
function claimTerms(claim) {
    var seen = {}, out = [];
    String(claim).toLowerCase().split(/[^a-z0-9_.+#-]+/).forEach(function (w) {
        if (w.length < 4 || STOP.indexOf(w) !== -1 || seen[w]) return;
        seen[w] = 1; out.push(w);
    });
    return out.slice(0, 12);
}

/* Require a phrase, writing the +"..." syntax so the caller never has to.
   Zero hits proves no document contains it. Fast: 3-46 ms measured. */
function phraseHits(sql, phrase, cap) {
    var n = 0, first = "", q = '+"' + String(phrase).replace(/"/g, " ") + '"';
    try {
        sql.exec("select Title from corpus where Doc likep ?;", [q],
                 { maxRows: cap || 5 }, function (r) {
            n++; if (!first) first = String(r.Title);
        });
    } catch (e) { return { error: String(e).split("\n")[0] }; }
    return { hits: n, topTitle: first, queryUsed: q };
}

/* A figure cannot be checked corpus-wide: the word expression splits
   "21.8" into "21" and "8", so the dictionary has no such token and likep
   matches the common components -- +"$999 trillion" returns hits. The
   only reliable check is an exact substring scan inside documents, so
   scan the ones that bear on the claim. */
function figureInDocs(sql, figure, docs) {
    var found = [], f = String(figure);
    docs.slice(0, 6).forEach(function (h) {
        var k = splitId(h.id);
        if (!k) return;
        sql.exec("select Doc from corpus where SrcPath = ? and Source = ?;",
                 [k.path, k.source], { maxRows: 1 }, function (r) {
            var doc = String(r.Doc), at = doc.indexOf(f);
            if (at >= 0)
                found.push({ id: h.id, offset: at,
                             context: doc.substring(Math.max(0, at - 50),
                                                    at + f.length + 50) });
        });
    });
    return found;
}

/* Parse "@1234: text" from abstract's querysingleoffset style. */
function parseOffset(s) {
    var m = /^@(\d+):\s?/.exec(s);
    return m ? { off: Number(m[1]), text: s.substring(m[0].length) } : null;
}

/* Pick the best verbatim window ourselves, by query-term density.
 *
 * abstract()'s own selection lands on Wikipedia navboxes and infoboxes:
 * they sit near byte 0 and are dense in topic terms, so they beat the
 * real discussion. Measured -- "reverse osmosis membrane fouling" chose
 * offset 77, the desalination-methods sidebar, on two articles.
 * Skipping the lead region fixes it, and the lead is returned separately
 * anyway. Falls back to the abstract offset when nothing scores.
 */
function terms(q) {
    return String(q).toLowerCase().split(/[^a-z0-9_+#.]+/)
        .filter(function (w) { return w.length > 2; });
}
function bestWindow(doc, q, size, leadSkip) {
    var ts = terms(q);
    if (!ts.length) return null;
    var hay = doc.toLowerCase(), hits = [];
    ts.forEach(function (t, ti) {
        var at = 0, i;
        while ((i = hay.indexOf(t, at)) >= 0 && hits.length < 4000) {
            hits.push({ at: i, t: ti });
            at = i + t.length;
        }
    });
    if (!hits.length) return null;
    hits.sort(function (a, b) { return a.at - b.at; });

    /* score each hit as the start of a window: distinct terms dominate,
       total hits break ties */
    var best = null;
    for (var k = 0; k < hits.length; k++) {
        var a = Math.max(0, hits[k].at - 80), b = a + size;
        if (a < leadSkip && hits[k].at < leadSkip) continue;  /* lead handled apart */
        var distinct = {}, n = 0;
        for (var j = k; j < hits.length && hits[j].at < b; j++) {
            distinct[hits[j].t] = 1; n++;
        }
        var score = Object.keys(distinct).length * 1000 + n;
        if (!best || score > best.score) best = { score: score, at: a };
    }
    if (!best) return null;
    return best.at;
}

/* Slice a verbatim window out of doc around off, on whitespace edges. */
function window_(doc, off, size) {
    var half = Math.floor(size / 2);
    var a = Math.max(0, off - Math.floor(half / 2));
    var b = Math.min(doc.length, a + size);
    /* nudge to whitespace so we do not cut words */
    if (a > 0) { var ws = doc.indexOf(" ", a); if (ws > -1 && ws - a < 40) a = ws + 1; }
    if (b < doc.length) {
        var we = doc.lastIndexOf(" ", b);
        if (we > a && b - we < 40) b = we;
    }
    return { start: a, end: b, text: doc.substring(a, b) };
}

/* A lone metamorph operator token zeroes the ENTIRE query -- measured for
   % @ + - ~ and =. So "Warum nutzen Menschen nur 10 % ihres Gehirns"
   returns nothing, because German writes "10 %" with a space where
   English writes "10%". Attached operators are fine and meaningful, so
   only free-standing ones are touched: % becomes the word, the rest go. */
var LONE_OP = /^[%@+~=-]+$/;
function cleanQuery(q) {
    return String(q).split(/\s+/).map(function (t) {
        if (t === "%") return "percent";
        return LONE_OP.test(t) ? "" : t;
    }).filter(function (t) { return t.length; }).join(" ");
}

/* One search, no ORDER BY: likep already streams in rank order, and
   ordering would run abstract() on every candidate instead of maxRows. */
function runSearch(sql, q, source, limit, snipBytes) {
    var hits = [];
    var original = String(q);
    q = cleanQuery(q);
    /* `source` may be one collection or an array of them. Measured on the
       48M-row table with the compound (Doc, Source) index: Source IN (4)
       costs 1.25x the unfiltered query, an OR chain of the same four 2.4x,
       and excluding two with != 3.1x. So always IN, never OR, never
       negation -- and filtering is often FASTER than not, because the
       predicate rides the index. */
    var list = (source && source.length)
             ? (typeof source === "string" ? [source] : source) : [];
    var restrict = "";
    if (list.length === 1) restrict = " and Source = ?";
    else if (list.length > 1)
        restrict = " and Source in (" +
                   list.map(function () { return "?"; }).join(",") + ")";
    var text = "select Source, Site, Title, SrcPath, Nbytes, $rank rnk, " +
               "abstract(Doc, " + snipBytes + ", 'querybest', ?) snip from corpus " +
               "where Doc likep ?" + restrict + ";";
    var params = [q, q].concat(list);
    sql.exec(text, params, { maxRows: limit }, function (r) {
        hits.push({
            id: makeId(String(r.Source), String(r.SrcPath)),
            source: String(r.Source),
            site: String(r.Site || ""),
            title: String(r.Title),
            bytes: Number(r.Nbytes),
            rank: Number(r.rnk),
            passage: String(r.snip || "")
        });
    });
    return hits;
}

/* ---------- schemas ---------- */

function schemas() {
    return [
    { type: "function", function: {
        name: "lips_search",
        description:
            "Search 48 million documents drawn from Wikipedia, Wiktionary, " +
            "Wikisource, Stack Overflow, Stack Exchange, iFixit and offline " +
            "reference archives. Returns a LIST OF CANDIDATES -- id, source, " +
            "title and a short passage of the part that matches -- not the " +
            "document text. Read the passages, then call lips_retrieve with " +
            "the ids worth reading in full and the SAME question.",
        parameters: { type: "object", properties: {
            query: { type: "string",
                description: "What to look for, in words that would appear in " +
                    "the text. Several related terms work better than one. " +
                    "MUST BE ENGLISH: every collection is an English edition. " +
                    "If the conversation is in another language, translate the " +
                    "subject into English here and answer the user in their " +
                    "language. A non-English query still returns hits -- from " +
                    "foreign names inside English articles and from Wiktionary " +
                    "entries about foreign words -- which looks like coverage " +
                    "but is not." },
            source: { type: "string",
                description: "Restrict to one collection. " + "Valid values, with document counts: stackoverflow (24.1M), wiktionary_en (9.1M), wikipedia_en (7.3M), stackexchange (6.4M, 157 Q&A sites), wikisource_en (700K), ifixit (103K, repair guides), wikiquote_en (74K), wikipedia_en_medicine (73K), wikiversity_en (54K), wikivoyage_en (35K), zimgit (107, offline reference PDFs). " +
                    "Omit to search everything, which is usually right -- but " +
                    "restrict when the question belongs to one collection: a " +
                    "word's meaning or etymology to wiktionary_en, a repair " +
                    "procedure to ifixit, a programming error to " +
                    "stackoverflow." },
            tier: { type: "string",
                enum: ["primary", "secondary", "discussion"],
                description: "Restrict to a reliability tier instead of a " +
                    "single collection. primary = the thing itself in its " +
                    "own words (works, manuals, sourced quotations, repair " +
                    "procedures). secondary = edited description or " +
                    "analysis of other things (encyclopedia, dictionary, " +
                    "guides). discussion = unedited Q&A, one person's " +
                    "answer. Use primary when you need to QUOTE a work or " +
                    "a procedure rather than read an account of it -- a " +
                    "work ranks below articles about it, so an unfiltered " +
                    "search will usually not show it. Cheap: measured at " +
                    "1.25x an unfiltered query, sometimes faster. Cannot " +
                    "be combined with a source in a different tier." },
            limit: { type: "integer",
                description: "Candidates to return, 1-50. Default 10." }
        }, required: ["query"] } } },

    { type: "function", function: {
        name: "lips_retrieve",
        description:
            "Read the passages of documents that lips_search listed. Pass the " +
            "ids you want and the SAME question -- each passage is located " +
            "around it, so retrieving with a different question returns " +
            "different text. Passages are VERBATIM slices of the document. " +
            "Also returns each document's opening, because an encyclopedia " +
            "article defines its subject in the first sentences.",
        parameters: { type: "object", properties: {
            ids: { type: "array", items: { type: "string" },
                description: "Document ids from lips_search, at most 8." },
            question: { type: "string",
                description: "The same question the search used, in English." },
            bytes: { type: "integer",
                description: "Passage size per document, 200-8000. Default 1200." }
        }, required: ["ids", "question"] } } },

    { type: "function", function: {
        name: "lips_survey",
        description:
            "Survey the corpus on a subject: many documents that cover it, " +
            "one line each, grouped by collection. Use this for breadth -- " +
            "what exists, and where -- rather than for reading. Returns more " +
            "candidates than lips_search and shorter passages.",
        parameters: { type: "object", properties: {
            subject: { type: "string", description: "The subject to survey." + " Search terms must be ENGLISH -- every collection is an English edition. Translate from the conversation's language and answer the user in theirs." },
            source: { type: "string",
                description: "Restrict to one collection. " + "Valid values, with document counts: stackoverflow (24.1M), wiktionary_en (9.1M), wikipedia_en (7.3M), stackexchange (6.4M, 157 Q&A sites), wikisource_en (700K), ifixit (103K, repair guides), wikiquote_en (74K), wikipedia_en_medicine (73K), wikiversity_en (54K), wikivoyage_en (35K), zimgit (107, offline reference PDFs). " },
            limit: { type: "integer",
                description: "Documents to list, 10-100. Default 40." }
        }, required: ["subject"] } } },

    { type: "function", function: {
        name: "lips_research",
        description:
            "Find the documents that bear on a question, in one call. Give " +
            "the goal -- the question itself, in full -- and 2 to 6 short " +
            "queries that each look for a different part of it. Runs every " +
            "query, merges the results, and returns passages. Use this " +
            "instead of several lips_search calls.",
        parameters: { type: "object", properties: {
            goal: { type: "string",
                description: "The question in full, as a reader would ask it." +
                    " Search terms must be ENGLISH -- every collection is an English edition. Translate from the conversation's language and answer the user in theirs." },
            queries: { type: "array", items: { type: "string" },
                description: "2-6 short keyword queries covering different " +
                    "facets of the goal." },
            source: { type: "string",
                description: "Restrict to one collection. " + "Valid values, with document counts: stackoverflow (24.1M), wiktionary_en (9.1M), wikipedia_en (7.3M), stackexchange (6.4M, 157 Q&A sites), wikisource_en (700K), ifixit (103K, repair guides), wikiquote_en (74K), wikipedia_en_medicine (73K), wikiversity_en (54K), wikivoyage_en (35K), zimgit (107, offline reference PDFs). " },
            limit: { type: "integer",
                description: "Documents to return after merging, 5-40. Default 15." }
        }, required: ["goal", "queries"] } } },

    { type: "function", function: {
        name: "lips_fetch",
        description:
            "Read a byte range of one document -- the whole of it, if you ask " +
            "for it in strides. Use when a passage was cut off or you need " +
            "context lips_retrieve did not include.",
        parameters: { type: "object", properties: {
            id: { type: "string", description: "Document id from lips_search." },
            start: { type: "integer", description: "Byte offset to start at. Default 0." },
            length: { type: "integer",
                description: "Bytes to return, up to 20000. Default 4000." }
        }, required: ["id"] } } },

    { type: "function", function: {
        name: "lips_locate",
        description:
            "Find EVERY occurrence of a string inside one document, with the " +
            "byte offset of each. Unlike lips_search, which ranks and returns " +
            "the best passage, this is exhaustive within the one document -- " +
            "use it to count mentions or to find a specific figure, then " +
            "lips_fetch the offsets that matter.",
        parameters: { type: "object", properties: {
            id: { type: "string", description: "Document id from lips_search." },
            needle: { type: "string", description: "Exact string to find, case-insensitive." },
            limit: { type: "integer", description: "Occurrences to return, up to 200. Default 50." }
        }, required: ["id", "needle"] } } },

    { type: "function", function: {
        name: "lips_verify",
        description:
            "Check a claim you already believe against the corpus BEFORE you " +
            "assert it. Pass plain words -- no quotes, no operators, no " +
            "special syntax; this tool writes the right query for each kind " +
            "of term itself. A single word is checked against the index of " +
            "every word in the corpus. A multi-word term is checked as a " +
            "required phrase. A number is checked by exact scan of the " +
            "documents that bear on the claim, because numbers cannot be " +
            "checked corpus-wide. Returns absentFromCorpus (terms no " +
            "document out of 48 million contains) and figuresNotFound " +
            "(numbers absent from the relevant documents) -- do not assert " +
            "anything named there. Use this on every figure, date, name and " +
            "causal claim you were going to state from memory. When the " +
            "corpus disagrees with you, say so in your answer rather than " +
            "silently choosing a side.\n\n" +
            "READ THE RESULT ASYMMETRICALLY. Absence is strong evidence; " +
            "presence is weak. A phrase is matched by proximity, not exact " +
            "adjacency, so hits>0 can mean the words merely occur near each " +
            "other -- \"Tiffany Watt Smith\" would also match a document " +
            "mentioning a Tiffany, a Watt and a Smith. So hits==0 means the " +
            "phrase is genuinely not there, while hits>0 means only that it " +
            "is worth reading the bearing passages to see whether the claim " +
            "is actually supported. The same holds for a single word: a " +
            "document count proves the word exists SOMEWHERE in the corpus, " +
            "never that it exists in the sense you mean. To confirm presence " +
            "exactly, use lips_locate on a specific document.",
        parameters: { type: "object", properties: {
            claim: { type: "string",
                description: "The claim to check, as a sentence." },
            terms: { type: "array", items: { type: "string" },
                description: "Specific terms to check for existence -- names, " +
                    "places, jargon. Optional: they are otherwise taken from " +
                    "the claim." }
        }, required: ["claim"] } } },

    { type: "function", function: {
        name: "lips_news",
        description: newsDescription(),
        parameters: { type: "object", properties: {
            query: { type: "string",
                description: "Words to match in the news items. Omit it to " +
                    "list a date range in order, newest first." },
            since: { type: "string",
                description: "Earliest date to include, YYYY-MM-DD." },
            until: { type: "string",
                description: "Latest date to include, YYYY-MM-DD." },
            section: { type: "string", enum: NEWS_SECTIONS,
                description: "Restrict to one section of the news." },
            n: { type: "integer",
                description: "Maximum items to return. Default 20, max 100." }
        } } } },

    { type: "function", function: {
        name: "lips_sources",
        description:
            "List the collections in the corpus with their document counts. " +
            "Use this to decide whether a question belongs to one collection " +
            "-- a repair question to iFixit, a programming error to Stack " +
            "Overflow -- before restricting a search to it.",
        parameters: { type: "object", properties: {} } } }
    ];
}

/* The window goes in the description, not only in the result: a model
   choosing a tool should be able to see that this one stops at a date,
   and reach for lips_search instead when the question is older or needs
   background rather than an event. */
function newsDescription() {
    var m = newsMeta();
    var d = "Recent news: items from Wikipedia's current events portal, " +
            "one per event, each with the outlets that reported it. ";
    if (m && m.from)
        d += "COVERS " + m.from + " TO " + m.to + " ONLY (" + m.items +
             " items over " + m.days + " days). Nothing after " + m.to +
             " is known to this corpus at all -- say so rather than guess. ";
    d += "These are short factual summaries, not the articles themselves. " +
         "`documents` on each item are Wikipedia articles HELD LOCALLY -- " +
         "the page written for that event where there is one, background " +
         "articles otherwise -- and are what a reader with no internet can " +
         "open; `sources` are the outlets that reported it, which need a " +
         "connection. Prefer citing the local documents and name the outlet " +
         "in the text. Use lips_search for background, context and " +
         "anything older than this window; use " +
         "this tool for what happened recently, or to list a date range.";
    return d;
}

/* ---------- dispatch ---------- */

function clamp(v, lo, hi, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(Math.max(Math.floor(n), lo), hi);
}

function dispatch_(sql, name, args) {
    args = args || {};

    /* Single-letter terms (C, R, D) are indexed but unreachable at the
       default qMinWordLen of 2, and LIKEP shows only its top likepRows by
       rank. Set per call, not once at load: thread copies re-init the
       handle and lose connection state. */
    sql.set({ qMinWordLen: 1, likepRows: LIKEP_ROWS });

    /* A wrong source name used to return an empty result set, which reads
       as "nothing on this subject" rather than "no such collection".
       Measured: the model guessed "wiktionary" and "wikisource" and burned
       two of ten calls before finding wiktionary_en. Name the valid ones. */
    if (args.source) {
        var known = sourceList(sql).map(function (x) { return x.name; });
        if (known.indexOf(String(args.source)) === -1)
            return { error: "no collection named \"" + args.source + "\"",
                     validSources: known,
                     hint: "Use one of validSources, or omit source to " +
                           "search the whole corpus." };
    }

    if (name === "lips_news") {
        var ns = newsSql();
        if (!ns)
            return { error: newsWhy_ || "no news table in this install",
                     hint: "The news table ships separately. Use lips_search; " +
                           "the corpus itself has no coverage of recent events." };
        var nm = newsMeta() || {};
        var nq = String(args.query || "").trim();
        var since = /^\d{4}-\d{2}-\d{2}$/.test(String(args.since || "")) ? String(args.since) : "";
        var until = /^\d{4}-\d{2}-\d{2}$/.test(String(args.until || "")) ? String(args.until) : "";
        var sect = String(args.section || "").trim();
        if (sect && NEWS_SECTIONS.indexOf(sect) === -1)
            return { error: "no section named \"" + sect + "\"",
                     validSections: NEWS_SECTIONS };
        var nn = clamp(args.n, 1, 100, 20);
        var hits = newsRows(ns, nq, since, until, sect, nn);
        /* Resolve each item's wikilinks to documents that actually
           exist: the event page in the news database, or the background
           article in the corpus. Only what exists is offered -- a link
           to a page this install does not hold is worse than none. */
        var allLinks = {};
        hits.forEach(function (h) {
            (h.links || []).forEach(function (t) { allLinks[t] = 1; });
        });
        var inNews = newsHas(Object.keys(allLinks));
        hits.forEach(function (h) {
            var docs = [], links = h.links || [];
            /* Two passes so the new event pages win the slots: filling
               in link order gave four background articles (Oman, Panama,
               Oil tanker, Strait of Hormuz) and dropped the page written
               for the event. */
            links.forEach(function (t) {
                if (docs.length >= 4 || !inNews[t]) return;
                docs.push({ id: makeId(NEWS_SOURCE, t), title: inNews[t].title,
                            bytes: inNews[t].bytes, written_for: "this event" });
            });
            links.forEach(function (t) {
                if (docs.length >= 4 || inNews[t]) return;
                var c = null;
                sql.exec("select Title, Nbytes from corpus where Source = ? and SrcPath = ?;",
                         ["wikipedia_en", t], { maxRows: 1 }, function (r) {
                    c = { title: String(r.Title), bytes: Number(r.Nbytes) };
                });
                if (c) docs.push({ id: makeId("wikipedia_en", t), title: c.title,
                                   bytes: c.bytes, written_for: "background" });
            });
            if (docs.length) h.documents = docs;
            delete h.links;
        });
        var out = { coverage: { from: nm.from, to: nm.to, items: nm.items,
                                days: nm.days, source: "Wikipedia current " +
                                "events portal", license: nm.license },
                    query: nq, since: since, until: until, section: sect || "",
                    returned: hits.length, results: hits };
        /* An empty result inside the window means the event is not there;
           a date outside it means the question cannot be answered at all.
           Those are different answers and the model must not merge them. */
        if (!hits.length) {
            if ((since && since > nm.to) || (until && until < nm.from))
                out.note = "That date is outside the window this corpus " +
                           "covers (" + nm.from + " to " + nm.to + "). " +
                           "There is no information about it here.";
            else
                out.note = "Nothing in the news items matches, within " +
                           nm.from + " to " + nm.to + ".";
        }
        return out;
    }

    if (name === "lips_sources") {
        return { corpus: corpusRows(sql), collections: sourceList(sql) };
    }

    if (name === "lips_verify") {
        var claim = String(args.claim || "").trim();
        if (!claim) return { error: "claim is required" };
        var ts = (args.terms && args.terms.length)
                   ? args.terms.map(String).slice(0, 12) : claimTerms(claim);

        /* Documents that bear on the claim, needed both as evidence and as
           the place to scan for figures. */
        var bearing = runSearch(sql, claim, "", 6, 320);

        /* Each term is routed to the mechanism that actually works for its
           kind. The caller supplies plain words; this writes the syntax. */
        var checks = ts.map(function (raw) {
            var w = String(raw).trim();
            if (/\d/.test(w)) {
                var fin = figureInDocs(sql, w, bearing);
                return { term: w, checkedBy: "exact scan of bearing documents",
                         foundIn: fin.length, where: fin,
                         note: fin.length ? undefined
                             : "Not present in any document that bears on the " +
                               "claim. Figures cannot be checked corpus-wide." };
            }
            if (/\s/.test(w)) {
                var ph = phraseHits(sql, w, 5);
                return { term: w, checkedBy: 'required phrase +"..."',
                         queryUsed: ph.queryUsed, hits: ph.hits,
                         topTitle: ph.topTitle,
                         absent: ph.hits === 0 };
            }
            var tf = termFreq(sql, w);
            tf.checkedBy = "index dictionary";
            return tf;
        });

        var absentTerms = checks.filter(function (c) {
            if (c.lookupFailed) return false;
            if (c.checkedBy === "index dictionary") return !c.present;
            if (c.absent) return true;
            return false;
        }).map(function (c) { return c.term; });

        var missingFigures = checks.filter(function (c) {
            return c.checkedBy === "exact scan of bearing documents" &&
                   c.foundIn === 0;
        }).map(function (c) { return c.term; });

        return {
            claim: claim,
            corpus: corpusRows(sql),
            checks: checks,
            absentFromCorpus: absentTerms,
            figuresNotFound: missingFigures,
            bearing: bearing,
            guidance:
              (absentTerms.length
                ? "absentFromCorpus: no document out of " + corpusRows(sql) +
                  " contains these. Strong evidence the claim is wrong or " +
                  "worded wrongly. "
                : "") +
              (missingFigures.length
                ? "figuresNotFound: these numbers do not appear in any " +
                  "document that bears on the claim. Do not assert them. "
                : "") +
              "Compare the bearing passages against what you already " +
              "believe, and state any disagreement explicitly rather than " +
              "silently picking a side."
        };
    }

    if (name === "lips_search") {
        var q = String(args.query || "").trim();
        if (!q) return { error: "query is required" };
        var lim = clamp(args.limit, 1, 50, 10);
        var cleaned = cleanQuery(q);
        var scope = resolveScope(args.source, args.tier);
        if (scope.error) return scope;
        var hits = runSearch(sql, q, scope.list, lim, 300);
        var shown = hits.map(function (h) { return h.source; });
        var also = hits.length ? alsoIn(sql, [cleaned], shown) : null;
        /* Pages written for events after the corpus was built. Offered on
           an unrestricted search only: a search deliberately scoped to a
           collection should not have another one folded into it. */
        var fresh = (!args.source && !args.tier) ? newsArticles(cleaned, 4) : [];
        return { query: q,
                 queryUsed: cleaned !== q ? cleaned : undefined,
                 queryNote: cleaned !== q
                   ? "A lone operator token was rewritten: it would have " +
                     "matched nothing." : undefined,
                 source: args.source || null,
                 tier: scope.tier || undefined,
                 tierCollections: scope.tier ? scope.list : undefined,
                 found: hits.length, results: hits,
                 alsoIn: also || undefined,
                 recentArticles: fresh.length ? fresh : undefined,
                 recentNote: fresh.length
                   ? "These are newer than the corpus and are NOT in the " +
                     "results above; the corpus predates them. Retrieve them " +
                     "by id like any other document." : undefined,
                 next: "Call lips_retrieve with the ids worth reading and the same question." };
    }

    if (name === "lips_survey") {
        var subj = String(args.subject || "").trim();
        if (!subj) return { error: "subject is required" };
        /* A survey is a shape, not a result set. It used to return every
           matching document with its passage -- 23 KB and 24 full
           Wikipedia entries for one subject -- which is both expensive to
           read and the wrong answer to "what does the corpus hold".
           Counts per collection with a few exemplars is the answer.
           Note the scope honestly: likepRows caps LIKEP at its top N by
           rank, so this describes the best matches, NOT the corpus. The
           earlier wording promised more than it delivered, and the number
           is reported rather than assumed. */
        var ex = clamp(args.examples, 1, 10, 3);
        var spread;
        try { spread = collectionSpread(sql, cleanQuery(subj)); }
        catch (e) { return { error: String(e).split("\n")[0] }; }

        /* Counts come from the SPREAD, which sees the whole likepRows
           window; the fetched rows are only for examples. Deriving counts
           from the rows instead made them disagree with consideredTop the
           moment likepRows was raised -- they summed to the fetch size,
           not the window. */
        var bySrc = {};
        Object.keys(spread.byCollection).forEach(function (c) {
            bySrc[c] = { tier: tierOf(c) || undefined,
                         matches: spread.byCollection[c].matches,
                         bestRank: spread.byCollection[c].bestRank,
                         examples: [] };
        });
        var rows = runSearch(sql, subj, [], 100, 110);
        rows.forEach(function (h) {
            var c = bySrc[h.source];
            if (!c) return;
            if (c.examples.length < ex)
                /* source and site must travel with each example: without
                   them the archive lookup cannot tell which of the 157
                   stackexchange ZIMs a hit came from, and the citation
                   silently fell back to the flavor-1 link. */
                c.examples.push({ id: h.id, source: h.source,
                                  site: h.site || undefined,
                                  title: h.title, rank: h.rank,
                                  passage: h.passage });
        });
        /* A collection can hold matches that begin below the example
           fetch, so say so rather than implying it has nothing to show. */
        Object.keys(bySrc).forEach(function (c) {
            if (!bySrc[c].examples.length)
                bySrc[c].examplesNote = "matches rank below the examples " +
                    "fetched; search with source set to see them";
        });
        /* strongest collections first, so the shape reads at a glance */
        var order = Object.keys(bySrc).sort(function (a, b) {
            return bySrc[b].matches - bySrc[a].matches; });
        var out = {};
        order.forEach(function (k) { out[k] = bySrc[k]; });

        var tiers = {};
        order.forEach(function (k) {
            var t = tierOf(k) || "other";
            tiers[t] = (tiers[t] || 0) + bySrc[k].matches;
        });

        return { subject: subj,
                 consideredTop: spread.considered,
                 scope: "the top " + spread.considered + " matches by rank " +
                        "(LIKEP is capped by likepRows), not the whole corpus",
                 byTier: tiers,
                 collections: order,
                 byCollection: out,
                 next: "Pick a collection or tier, then lips_search with " +
                       "source or tier set to go deeper." };
    }

    if (name === "lips_research") {
        var goal = String(args.goal || "").trim();
        var qs = (args.queries || []).map(String).filter(function (s) {
            return s.trim().length; }).slice(0, 6);
        if (!goal || !qs.length) return { error: "goal and queries are required" };
        var lim3 = clamp(args.limit, 5, 40, 15);
        var scope3 = resolveScope(args.source, args.tier);
        if (scope3.error) return scope3;
        var seen = {}, merged = [];
        /* Interleave by position so one broad query cannot crowd out the
           others; within a position, better rank first. */
        var perQuery = qs.map(function (q) {
            return runSearch(sql, q, scope3.list, lim3, 240);
        });
        for (var i = 0; i < lim3; i++) {
            var round = [];
            perQuery.forEach(function (list, qi) {
                if (list[i] && !seen[list[i].id]) round.push({ h: list[i], qi: qi });
            });
            round.sort(function (a, b) { return b.h.rank - a.h.rank; });
            round.forEach(function (x) {
                if (merged.length >= lim3 || seen[x.h.id]) return;
                seen[x.h.id] = 1;
                x.h.matchedQuery = qs[x.qi];
                merged.push(x.h);
            });
            if (merged.length >= lim3) break;
        }
        var shown3 = merged.map(function (h) { return h.source; });
        /* One extra spread query per research query -- up to six. Measured
           cost is reported in claude-work/likeprows-tuning.out. */
        var also3 = merged.length
                  ? alsoIn(sql, qs.map(cleanQuery), shown3) : null;
        return { goal: goal, queries: qs,
                 tier: scope3.tier || undefined,
                 tierCollections: scope3.tier ? scope3.list : undefined,
                 found: merged.length, results: merged,
                 alsoIn: also3 || undefined,
                 next: "Call lips_retrieve with the ids worth reading and the goal as the question." };
    }

    if (name === "lips_retrieve") {
        var ids = (args.ids || []).map(String).slice(0, 8);
        var question = String(args.question || "").trim();
        if (!ids.length || !question) return { error: "ids and question are required" };
        var size = clamp(args.bytes, 200, 8000, 1200);
        var out = [];
        ids.forEach(function (id) {
            var k = splitId(id);
            if (!k) { out.push({ id: id, error: "malformed id, expected source:srcpath" }); return; }
            var got = false;
            /* A news: id is in the other database and has no Source
               column, so it is read by path from the event table. */
            var isNews = (k.source === NEWS_SOURCE);
            var rsql = isNews ? newsSql() : sql;
            if (isNews && !rsql) {
                out.push({ id: id, error: "no news table in this install" });
                return;
            }
            var rq = isNews
                ? "select 'news' Source, Title, Nbytes, " +
                  "abstract(Doc, 400, 'querysingleoffset', ?) snip, Doc " +
                  "from wikipedia_en_news where SrcPath = ?;"
                : "select Source, Title, Nbytes, " +
                  "abstract(Doc, 400, 'querysingleoffset', ?) snip, Doc " +
                  "from corpus where SrcPath = ? and Source = ?;";
            var ra = isNews ? [question, newsDocPath(k.path)]
                            : [question, k.path, k.source];
            rsql.exec(rq, ra, { maxRows: 1 }, function (r) {
                got = true;
                var doc = String(r.Doc);
                var po = parseOffset(String(r.snip || ""));
                var lead = doc.substring(0, Math.min(doc.length, 320));
                var off = bestWindow(doc, question, size, lead.length);
                var how = "density";
                if (off === null) {
                    off = po ? po.off : 0;
                    how = po ? "abstract" : "prefix";
                }
                var w = window_(doc, off + Math.floor(size / 4), size);
                var rec = {
                    id: id, source: String(r.Source), title: String(r.Title),
                    bytes: Number(r.Nbytes),
                    opening: lead,
                    passage: w.text,
                    passageStart: w.start,
                    passageEnd: w.end,
                    selectedBy: how
                };
                /* do not spend the model's context on the same bytes twice */
                if (w.start < lead.length) delete rec.opening;
                out.push(rec);
            });
            if (!got) out.push({ id: id, error: "not found" });
        });
        return { question: question, documents: out,
                 note: "Passages are verbatim slices. Use lips_fetch for more of a document." };
    }

    if (name === "lips_fetch") {
        var k2 = splitId(String(args.id || ""));
        if (!k2) return { error: "malformed id, expected source:srcpath" };
        var start = clamp(args.start, 0, 1 << 30, 0);
        var len = clamp(args.length, 1, 20000, 4000);
        var res = null;
        var fIsNews = (k2.source === NEWS_SOURCE);
        var fsql = fIsNews ? newsSql() : sql;
        if (fIsNews && !fsql) return { error: "no news table in this install" };
        var fq = fIsNews
            ? "select 'news' Source, Title, Nbytes, Doc from wikipedia_en_news " +
              "where SrcPath = ?;"
            : "select Source, Title, Nbytes, Doc from corpus " +
              "where SrcPath = ? and Source = ?;";
        var fa = fIsNews ? [newsDocPath(k2.path)] : [k2.path, k2.source];
        fsql.exec(fq, fa, { maxRows: 1 }, function (r) {
            var doc = String(r.Doc);
            res = { id: args.id, source: String(r.Source), title: String(r.Title),
                    documentBytes: doc.length, start: start,
                    text: doc.substring(start, start + len) };
            res.end = start + res.text.length;
            res.more = res.end < doc.length;
        });
        return res || { error: "not found" };
    }

    if (name === "lips_locate") {
        var k3 = splitId(String(args.id || ""));
        var needle = String(args.needle || "");
        if (!k3 || !needle) return { error: "id and needle are required" };
        var lim4 = clamp(args.limit, 1, 200, 50);
        var hit = null;
        sql.exec("select Title, Doc from corpus where SrcPath = ? and Source = ?;",
                 [k3.path, k3.source], { maxRows: 1 }, function (r) {
            var doc = String(r.Doc), hay = doc.toLowerCase(),
                nd = needle.toLowerCase(), at = 0, found = [];
            while (found.length < lim4) {
                var i = hay.indexOf(nd, at);
                if (i < 0) break;
                found.push({ offset: i,
                             context: doc.substring(Math.max(0, i - 60),
                                                    i + nd.length + 60) });
                at = i + nd.length;
            }
            var total = found.length;
            if (total === lim4) {           /* count the rest without context */
                while (true) {
                    var j = hay.indexOf(nd, at);
                    if (j < 0) break;
                    total++; at = j + nd.length;
                }
            }
            hit = { id: args.id, title: String(r.Title), needle: needle,
                    occurrences: total, returned: found.length, at: found };
        });
        return hit || { error: "not found" };
    }

    return { error: "unknown tool: " + name };
}



/* ---------- what each collection holds, and its tier ----------
 * Names and counts are not guidance. A book report cited only the
 * encyclopedia article while the complete novel sat in wikisource_en,
 * because nothing said what wikisource_en is.
 *
 * TIERS double as citation reliability, strongest first:
 *   primary    the thing itself, in its own words -- a work, a statute,
 *              a published manual. Nothing stands between the reader and
 *              the source.
 *   secondary  edited description or analysis OF other things. Reliable
 *              for orientation and summary, but it is someone's account.
 *   discussion unedited Q&A: one person's answer, sometimes wrong, often
 *              the only place a specific problem is addressed at all.
 *
 * Carried in the source parameter, in lips_sources, AND on every result,
 * so the model never has to remember the mapping.
 */
var COLLECTIONS = {
  wikisource_en: { tier: "primary", holds:
    "PRIMARY TEXTS, the complete works themselves: novels, plays, poems, " +
    "speeches, treaties, legislation, in their original wording, usually " +
    "also split per chapter. Use it to QUOTE a work rather than read " +
    "about it. A work rarely repeats its own title, so it ranks below " +
    "encyclopedia articles about it -- restrict here to find it" },
  zimgit: { tier: "primary", holds:
    "published reference manuals as PDFs: water treatment, knots, " +
    "medicine, food preparation, post-disaster response" },
  wikiquote_en: { tier: "primary", holds:
    "quotations in their original wording, each with its source, and " +
    "explicit sections for the misattributed and disputed ones -- the " +
    "place to check whether a famous line is genuine" },
  ifixit: { tier: "primary", holds:
    "the repair procedures themselves: step-by-step guides and teardowns " +
    "for specific devices, with the tools and parts each one needs" },
  gutenberg: { tier: "primary", holds:
    "COMPLETE BOOKS as published: ~64,000 public-domain works of " +
    "literature, philosophy, history, science and reference, each the " +
    "full text of one book. Classified by Library of Congress class, " +
    "which is on Site as lcc-<class> (lcc-pr and lcc-ps are English and " +
    "American literature, lcc-b philosophy, lcc-q science, lcc-t " +
    "technology, lcc-d world history). Overlaps wikisource_en but holds " +
    "far more full-length books, whole rather than per-chapter. Use it " +
    "to quote a book's actual words; search a distinctive phrase, since " +
    "a 350 KB book mentions its own title rarely" },
  wikibooks_en: { tier: "secondary", holds:
    "open textbooks and instructional manuals written for teaching: " +
    "structured courses, how-to guides and cookbooks, organised as " +
    "books with chapters. Explains and teaches a subject where " +
    "wikipedia_en summarises it" },
  wikipedia_en: { tier: "secondary", holds:
    "encyclopedia articles ABOUT subjects, people, events and works -- " +
    "description and analysis, not the works themselves" },
  wikipedia_en_medicine: { tier: "secondary", holds:
    "the medical subset of Wikipedia: conditions, drugs, procedures, " +
    "anatomy" },
  wiktionary_en: { tier: "secondary", holds:
    "dictionary entries ABOUT words: definitions, etymology, " +
    "pronunciation, inflections, translations, including foreign words" },
  wikivoyage_en: { tier: "secondary", holds:
    "travel guides: destinations, what to see, getting around and " +
    "practicalities" },
  wikiversity_en: { tier: "secondary", holds:
    "learning material: course notes, lesson plans and exercises, mixed " +
    "with student projects, so quality varies more than the other wikis" },
  stackoverflow: { tier: "discussion", holds:
    "programming Q&A: error messages, APIs, language and library " +
    "specifics, usually with working code. Individual answers, not " +
    "edited reference -- often the only source for a specific error" },
  stackexchange: { tier: "discussion", holds:
    "Q&A outside programming across 157 sites: DIY, cooking, physics, " +
    "law, language, gardening, music and more; each hit names its site. " +
    "Individual answers, not edited reference" }
};

function tierOf(name) {
    return (COLLECTIONS[name] && COLLECTIONS[name].tier) || null;
}

function holdsClause() {
    var tiers = { primary: [], secondary: [], discussion: [] };
    Object.keys(COLLECTIONS).forEach(function (k) {
        tiers[COLLECTIONS[k].tier].push(k + " = " + COLLECTIONS[k].holds);
    });
    return " WHAT EACH COLLECTION HOLDS, grouped by tier. Tier is also " +
        "citation reliability, strongest first. PRIMARY (the thing " +
        "itself, in its own words): " + tiers.primary.join("; ") +
        ". SECONDARY (edited description or analysis of other things): " +
        tiers.secondary.join("; ") +
        ". DISCUSSION (unedited Q&A, one person's answer): " +
        tiers.discussion.join("; ") + ".";
}



/* ---------- where else the matches are ----------
 * likepRows caps a LIKEP query at its top N by rank (texis default 100,
 * raised to LIKEP_ROWS here), and lips_search shows at most 50 of those. So
 * a collection can hold most of the best matches and appear nowhere in
 * the results -- a book report cited only the encyclopedia while
 * wikisource held 68 of the top 100.
 *
 * One query over the same top 100, selecting Source and $rank only (no
 * abstract, which is the expensive part). Measured 25-425 ms depending on
 * how broad the query is.
 *
 * Per-source and per-tier variants were tried and rejected: because LIKEP
 * ranks rather than filters, giving a collection its own window fills it
 * to the cap however weakly it matches -- every collection reported 100,
 * at 3-20x the cost. The global window is the only one whose counts mean
 * anything, because the ranking allocates it competitively. The best rank
 * is reported with each count so a weak collection declares itself.
 */
function collectionSpread(sql, q) {
    var acc = {}, total = 0;
    sql.exec("select Source, $rank rnk from corpus where Doc likep ?;",
             [q], { maxRows: -1 }, function (r) {
        var c = String(r.Source), k = Number(r.rnk);
        if (!acc[c]) acc[c] = { matches: 0, bestRank: 0 };
        acc[c].matches++;
        if (k > acc[c].bestRank) acc[c].bestRank = k;
        total++;
    });
    return { byCollection: acc, considered: total };
}

/* The collections holding top-ranked matches that the caller did not see,
   strongest first. Returns null when there is nothing to report, so the
   field simply does not appear rather than saying "nothing". */
function alsoIn(sql, queries, shownSources) {
    var list = (typeof queries === "string") ? [queries] : (queries || []);
    if (!list.length) return null;
    /* Across several queries, take the BEST showing per collection rather
       than a sum: the same document can match more than one query, so a
       sum would overstate. "In at least one of your queries this
       collection held N of the top set" is the claim that holds. */
    var acc = {}, considered = 0;
    list.forEach(function (q) {
        var sp;
        try { sp = collectionSpread(sql, q); } catch (e) { return; }
        if (sp.considered > considered) considered = sp.considered;
        Object.keys(sp.byCollection).forEach(function (c) {
            var e = sp.byCollection[c];
            if (!acc[c]) acc[c] = { matches: 0, bestRank: 0 };
            if (e.matches  > acc[c].matches)  acc[c].matches  = e.matches;
            if (e.bestRank > acc[c].bestRank) acc[c].bestRank = e.bestRank;
        });
    });
    var seen = {};
    (shownSources || []).forEach(function (c) { seen[c] = 1; });
    var out = [];
    Object.keys(acc).forEach(function (c) {
        if (seen[c]) return;
        out.push({ source: c, tier: tierOf(c) || undefined,
                   matches: acc[c].matches, bestRank: acc[c].bestRank });
    });
    if (!out.length) return null;
    out.sort(function (a, b) { return b.matches - a.matches; });
    return { consideredTop: considered, collections: out,
             note: "These collections hold matches among the top " +
                   considered + " by rank but are absent from the " +
                   "results above. matches is how many of that top set " +
                   "they hold (the best showing across your queries); " +
                   "bestRank is their strongest match, comparable with " +
                   "the rank of the results shown -- a much lower " +
                   "bestRank means the matches are weak. Search again " +
                   "with source or tier set to reach them." };
}

/* ---------- tier selection ---------- */

function collectionsInTier(t) {
    var out = [];
    Object.keys(COLLECTIONS).forEach(function (k) {
        if (COLLECTIONS[k].tier === t) out.push(k);
    });
    return out;
}

/* Returns {list: [...]} or {error: "..."}. A source/tier conflict is an
   explicit error, not an empty result set: an empty result reads as
   "nothing on this subject" and sent the model down the wrong path once
   already. */
function resolveScope(source, tier) {
    source = String(source || "").trim();
    tier = String(tier || "").trim().toLowerCase();
    if (!tier) return { list: source ? [source] : [] };
    if (!collectionsInTier(tier).length)
        return { error: "no tier named \"" + tier + "\"",
                 validTiers: ["primary", "secondary", "discussion"] };
    if (source) {
        var st = tierOf(source);
        if (st && st !== tier)
            return { error: "source \"" + source + "\" is " + st +
                     " tier, not " + tier + " -- drop one of the two",
                     sourceTier: st };
        return { list: [source] };
    }
    return { list: collectionsInTier(tier), tier: tier };
}

/* ---------- citation URLs ---------- */

/* Every result object that has an `id` gets a `url` beside it, so the
   model never has to construct a link (and so a wrong link is a bug here
   rather than a hallucination there). Walked recursively because results
   are nested differently per tool: results[], byCollection{}, merged[]. */
function addUrls(node, base, depth, seen, sql) {
    if (!node || typeof node !== "object" || (depth || 0) > 6) return node;
    if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++)
            addUrls(node[i], base, (depth || 0) + 1, seen, sql);
        return node;
    }
    if (typeof node.id === "string" && node.id.indexOf(":") > 0 && !node.url) {
        /* ONE link per result, and now ONE SHAPE of link regardless of
           flavour: /apps/doc?id=<id> on this server. That endpoint
           decides at request time what to show -- it redirects to the
           proxied archive page while kiwix answers, and renders the
           stored text when it does not.
           This replaces choosing the URL here by flavour. Three reasons.
           The citation outlives the decision: a link shared today still
           resolves after the archives are detached, where a baked-in
           :8098 url would 404. It needs no second public port, since
           /zim/ is proxied by this server. And the flavour no longer
           leaks into anything the model sees -- which was the original
           complaint about making it choose between two links.
           Grouped results (lips_survey) carry no source/site of their own,
           which used to downgrade their link silently; with one shape
           there is nothing left to downgrade. */
        node.url = base + "/apps/doc?id=" + encodeURIComponent(node.id);
        if (node.title) {
            /* lips_survey groups results UNDER collection keys, so those
               objects carry no `source` of their own and the citation came
               out as "[Title](url) -- " with a dangling separator. The id
               always begins with the collection, so take it from there. */
            var where = String(node.source ||
                               node.id.substring(0, node.id.indexOf(":")));
            if (node.site) where += " (" + String(node.site) + ")";
            /* Markdown, not bare urls. A long line of two raw urls gets
               abbreviated -- observed: a model copied the first and
               silently dropped the "original" tail. Links are shorter on
               screen, atomic to copy, and clickable in clients that
               render markdown. Title is bracket-escaped so a "]" in an
               article title cannot break the link. */
            var t = String(node.title).replace(/[\[\]]/g, " ");
            node.citeAs = "[" + t + "](" + node.url + ") -- " + where;
            var tr = tierOf(where.replace(/ \(.*$/, ""));
            if (tr) node.tier = tr;
        }
        seen.n++;
    }
    Object.keys(node).forEach(function (k) {
        if (k !== "url" && k !== "citeAs")
            addUrls(node[k], base, (depth || 0) + 1, seen, sql);
    });
    return node;
}

/* The citation rule has to travel with the RESULTS, not only in the
   server's `instructions`. Unsloth Studio fetches instructions on
   initialize and does not put them in the system prompt, and it is not
   alone -- a client forwarding tool schemas and results but dropping
   instructions is common. Results and tool descriptions are the only
   channels every client passes through. */
var CITE_DIRECTIVE =
    "Cite every document you used. Put [1], [2] in the text where the " +
    "claim is made, then list sources at the end by copying each citeAs " +
    "verbatim. Do not alter, shorten or invent a url, and do not cite a " +
    "document you did not retrieve. Each result carries a `tier`: prefer " +
    "primary (the thing itself) over secondary (an account of it) over " +
    "discussion (one person's answer). Where they disagree, say which " +
    "tier each claim came from, and mark a discussion-tier claim as an " +
    "individual answer rather than an edited source." +
    "";

function dispatch(sql, name, args, base) {
    var out = dispatch_(sql, name, args);
    /* Configured base wins; the request host is the fallback, and a
       relative url the last resort -- still usable, never a wrong host. */
    var seen = { n: 0 };
    addUrls(out, BASE_URL || base || "", 0, seen, sql);
    if (seen.n && out && typeof out === "object" && !Array.isArray(out) &&
        !out.error)
        out.cite = CITE_DIRECTIVE;
    /* lips_sources listed names and counts, which told the model nothing
       about what to pick. */
    if (out && Array.isArray(out.collections))
        out.collections.forEach(function (c) {
            if (c && c.name && COLLECTIONS[c.name]) {
                c.tier  = COLLECTIONS[c.name].tier;
                c.holds = COLLECTIONS[c.name].holds;
            }
        });
    return out;
}

/* Same reasoning for the tool descriptions: appended once, here, rather
   than edited into each schema. */
var CITE_HINT = " Each result carries `url` (the document, openable by the " +
    "reader) and `citeAs` (a ready markdown citation line). Cite every " +
    "document you use by reproducing citeAs.";

/* Only the tools that actually return citable documents. lips_survey
   returns counts, lips_verify term frequencies, lips_sources the registry --
   none has an id to cite, and claiming otherwise invites a fabricated
   citation. */
var CITING_TOOLS = ["lips_search", "lips_retrieve", "lips_research",
                    "lips_fetch", "lips_locate"];

function schemasCited() {
    var out = schemas();
    /* A corpus-only install must not be offered a tool that can only
       fail: the news table is a separate download. */
    if (!newsSql())
        out = out.filter(function (t) {
            return !(t && t.function && t.function.name === "lips_news");
        });
    out.forEach(function (t) {
        var f = t && t.function;
        if (!f) return;
        if (f.description && CITING_TOOLS.indexOf(f.name) > -1 &&
            f.description.indexOf("citeAs") === -1)
            f.description += CITE_HINT;
        /* Three tools carry the same `source` description; append the
           collection notes here rather than editing each copy. */
        var props = f.parameters && f.parameters.properties;
        if (props && props.source && props.source.description &&
            props.source.description.indexOf("WHAT EACH COLLECTION") === -1)
            props.source.description += holdsClause();
    });
    return out;
}

module.exports = { schemas: schemasCited, dispatch: dispatch, DB: DB,
                   newsSql: newsSql, newsDocPath: newsDocPath,
                   /* The apps own the corpus handle; this clears the
                      caches here that are derived from it. */
                   corpusReopened: corpusReopened,
                   BASE_URL: BASE_URL, ZIM_BASE: ZIM_BASE,
                   flavor: function () { return FLAVOR2 ? 2 : 1; },
                   zimCount: function () { return ZIM_COUNT; },
                   splitId: splitId, makeId: makeId };
