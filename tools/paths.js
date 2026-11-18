/* Where the big directories are, for the tools written in JavaScript.
 *
 * config.sh is shell and cannot be sourced from here, but only one
 * setting matters -- DATA -- and only two files set it: config.local.sh,
 * which is per-machine and not in the repo, then config.sh's own
 * default. Both spell it `DATA=<path>` or `DATA=${DATA:-<path>}`, so one
 * expression reads either, and $LIPS in the value is resolved the same
 * way the shell would.
 *
 * An exported DATA wins over both, exactly as it does in the shell, so
 * ./build.sh --data reaches these tools too.
 *
 * Without this a standalone `rampart tools/zim-link.js` on a machine
 * whose archives live elsewhere looked inside the clone and reported
 * every archive missing.
 */
var u = rampart.utils;
var ASSIGN = /^[ \t]*DATA=(?:\$\{DATA:-)?([^}\s#]+)\}?[ \t]*$/m;

function dataDir(lips) {
    if (process.env.DATA) return String(process.env.DATA);
    var files = [lips + "/config.local.sh", lips + "/config.sh"], i, m, t;
    for (i = 0; i < files.length; i++) {
        if (!u.stat(files[i])) continue;
        t = u.readFile(files[i], { returnString: true });
        m = ASSIGN.exec(t);
        if (m) return m[1].replace(/\$\{?LIPS\}?/g, lips);
    }
    return lips + "/downloads";
}

/* The pool, plus any second pool beside it (a fast-mirror copy, say),
   but only directories that are there: a fresh clone has one. */
function pools(data) {
    var out = [process.env.KIWIX ? String(process.env.KIWIX) : data + "/kiwix"];
    var list;
    try { list = u.readdir(data); } catch (e) { return out; }
    list.forEach(function (f) {
        var d = data + "/" + f, st;
        if (f.indexOf("kiwix-") !== 0 || out.indexOf(d) >= 0) return;
        st = u.stat(d);
        if (st && st.isDirectory) out.push(d);
    });
    return out;
}

module.exports = { dataDir: dataDir, pools: pools };
