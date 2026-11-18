#!/usr/bin/env rampart
/* Download progress against jobs.tsv. */
rampart.globalize(rampart.utils);
var LIPS = rampart.utils.realPath(process.scriptPath + "/../..");
var M = process.env.META || (require("../paths.js").dataDir(LIPS) + "/meta");
var groups = {};
readFile(M + "/jobs.tsv", { returnString: true }).split("\n").forEach(function (l) {
    if (!l.trim().length) return;
    var f = l.split("\t"), dest = f[0], want = Number(f[2]) || 0;
    var parts = dest.split("/");
    var g = (dest.indexOf("/kiwix/") > 0) ? "kiwix" : parts[parts.length - 2];
    if (!groups[g]) groups[g] = { n: 0, done: 0, want: 0, have: 0, partial: 0 };
    var G = groups[g];
    G.n++; G.want += want;
    var s = stat(dest);
    if (s) {
        G.have += s.size;
        if (want && s.size === want) G.done++; else G.partial++;
    }
});
printf("%-26s %5s %5s %5s %10s %10s %6s\n",
       "group", "files", "done", "part", "GB have", "GB want", "%");
var tn = 0, td = 0, th = 0, tw = 0;
Object.keys(groups).sort().forEach(function (k) {
    var G = groups[k];
    tn += G.n; td += G.done; th += G.have; tw += G.want;
    printf("%-26s %5d %5d %5d %10.2f %10.2f %5.1f%%\n", k, G.n, G.done, G.partial,
           G.have / 1073741824, G.want / 1073741824,
           G.want ? 100 * G.have / G.want : 0);
});
printf("%-26s %5d %5d %5s %10.2f %10.2f %5.1f%%\n", "TOTAL", tn, td, "",
       th / 1073741824, tw / 1073741824, tw ? 100 * th / tw : 0);
