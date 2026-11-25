/* Search the merged alpacaLIPS corpus, as JSON.
 *
 *   /apps/search.json?q=water+purification&n=20
 *   /apps/search.json?q=sprocket&source=ifixit
 *
 * One query against one table. Ranks are comparable because there is a
 * single corpus statistic -- that is the whole point of the merge, and
 * it is why no cross-collection fusion is needed here (DESIGN.md 27).
 *
 * No ORDER BY: likep already streams in rank order, and ordering would
 * force abstract() to run on every candidate instead of just maxRows.
 */

var Sql = require("rampart-sql");
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

/* One connection per thread: texis engine state is single-threaded, but
   each JS thread gets its own DDIC connection.
 *
 * Opened through lib/db.js, which reopens it when the files behind it
 * are replaced -- a corpus swapped under a running server is otherwise
 * served from the old files indefinitely, silently. The collection list
 * and counts below are derived from it and go stale with the same
 * event, so they are cleared when it reopens.
 */
var db = require(WEB + "/lib/db.js");
var CORPUS_FILES = ["corpus.tbl", "corpus_Doc_Source_ftx.dat"];
function corpusReopened() { SOURCES = null; DOCS = {}; ARCHIVES = 0; CORPUS = 0; }
function corpus() { return db.open(DB, CORPUS_FILES, corpusReopened); }
var sql = corpus();

/* Collection list and sizes, read once per thread from the registry.
 *
 * A corpus row's Source is NOT always its staging table's name, so this
 * cannot tally lips_sources.TableName: that listed 39 gutenberg_en_*
 * names which match no row in corpus, while omitting "gutenberg", which
 * matches 60,672 -- and the validator below then REJECTED ?source=
 * gutenberg as unknown. corpus_merged records the Source each unit went
 * in under; tables merged before that registry existed used
 * Source == TableName, which is the fallback. Same fix as lib/tools.js.
 */
var SOURCES = null, DOCS = {}, ARCHIVES = 0, CORPUS = 0;
/* The news items live in their own database, so the dropdown's "News"
 * entry searches that instead of the corpus. Same shape of result goes
 * back to the page, with the outlets attached: an item is not a document
 * and has no stored text to open, so it links out to who reported it.
 */
var NEWS_DB = ((typeof confData !== "undefined" && confData) ? String(confData)
                                                             : LIPS + "/build") + "/news";
/* The news database is replaced daily, so it gets the same treatment.
   Its coverage metadata is read per call, so there is nothing cached to
   clear here. */
var NEWS_FILES = ["news.tbl", "wikipedia_en_news.tbl"];
function newsSql() {
    var s = db.open(NEWS_DB, NEWS_FILES, function (h) {
        /* The index was built without a noiselist so short tokens stay
           searchable; the query side has to match or the term is dropped
           before it reaches the index. Set on each new handle. */
        try { h.set({ noiseList: [] }); h.set({ qMinWordLen: 1 }); } catch (e) {}
    });
    return s;
}

/* Is kiwix answering? The page offers its library only when it is: a
   "browse archives" link to a dead port is worse than no link. Probed
   once per thread with a short TTL -- apps/doc.js keeps its own copy for
   the same reason, with the same shape. */
var KIWIX_URL = "http://127.0.0.1:8098";
var kiwixOk = false, kiwixAt = 0;
var KIWIX_TTL = 15000;
function kiwixUp() {
    var now = Date.now();
    if (now - kiwixAt < KIWIX_TTL) return kiwixOk;
    kiwixAt = now;
    try {
        var curl = require("rampart-curl");
        var r = curl.fetch(KIWIX_URL + "/viewer", { "max-time": 2, nobody: true });
        kiwixOk = !!(r && Number(r.status) >= 200 && Number(r.status) < 400);
    } catch (e) { kiwixOk = false; }
    return kiwixOk;
}

function newsCount() {
    var s = newsSql();
    if (!s) return 0;
    var n = 0;
    try { s.exec("select Val from news_meta where Prop = ?;", ["items"],
                 { maxRows: 1 }, function (r) { n = Number(r.Val) || 0; }); }
    catch (e) {}
    return n;
}

/* The offline-useful half of a news item: the Wikipedia articles this
 * install actually holds. The outlets that reported an event need a
 * connection; these do not. Event pages (written for the event, present
 * only in the news database) come before background articles from the
 * corpus.
 */
function localDocs(ns, links) {
    var out = [];
    if (!links.length) return out;
    links.forEach(function (t) {
        if (out.length >= 3) return;
        var hit = null;
        try {
            ns.exec("select Title from wikipedia_en_news where SrcPath = ?;",
                    ["A/" + t + ".html"], { maxRows: 1 },
                    function (r) { hit = String(r.Title); });
        } catch (e) {}
        if (hit) out.push({ id: "news:" + t, title: hit, kind: "event page" });
    });
    links.forEach(function (t) {
        if (out.length >= 3) return;
        if (out.some(function (d) { return d.id === "news:" + t; })) return;
        var hit = null;
        try {
            sql.exec("select Title from corpus where Source = ? and SrcPath = ?;",
                     ["wikipedia_en", t], { maxRows: 1 },
                     function (r) { hit = String(r.Title); });
        } catch (e) {}
        if (hit) out.push({ id: "wikipedia_en:" + t, title: hit, kind: "background" });
    });
    return out;
}

/* Matching event articles, so choosing News searches the new pages too
 * and not only the headlines. They are documents, so they render as
 * normal hits with a local link. */
function newsDocs(ns, q, n) {
    var out = [];
    if (!q) return out;
    try {
        ns.exec("select Title, SrcPath, Nbytes, $rank rnk, " +
                "stringformat('%mCH', ?, abstract(Doc, 260, 'querybest', ?)) snip " +
                "from wikipedia_en_news where Doc likep ?;",
                [q, q, q], { maxRows: n }, function (r) {
            var path = String(r.SrcPath).replace(/^A\//, "").replace(/\.html$/, "");
            if (/^Portal_Current_events/.test(path)) return;
            out.push({ pos: 0, kind: "newsdoc", source: "news", site: "new article",
                       rank: Number(r.rnk) || 0, title: String(r.Title),
                       path: path, snippet: String(r.snip || "") });
        });
    } catch (e) {}
    return out;
}

function newsSearch(q, skip, n) {
    var s = newsSql();
    if (!s) return { json: { error: "this install has no news table" } };
    var t0 = Date.now(), hits = [], total = -1, cov = {};
    try {
        s.exec("select Val, Prop from news_meta;", { maxRows: 20 },
               function (r) { cov[String(r.Prop)] = String(r.Val); });
    } catch (e) {}
    /* Items are short, so the whole item is the snippet: stringformat
       marks the query terms in it, the way abstract()'s output is marked
       for corpus hits. Ordered by date when there is no query. */
    var where = q ? " where Doc likep ?" : "";
    /* Ordered in SQL for the no-query listing: paging happens before any
       JS sort could run, so sorting the page gave the three oldest items
       in date order rather than the three newest. texis has no ORDER BY
       alias, hence the column position; Date is indexed and no likep is
       involved, so this is not the $rank ordering that costs an order of
       magnitude. */
    var sqlText = "select Date, Section, Topic, Sources, Links, $rank rnk, " +
                  (q ? "stringformat('%mCH', ?, Doc)" : "Doc") + " snip " +
                  "from news" + where +
                  (q ? "" : " order by 1 desc") + ";";
    var params = q ? [q, q] : [];
    try {
        s.exec(sqlText, params, { skipRows: skip, maxRows: n, includeCounts: true },
               function (r, i, cols, info) {
            if (total < 0 && info) total = parseInt(info.indexCount, 10);
            var outlets = String(r.Sources || "").split("\n")
                .filter(function (l) { return l.length; })
                .map(function (l) { var p = l.split("\t");
                                    return { outlet: p[0], url: p[1] || "" }; });
            hits.push({
                pos: skip + hits.length + 1,
                kind: "news",
                docs: localDocs(s, String(r.Links || "").split(" ")
                                     .filter(function (t) { return t.length; })),
                source: "news",
                site: String(r.Section || ""),
                rank: Number(r.rnk) || 0,
                title: String(r.Date) + (r.Topic ? " \u2014 " + String(r.Topic) : ""),
                path: String(r.Date),
                snippet: String(r.snip || ""),
                outlets: outlets
            });
        });
    } catch (e) {
        return { json: { error: String(e).split("\n")[0] } };
    }

    /* Articles first on page one: they are whole documents on the
       subject, where an item is a sentence about one day of it. */
    var arts = (skip === 0) ? newsDocs(s, q, 3) : [];
    arts.forEach(function (a, i) { a.pos = i + 1; });
    if (arts.length)
        hits.forEach(function (h, i) { h.pos = skip + arts.length + i + 1; });
    return { json: { query: q, source: "news", skip: skip, n: n,
                     results: arts.concat(hits), found: hits.length + arts.length,
                     /* With no predicate there is no index estimate, so
                        the table's own item count is the total. */
                     total: q ? (total < 0 ? hits.length : total)
                              : (Number(cov.items) || hits.length),
                     marked: !!q, mix: hits.length ? { news: hits.length } : {},
                     coverage: { from: cov.firstItem || "", to: cov.lastItem || "",
                                 items: Number(cov.items) || 0 },
                     ms: Date.now() - t0, error: null } };
}

function sources() {
    if (SOURCES) return SOURCES;
    DOCS = {}; ARCHIVES = 0;
    var srcOf = {};
    try {
        sql.exec("select TableName, Source from corpus_merged;",
                 { maxRows: 5000 }, function (r) {
            srcOf[String(r.TableName)] = String(r.Source);
        });
    } catch (e) { /* no registry yet: every Source is its table name */ }
    sql.exec("select TableName, Docs from lips_sources;", { maxRows: 5000 },
             function (r) {
        var t = String(r.TableName), s = srcOf[t] || t;
        DOCS[s] = (DOCS[s] || 0) + Number(r.Docs);
        ARCHIVES++;
    });
    /* Live, not a literal: the hardcoded 48,033,082 went stale the moment
       1.9M rows were merged, and it is shown to the user as fact. */
    try {
        sql.exec("select count(*) c from corpus;", { maxRows: 1 },
                 function (r) { CORPUS = Number(r.c); });
    } catch (e) { CORPUS = 0; }
    SOURCES = Object.keys(DOCS).sort(function (a, b) { return DOCS[b] - DOCS[a]; });
    return SOURCES;
}

module.exports = function (req) {
    /* Re-resolved per request: this is where a replaced corpus is
       noticed. Cheap -- two stat() calls -- and the alternative is
       answering from files that were swapped out hours ago. */
    sql = corpus();
    if (!sql)
        return { json: { error: "no corpus at " + DB, results: [] } };
    /* Single-letter terms (C, R, D) are indexed but unreachable at the
       default qMinWordLen of 2. Set per request, not once at load:
       thread copies re-init the handle and lose connection state. */
    sql.set({ qMinWordLen: 1 });

    var query = (req.query || {});
    var q = String(query.q || "").trim();
    var n = Math.min(Math.max(Number(query.n || 20), 1), 100);
    var src = String(query.source || "").trim();
    /* req.query.skip is a string; parseInt and floor at 0. */
    var skip = parseInt(query.skip, 10);
    if (!skip || skip < 0) skip = 0;

    var all = sources();
    /* "news" is a different database, not a corpus collection, so it is
       routed before the collection validator -- which would otherwise
       drop it as an unknown name and silently search everything. */
    if (src === "news") {
        if (!q) {
            /* No query: list the window newest-first, so picking News and
               pressing search shows what is in there. */
            var r0 = newsSearch("", skip, n);
            if (r0.json) {
                r0.json.corpus = CORPUS; r0.json.archives = ARCHIVES;
                r0.json.kiwix = kiwixUp();
                r0.json.sources = all.map(function (x) {
                    return { name: x, docs: DOCS[x] };
                });
                r0.json.newsItems = newsCount();
            }
            return r0;
        }
        var r1 = newsSearch(q, skip, n);
        if (r1.json) {
            r1.json.corpus = CORPUS; r1.json.archives = ARCHIVES;
                r1.json.kiwix = kiwixUp();
            r1.json.sources = all.map(function (x) {
                return { name: x, docs: DOCS[x] };
            });
            r1.json.newsItems = newsCount();
        }
        return r1;
    }
    if (src && all.indexOf(src) === -1) src = "";

    if (!q) {
        return { json: { query: "", results: [], ms: 0, source: src,
                         skip: 0, total: 0, n: n,
                         corpus: CORPUS, archives: ARCHIVES, kiwix: kiwixUp(),
                         newsItems: newsCount(),
                         sources: all.map(function (s) {
                             return { name: s, docs: DOCS[s] }; }) } };
    }

    /* LIKEP only returns its top `likeprows` rows (default 100), so page 6
       and beyond simply do not exist unless the window is widened. Raise it
       to cover the requested page, and put it BACK to 100 otherwise: the
       connection is per-thread and persists, so a one-off deep page would
       otherwise leave every later search on that thread paying for a wide
       window. Same rule as rampart-web/apps/wikipedia.js. */
    if (skip > 100 - n) sql.set({ likeprows: skip + n });
    else                sql.set({ likeprows: 100 });

    var t0 = Date.now(), hits = [], err = null, marked = true, total = -1;

    /* Snippets come back with the query terms marked up.
     *
     * stringformat's `m` flag runs a Metamorph query over the string and
     * wraps each hit; the query is the argument BEFORE the text. Sub-flag
     * C emits <span class="query querysetN"> -- one class per distinct
     * term -- so the page can theme it, where sub-flag I bakes in
     * #ffff66 and ignores dark mode. H escapes the DOCUMENT text while
     * leaving the inserted tags real, which is what makes the result
     * safe to drop into innerHTML; without H the client would have to
     * escape it and would show literal <span> instead.
     *
     * Every argument is varchar on purpose. SQL stringformat reaches
     * TXgetFldopFromCache() at strfmt.c:461 only on the ARGUMENT CAST
     * path, and that cache is the unlocked TXApp->fldopCache whose fix
     * (2026-07-24) landed in db_misc.c only -- strfmt.c has no __thread.
     * A literal format, a varchar query and abstract()'s varchar result
     * need no cast, so the path is not entered. Do not pass a number
     * here without re-testing concurrency.
     */
    function run(markup) {
        hits.length = 0;
        /* abstract() in the select list is evaluated lazily -- only for the
           rows maxRows returns. The Source predicate rides the compound
           (Doc, Source) index rather than filtering after the fact. */
        var snip = markup
            ? "stringformat('%mCH', ?, abstract(Doc, 260, 'querybest', ?))"
            : "abstract(Doc, 260, 'querybest', ?)";
        var sqlText = "select Source, Site, Title, SrcPath, $rank rnk, " +
                      snip + " snip from corpus " +
                      "where Doc likep ?" +
                      (src ? " and Source = ?;" : ";");
        var params = markup ? [q, q, q] : [q, q];
        if (src) params.push(src);
        /* includeCounts gives countInfo as the 4th callback argument;
           indexCount estimates the total matching rows, which is what the
           "of about N" figure and the Next link both need. The first row of
           a page arrives with i == skip, not i == 0. */
        sql.exec(sqlText, params,
                 { skipRows: skip, maxRows: n, includeCounts: true },
                 function (r, i, cols, info) {
            if (total < 0 && info) total = parseInt(info.indexCount, 10);
            hits.push({
                pos: skip + hits.length + 1,
                source: String(r.Source),
                site: String(r.Site || ""),
                rank: Number(r.rnk),
                title: String(r.Title),
                path: String(r.SrcPath),
                snippet: String(r.snip || "")
            });
        });
    }

    /* If the mark-up form fails -- a query shape stringformat's Metamorph
       pass rejects, say -- fall back to plain snippets rather than
       failing the search, and tell the client which it got. */
    try {
        run(true);
    } catch (e) {
        marked = false;
        try { run(false); }
        catch (e2) { err = String(e2).split("\n")[0]; }
    }

    /* which collections answered, in result order */
    var mix = {};
    hits.forEach(function (h) { mix[h.source] = (mix[h.source] || 0) + 1; });

    return { json: {
        query: q,
        source: src,
        skip: skip,
        n: n,
        /* -1 when texis could not estimate (no fulltext index path). */
        total: isFinite(total) ? total : -1,
        ms: Date.now() - t0,
        error: err,
        corpus: CORPUS,
        archives: ARCHIVES,
        kiwix: kiwixUp(),
        newsItems: newsCount(),
        marked: marked,
        mix: mix,
        sources: all.map(function (s) { return { name: s, docs: DOCS[s] }; }),
        results: hits
    } };
};
