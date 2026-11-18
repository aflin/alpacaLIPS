/* Serve a stored document straight out of the corpus table, so a citation
 * can link to something the reader can open and check.
 *
 *   /apps/doc?id=wikipedia_en:Tourniquet
 *   /apps/doc?id=...&raw=1                 unformatted text/plain
 *   /apps/doc?id=...&start=4200&len=1200   just that window, as cited
 *
 * The text is what the importer extracted, not the original page: no
 * images, no markup, paragraph breaks only. That is the point -- it is the
 * exact bytes the index was built from and that excerpt() quoted, so a
 * reader can confirm a quotation character for character.
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
var tools = require(WEB + "/lib/tools.js");

/* One connection per thread; texis engine state is single-threaded. */
/* Opened through lib/db.js so a corpus replaced under a running
   server is noticed rather than served from the old files for ever;
   see the measurements there. Re-resolved per request below. */
var db = require(WEB + "/lib/db.js");
var CORPUS_FILES = ["corpus.tbl", "corpus_cx.dat"];
function corpusReopened() { META = null; tools.corpusReopened(); }
function corpus() { return db.open(tools.DB, CORPUS_FILES, corpusReopened); }
var sql = corpus();

function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/* lips_sources carries the provenance a citation needs: which archive the
   document came from and when that archive was made. */
var META = null;
function meta(source, site) {
    if (!META) {
        META = {};
        /* Keyed by BOTH TableName+Site and Collection+Site. A corpus row's
           Source is sometimes one and sometimes the other: gutenberg's 39
           slices were merged under a single Source of "gutenberg" with the
           slice on Site, so keying only on TableName left every Gutenberg
           document with NO provenance -- no archive name, no snapshot
           date -- while wikipedia_en resolved fine. TableName wins on a
           clash, being the more specific key. Same fix as lib/tools.js
           and apps/search.js. */
        sql.exec("select TableName, Site, Zim, Asof, Collection " +
                 "from lips_sources;", { maxRows: 2000 }, function (r) {
            var s = String(r.Site || "");
            var rec = { zim: String(r.Zim), asof: String(r.Asof),
                        collection: String(r.Collection) };
            META[String(r.TableName) + "\u0000" + s] = rec;
            var ck = String(r.Collection) + "\u0000" + s;
            if (!META[ck]) META[ck] = rec;
        });
    }
    return META[source + "\u0000" + (site || "")] ||
           META[source + "\u0000"] || null;
}

/* Is kiwix-serve answering right now?
 *
 * ONE citation URL has to serve both worlds: /apps/doc?id=... is what
 * search results and MCP citations point at, forever, and what it
 * DISPLAYS depends only on whether kiwix is up. With kiwix running it
 * redirects to the proxied archive page (images, formatting); with kiwix
 * down it renders the stored text. A link shared today therefore still
 * works after the archives are removed, which the old split -- :8098
 * links in flavour 2, :8099 links in flavour 1 -- could not promise.
 *
 * Probed per request, not at startup, so starting or stopping kiwix
 * takes effect without restarting this server. Cached briefly per
 * thread: a module-level cache is copied to each server thread and each
 * has its own, so staleness is bounded by the TTL rather than lasting
 * until a reload (the mistake ZIM_OF made).
 */
var KIWIX = (process.env && (typeof confKiwix !== "undefined" && confKiwix))
          ? String(confKiwix) : "http://127.0.0.1:8098";
var KIWIX_TTL = 15000;
var kiwixOkAt = 0, kiwixOk = false;

function kiwixUp() {
    var now = Date.now();
    if (now - kiwixOkAt < KIWIX_TTL) return kiwixOk;
    kiwixOkAt = now;
    try {
        var curl = require("rampart-curl");
        var r = curl.fetch(KIWIX + "/viewer", { "max-time": 2, nobody: true });
        kiwixOk = !!(r && r.status >= 200 && r.status < 400);
    } catch (e) {
        kiwixOk = false;
    }
    return kiwixOk;
}

/* The proxied archive page for a document, or null when the archive it
   came from is unknown. Path segments are encoded individually: a
   SrcPath carries slashes that must stay slashes. */
/* The news zim, when this install has one. It is packed by
   import/news-zim.js with -n wikipedia_en_news, and kiwix serves a book
   under its NAME, not its filename -- which is why this is a constant
   rather than something read from the registry. The entry path inside
   it is already "A/<Title>.html", the SrcPath we store. */
var NEWS_BOOK = "wikipedia_en_news";
var newsBookOk = null;
function newsZimUrl(path) {
    if (newsBookOk === null) {
        /* Asked once per thread: a book is not added or removed under a
           running server without a library change, and the kiwix probe
           below already covers kiwix going away. */
        try {
            var curl = require("rampart-curl");
            var r = curl.fetch(KIWIX + "/content/" + NEWS_BOOK + "/",
                               { "max-time": 3, nobody: true });
            newsBookOk = !!(r && Number(r.status) < 500);
        } catch (e) { newsBookOk = false; }
    }
    if (!newsBookOk) return null;
    return "/content/" + NEWS_BOOK + "/" +
           String(path).split("/").map(encodeURIComponent).join("/");
}

function zimUrl(source, site, path) {
    if (source === "news") return newsZimUrl(path);
    var m = meta(source, site);
    if (!m || !m.zim) return null;
    /* /content/... not /zim/content/...: kiwix's own viewer emits bare
       /content/ links (viewer.js:500 ignores its root), so staying in
       that namespace keeps navigation inside one prefix instead of
       bouncing between two. /zim/ remains mounted as an alias. */
    return "/content/" + String(m.zim).replace(/\.zim$/, "") + "/" +
           String(path).split("/").map(encodeURIComponent).join("/");
}

module.exports = function (req) {
    sql = corpus();
    if (!sql) return { status: 503, json: { error: "no corpus at " + tools.DB } };
    var query = req.query || {};
    var id = String(query.id || "").trim();
    if (!id) {
        return { status: 400, json: { error: "id is required",
                 usage: "/apps/doc?id=<source>:<path>[&text=1][&raw=1]" +
                        "[&start=N&len=M]" } };
    }

    var parts = tools.splitId(id);
    if (!parts) {
        return { status: 400, json: { error: "malformed id, expected " +
                 "<source>:<path>", got: id } };
    }

    var row = null;
    try {
        if (parts.source === "news") {
            /* The event articles are in their own database, so a
               citation of one has to be read from there. Without this
               every news: url returned 404 -- a citation that does not
               open is worse than no citation. */
            var ns = tools.newsSql && tools.newsSql();
            if (!ns)
                return { status: 404, json: { error: "this install has no news table",
                                              id: id } };
            ns.exec("select 'news' Source, Site, Title, SrcPath, Nbytes, Doc " +
                    "from wikipedia_en_news where SrcPath = ?;",
                    ["A/" + parts.path + ".html"], { maxRows: 1 },
                    function (r) { row = r; });
        } else {
            sql.exec("select Source, Site, Title, SrcPath, Nbytes, Doc " +
                     "from corpus where SrcPath = ? and Source = ?;",
                     [parts.path, parts.source], { maxRows: 1 },
                     function (r) { row = r; });
        }
    } catch (e) {
        return { status: 500, json: { error: String(e).split("\n")[0] } };
    }
    if (!row) return { status: 404, json: { error: "no such document",
                                            id: id } };

    var title = String(row.Title), src = String(row.Source);
    var site = String(row.Site || ""), path = String(row.SrcPath);

    /* The whole point of the single URL: with kiwix up, hand the reader
       the real archive page. &text=1 forces the stored text, which is
       what makes a quotation checkable character for character, and
       &raw=1 or a &start= window imply it -- neither has a kiwix
       equivalent. */
    if (!query.text && !query.raw && num(query.start, -1) < 0) {
        var zu = zimUrl(src, site, path);
        if (zu && kiwixUp()) {
            return { status: 302, headers: { "location": zu },
                     html: '<!doctype html><meta charset="utf-8">' +
                           '<p>Moved to <a href="' + esc(zu) + '">' +
                           esc(title) + "</a></p>" };
        }
    }
    var full;
    try { full = String(row.Doc); }
    catch (e) {
        /* Invalid UTF-8 out of SQL throws in duktape rather than
           returning replacement characters. Report it instead of 500ing. */
        return { status: 500, json: { error: "document text is not valid " +
                 "UTF-8 and cannot be rendered", id: id } };
    }

    /* A window, when the citation pointed at one. */
    var start = num(query.start, -1), len = num(query.len, 1200);
    var windowed = (start >= 0);
    var text = windowed ? full.substring(start, start + len) : full;

    if (query.raw) {
        return { text: text, headers: { "Content-Type":
                 "text/plain; charset=utf-8" } };
    }

    var m = meta(src, site) || {};
    var selfBase = "/apps/doc?id=" + encodeURIComponent(id);
    var label = src + (site ? " (" + site + ")" : "");
    /* Shown only when there is somewhere to go: with kiwix down this
       page IS the document, and a dead link would be worse than none. */
    var zu = zimUrl(src, site, path);
    var pageLink = (zu && kiwixUp())
        ? ' &middot; <a href="' + esc(zu) + '">archive page</a>' : "";

    var head =
      "<!doctype html><html><head><meta charset=\"utf-8\">" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<title>" + esc(title) + "</title><style>" +
      "body{margin:0;font:16px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;" +
      "color:#1a1a1a;background:#fff}" +
      "header{padding:18px 20px;border-bottom:1px solid #ddd;background:#fafafa}" +
      "h1{margin:0 0 6px;font-size:21px;line-height:1.25}" +
      "dl{margin:0;font-size:13px;color:#555;display:grid;" +
      "grid-template-columns:max-content 1fr;gap:2px 10px}" +
      "dt{font-weight:600}dd{margin:0}" +
      "nav{margin-top:10px;font-size:13px}nav a{margin-right:14px}" +
      "pre{white-space:pre-wrap;word-wrap:break-word;margin:0;padding:20px;" +
      "font:15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-width:52em}" +
      ".note{padding:10px 20px;background:#fff8e1;border-bottom:1px solid #f0e0a0;" +
      "font-size:13px}" +
      "@media(prefers-color-scheme:dark){body{background:#151515;color:#e4e4e4}" +
      "header{background:#1e1e1e;border-color:#333}dl{color:#aaa}" +
      ".note{background:#2a2410;border-color:#4a3f14}}" +
      "</style></head><body>";

    var hdr = "<header><h1>" + esc(title) + "</h1><dl>" +
      "<dt>collection</dt><dd>" + esc(label) + "</dd>" +
      "<dt>path</dt><dd>" + esc(path) + "</dd>" +
      "<dt>id</dt><dd>" + esc(id) + "</dd>" +
      (m.zim ? "<dt>archive</dt><dd>" + esc(m.zim) +
               (m.asof ? " &middot; snapshot " + esc(m.asof) : "") +
               pageLink + "</dd>" : "") +
      "<dt>size</dt><dd>" + full.length + " characters</dd>" +
      "</dl><nav>" +
      "<a href=\"" + selfBase + "&text=1&raw=1\">raw text</a>" +
      (windowed ? "<a href=\"" + selfBase + "&text=1\">whole document</a>" : "") +
      "</nav></header>";

    var note = windowed
      ? "<div class=\"note\">Showing characters " + start + "&ndash;" +
        (start + text.length) + " of " + full.length + ".</div>"
      : "";

    return { html: head + hdr + note + "<pre>" + esc(text) + "</pre>" +
                   "</body></html>" };
};
