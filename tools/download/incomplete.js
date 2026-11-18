#!/usr/bin/env rampart
/* Print the jobs.tsv lines whose destination is missing or short. */
rampart.globalize(rampart.utils);
var LIPS = rampart.utils.realPath(process.scriptPath + "/../..");
var M = process.env.META || (require("../paths.js").dataDir(LIPS) + "/meta");
var out = [];
readFile(M + "/jobs.tsv", { returnString: true }).split("\n").forEach(function (l) {
    if (!l.trim().length) return;
    var f = l.split("\t"), want = Number(f[2]) || 0;
    var s = stat(f[0]);
    if (!s || (want && s.size !== want)) out.push(l);
});
if (out.length) printf("%s\n", out.join("\n"));
