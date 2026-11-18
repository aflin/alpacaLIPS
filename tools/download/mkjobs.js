#!/usr/bin/env rampart
/* Build the download job list for the offline-knowledge corpus.
 *
 *   rampart mkjobs.js [--kiwix] [--hf]
 *
 * jobs.tsv, one line per file:
 *     dest <TAB> sha256-or-dash <TAB> bytes <TAB> url [<TAB> alt-url ...]
 *
 * Kiwix comes through the Metalink (.meta4) files its own OPDS
 * catalogue advertises on lb.download.kiwix.org -- the sanctioned bulk
 * path.  Each carries a sha-256 and 8 public mirrors; the mirror order
 * is rotated per file so the pool shares the load, and the alternates
 * stay on the job line so a retry can move hosts.
 *
 * Hugging Face is enumerated from the dataset's `siblings` list
 * (?full=true), because the tree API pages at 50 entries and silently
 * truncated several of these repos.  Sizes come from a HEAD per file.
 */
rampart.globalize(rampart.utils);
var curl = require("rampart-curl");

/* The tree this file sits in, two levels up, and whatever config.sh or
   config.local.sh says the big directories are. */
var LIPS  = rampart.utils.realPath(process.scriptPath + "/../..");
var ROOT = require("../paths.js").dataDir(LIPS);
var META = process.env.META || (ROOT + "/meta");
var UA   = "rampart-keep/0.7 (offline corpus build; contact: admin@rampart.dev)";

function arg(n) { return process.argv.indexOf("--" + n) >= 0; }
var only = arg("kiwix") || arg("hf");
var doKiwix = arg("kiwix") || !only;
var doHf    = arg("hf")    || !only;

function get(u, t) {
    var r = curl.fetch(u, { headers: { "User-Agent": UA },
                            location: true, "max-time": t || 60 });
    return (r && r.status === 200 && r.text) ? r.text : null;
}

var jobs = [];

/* ---------------- kiwix ---------------- */
if (doKiwix) {
    /* The working copy under $META if there is one -- refresh-urls.sh
       writes it -- otherwise the list this repo ships beside this file. */
    var ulist = META + "/kiwix-urls.txt";
    if (!stat(ulist)) ulist = process.scriptPath + "/kiwix-urls.txt";
    printf("kiwix: url list %s\n", ulist);
    mkdir(META + "/meta4");          /* recursive; first run has neither */
    var list = readFile(ulist, { returnString: true })
                 .split("\n").filter(function (l) { return l.trim().length; });
    printf("kiwix: resolving %d metalink(s)\n", list.length);
    var ok = 0, bad = 0;
    list.forEach(function (u, idx) {
        var name = u.substring(u.lastIndexOf("/") + 1);
        var cache = META + "/meta4/" + name, body = null;
        if (stat(cache)) {
            body = readFile(cache, { returnString: true });
            if (body.indexOf("<metalink") < 0) body = null;   /* reject junk */
        }
        if (!body) {
            body = get(u.trim());
            if (!body || body.indexOf("<metalink") < 0) { bad++; return; }
            fprintf(cache, "%s", body);
        }
        var fn = /<file name="([^"]+)"/.exec(body);
        var sz = /<size>(\d+)<\/size>/.exec(body);
        var sh = /<hash type="sha-256">([0-9a-f]+)<\/hash>/.exec(body);
        var urls = [], re = /<url[^>]*priority="\d+"[^>]*>([^<]+)<\/url>/g, m;
        while ((m = re.exec(body)) !== null) urls.push(m[1]);
        if (!fn || !urls.length) { bad++; return; }
        var off = idx % urls.length;
        var ordered = urls.slice(off).concat(urls.slice(0, off));
        jobs.push([ ROOT + "/kiwix/" + fn[1], sh ? sh[1] : "-",
                    sz ? sz[1] : "0" ].concat(ordered.slice(0, 4)).join("\t"));
        ok++;
        if (ok % 40 === 0) printf("  %d/%d\n", ok, list.length);
    });
    printf("kiwix: %d job(s), %d failed\n", ok, bad);
}

/* ---------------- huggingface ---------------- */
if (doHf) {
    var repos = [
        { repo: "HuggingFaceFW/fineweb-edu",      pre: "sample/10BT/",  dir: "fineweb-edu-10BT" },
        { repo: "HuggingFaceFW/fineweb-edu",      pre: "sample/100BT/", dir: "fineweb-edu-100BT" },
        { repo: "wikimedia/wikipedia",            pre: "20231101.en/",  dir: "wikipedia-en-20231101" },
        { repo: "wikimedia/structured-wikipedia", pre: "enwiki/data/",  dir: "structured-wikipedia-en" },
        { repo: "pile-of-law/pile-of-law",        pre: "data/",         dir: "pile-of-law" },
        { repo: "sedthh/gutenberg_english",       pre: "data/",         dir: "gutenberg-english" },
        { repo: "MedRAG/textbooks",               pre: "chunk/",        dir: "medrag-textbooks" }
    ];
    printf("huggingface:\n");
    repos.forEach(function (r) {
        var txt = get("https://huggingface.co/api/datasets/" + r.repo + "?full=true", 120);
        if (!txt) { printf("  %-34s API failed -- SKIPPED\n", r.repo); return; }
        var info;
        try { info = JSON.parse(txt); } catch (e) {
            printf("  %-34s bad JSON -- SKIPPED\n", r.repo); return;
        }
        var sibs = (info.siblings || []).map(function (s) { return s.rfilename; })
                     .filter(function (p) { return p && p.indexOf(r.pre) === 0; });
        var cnt = 0, bytes = 0;
        sibs.forEach(function (p) {
            var base = p.substring(p.lastIndexOf("/") + 1);
            var url = "https://huggingface.co/datasets/" + r.repo + "/resolve/main/" + p;
            var hr = curl.fetch(url, { headers: { "User-Agent": UA }, location: true,
                                       nobody: true, "max-time": 60 });
            var len = 0;
            if (hr && hr.headers) {
                var h = hr.headers["content-length"] || hr.headers["Content-Length"];
                if (h) len = Number(h) || 0;
            }
            jobs.push([ ROOT + "/hf/" + r.dir + "/" + base, "-", String(len), url ].join("\t"));
            cnt++; bytes += len;
        });
        printf("  %-34s %3d file(s)  %7.2f GB\n", r.repo, cnt, bytes / 1073741824);
    });
}

fprintf(META + "/jobs.tsv", "%s\n", jobs.join("\n"));
var tot = 0, nk = 0, nh = 0;
jobs.forEach(function (j) {
    var f = j.split("\t");
    tot += Number(f[2]) || 0;
    if (f[0].indexOf("/kiwix/") > 0) nk++; else nh++;
});
printf("\n%d job(s) (%d kiwix, %d hf), %.2f GB -> %s/jobs.tsv\n",
       jobs.length, nk, nh, tot / 1073741824, META);
