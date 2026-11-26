#!/usr/bin/env rampart
/* A browsable page for a download host that cannot list itself.
 *
 *   rampart tools/make-download-index.js [--stage DIR] [--public URL]
 *
 * A public R2 bucket answers GET and HEAD on known object paths and
 * nothing else: / and every prefix return 404, and there is no way to
 * enumerate. So the listing has to be published as an object like any
 * other. This writes two kinds:
 *
 *   <stage>/index.html              what is available, which payload is
 *                                   current, and how to install it
 *   <stage>/corpus-DATE/index.html  that payload's parts and hashes
 *
 * The root page is rewritten on every publish because it changes; a
 * payload's page is written only when missing, because a dated payload
 * never changes and rewriting it would re-upload an identical file
 * under an immutable cache header.
 *
 * No JavaScript, no web fonts, no CDN: this is the download page for an
 * offline corpus, and it should render on whatever browser is to hand.
 * Colours are stated explicitly for both schemes rather than inherited,
 * because a page that renders white-on-white is worse than no page.
 */
rampart.globalize(rampart.utils);

function arg(n, d) {
    var i = process.argv.indexOf("--" + n);
    return i > 0 ? process.argv[i + 1] : d;
}
var STAGE = String(arg("stage", "/imgb/alpacalips")).replace(/\/+$/, "");
/* The addresses to PRINT, which are not the host serving this page: the
   payload may be redirected to object storage, and published
   instructions should not name whatever it is redirected to this week.
   --public is still accepted, and ignored, so an older caller works. */
var CANON = String(arg("base", "https://rampart.dev/downloads/alpacalips"))
                .replace(/\/+$/, "");
var INSTALL = String(arg("install", "https://rampart.dev/install-alpacalips.sh"));

function human(b) {
    b = Number(b) || 0;
    var u = ["B", "KiB", "MiB", "GiB", "TiB"], i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i === 0 ? b.toFixed(0) : b.toFixed(b < 10 ? 2 : 1)) + " " + u[i];
}
function esc(s) {
    return String(s === undefined || s === null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
function slurp(p) {
    try { return bufferToString(readFile(p)); } catch (e) { return ""; }
}
/* VERSION and MANIFEST are "key value" and "name bytes" lines. */
function kv(text) {
    var o = {};
    text.split("\n").forEach(function (l) {
        var m = l.replace(/^\s+|\s+$/g, "").match(/^(\S+)\s+(.*)$/);
        if (m) o[m[1]] = m[2];
    });
    return o;
}
function parts(text) {
    var out = [];
    text.split("\n").forEach(function (l) {
        var m = l.replace(/^\s+|\s+$/g, "").match(/^(\S+)\s+(\d+)$/);
        if (m) out.push({ name: m[1], bytes: Number(m[2]) });
    });
    return out;
}

var CSS = [
    ":root{--bg:#fff;--fg:#111;--dim:#555;--line:#d8d8d8;--acc:#0b5;--code:#f4f4f4}",
    "@media (prefers-color-scheme:dark){:root:not([data-theme=light]){",
    "--bg:#15171a;--fg:#e8e8e8;--dim:#a0a4aa;--line:#33383d;--acc:#2db36a;--code:#1e2126}}",
    "*{box-sizing:border-box}",
    "body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);",
    "font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}",
    "main{max-width:52rem;margin:0 auto}",
    "h1{font-size:1.5rem;margin:0 0 .25rem}",
    "h2{font-size:1.1rem;margin:2rem 0 .5rem;padding-bottom:.25rem;",
    "border-bottom:1px solid var(--line)}",
    "p.sub{color:var(--dim);margin:0 0 1.5rem}",
    "table{border-collapse:collapse;width:100%;font-size:.93rem}",
    "th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line)}",
    "th{color:var(--dim);font-weight:600}",
    "td.n{text-align:right;white-space:nowrap}",
    "code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
    "pre{background:var(--code);padding:.75rem;overflow-x:auto;border-radius:4px;",
    "font-size:.88rem}",
    "a{color:var(--acc)}",
    ".cur{font-weight:600}",
    ".note{color:var(--dim);font-size:.9rem}",
    "dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;margin:0}",
    "dt{color:var(--dim)}dd{margin:0}"
].join("\n");

function page(title, body) {
    return "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
         + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
         + "<title>" + esc(title) + "</title>\n<style>\n" + CSS + "\n</style>\n"
         + "</head>\n<body>\n<main>\n" + body + "</main>\n</body>\n</html>\n";
}

/* ---- gather what is staged ---------------------------------------- */
var cur = slurp(STAGE + "/corpus-current.txt").replace(/\s+/g, "");
var payloads = [];
readDir(STAGE).forEach(function (f) {
    if (!/^corpus-2\d\d\d-\d\d-\d\d(-\d+)?$/.test(f)) return;
    var st = stat(STAGE + "/" + f);
    if (!st || !st.isDirectory) return;
    var mf = parts(slurp(STAGE + "/" + f + "/MANIFEST"));
    if (!mf.length) return;                 /* unfinished: not advertised */
    var v = kv(slurp(STAGE + "/" + f + "/VERSION"));
    var tot = 0;
    mf.forEach(function (p) { tot += p.bytes; });
    payloads.push({
        dir: f, parts: mf, bytes: tot, ver: v,
        extracted: Number(slurp(STAGE + "/" + f + "/EXTRACTED").replace(/\D/g, "")) || 0,
        current: f === cur
    });
});
payloads.sort(function (a, b) { return a.dir < b.dir ? 1 : a.dir > b.dir ? -1 : 0; });

var base = CANON;
var rt = stat(STAGE + "/alpacalips-run.tar.gz");
var vtxt = kv(slurp(STAGE + "/version.txt"));

/* ---- the root page ------------------------------------------------ */
var b = [];
b.push("<h1>alpacaLIPS downloads</h1>");
b.push("<p class=\"sub\">An offline corpus of " +
       esc(vtxt.corpus_documents || (payloads[0] && payloads[0].ver.documents) || "?") +
       " documents from " +
       esc((payloads[0] && payloads[0].ver.archives) || "?") +
       " archives, served over HTTP and MCP.</p>");

b.push("<p class=\"note\">Source, build tooling and issues: "
     + "<a href=\"https://github.com/aflin/alpacaLIPS\">"
     + "github.com/aflin/alpacaLIPS</a>.</p>");

b.push("<h2>Install</h2>");
b.push("<pre>curl -fsSL " + esc(INSTALL) + " | sh</pre>");
b.push("<p class=\"note\">The installer reads <code>corpus-current.txt</code> to find"
     + " the payload below, then fetches its parts. To pin a particular one, pass"
     + " <code>--corpus-dir corpus-YYYY-MM-DD</code>.</p>");

b.push("<p class=\"note\">Downloads may be redirected to object storage;"
     + " the addresses above are the ones that stay put.</p>");
b.push("<h2>Current payload</h2>");
var c = null;
payloads.forEach(function (p) { if (p.current) c = p; });
if (c) {
    b.push("<dl>");
    b.push("<dt>directory</dt><dd><a href=\"" + esc(c.dir) + "/index.html\"><code>"
           + esc(c.dir) + "</code></a></dd>");
    b.push("<dt>download</dt><dd>" + esc(human(c.bytes)) + " in "
           + c.parts.length + " parts</dd>");
    b.push("<dt>installed</dt><dd>" + esc(human(c.extracted)) + " once unpacked</dd>");
    b.push("<dt>documents</dt><dd>" + esc(c.ver.documents || "?") + "</dd>");
    b.push("<dt>packed</dt><dd>" + esc(c.ver.packed || "?") + "</dd>");
    b.push("<dt>identity</dt><dd><code>" +
           esc(String(c.ver.manifest_sha256 || "").substring(0, 32)) + "…</code></dd>");
    b.push("</dl>");
} else {
    b.push("<p class=\"note\">Nothing is published yet.</p>");
}

if (payloads.length > 1) {
    b.push("<h2>Earlier payloads</h2>");
    b.push("<table><tr><th>directory</th><th class=\"n\">download</th>"
         + "<th class=\"n\">documents</th><th>packed</th></tr>");
    payloads.forEach(function (p) {
        if (p.current) return;
        b.push("<tr><td><a href=\"" + esc(p.dir) + "/index.html\"><code>" + esc(p.dir)
             + "</code></a></td><td class=\"n\">" + esc(human(p.bytes))
             + "</td><td class=\"n\">" + esc(p.ver.documents || "?")
             + "</td><td>" + esc((p.ver.packed || "").replace("T", " ").replace("Z", ""))
             + "</td></tr>");
    });
    b.push("</table>");
    b.push("<p class=\"note\">Earlier payloads stay here for about a week so a"
         + " download in progress is never pulled out from under you.</p>");
}

b.push("<h2>Also here</h2>");
b.push("<table><tr><th>file</th><th class=\"n\">size</th><th>what it is</th></tr>");
function row(f, what) {
    var st2 = stat(STAGE + "/" + f);
    if (!st2) return;
    b.push("<tr><td><a href=\"" + esc(f) + "\"><code>" + esc(f) + "</code></a></td>"
         + "<td class=\"n\">" + esc(human(st2.size)) + "</td><td>" + what + "</td></tr>");
}
row("install-alpacalips.sh", "one-line installer");
row("alpacalips-run.tar.gz", "the runtime: server, MCP, web app, setup.sh");
row("version.txt", "what is current, for an install to compare against");
row("INSTRUCTIONS.txt", "what the corpus holds, as the MCP server reports it");
row("INVENTORY.txt", "every archive, with dates and counts");
row("inventory.json", "the same, for programs");
row("corpus-current.txt", "names the current payload directory");
b.push("</table>");

b.push("<h2>Licences</h2>");
b.push("<p class=\"note\">The corpus collects freely licensed sources, mostly"
     + " CC BY-SA and public domain, and each reader page shows the terms for"
     + " the source it came from. "
     + esc(vtxt.licenses ? "Summary: " + vtxt.licenses + "." : "") + "</p>");

/* toISOString rather than dateFmt: the format string comes first
   there, and this needs no format at all. */
var now = new Date().toISOString().replace("T", " ").substring(0, 16) + " UTC";
b.push("<p class=\"note\">Generated " + esc(now) + ".</p>");

writeFile(STAGE + "/index.html", page("alpacaLIPS downloads", b.join("\n")));
printf("  wrote %s/index.html (%d payloads)\n", STAGE, payloads.length);

/* ---- a page per payload, only when missing ------------------------ */
payloads.forEach(function (p) {
    var out = STAGE + "/" + p.dir + "/index.html";
    var q = [];
    q.push("<h1><code>" + esc(p.dir) + "</code></h1>");
    q.push("<p class=\"sub\">" + (p.current ? "The current payload. " : "")
         + esc(p.ver.documents || "?") + " documents, "
         + esc(human(p.bytes)) + " to download, "
         + esc(human(p.extracted)) + " installed.</p>");

    q.push("<h2>Install</h2>");
    if (p.current) {
        /* The whole command: BASE already defaults to the canonical host,
           and corpus-current.txt already names this payload. */
        q.push("<pre>./setup.sh --corpus</pre>");
        q.push("<p class=\"note\">This is the current payload, so that is the"
             + " whole command. To pin this exact one, so a later publish does"
             + " not change what you get:</p>");
        q.push("<pre>./setup.sh --corpus --corpus-dir " + esc(p.dir) + "</pre>");
    } else {
        q.push("<pre>./setup.sh --corpus --corpus-dir " + esc(p.dir) + "</pre>");
        q.push("<p class=\"note\">The <code>--corpus-dir</code> is needed here:"
             + " this is not the current payload, so plain"
             + " <code>./setup.sh --corpus</code> would fetch "
             + esc(cur || "the current one") + " instead.</p>");
    }

    q.push("<h2>Parts</h2>");
    q.push("<table><tr><th>file</th><th class=\"n\">bytes</th><th>sha256</th></tr>");
    p.parts.forEach(function (f) {
        q.push("<tr><td><a href=\"" + esc(f.name) + "\"><code>" + esc(f.name)
             + "</code></a></td><td class=\"n\">" + esc(human(f.bytes))
             + "</td><td><a href=\"" + esc(f.name) + ".sha256\">.sha256</a></td></tr>");
    });
    q.push("</table>");
    q.push("<p class=\"note\">The parts are one gzipped tar, split. Concatenate"
         + " them in order, then unpack:</p>");
    q.push("<pre>cat corpus.tar.gz.part-* | gzip -dc | tar -xf -</pre>");
    q.push("<p class=\"note\">Or let <code>setup.sh</code> do it, which checks"
         + " every part against its sha256 and streams the unpack so only one"
         + " part is on disk at a time.</p>");

    q.push("<h2>Identity</h2>");
    q.push("<dl>");
    ["manifest_sha256", "packed", "documents", "archives", "snapshots"].forEach(function (k) {
        if (p.ver[k]) q.push("<dt>" + esc(k) + "</dt><dd><code>" + esc(p.ver[k])
                             + "</code></dd>");
    });
    q.push("</dl>");
    q.push("<p class=\"note\"><a href=\"../index.html\">All downloads</a> · "
         + "<a href=\"MANIFEST\">MANIFEST</a> · <a href=\"VERSION\">VERSION</a></p>");

    writeFile(out, page(p.dir + " — alpacaLIPS", q.join("\n")));
    printf("  wrote %s/index.html (%d parts)\n", p.dir, p.parts.length);
});
