/* Publish what the corpus holds, for people deciding whether to fetch it.
 *
 *   rampart tools/publish-inventory.js [--db DIR] [--out DIR]
 *
 * Writes INVENTORY.txt (to read) and inventory.json (to parse) beside
 * the payloads, so the question "what is actually in this 112 GB?" can
 * be answered with a 4 KB download. The opening sentence is taken from
 * web/lib/corpus-inventory.js, the file the build generates and the MCP
 * server serves, so the published description and the one a model is
 * given are the same words.
 *
 * Run by make-payloads.sh. Reads lips_sources for the per-collection
 * table, which carries dates the one-line summary cannot.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");

var DB = "", OUT = "";
for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--db") DB = process.argv[++i];
    else if (process.argv[i] === "--out") OUT = process.argv[++i];
}
var HERE = (process.scriptPath || ".").replace(/[\/]tools[\/]?$/, "");
if (!DB)  DB  = HERE + "/build/corpus";
if (!OUT) OUT = HERE + "/downloads/alpacalips";

var summary = "";
try { summary = String(require(HERE + "/web/lib/corpus-inventory.js").text); }
catch (e) { summary = ""; }

var sql = new Sql.init(DB);
var coll = {};
sql.exec("select Collection, Docs, Nbytes, Asof, Zim from lips_sources;",
         { maxRows: 5000 }, function (r) {
    var c = String(r.Collection || "other");
    var k = coll[c] || (coll[c] = { n: 0, docs: 0, bytes: 0, lo: "", hi: "" });
    k.n++;
    k.docs  += Number(r.Docs) || 0;
    k.bytes += Number(r.Nbytes) || 0;
    var a = String(r.Asof || "").substring(0, 7);
    if (a.length === 7) {
        if (!k.lo || a < k.lo) k.lo = a;
        if (!k.hi || a > k.hi) k.hi = a;
    }
});

var names = Object.keys(coll).sort(function (a, b) {
    return coll[b].docs - coll[a].docs;
});
if (!names.length) { printf("no rows in lips_sources at %s\n", DB); process.exit(1); }

function comma(n) { return String(n).replace(/\B(?=(\d{3})+$)/g, ","); }
function gib(n) { return (n / 1073741824).toFixed(1); }

var tot = { n: 0, docs: 0, bytes: 0, lo: "", hi: "" };
names.forEach(function (c) {
    var k = coll[c];
    tot.n += k.n; tot.docs += k.docs; tot.bytes += k.bytes;
    if (k.lo && (!tot.lo || k.lo < tot.lo)) tot.lo = k.lo;
    if (k.hi && (!tot.hi || k.hi > tot.hi)) tot.hi = k.hi;
});

/* ---- INVENTORY.txt ---- */
var t = "";
t += "alpacaLIPS -- corpus inventory\n";
t += "generated " + dateFmt("%Y-%m-%d", new Date()) + " from the corpus itself\n\n";
if (summary) t += summary + "\n\n";
t += sprintf("%-16s %9s %16s %18s  %s\n",
             "collection", "archives", "documents", "text", "snapshots");
t += sprintf("%-16s %9s %16s %18s  %s\n",
             "-".repeat(16), "-".repeat(9), "-".repeat(16), "-".repeat(18),
             "-".repeat(17));
names.forEach(function (c) {
    var k = coll[c];
    t += sprintf("%-16s %9d %16s %14s GiB  %s\n", c, k.n, comma(k.docs),
                 gib(k.bytes), k.lo === k.hi ? k.lo : k.lo + " .. " + k.hi);
});
t += sprintf("%-16s %9s %16s %18s  %s\n",
             "-".repeat(16), "-".repeat(9), "-".repeat(16), "-".repeat(18),
             "-".repeat(17));
t += sprintf("%-16s %9d %16s %14s GiB  %s\n", "TOTAL", tot.n, comma(tot.docs),
             gib(tot.bytes), tot.lo + " .. " + tot.hi);
t += "\nEvery collection is an English edition. The text above is the stored\n";
t += "plain text that search runs over; the original pages, with images and\n";
t += "tables, are in the ZIM archives, which are a separate download.\n";
fprintf(OUT + "/INVENTORY.txt", "%s", t);

/* ---- inventory.json ---- */
var j = { generated: dateFmt("%Y-%m-%dT%H:%M:%SZ", new Date()),
          documents: tot.docs, archives: tot.n,
          text_bytes: tot.bytes,
          snapshots: { from: tot.lo, to: tot.hi },
          summary: summary,
          collections: names.map(function (c) {
              return { name: c, archives: coll[c].n, documents: coll[c].docs,
                       text_bytes: coll[c].bytes,
                       snapshots: { from: coll[c].lo, to: coll[c].hi } };
          }) };
fprintf(OUT + "/inventory.json", "%s\n", JSON.stringify(j, null, 1));

/* The instructions a client is handed at initialize, built from the
   same module the server uses and the same generated inventory, so the
   published text is the served text -- and no server need be running. */
var instr = "";
try {
    instr = String(require(HERE + "/web/lib/mcp-instructions.js")(
        require(HERE + "/web/lib/corpus-inventory.js")));
} catch (e) { instr = ""; }
if (instr) {
    var ih = "alpacaLIPS -- the instructions this corpus gives an MCP client\n" +
             "generated " + dateFmt("%Y-%m-%d", new Date()) +
             ", served verbatim at initialize\n\n";
    fprintf(OUT + "/INSTRUCTIONS.txt", "%s%s\n", ih, instr);
    printf("  instructions     %d chars\n", instr.length);
} else {
    printf("  instructions     could not be read from web/apps/mcp.js\n");
}

printf("  inventory        %s documents, %d archives, %d collections\n",
       comma(tot.docs), tot.n, names.length);
printf("  wrote            %s/INVENTORY.txt, %s/inventory.json\n", OUT, OUT);
