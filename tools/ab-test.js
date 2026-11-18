/* A/B the demo prompts: the loaded model alone, then the same model with
 * the alpacaLIPS MCP tools.
 *
 *   rampart tools/ab-test.js [promptNumber]
 *
 *   LIPS_LLM    chat endpoint   (default: a local OpenAI-shaped server)
 *   LIPS_MCP    alpacaLIPS MCP endpoint
 *   LIPS_MODEL  model name to ask for
 *
 * Both arms use the same prompt, the same model and temperature 0. The
 * tool arm runs a real tool loop: the MCP tool list is handed over as
 * OpenAI function definitions, tool calls are executed against the
 * server and fed back until the model answers.
 *
 * Answers go to answers-<n>-<arm>.txt so they can be read whole; the
 * table on stdout is only the scoring summary.
 */
rampart.globalize(rampart.utils);

/* Endpoints and model, overridable so this runs against whatever is
   serving: any OpenAI-shaped chat endpoint and any alpacaLIPS server.
   The defaults are the ones the published results were measured with. */
var LLM   = process.env.LIPS_LLM   || "http://127.0.0.1:8888/v1/chat/completions";
var MCP   = process.env.LIPS_MCP   || "http://localhost:8099/apps/mcp";
var MODEL = process.env.LIPS_MODEL || "unsloth/Qwen3.8-Flash-Next-GGUF";
var HERE  = process.scriptPath || ".";
var MAXTOOLCALLS = 10;
var TOOLCAP = 6000;        /* chars of tool output handed back */

/* ---- HTTP through curl: one shape for both endpoints ---------------- */
var seq = 0;
function post(url, obj, secs) {
    var f = "/tmp/ab-body." + (seq++) + ".json";
    fprintf(f, "%s", JSON.stringify(obj));
    var r = exec("curl", "-s", "-m", String(secs || 300), "-X", "POST", url,
                 "-H", "Content-Type: application/json", "-d", "@" + f);
    rmFile(f);
    if (r.exitStatus !== 0) return null;
    try { return JSON.parse(r.stdout); } catch (e) { return null; }
}

/* ---- the tools, as the model wants to see them ---------------------- */
function mcpTools() {
    var j = post(MCP, { jsonrpc: "2.0", id: 1, method: "tools/list" }, 60);
    if (!j || !j.result || !j.result.tools) return [];
    return j.result.tools.map(function (t) {
        return { type: "function", function: {
            name: t.name,
            description: String(t.description || "").substring(0, 900),
            parameters: t.inputSchema || { type: "object", properties: {} }
        } };
    });
}

function callTool(name, args) {
    var j = post(MCP, { jsonrpc: "2.0", id: 2, method: "tools/call",
                        params: { name: name, arguments: args || {} } }, 180);
    if (!j) return "(tool call failed)";
    if (j.error) return "(tool error: " + JSON.stringify(j.error).substring(0, 200) + ")";
    var c = (j.result && j.result.content) || [];
    var out = c.map(function (p) { return String(p.text || ""); }).join("\n");
    return out.length > TOOLCAP ? out.substring(0, TOOLCAP) + "\n...(truncated)" : out;
}

/* ---- one arm -------------------------------------------------------- */
function arm(prompt, tools) {
    var msgs = [{ role: "user", content: prompt }];
    var used = [], t0 = Date.now();
    for (var step = 0; step <= MAXTOOLCALLS; step++) {
        /* Room for Qwen's thinking AND an answer: at 1600 the no-tool
           arm spent the whole budget reasoning and returned an empty
           content field, which would have scored as ignorance. */
        var body = { model: MODEL, messages: msgs, temperature: 0,
                     max_tokens: 8000 };
        if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
        var r = post(LLM, body, 600);
        if (!r || !r.choices || !r.choices.length) {
            return { text: "(no response from the model)", used: used,
                     secs: (Date.now() - t0) / 1000 };
        }
        var m = r.choices[0].message || {};
        if (m.tool_calls && m.tool_calls.length) {
            msgs.push(m);
            m.tool_calls.forEach(function (tc) {
                var fn = (tc["function"] || {});
                var args = {};
                try { args = JSON.parse(fn.arguments || "{}"); } catch (e) {}
                used.push(fn.name + "(" + Object.keys(args).map(function (k) {
                    return k + "=" + String(args[k]).substring(0, 40);
                }).join(" ") + ")");
                msgs.push({ role: "tool", tool_call_id: tc.id,
                            content: callTool(fn.name, args) });
            });
            continue;
        }
        /* Credit facts stated in the reasoning when no final answer was
           emitted: the question is what the model knows, not whether it
           formatted an answer in time. */
        var ans = String(m.content || "");
        if (!ans.replace(/\s/g, "").length && m.reasoning_content) {
            ans = "(no final answer; reasoning only)\n" +
                  String(m.reasoning_content);
        }
        return { text: ans || "(empty answer)", used: used,
                 secs: (Date.now() - t0) / 1000 };
    }
    /* Out of tool rounds: ask once more with the tools taken away, so
       everything it gathered turns into an answer instead of another
       search. A loop that never concludes is the harness's failure, not
       the model's. */
    msgs.push({ role: "user", content:
        "Answer now, from what you have already found. Do not search again." });
    var last = post(LLM, { model: MODEL, messages: msgs, temperature: 0,
                           max_tokens: 8000 }, 600);
    var lm = (last && last.choices && last.choices[0] &&
              last.choices[0].message) || {};
    var lt = String(lm.content || "");
    if (!lt.replace(/\s/g, "").length && lm.reasoning_content) {
        lt = "(no final answer; reasoning only)\n" + String(lm.reasoning_content);
    }
    return { text: lt || "(gave up after " + MAXTOOLCALLS + " tool rounds)",
             used: used, secs: (Date.now() - t0) / 1000 };
}

/* ---- the prompts, and what a right answer has to contain ----------- */
var PROMPTS = [
 { n: 1, label: "news: bank acquisition",
   p: "In November 2026, regulators approved a large European bank acquisition. Which bank was acquired, by whom, for how much, and which regulators signed off?",
   key: ["unicredit", "commerzbank", "45", "49"] },
 { n: 2, label: "ifixit: guide specifics",
   p: "How many steps are involved in replacing the volume buttons on an iPhone 5s, how difficult is it, and how long does it take?",
   key: ["31", "difficult", "2 hour"] },
 { n: 3, label: "wikipedia: Potato Patches",
   p: "Tristan da Cunha is a remote British island in the South Atlantic. What is \"Potato Patches\" there, and what are its coordinates?",
   /* The Patches, not the settlement 1.3 km away: either spelling of
      the distinguishing minutes, or the decimal form. */
   key: ["37\u00b05", "37.089", "12\u00b020", "12.334"] },
 { n: 4, label: "wiktionary: swedish synonyms",
   p: "What is the Swedish word for defenestration and does it have synonyms?",
   key: ["defenestrering", "fonsterutkastning", "fonsterstortning"] },
 { n: 5, label: "stackexchange: FAR 25.841",
   p: "How do airliners handle cabin altitude when operating from airports above 8,000 ft, and what does the governing regulation require?",
   key: ["25.841", "8,000", "8000"] },
 { n: 6, label: "wikiquote: misattribution",
   p: "Did Einstein say \"insanity is doing the same thing over and over and expecting different results\"? Who actually said it?",
   key: ["narcotics anonymous", "rita mae brown", "not einstein", "misattribut"] }
];

/* Loose containment: lowercase, strip accents and punctuation, so
   "fönsterutkastning" matches whichever way the model spells it. */
function flat(s) {
    return String(s).toLowerCase()
        .replace(/[öø]/g, "o").replace(/[äå]/g, "a")
        .replace(/[^a-z0-9., ]+/g, " ");
}
function score(text, key) {
    var f = flat(text), hits = [];
    key.forEach(function (k) { if (f.indexOf(flat(k)) >= 0) hits.push(k); });
    return hits;
}

/* An answer already on disk, if it got as far as an answer. Truncated
   and empty runs are not settled and are fetched again. */
function cached(file) {
    if (!stat(file)) return null;
    var t = bufferToString(readFile(file));
    if (t.indexOf("(no final answer") >= 0 || t.indexOf("(empty answer)") >= 0
        || t.indexOf("(no response from the model)") >= 0
        || t.indexOf("(gave up after") >= 0) return null;
    var i = t.indexOf("ANSWER");
    if (i < 0) return null;
    var calls = [];
    var c0 = t.indexOf("TOOL CALLS"), c1 = t.indexOf("ANSWER");
    if (c0 >= 0 && c1 > c0) {
        t.substring(c0 + 10, c1).split("\n").forEach(function (l) {
            if (l.replace(/\s/g, "").length) calls.push(l.trim());
        });
    }
    return { text: t.substring(i), used: calls };
}

var only = Number(process.argv[2]) || 0;
var tools = mcpTools();
printf("model : %s\ntools : %d from the MCP server\n\n", MODEL, tools.length);

printf("%-4s %-28s %-9s %-9s %s\n", "#", "prompt", "no tools", "w/ tools", "tool calls made");
PROMPTS.forEach(function (q) {
    if (only && q.n !== only) return;
    var fa = HERE + "/answers-" + q.n + "-notools.txt";
    var fb = HERE + "/answers-" + q.n + "-tools.txt";
    var ca = cached(fa), cb = cached(fb);
    var a = ca ? { text: ca.text, used: [], secs: 0, cached: 1 } : arm(q.p, null);
    var b = cb ? { text: cb.text, used: cb.used, secs: 0, cached: 1 }
               : arm(q.p, tools);
    if (!ca) fprintf(fa, "PROMPT\n%s\n\nANSWER (%.0fs)\n%s\n",
                     q.p, a.secs, a.text);
    if (!cb) fprintf(fb, "PROMPT\n%s\n\nTOOL CALLS\n%s\n\nANSWER (%.0fs)\n%s\n",
                     q.p, b.used.join("\n"), b.secs, b.text);
    var sa = score(a.text, q.key), sb = score(b.text, q.key);
    printf("%-4d %-28s %d/%d%-6s %d/%d%-6s %s\n", q.n, q.label.substring(0, 28),
           sa.length, q.key.length, a.cached ? " (c)" : "",
           sb.length, q.key.length, b.cached ? " (c)" : "",
           b.used.length ? b.used.join(", ").substring(0, 58) : "(none)");
});
printf("\nanswers written to %s/answers-*.txt\n", HERE);
