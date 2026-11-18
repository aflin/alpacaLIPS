/* The body of server_conf.js.
 *
 * setup.sh writes the settings as plain variables at the top of
 * server_conf.js and appends this file after them, so the running
 * config is a readable JS file with no environment behind it. That
 * matters on macOS: the server is daemonized through launchd, whose
 * plist carries only HOME and PATH, so an LIPS_BIND=... handed to
 * `servers.sh start` never reached the server at all -- it came up on
 * loopback and reported the address it had been asked for.
 *
 * The variables the header defines:
 *   confAddr  a comma separated list: "localhost", "all", addresses,
 *             or any mix of them ("10.0.0.9, localhost")
 *   confPort  the port
 *   confBase  citation link base; "" means each client's own host
 *   confData  where the database lives (<root>/build by default)
 *   confZim   where the archives live
 *
 * They are ordinary globals, so the app modules see them too -- which
 * is how apps/*.js and lib/tools.js get the citation base.
 */

var working_directory = process.scriptPath;

/* A path inside this tree, resolved. The generated header above calls
   this for confData and confZim so that moving or renaming the whole
   directory needs no edit -- function declarations are hoisted over the
   entire script, so it is callable from the header even though it is
   declared here.
   realPath THROWS on a path that does not exist, and zim/ is absent on
   a corpus-only install, so the unresolved path is the fallback rather
   than an exception that stops the server. */
function confPath(rel) {
    var p = String(process.scriptPath).replace(/[\/]web[\/]?$/, "") + "/" + rel;
    try { return rampart.utils.realPath(p); } catch (e) { return p; }
}

/* ---- relocatable root ------------------------------------------------
 * This file lives in <root>/web, so the tree root is its parent. Setting
 * LIPS here is what lets every app module find the database, the zim
 * directory and lib/tools.js without a compiled-in path -- an unpacked
 * tarball works wherever it lands, which is the whole point of shipping
 * one. confData is separate so the ~275 GB of data can sit on another disk
 * from the code.
 */
var LIPS = String(working_directory).replace(/[\/]web[\/]?$/, "");

var PORT = Number(confPort) || 8099;

/* confAddr is a list, so that a server reachable on a LAN address can
   also answer on loopback -- local clients, health checks and
   servers.sh status all talk to 127.0.0.1, and binding one interface
   used to cut them off. Square brackets mean IPv6; a bare token with a
   colon in it is treated as IPv6 and bracketed. */
function bindList(spec, port) {
    var out = [], seen = {};
    function add(a) { if (!seen[a]) { seen[a] = 1; out.push(a); } }
    String(spec).split(",").forEach(function (tok) {
        tok = tok.replace(/^\s+|\s+$/g, "");
        if (!tok) return;
        if (/^(all|\*|0\.0\.0\.0)$/i.test(tok)) {
            add("0.0.0.0:" + port); add("[::]:" + port); return;
        }
        if (/^localhost$/i.test(tok)) {
            add("127.0.0.1:" + port); add("[::1]:" + port); return;
        }
        if (tok.charAt(0) === "[") { add(tok + ":" + port); return; }
        if (tok.indexOf(":") >= 0) { add("[" + tok + "]:" + port); return; }
        add(tok + ":" + port);
    });
    if (!out.length) { add("127.0.0.1:" + port); add("[::1]:" + port); }
    return out;
}

var BINDS = bindList(confAddr || "localhost", PORT);
rampart.utils.printf("root     = %s\nlisten   = %s\n", LIPS, BINDS.join(", "));

var serverConf = {
    /* A listen block, not port/ipAddr: ipAddr holds one address per
       family, and the whole point here is more than one. A block with
       no map of its own inherits the one built from appendMap below,
       so the routes are unaffected. */
    listen:    [ { bind: BINDS } ],
    scriptTimeout: 60,        /* a cold cache query can take seconds */
    /* Not about connecting: rampart-webserver.js defaults this to 20 and
     * rampart-server.c applies it as the WRITE timeout too, so any reply
     * taking longer than it is cut mid-stream even while making full
     * speed. Serving 5 GiB payload parts needs room for a slow client:
     * 5 GiB at 1 MB/s is 85 minutes. */
    connectTimeout: 14400,
    threads:   4,
    log:       true,
    dataRoot:  confData,
    directoryFunc: false
};

/* A name would reach this point only if setup.sh had been bypassed:
   it resolves names before writing confAddr, because rampart binds
   addresses and a name makes the bind fail outright. */
BINDS.forEach(function (b) {
    var host = b.replace(/:[0-9]+$/, "");
    if (/[A-Za-z]/.test(host) && host.charAt(0) !== "[") {
        rampart.utils.fprintf(rampart.utils.stderr,
            "confAddr contains \"%s\", which is a name, not an address.\n" +
            "Use an address, \"localhost\", or \"all\" -- or re-run ./setup.sh,\n" +
            "which resolves names for you.\n", host);
        process.exit(1);
    }
});

/* ---- kiwix-serve, reverse-proxied so one port faces the world -------
 *
 * The ZIM archives are served by kiwix-serve on 127.0.0.1:8098. Rather
 * than exposing a second port, mount it here: /zim/ proxies to the kiwix
 * root, so /zim/viewer and /zim/content/<archive>/<page> both work and
 * citations can point at this server alone.
 *
 * MOUNTED UNCONDITIONALLY, and deliberately not gated on a startup
 * probe. The route's existence is no longer the thing that decides what
 * a reader sees: apps/doc.js probes kiwix per request and either
 * redirects here or renders the stored text, so starting or stopping
 * kiwix takes effect with no restart of this server. Gating the mount
 * would have put that decision back at startup -- kiwix brought up
 * afterwards would leave doc.js redirecting to a route that was never
 * mapped, which is a 404 and a puzzle rather than a fallback.
 * The cost is that hitting a /zim/ url directly while kiwix is down
 * gives 502 rather than 404. That is honest: the route exists, the
 * upstream does not.
 *
 * Upstream is "/" not "/zim/": the matched local prefix is REPLACED by
 * the upstream path, so /zim/viewer -> 8098/viewer. kiwix's own pages
 * reference their assets relatively ("./skin/kiwix.css"), which resolve
 * back under /zim/ in the browser and proxy through unchanged -- that is
 * what makes mounting it under a prefix work without re-rooting kiwix
 * with --urlRootLocation. The one exception is an absolute
 * "/skin/blank.html" in the viewer, so /skin/ is mapped too.
 */
var KIWIX = "http://127.0.0.1:8098";

/* Mounted 1:1 at the top level, NOT only under /zim/.
 *
 * kiwix's viewer.js builds some URLs absolutely, and not all of them
 * honour its root: line 33 is `${root}/content/${url}` but line 500 is
 * a bare `/content/${book}/${path}` and line 503 a bare `/search?...`.
 * So a prefix mount alone breaks viewer navigation -- the reported case
 * was /content/cooking.stackexchange.com_.../questions 404ing from a
 * page served under /zim/. Re-rooting kiwix with --urlRootLocation
 * would not fix it either, because those two lines ignore root entirely.
 *
 * Mirroring kiwix's own paths means every URL it emits resolves as
 * emitted, absolute or relative, with no dependence on its root setting
 * and no kiwix restart. /zim/ stays as an alias so links already shared
 * keep working.
 *
 * These names are now ours as far as this server is concerned: /search
 * in particular is taken, so our own search endpoint stays at
 * /apps/search.json.
 */
var KIWIX_PATHS = ["/content/", "/skin/", "/catalog/", "/raw/",
                   "/viewer", "/search", "/suggest", "/random"];

/* Hosted payloads: the prebuilt corpus, the runtime tarball and
 * optionally the archives, served as plain static files.
 *
 * A static directory, not a handler: the C server sends the bytes.
 * NOTE for anyone writing download instructions -- open-ended ranges
 * ("Range: bytes=N-", which is what `curl -C -` and `wget -c` send on a
 * resume) are capped at defaultRangeMBytes, 8 MB by default, and the
 * client then stops thinking it is done. BOUNDED ranges are not capped,
 * and a plain GET with no Range is fine. setup.sh resumes with a bounded
 * range built from the size in the MANIFEST for exactly this reason, so
 * it installs correctly from a mirror served by this server. Tell anyone
 * writing their own fetch loop the same thing: give the range an end.
 */
/* downloads/ is also where the build puts what it fetches -- the
   archive pool, the job lists, the extracted staging -- so only the
   published payload directory is served, not the whole of it. The URL
   is unchanged: /downloads/alpacalips/... is what setup.sh asks for. */
var DOWNLOADS = LIPS + "/downloads/alpacalips";

serverConf.appendMap = { "/zim/": { proxy: KIWIX + "/", timeout: 60 } };
if (rampart.utils.stat(DOWNLOADS))
    serverConf.appendMap["/downloads/alpacalips/"] = DOWNLOADS;
KIWIX_PATHS.forEach(function (p) {
    serverConf.appendMap[p] = { proxy: KIWIX + p, timeout: 60 };
});

/* Informational only -- the routes above are mapped either way. */
(function () {
    var up = false;
    try {
        var curl = require("rampart-curl");
        var r = curl.fetch(KIWIX + "/viewer", { "max-time": 2, nobody: true });
        up = !!(r && r.status >= 200 && r.status < 400);
    } catch (e) { up = false; }
    rampart.utils.printf("kiwix paths + /zim/ -> %s (mounted; kiwix %s)\n",
                         KIWIX,
                         up ? "answering" : "NOT answering -- doc.js will " +
                         "serve stored text until it is");
})();

if (module && module.exports) {
    module.exports = function () {
        serverConf.dumpObj = true;
        var ret = require("rampart-webserver").web_server_conf(serverConf);
        delete ret.dumpObj;
        return ret;
    };
} else {
    var webserver = require("rampart-webserver");
    if (webserver.bundleSetup)
        webserver.bundleSetup(serverConf);
    webserver.web_server_conf(serverConf);
}
