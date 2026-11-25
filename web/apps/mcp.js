/* The alpacaLIPS corpus as an MCP server.
 *
 *   POST /apps/mcp.json      JSON-RPC over Streamable HTTP
 *
 * Both protocol eras, chosen by how the client opens: the 2025 revisions
 * send an `initialize' handshake, 2026-07-28 sends no handshake and
 * carries its version in `_meta' with `server/discover' in place of
 * initialize. Stateless either way, so any server thread can serve any
 * request -- which is what the rampart threading model wants.
 *
 * The tools are lib/tools.js, the same code any other caller would use.
 * This file converts between two shapes of JSON and nothing else; if it
 * starts making retrieval decisions the two surfaces will drift.
 */
rampart.globalize(rampart.utils);

var Sql   = require("rampart-sql");
/* Relocatable root. process.scriptPath is the directory of the script
 * the server was started with -- <root>/web -- and the server sets it
 * for every module it loads, apps and libs alike, so each file works
 * the tree out for itself and an unpacked tarball runs wherever it
 * lands. Nothing comes from the environment: assignments made in
 * server_conf.js do not reach app modules, and on macOS the launchd
 * plist drops all but HOME and PATH. The database directory comes from
 * confData, a plain global the generated server_conf.js declares, so
 * the data can live on a different disk from the code. */
var WEB = String(process.scriptPath);
var LIPS = WEB.replace(/[\/]web[\/]?$/, "");
var tools = require(WEB + "/lib/tools.js");

var VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
var SERVER_INFO = { name: "alpacalips", version: "0.1.0" };
/* What the corpus holds, written at build time by
   tools/make-instructions.js from lips_sources. Required, not computed:
   a server should not query its own catalogue to describe itself, and a
   published runtime should already know what shipped with it. If the
   generator has not run, the fallback names the collections and claims
   no numbers -- an absent count is better than a stale one. */
var INV = {};
try { INV = require(WEB + "/lib/corpus-inventory.js"); } catch (e) {}

var INSTRUCTIONS = require(WEB + "/lib/mcp-instructions.js")(INV);

/* One connection per thread. */
/* Opened through lib/db.js so a corpus replaced under a running
   server is noticed rather than served from the old files for ever;
   see the measurements there. Re-resolved per request below. */
var db = require(WEB + "/lib/db.js");
var CORPUS_FILES = ["corpus.tbl", "corpus_Doc_Source_ftx.dat"];
function corpusReopened() { tools.corpusReopened(); }
function corpus() { return db.open(tools.DB, CORPUS_FILES, corpusReopened); }
var sql = corpus();

function ok(id, result) {
    return { jsonrpc: "2.0", id: (id === undefined ? null : id), result: result };
}
function err(id, code, message) {
    return { jsonrpc: "2.0", id: (id === undefined ? null : id),
             error: { code: code, message: message } };
}

/* OpenAI function shape -> MCP tool shape: the two differ only in nesting. */
function mcpTools() {
    return tools.schemas().map(function (s) {
        return { name: s.function.name,
                 description: s.function.description,
                 inputSchema: s.function.parameters };
    });
}

function handle(msg, base) {
    var id = msg.id, m = String(msg.method || ""), p = msg.params || {};

    if (m === "initialize" || m === "server/discover") {
        var want = String(p.protocolVersion ||
                          (msg._meta && msg._meta.protocolVersion) || "");
        var use = VERSIONS.indexOf(want) !== -1 ? want : VERSIONS[1];
        return ok(id, { protocolVersion: use,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: SERVER_INFO,
                        instructions: INSTRUCTIONS });
    }
    if (m === "notifications/initialized" || m === "ping") return ok(id, {});
    if (m === "tools/list") return ok(id, { tools: mcpTools() });

    if (m === "tools/call") {
        var name = String(p.name || "");
        var known = mcpTools().some(function (t) { return t.name === name; });
        if (!known) return err(id, -32602, "unknown tool: " + name);
        /* One line per call, so a trace can be read off the server instead
           of pasted in by hand. Name and arguments only; results are
           reproducible by making the same call. */
        var out, tcall0 = Date.now();
        try { out = tools.dispatch(sql, name, p.arguments || {}, base); }
        catch (e) {
            return ok(id, { isError: true, content: [ { type: "text",
                     text: "tool failed: " + String(e).split("\n")[0] } ] });
        }
        var payload = JSON.stringify(out, null, 1);
        try {
            var lf = fopen(WEB + "/logs/mcp-calls.log", "a");
            fprintf(lf, "%s  %-13s %6d ms %7d B  %s\n",
                    dateFmt("%Y-%m-%d %H:%M:%S", new Date()),
                    name, Date.now() - tcall0, payload.length,
                    JSON.stringify(p.arguments || {}).substring(0, 200));
            fflush(lf); fclose(lf);
        } catch (e) {}

        /* Results go back as one JSON text block: clients render text, and
           a model reads JSON perfectly well. */
        return ok(id, { content: [ { type: "text", text: payload } ],
                 isError: out && out.error ? true : false });
    }

    /* Notifications have no id and want no reply. */
    if (id === undefined || id === null) return null;
    return err(id, -32601, "method not found: " + m);
}

/* The text a client is handed at initialize, so the build can publish it
   verbatim without a server to ask. A property on the handler, which is
   what this module exports. */
module.exports = function (req) {
    sql = corpus();
    if (!sql) return { status: 503, json: { error: "no corpus at " + tools.DB } };
    if (String(req.method || "").toUpperCase() !== "POST") {
        return { json: { server: SERVER_INFO, protocols: VERSIONS,
                         tools: mcpTools().map(function (t) { return t.name; }),
                         usage: "POST JSON-RPC to this URL" } };
    }

    /* req.body is a buffer; bufferToString unconditionally, as the Keep's
       transport does. A conditional on constructor.name silently failed. */
    var body = "";
    if (req.body) {
        try { body = bufferToString(req.body); } catch (e) { body = ""; }
    }
    if (!body.length) return { status: 202, text: "" };

    var msg;
    try { msg = JSON.parse(body); }
    catch (e) { return { json: err(null, -32700, "parse error") }; }

    /* Citation links are built from the host the client actually used, so
       they work whether reached over localhost or from another machine.
       Falls back to relative urls rather than inventing a host. */
    var p = req.path || {};
    var base = (p.scheme && p.host) ? (String(p.scheme) + String(p.host)) : "";

    /* A client may batch. */
    if (Array.isArray(msg)) {
        var out = [];
        msg.forEach(function (one) {
            var r = handle(one, base);
            if (r) out.push(r);
        });
        return { json: out };
    }

    var res = handle(msg, base);
    return { json: res === null ? {} : res };
};

module.exports.instructions = INSTRUCTIONS;
