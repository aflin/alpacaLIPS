#!/usr/bin/env rampart
/* Build download jobs for the maxi-flavour ZIMs (images included).
 * sha256 and size come from each file's Kiwix Metalink; the bytes are
 * fetched from ftp.fau.de, measured at ~13 MB/s against 1.78 MB/s for
 * the rotated mirror pool, with the Metalink mirrors kept as fallbacks. */
rampart.globalize(rampart.utils);
var curl = require("rampart-curl");

var LB   = "https://lb.download.kiwix.org/zim/";
var FAU  = "https://ftp.fau.de/kiwix/zim/";
var LIPS  = rampart.utils.realPath(process.scriptPath + "/../..");
var DATA = require("../paths.js").dataDir(LIPS);
var DEST = (process.env.KIWIX || (DATA + "/kiwix")) + "/";
var META = process.env.META || (DATA + "/meta");
var UA   = "rampart-keep/0.7 (offline corpus build; contact: admin@rampart.dev)";

var want = [
  ["wikipedia",   "wikipedia_en_all_maxi_2026-08.zim"],
  ["wikipedia",   "wikipedia_en_medicine_maxi_2026-10.zim"],
  ["wikisource",  "wikisource_en_all_maxi_2026-09.zim"],
  ["wikibooks",   "wikibooks_en_all_maxi_2026-10.zim"],
  ["wikiversity", "wikiversity_en_all_maxi_2026-11.zim"],
  ["wikivoyage",  "wikivoyage_en_all_maxi_2026-09.zim"],
  ["wikiquote",   "wikiquote_en_all_maxi_2026-10.zim"]
];

mkdir(META + "/meta4");              /* recursive; first run has neither */
var jobs = [], tot = 0;
want.forEach(function (w) {
    var coll = w[0], file = w[1];
    var cache = META + "/meta4/" + file + ".meta4", body = null;
    if (stat(cache)) {
        body = readFile(cache, { returnString: true });
        if (body.indexOf("<metalink") < 0) body = null;
    }
    if (!body) {
        var r = curl.fetch(LB + coll + "/" + file + ".meta4",
                           { headers: { "User-Agent": UA }, location: true, "max-time": 60 });
        if (!r || r.status !== 200 || !r.text || r.text.indexOf("<metalink") < 0) {
            printf("  %-46s metalink FAILED\n", file); return;
        }
        body = r.text;
        fprintf(cache, "%s", body);
    }
    var sz = /<size>(\d+)<\/size>/.exec(body);
    var sh = /<hash type="sha-256">([0-9a-f]+)<\/hash>/.exec(body);
    var mirrors = [], re = /<url[^>]*priority="\d+"[^>]*>([^<]+)<\/url>/g, m;
    while ((m = re.exec(body)) !== null) mirrors.push(m[1]);
    if (!sz) { printf("  %-46s no size in metalink\n", file); return; }
    var urls = [FAU + coll + "/" + file].concat(mirrors.slice(0, 3));
    jobs.push([DEST + file, sh ? sh[1] : "-", sz[1]].concat(urls).join("\t"));
    tot += Number(sz[1]);
    printf("  %-46s %7.2f GB  sha %s\n", file, Number(sz[1]) / 1073741824,
           sh ? "yes" : "NO");
});
fprintf(META + "/jobs-maxi.tsv", "%s\n", jobs.join("\n"));
printf("\n%d job(s), %.2f GB -> %s/jobs-maxi.tsv\n", jobs.length, tot / 1073741824, META);
