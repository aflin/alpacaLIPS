#!/usr/bin/env rampart
/* Build the news ZIM: the current-events portal for the window, plus the
 * articles it links that the corpus does not already have.
 *
 *   rampart news-zim.js --init   [--since YYYY-MM-DD]
 *   rampart news-zim.js --update
 *
 * Both modes run the same code. They differ only in what gets re-fetched:
 * --init walks the whole window with an empty cache, --update re-reads the
 * current month and re-fetches the event pages that have changed since.
 *
 * WHY A ZIM. The pages enter the corpus through extract/zim2jsonl.py and
 * import/kiwix-import.js, exactly like every other collection: same
 * selectors from families.js, same Title/SrcPath/Nbytes conventions, same
 * lips_sources registry row. A sidecar naming the mwoffliner family is what
 * routes them there, so no second extractor exists to drift out of step.
 * ZIM is write-once, so each run rebuilds the file from the cache -- which
 * is why the cache, not the ZIM, is the thing that must not be lost.
 *
 * THE CACHE IS APPEND-ONLY. Nothing here deletes a fetched page. A page
 * that leaves the window stays on disk; it simply stops being packed.
 *
 * WHOLE MONTHS. The window start is a day, but the portal is fetched by
 * month, so a start of 08-18 pulls all of August. The extra fortnight is
 * a few hundred KB and it covers the fetch smear inside the Wikipedia ZIM
 * (articles in one build are fetched over about a week, so the real
 * "everything after this may be missing" boundary predates the filename).
 *
 * POLITE. One request at a time, PAUSE ms apart. An --init over a 90 day
 * window is ~1300 article fetches, so budget an hour; an --update is a
 * few dozen seconds.
 */
rampart.globalize(rampart.utils);
var Sql  = require("rampart-sql");
var curl = require("rampart-curl");

/* The tree this file sits in, so a clone anywhere works. */
var LIPS   = process.env.LIPS || rampart.utils.realPath(process.scriptPath + "/..");
var DB    = LIPS + "/build/corpus";
var ROOT  = LIPS + "/build/news-src";
var ILLUS = LIPS + "/tools/news-illustration.png";
var UA    = "alpacalips/0.1 (+https://rampart.dev; admin@rampart.dev)";
var API   = "https://en.wikipedia.org/w/api.php";
var REST  = "https://en.wikipedia.org/api/rest_v1/page/html/";

var MODE = "", SINCE = "", PAUSE = 3000, ALL = 0, DRY = 0, LIMIT = 0;
/* Images come from the thumb CDN, not an API, so they get their own
   much shorter pause: 2,255 files at the API's 3s would be two hours to
   fetch 15 MB of static assets. */
var IMAGES = 1, IMGPAUSE = 500;
for (var i = 2; i < process.argv.length; i++) {
    var a = process.argv[i];
    if      (a === "--init")    MODE  = "init";
    else if (a === "--update")  MODE  = "update";
    else if (a === "--since")   SINCE = process.argv[++i];
    else if (a === "--pause")   PAUSE = Number(process.argv[++i]);
    else if (a === "--root")    ROOT  = process.argv[++i];
    else if (a === "--limit")   LIMIT = Number(process.argv[++i]);
    else if (a === "--all")     ALL   = 1;
    else if (a === "--no-images") IMAGES = 0;
    else if (a === "--img-pause") IMGPAUSE = Number(process.argv[++i]);
    else if (a === "--dry-run") DRY   = 1;
    else { printf("unknown option %s\n", a); process.exit(1); }
}
if (!MODE) {
    printf("usage: news-zim.js --init [--since YYYY-MM-DD] | --update\n" +
           "       [--all] [--pause MS] [--limit N] [--root DIR] [--dry-run]\n\n" +
           "  --all    pack every linked article, not only those the corpus\n" +
           "           lacks (about 4x the size: the corpus already has 86%%)\n" +
           "  --limit  stop after N article fetches, for a trial run\n" +
           "  --no-images  leave the pictures out (the pages then show\n" +
           "           broken images offline, but the ZIM is ~15 MB smaller)\n");
    process.exit(1);
}

var CACHE   = ROOT + "/cache";
var PAGES   = CACHE + "/pages";
var PORTALS = CACHE + "/portal";
var MEDIA   = CACHE + "/media";
var STATEF  = CACHE + "/state.json";
var STAGE   = ROOT + "/staging";
var OUT     = ROOT + "/out";
["", "/cache", "/cache/pages", "/cache/portal", "/cache/media",
 "/out"].forEach(function (d) {
    exec("mkdir", "-p", ROOT + d);
});

/* ---------- state: what we have fetched, and at which revision ------- */
var state = { pages: {}, portals: {}, redirects: {} };
if (stat(STATEF)) {
    try { state = JSON.parse(readFile(STATEF, { returnString: true })); }
    catch (e) { printf("warning: unreadable %s, starting fresh\n", STATEF); }
}
if (!state.pages)     state.pages = {};
if (!state.portals)   state.portals = {};
if (!state.redirects) state.redirects = {};
if (!state.canon)     state.canon = {};
function saveState() { fprintf(STATEF, "%s", JSON.stringify(state, null, 1)); }

/* A title is stored under its percent-encoded form: titles contain "/"
   and other characters a filename cannot carry (AC/DC, 50/50). */
function cacheFile(title) { return PAGES + "/" + encodeURIComponent(title) + ".html"; }

/* ---------- images ---------------------------------------------------
 * Parsoid points at the live thumb CDN, so a stored page without them
 * shows broken pictures offline -- which is the whole point of storing
 * it. Each distinct image is fetched once, cached, and referenced from
 * the staged HTML as ../I/<key>; articles live at A/<Title>.html, so
 * that resolves inside the ZIM.
 *
 * srcset is dropped rather than followed: its 1.5x and 2x variants are
 * 9,177 more files for a page nobody is zooming, and a srcset left
 * pointing at the CDN would quietly win over the local src.
 */
function mediaKey(url) {
    /* Deterministic, short, and collision-resistant enough: the last
       path segment for legibility plus a hash of the whole url. */
    var h = 5381, i;
    for (i = 0; i < url.length; i++) h = ((h * 33) ^ url.charCodeAt(i)) & 0x7fffffff;
    var tail = String(url).split("?")[0].split("/").pop() || "img";
    tail = tail.replace(/[^A-Za-z0-9._-]/g, "_");
    if (tail.length > 48) tail = tail.substring(tail.length - 48);
    return h.toString(36) + "_" + tail;
}
/* NOT named absUrl: rampart.utils has a function of that name, and
   after rampart.globalize() the global is non-configurable -- a function
   declaration with the same name is silently ignored and every call
   lands in rampart's URL helper instead, which takes (base, url). It
   fails with "second argument must be a string", nowhere near the
   shadowing that caused it. */
function imgAbs(u) {
    if (String(u).substring(0, 2) === "//") return "https:" + u;
    return String(u);
}

/* An attribute value is HTML, so "&" arrives as "&amp;". The thumb CDN
   ignores unknown query parameters and served those fine; maps.wikimedia
   .org needs its real ones and returned nothing for 13 map tiles.
   The KEY stays derived from the raw attribute, so correcting this does
   not invalidate the 2,244 images already cached -- only the fetch url
   is repaired. */
function unentity(u) {
    return String(u).replace(/&amp;/g, "&").replace(/&#38;/g, "&")
                    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

/* Parsoid pages are written to be read ON en.wikipedia.org, and say so:
 *
 *   <base href="//en.wikipedia.org/wiki/"/>
 *
 * That one tag re-points every relative url in the document at the live
 * site, so "../I/foo.png" became https://en.wikipedia.org/I/foo.png --
 * broken images offline even though the file is right there in the
 * archive -- and the stylesheet, a /w/load.php url, needed the internet,
 * which is why the pages rendered full width with no styling at all.
 *
 * So the staged copy drops the base, brings the stylesheet in with it,
 * and resolves links: to the article in this archive where there is one,
 * to en.wikipedia.org otherwise. An external link that is plainly
 * external beats a relative one that 404s inside the archive.
 */
function rewriteOffline(html, wantImg, wantCss, haveArticle) {
    var out = String(html);

    /* 1. the base tag */
    out = out.replace(/<base\b[^>]*>/gi, "");

    /* 2. the stylesheet: one shared load.php bundle per page variant */
    out = out.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/gi, function (tag) {
        var m = /\bhref="([^"]+)"/i.exec(tag);
        if (!m) return tag;
        var href = unentity(m[1]);
        if (href.indexOf("load.php") < 0) return tag;
        var abs = href.substring(0, 1) === "/" ? "https://en.wikipedia.org" + href
                                               : imgAbs(href);
        var key = mediaKey(abs) + ".css";
        wantCss[abs] = key;
        return tag.replace(m[0], 'href="../S/' + key + '"');
    });

    /* 3. internal links */
    out = out.replace(/href="\.\/([^"]+)"/g, function (whole, target) {
        var t = decodeURIComponent(target.split("#")[0]).replace(/ /g, "_");
        var frag = target.indexOf("#") > -1 ? "#" + target.split("#").slice(1).join("#") : "";
        if (haveArticle[t]) return 'href="../A/' + t + '.html' + frag + '"';
        return 'href="https://en.wikipedia.org/wiki/' + target + '"';
    });

    /* 4. the images, as before */
    return rewriteImages(out, wantImg);
}

/* Rewrite one article's markup for offline use, collecting what it
   needs. The cache keeps the original; only the staged copy is
   rewritten. */
function rewriteImages(html, want) {
    return String(html).replace(/<img\b[^>]*>/gi, function (tag) {
        var m = /\bsrc="([^"]+)"/i.exec(tag);
        if (!m) return tag;
        var raw = m[1];
        var u = imgAbs(unentity(raw));
        if (u.substring(0, 4) !== "http") return tag;
        /* Keyed on the raw attribute, fetched with the decoded url. */
        var key = mediaKey(imgAbs(raw));
        want[u] = key;
        var out = tag.replace(m[0], 'src="../I/' + key + '"');
        out = out.replace(/\s+srcset="[^"]*"/gi, "")
                 .replace(/\s+sizes="[^"]*"/gi, "");
        return out;
    });
}

var nreq = 0;
function get(url) {
    if (nreq++) sleep(PAUSE / 1000);   /* rampart sleep() takes seconds */
    var r = curl.fetch(url, { headers: { "User-Agent": UA }, "max-time": 90,
                              location: true, "max-redirs": 3 });
    if (!r || Number(r.status) !== 200) return null;
    return String(r.text);
}

/* Binary fetch: curl writes the body to a file rather than through JS,
   so an image never becomes a string. */
var nimg = 0;
function getFile(url, path) {
    if (nimg++) sleep(IMGPAUSE / 1000);
    var r = exec("curl", "-fsSL", "-m", "120", "-A", UA, "-o", path, url);
    return r.exitStatus === 0 && stat(path) && Number(stat(path).size) > 0;
}

/* ---------- the window ----------------------------------------------- */
var sql = new Sql.init(DB);
function windowStart() {
    if (SINCE) return SINCE;
    /* The full-wikipedia build, not the newest archive in the collection:
       wikipedia_en_medicine is newer but covers medicine only, and using
       it would claim coverage the corpus does not have. */
    var asof = "";
    sql.exec("select Zim, Asof from lips_sources where Collection = ?;",
             ["wikipedia"], { maxRows: 50 }, function (r) {
        var z = String(r.Zim), s = String(r.Asof || "");
        if (/_all_/.test(z) && s > asof) asof = s;
    });
    var floor = new Date(Date.now() - 30 * 86400000);
    var start = asof ? new Date(new Date(asof + "T00:00:00Z").getTime() - 7 * 86400000)
                     : floor;
    if (start.getTime() > floor.getTime()) start = floor;
    return dateFmt("%Y-%m-%d", start);
}
var START = windowStart();
var TODAY = dateFmt("%Y-%m-%d", new Date());

/* Whole months from START to today. */
var MONTH_NAMES = ["January","February","March","April","May","June","July",
                   "August","September","October","November","December"];
function monthsIn(from, to) {
    var a = from.split("-"), b = to.split("-"), out = [];
    var y = Number(a[0]), m = Number(a[1]);
    while (y < Number(b[0]) || (y === Number(b[0]) && m <= Number(b[1]))) {
        out.push(MONTH_NAMES[m - 1] + "_" + y);
        if (++m > 12) { m = 1; y++; }
    }
    return out;
}
var MONTHS = monthsIn(START, TODAY);
printf("mode     : %s\nwindow   : %s .. %s\nmonths   : %s\n",
       MODE, START, TODAY, MONTHS.join(", "));

/* ---------- 1. the portal month pages -------------------------------- */
/* The rendered month page carries every day transcluded into it, so one
   fetch per month replaces ninety daily fetches. The current month is
   always re-read because it grows; the one before it is re-read too, for
   a few days, because late edits land after a month turns over. */
var CURRENT = MONTH_NAMES[new Date().getUTCMonth()] + "_" + new Date().getUTCFullYear();
var PREV_IDX = MONTHS.length - 2;
var fetchedPortals = 0;
MONTHS.forEach(function (mon, idx) {
    var f = PORTALS + "/" + mon + ".html";
    var have = stat(f);
    var stale = (mon === CURRENT) ||
                (idx === PREV_IDX && Number(dateFmt("%d", new Date())) <= 5);
    if (have && !stale) return;
    if (DRY) { printf("  would fetch portal %s\n", mon); return; }
    var url = REST + encodeURIComponent("Portal:Current events/" + mon);
    var html = get(url);
    if (!html) { printf("  portal %s: FETCH FAILED\n", mon); return; }
    fprintf(f, "%s", html);
    state.portals[mon] = { fetched: TODAY, bytes: html.length };
    fetchedPortals++;
    printf("  portal %-16s %d bytes%s\n", mon, html.length, have ? " (refreshed)" : "");
});
saveState();

/* ---------- 2. the articles those pages link ------------------------- */
/* Parsoid writes internal links as href="./Title". Namespaced pages are
   context, not content, and the portal links its own scaffolding. */
var SKIP_NS = /^(Portal|File|Category|Template|Wikipedia|Help|Special|Talk|User|Module|Draft|MediaWiki|wikt|s|commons|c|m):/;
var linked = {};
MONTHS.forEach(function (mon) {
    var f = PORTALS + "/" + mon + ".html";
    if (!stat(f)) return;
    var html = readFile(f, { returnString: true });
    var re = /href="\.\/([^"#]+)"/g, m;
    while ((m = re.exec(html)) !== null) {
        var t = decodeURIComponent(m[1]).replace(/_/g, " ").replace(/\s+/g, " ").trim();
        if (!t || SKIP_NS.test(t)) continue;
        linked[t.replace(/ /g, "_")] = 1;
    }
});
var titles = Object.keys(linked).sort();
printf("linked   : %d distinct articles across %d month pages\n", titles.length, MONTHS.length);

/* ---------- 3. canonicalise, and learn the redirects ----------------- */
/* Resolving redirects here does two jobs: it stops us fetching the same
   article under two names, and it fills the TSV that lets links inside
   the ZIM resolve (CEO -> Chief executive officer). */
function canonicalise(list) {
    /* Cached per title, because this is the expensive step: 6,878 titles
       is 159 batched calls, and an update that re-asked about all of them
       would cost eight minutes a day to learn nothing. Only titles never
       resolved before are sent. */
    var out = {}, batch = [], n = 0, asked = 0;
    list = list.filter(function (t) {
        var c = state.canon[t];
        if (c === undefined) return true;
        if (c) out[c] = 1;              /* "" means absent upstream */
        return false;
    });
    printf("canon    : %d known, %d to resolve\n", Object.keys(state.canon).length, list.length);
    function flush() {
        if (!batch.length) return;
        var url = API + "?action=query&format=json&formatversion=2&redirects=1&titles=" +
                  encodeURIComponent(batch.join("|"));
        var body = DRY ? null : get(url);
        if (body) {
            try {
                var d = JSON.parse(body);
                (d.query.redirects || []).forEach(function (r) {
                    var from = String(r.from).replace(/ /g, "_"),
                        to   = String(r.to).replace(/ /g, "_");
                    state.redirects[from] = to;
                });
                (d.query.pages || []).forEach(function (p) {
                    var asTitle = String(p.title).replace(/ /g, "_");
                    if (p.missing) { state.canon[asTitle] = ""; return; }
                    out[asTitle] = 1;
                    state.canon[asTitle] = asTitle;
                });
                /* A redirect's source resolves to its target, so the next
                   run does not ask about it again. */
                (d.query.redirects || []).forEach(function (r) {
                    state.canon[String(r.from).replace(/ /g, "_")] =
                        String(r.to).replace(/ /g, "_");
                });
            } catch (e) { printf("  canonicalise: bad JSON for a batch of %d\n", batch.length); }
        }
        batch = [];
    }
    list.forEach(function (t) {
        batch.push(t.replace(/_/g, " "));
        if (batch.length >= 45) { flush(); n++; }
    });
    flush();
    saveState();
    return Object.keys(out);
}
var canon = DRY ? titles : canonicalise(titles);
printf("canonical: %d after redirects (%d redirects known)\n",
       canon.length, Object.keys(state.redirects).length);

/* ---------- 4. drop what the corpus already has ---------------------- */
var want = [], inCorpus = 0;
canon.forEach(function (t) {
    if (!ALL) {
        var found = 0;
        sql.exec("select SrcPath from corpus where Source = ? and SrcPath = ?;",
                 ["wikipedia_en", t], { maxRows: 1 }, function () { found = 1; });
        if (found) { inCorpus++; return; }
    }
    want.push(t);
});
printf("to pack  : %d articles (%d already in the corpus%s)\n",
       want.length, inCorpus, ALL ? ", packed anyway" : ", skipped");

/* ---------- 5. fetch what is missing or has changed ------------------ */
/* Everything we pack is, by definition, absent from the corpus: a page
   created for a recent event. Those grow for days afterwards, so a
   cached copy is checked against the live revision and re-fetched when
   it has moved on. Background articles are not chased -- the news item
   itself carries what is new about them. */
function currentRevs(list) {
    var revs = {}, batch = [];
    function flush() {
        if (!batch.length) return;
        var url = API + "?action=query&format=json&formatversion=2&prop=revisions" +
                  "&rvprop=ids|timestamp&titles=" + encodeURIComponent(batch.join("|"));
        var body = get(url);
        if (body) {
            try {
                JSON.parse(body).query.pages.forEach(function (p) {
                    if (p.missing || !p.revisions) return;
                    revs[String(p.title).replace(/ /g, "_")] = p.revisions[0].revid;
                });
            } catch (e) {}
        }
        batch = [];
    }
    list.forEach(function (t) {
        batch.push(t.replace(/_/g, " "));
        if (batch.length >= 45) flush();
    });
    flush();
    return revs;
}

var cachedWanted = want.filter(function (t) { return stat(cacheFile(t)); });
var live = (DRY || !cachedWanted.length) ? {} : currentRevs(cachedWanted);

var nnew = 0, nupd = 0, nhave = 0, nfail = 0;
for (var w = 0; w < want.length; w++) {
    var t = want[w], f = cacheFile(t), st = state.pages[t] || {};
    var haveIt = stat(f);
    var changed = haveIt && live[t] && st.revid && Number(live[t]) !== Number(st.revid);
    if (haveIt && !changed) { nhave++; continue; }
    if (LIMIT && (nnew + nupd) >= LIMIT) { printf("  --limit %d reached\n", LIMIT); break; }
    if (DRY) { printf("  would fetch %s%s\n", t, changed ? " (changed)" : ""); haveIt ? nupd++ : nnew++; continue; }
    var html = get(REST + encodeURIComponent(t.replace(/_/g, " ")));
    if (!html) { printf("  %s: FETCH FAILED\n", t); nfail++; continue; }
    fprintf(f, "%s", html);
    state.pages[t] = { fetched: TODAY, bytes: html.length,
                       revid: live[t] || (st.revid || 0) };
    if (changed) nupd++; else nnew++;
    if (((nnew + nupd) % 25) === 0) { saveState(); printf("  ... %d fetched\n", nnew + nupd); }
}
saveState();
printf("fetched  : %d new, %d updated, %d already cached, %d failed\n",
       nnew, nupd, nhave, nfail);
if (DRY) { printf("\ndry run: nothing written\n"); process.exit(0); }

/* ---------- 6. stage and pack --------------------------------------- */
/* Hard links, not copies: the staging tree is rebuilt every run and the
   cache is the only real storage. */
exec("rm", "-rf", STAGE);
exec("mkdir", "-p", STAGE + "/A");
if (IMAGES) exec("mkdir", "-p", STAGE + "/I");
var packed = 0, wantImg = {}, wantCss = {};
/* Which titles this archive will actually contain, so a link can be
   resolved to it rather than sent to the live site. */
var haveArticle = {};
want.forEach(function (t) { if (stat(cacheFile(t))) haveArticle[t] = 1; });
want.forEach(function (t) {
    var f = cacheFile(t);
    if (!stat(f)) return;
    var dest = STAGE + "/A/" + t + ".html";
    if (IMAGES) {
        /* The staged copy is rewritten, so it cannot be a hard link to
           the cache -- the cache must stay exactly as fetched. */
        fprintf(dest, "%s", rewriteOffline(readFile(f, { returnString: true }),
                                           wantImg, wantCss, haveArticle));
    } else {
        var r = exec("ln", "-f", f, dest);
        if (r.exitStatus !== 0) exec("cp", f, dest);
    }
    packed++;
});

/* The portal pages themselves, so the month's news is browsable and
   searchable as a document, not only as parsed items. */
MONTHS.forEach(function (mon) {
    var f = PORTALS + "/" + mon + ".html";
    if (!stat(f)) return;
    var name = "Portal_Current_events_" + mon;
    var dest = STAGE + "/A/" + name + ".html";
    if (IMAGES)
        fprintf(dest, "%s", rewriteOffline(readFile(f, { returnString: true }),
                                           wantImg, wantCss, haveArticle));
    else
        exec("ln", "-f", f, dest);
    packed++;
});

/* The stylesheets the pages asked for, with their own icon references
   brought local too, plus the one rule MediaWiki's content styles do not
   carry: a readable measure. Without it the text runs the full width of
   the window, because the skin that normally constrains it is not part
   of the article HTML. */
if (IMAGES && Object.keys(wantCss).length) {
    exec("mkdir", "-p", STAGE + "/S");
    Object.keys(wantCss).forEach(function (u) {
        var key = wantCss[u], cf = MEDIA + "/" + key;
        if (!stat(cf) && !getFile(u, cf)) {
            printf("  stylesheet FAILED: %s\n", u.substring(0, 90));
            return;
        }
        var css = readFile(cf, { returnString: true });
        /* url(/w/resources/...) would resolve against the archive and
           404; pull each one in beside the images. */
        css = String(css).replace(/url\(([^)]+)\)/g, function (whole, ref) {
            var r = ref.replace(/^['"]|['"]$/g, "");
            if (r.substring(0, 5) === "data:") return whole;
            /* "//host/path" is protocol-relative, not site-relative:
               prefixing the host gave en.wikipedia.org//upload.wikimedia
               .org/... Check the two-slash form first. */
            var abs = (r.substring(0, 2) === "//") ? imgAbs(r)
                    : (r.substring(0, 1) === "/") ? "https://en.wikipedia.org" + r
                    : imgAbs(r);
            if (abs.substring(0, 4) !== "http") return whole;
            var ik = mediaKey(abs);
            wantImg[abs] = ik;
            return "url(../I/" + ik + ")";
        });
        css += "\n/* alpacalips: the article html carries no skin, so give it a measure */\n" +
               "body{max-width:62em;margin:0 auto;padding:1.2em 1.4em;" +
               "font-family:sans-serif;line-height:1.6}\n" +
               "img{max-width:100%;height:auto}\n" +
               "figure,.infobox,table{max-width:100%}\n";
        fprintf(STAGE + "/S/" + key, "%s", css);
        packed++;
    });
    printf("styles   : %d stylesheet(s)\n", Object.keys(wantCss).length);
}

/* Fetch what the staged pages now reference, skipping anything already
   in the media cache. */
var imgNew = 0, imgHave = 0, imgFail = 0, imgBytes = 0;
if (IMAGES) {
    var urls = Object.keys(wantImg);
    printf("images   : %d distinct referenced\n", urls.length);
    urls.forEach(function (u) {
        var key = wantImg[u], mf = MEDIA + "/" + key;
        if (stat(mf)) { imgHave++; }
        else if (getFile(u, mf)) { imgNew++; }
        else {
            /* Named, not just counted: 11 failures with no url between
               them told me nothing about why. */
            imgFail++;
            printf("  image FAILED: %s\n", u.substring(0, 110));
            exec("rm", "-f", mf); return;
        }
        var st = stat(mf);
        if (st) imgBytes += Number(st.size);
        var lr = exec("ln", "-f", mf, STAGE + "/I/" + key);
        if (lr.exitStatus !== 0) exec("cp", mf, STAGE + "/I/" + key);
        packed++;
        if (imgNew && (imgNew % 200) === 0) printf("  ... %d images fetched\n", imgNew);
    });
    printf("images   : %d fetched, %d cached, %d failed, %.1f MB\n",
           imgNew, imgHave, imgFail, imgBytes / 1048576);
}
var idx = "<html><head><meta charset=\"UTF-8\"><title>Current events</title></head><body>" +
          "<h1>Current events, " + START + " to " + TODAY + "</h1><ul>";
MONTHS.forEach(function (mon) {
    idx += "<li><a href=\"A/Portal_Current_events_" + mon + ".html\">" +
           mon.replace("_", " ") + "</a></li>";
});
idx += "</ul><p>" + want.length + " articles created for events in this window.</p>" +
       "<p>Text from Wikipedia, CC BY-SA 4.0.</p></body></html>";
fprintf(STAGE + "/index.html", "%s", idx);

if (!stat(ILLUS)) {
    printf("\nmissing %s -- zimwriterfs needs a 48x48 PNG illustration\n", ILLUS);
    process.exit(1);
}
exec("cp", ILLUS, STAGE + "/illustration.png");

/* Redirects that point at something we packed, so a link inside the ZIM
   resolves instead of dangling. */
var rtsv = "", nred = 0, packedSet = {};
want.forEach(function (t) { packedSet[t] = 1; });
Object.keys(state.redirects).forEach(function (from) {
    var to = state.redirects[from];
    if (!packedSet[to] || from === to) return;
    rtsv += "A/" + from + ".html\t" + from.replace(/_/g, " ") + "\tA/" + to + ".html\n";
    nred++;
});
var RTSV = ROOT + "/redirects.tsv";
if (nred) fprintf(RTSV, "%s", rtsv);

var ZIMNAME = "wikipedia_en_news_" + START + "_" + TODAY + ".zim";
var ZIMPATH = OUT + "/" + ZIMNAME;
exec("rm", "-f", ZIMPATH);
var args = ["-w", "index.html", "-I", "illustration.png", "-l", "eng",
            "-n", "wikipedia_en_news",
            "-t", "Current events " + TODAY.substring(0, 7),
            "-d", "Current events " + START + " to " + TODAY + ", with cited articles",
            "-L", "The current events portal for " + START + " to " + TODAY +
                  ", with the articles created for those events.",
            "-c", "Wikipedia contributors", "-p", "alpacalips"];
if (nred) args = args.concat(["-r", RTSV]);
args = args.concat([STAGE, ZIMPATH]);
var z = exec.apply(null, ["zimwriterfs"].concat(args));
/* zimwriterfs 3.2.0 rejects the redirect TSV its own man page documents
   (url, title, target_url, tab separated) in every arrangement tried, so
   the file is attempted and dropped rather than allowed to block the
   build. Redirects inside the ZIM are cosmetic here: the corpus resolves
   95% of the portal's links already, and the news items read correctly
   with no link resolving at all. The map is still written beside the ZIM
   so nothing is lost and the items importer can use it. */
if ((z.exitStatus !== 0 || !stat(ZIMPATH)) && nred) {
    printf("note     : zimwriterfs rejected the redirect file, building without it\n");
    var plain = [];
    for (var ai = 0; ai < args.length; ai++) {
        if (args[ai] === "-r") { ai++; continue; }
        plain.push(args[ai]);
    }
    z = exec.apply(null, ["zimwriterfs"].concat(plain));
}
if (z.exitStatus !== 0 || !stat(ZIMPATH)) {
    printf("zimwriterfs failed: %s\n", String(z.stderr || z.stdout).substring(0, 400));
    process.exit(1);
}

/* The sidecar routes this through the mwoffliner selectors in
   families.js, so these pages are extracted exactly like the rest of
   Wikipedia rather than through a second code path. */
fprintf(ZIMPATH + ".meta.json", "%s",
        JSON.stringify({ zim: ZIMNAME, zimScraper: "mwoffliner 2.1.1",
                         asof: TODAY, windowStart: START,
                         articles: want.length, redirects: nred }, null, 1));
/* The redirect map as data: a title the portal linked, and the article
   it really means. The items table needs this to turn a link into a
   document id. */
fprintf(OUT + "/redirects.json", "%s", JSON.stringify(state.redirects, null, 1));

printf("\npacked   : %d entries (%d redirects)\n", packed, nred);
printf("zim      : %s (%.1f MB)\n", ZIMPATH, Number(stat(ZIMPATH).size) / 1048576);
printf("sidecar  : %s.meta.json\n", ZIMPATH);
printf("\nnext: rampart %s/import/kiwix-import.js --db <newsdb> --src <jsonl>\n" +
       "      after extract/zim2jsonl.py, which is what run-import.sh does.\n", LIPS);
