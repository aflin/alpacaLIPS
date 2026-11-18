/* Registry status: one line per imported archive, totals at the end.
   Filtering is done in JS so no SQL string quoting is needed. */
var Sql = require("rampart-sql");
var p = rampart.utils.printf;
var argv = process.argv;
var i = argv.indexOf("--db");
var LIPS = process.env.LIPS || rampart.utils.realPath(process.scriptPath + "/..");
var sql = new Sql.init(i > 0 ? argv[i + 1] : LIPS + "/build/corpus", true);
/* Any bare argument is a filter on the archive name. */
var want = "";
for (var a = 2; a < argv.length; a++)
    if (argv[a].indexOf("--") !== 0 && argv[a - 1] !== "--db") want = String(argv[a]);
var n = 0, docs = 0, bytes = 0;
sql.exec("select Zim, TableName, Docs, Nbytes, Skipped, Failed from lips_sources;",
    { maxRows: 5000 },
    function (r) {
        var z = String(r.Zim);
        n++; docs += Number(r.Docs); bytes += Number(r.Nbytes);
        if (want && z.indexOf(want) === -1) return;
        if (want) p("  %-48s %9s docs  %7.1f MB  skip=%s fail=%s\n",
                    z, r.Docs, Number(r.Nbytes)/1048576, r.Skipped, r.Failed);
    });
p("  registry: %d archives, %s docs, %.1f GB of text\n",
  n, docs, bytes/1073741824);
