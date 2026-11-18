# Does the corpus change the answer?

Six questions, asked twice of the same local model: once on its own, once
with the alpacaLIPS MCP server available. Same prompt, same settings, no
hints about where to look.

The short version: the model scored **9 of 21** checkable facts unaided and
**20 of 21** with the corpus. But the scores are the least interesting part.
Unaided, it invented a step count and attributed it to iFixit; it invented a
Swedish word; it gave coordinates for a place 3.7 km from the one asked
about. Each answer was confident, well formatted, and wrong in a way a
reader could not detect.

## How this was run

| | |
|---|---|
| Model | `unsloth/Qwen3.8-Flash-Next-GGUF`, UD-IQ4_XS, 262 144 context |
| Served by | `llama-server` with `--jinja`, speculative draft model, 4 slots |
| Corpus | 49 947 943 documents, 215 archives, snapshots 2024-05 to 2026-10 |
| Tools | the nine `lips_*` tools, over MCP |
| Both arms | temperature 0, 8 000 token budget, thinking enabled |
| Tool arm | real tool loop, up to 10 rounds, tool output capped at 6 000 chars |
| Date | 2026-11-18 |

The tool arm is a genuine loop: tool calls are executed against the server
and the results fed back until the model answers. Nothing is pre-retrieved
and no prompt names a collection — deciding that a lookup would help, and
choosing what to look up, is part of what is being measured.

Scoring is deliberately mechanical: does the answer contain the specific
facts the corpus holds, compared case- and accent-insensitively. It rewards
nothing for fluency and punishes nothing for style. Its limits are set out
at the end.

## Results

| # | question | unaided | with corpus | unaided time | tool time | tools called |
|---|---|---|---|---|---|---|
| 1 | November 2026 bank acquisition | 3/4 \* | **4/4** | 216 s | 95 s | 4×news, research, retrieve, verify |
| 2 | iPhone 5s volume button repair | 1/3 | **3/3** | 162 s | 84 s | 3×search, 2×retrieve, fetch |
| 3 | "Potato Patches", Tristan da Cunha | 0/4 | **4/4** | 108 s | 92 s | 4×search, 3×retrieve, 2×fetch |
| 4 | Swedish for "defenestration" | 0/3 | **3/3** | 47 s | 95 s | 5×search, 2×retrieve, verify |
| 5 | cabin altitude above 8 000 ft | 3/3 \* | **3/3** | 207 s | 375 s | 8×search, 5×retrieve, 2×research, fetch, verify |
| 6 | the Einstein "insanity" quote | 2/4 | **3/4** | 154 s | 104 s | 2×search, 2×fetch, 2×verify, retrieve |
| | | **9/21** | **20/21** | | | |

\* These two unaided answers never arrived: the model spent its whole
8 000 token budget reasoning and emitted no final answer, so their scores
were read out of the reasoning text. See the caveats.

---

## 1. A recent event

> In November 2026, regulators approved a large European bank acquisition.
> Which bank was acquired, by whom, for how much, and which regulators
> signed off?

**In the corpus** (current events, 2026-11-16): the European Commission and
the US Federal Reserve approved UniCredit's €45 billion (US$49 billion)
acquisition of Commerzbank, following the ECB's approval in October; the EC
granted unconditional antitrust clearance.

**With the corpus** — a table of regulators and dates:

> | Regulator | What it did | When |
> |---|---|---|
> | **European Central Bank** | Authorised UniCredit to raise its stake above 30% with no upper limit | October 2026 |
> | **European Commission** | Antitrust clearance — granted **unconditionally** | 16 November 2026 |
> | **US Federal Reserve** | Approved the transaction | 16 November 2026 |

**Unaided**, the model reasoned at length and produced no answer, though its
reasoning named UniCredit and Commerzbank repeatedly.

**Reading.** This is the weakest of the six as a test of recency, and it is
included for honesty rather than effect: the UniCredit bid for Commerzbank
has been running since 2024, so the parties and the valuation are within any
recent model's training data. Only the November 2026 approval is new. A model
can infer most of this answer without retrieving anything.

## 2. A repair procedure

> How many steps are involved in replacing the volume buttons on an
> iPhone 5s, how difficult is it, and how long does it take?

**In the corpus** (iFixit, "iPhone 5s Volume Controls Replacement"):
31 steps, difficulty **Difficult**, time required **1–2 hours**.

**Unaided**, in full:

> According to the standard iFixit guide for the **iPhone 5s Volume Button
> Replacement**:
> - **Steps involved:** **14 steps**
> - **Difficulty:** **Moderate**
> - **Estimated time:** **30–60 minutes**

**With the corpus:**

> | **Steps** | **31** |
> | **Difficulty** | **Difficult** |
> | **Time required** | **1–2 hours** |

**Reading.** The most instructive answer in the set. All three values are
wrong, and the answer **cites iFixit as its source** — a fabricated
attribution to the exact document that contains the right numbers. Nothing
in the unaided answer's form distinguishes it from the correct one.

## 3. A long-tail place

> Tristan da Cunha is a remote British island in the South Atlantic. What is
> "Potato Patches" there, and what are its coordinates?

**In the corpus** (Wikipedia): the island's main agricultural area, also
Patches Plain or "The Patches", southwest of Edinburgh of the Seven Seas
along the Patches Road, at **37°5′22.1″S 12°20′2.5″W**.

**Unaided:**

> "Potato Patches" on Tristan da Cunha is not a town but an agricultural
> locality — the island's cultivated potato-growing plots/fields […]
> Its commonly listed coordinates are:
> - **37°04′S 12°18′W**
> - Decimal: **−37.0667, −12.3000**
> Because it is an area of fields rather than a single point, different maps
> may give slightly different coordinates.

**With the corpus:**

> **Coordinates:** **37°5′22.1″S 12°20′2.5″W (37.089472°S, 12.334028°W)** [1]
> - It lies about **3.7 km southwest of Edinburgh of the Seven Seas**, along
>   Patches Road / the M1
> - It is the **largest plain on Tristan da Cunha** […] the fields are
>   **irregularly arranged cultivated beds surrounded by stone walls**
> - Getting there: one road plus a 24-seat mini-bus known as the
>   **"Potato Patches Flier"**
> - In older accounts: writing in the 1880s, K. M. Barrow described potatoes
>   as the islanders' staple food, "grown in walled-in patches…"

**Reading.** The unaided answer gets the *kind* of thing right and the
location wrong: 37°04′S 12°18′W is Edinburgh of the Seven Seas, the
settlement 3.7 km away. It then hedges about maps disagreeing, which reads
as diligence and is actually a wrong answer wearing a caveat. This question
was scored 3/3 under an earlier, looser key before the key was tightened to
the minutes that distinguish the two places — a reminder that automated
scoring flatters near-misses.

## 4. A cross-language detail

> What is the Swedish word for defenestration and does it have synonyms?

**In the corpus** (Wiktionary): **defenestrering**, with synonyms
*defenestration*, **fönsterutkastning** and **fönsterstörtning**.

**Unaided:**

> The Swedish word for **defenestration** is:
> - **defenistration** — *en defenistration*, plural **defenistrationer**
> […]
> - **fönsterkastning** — literally "window-throwing," a transparent Swedish
>   synonym/coinage, uncommon and somewhat technical or humorous.

**With the corpus:**

> - **defenestration**
> - **fönsterutkastning** (literally "window-throwing-out")
> - **fönsterstörtning** (literally "window-falling/plunge")
>
> Its declension, as given in the same entry: singular indefinite
> *defenestrering* / definite *defenestreringen*; plural indefinite
> *defenestreringar* […]

**Reading.** Unaided, every specific is invented: *defenistration* is not a
Swedish word (nor an English one), the plural is invented from it, and
*fönsterkastning* is not the synonym Wiktionary lists. The answer is
grammatically confident and lexically fictional. This is the cleanest
separation in the set — 0/3 against 3/3 — and the one hardest to bluff,
because a reader who does not speak Swedish cannot tell.

## 5. A regulation

> How do airliners handle cabin altitude when operating from airports above
> 8 000 ft, and what does the governing regulation require?

**In the corpus** (Aviation Stack Exchange, accepted answer): FAR 25.841 —
"Pressurized cabins and compartments to be occupied must be equipped to
provide a cabin pressure altitude of not more than 8,000 feet at the maximum
operating altitude."

**With the corpus:**

> §25.841 is written as a **capability requirement at the airplane's maximum
> operating altitude** […] The airworthiness rule is 14 CFR §25.841
> (transport category), with §23.841 as its near-identical general-aviation
> twin […] **Failure conditions.** §25.841(a)(2): after decompression "from
> any failure condition not shown to be extremely improbable"…

**Unaided**, the model again produced no final answer within its budget,
having stated the rule number and the 8 000 ft figure in its reasoning.

**Reading.** A tie on facts, and the one question where the corpus made the
model *slower*: 17 tool calls over 375 seconds against 207 seconds unaided.
The regulation is well known enough to be in the weights; what retrieval
added was the exact quoted text and a citation, not the substance.

## 6. A misattribution

> Did Einstein say "insanity is doing the same thing over and over and
> expecting different results"? Who actually said it?

**In the corpus** (Wikiquote): listed under *Misattributed* on the Einstein
page; the Narcotics Anonymous page carries the line, and the Misquotations
page records Quote Investigator's finding about Rita Mae Brown.

**Unaided:**

> No — there's no reliable evidence that Albert Einstein ever said or wrote
> that line. […] The earliest known printed version of the modern wording is
> from novelist **Rita Mae Brown** in her 1983 novel *Sudden Death*.

**With the corpus:**

> The earliest known appearance in print is the Narcotics Anonymous "Basic
> Text" — specifically the *approval version* released in November 1981 […]
> A 1980 Alcoholics Anonymous pamphlet (*Step Two…*) […] **What about Rita
> Mae Brown?** She's the person most often credited […] One wrinkle worth
> flagging: Wikiquote's general **Misquotations** page says Quote
> Investigator found it "may have first appeared in Rita Mae Brown" […]
> **So the honest answer to "who said it":** nobody single.
>
> [1] Albert Einstein — wikiquote_en — http://…/apps/doc?id=wikiquote_en%3AAlbert_Einstein
> [2] Narcotics Anonymous — wikiquote_en — http://…/apps/doc?id=wikiquote_en%3ANarcotics_Anonymous

**Reading.** Scored almost as a tie, 2/4 against 3/4, and the scoring misses
the point. Both answers correctly reject Einstein. The corpus-backed one
dates the line two years earlier, to a source the unaided answer does not
mention, names a 1980 antecedent, and *flags a disagreement between two
pages of its own source* rather than picking one. That is a better answer in
a way keyword counting cannot see.

---

## What these numbers do and do not show

**Scoring is keyword containment.** It catches "did not know" and "invented
something else" reliably. It cannot tell a right number used for a wrong
reason from a right answer, and it under-credits an answer that is better
sourced without being differently worded — question 6 above. The full text
of all twelve answers should be read before drawing conclusions from the
tally.

**Two unaided answers never arrived.** On questions 1 and 5 the model used
its entire 8 000 token budget reasoning and emitted no final answer; those
scores were read out of the reasoning. An earlier pass with a 3 500 token
budget produced no final answer on four of six, which is why the budget was
raised rather than the thinking disabled: cutting a model off mid-thought
and scoring the silence is not a comparison.

**One question is soft.** Question 1's subject predates any recent model's
training cutoff except for the approval date. It is kept because removing an
unflattering case would be worse than labelling it.

**Two questions are near-ties** (5 and 6), and they are kept for the same
reason. Where a fact is already in the weights, the corpus adds provenance
rather than correctness — which is worth something, but it is a different
claim.

**The corpus is not free.** The unaided prompt costs about 80 input tokens;
the tool arm's final call carried **19 559**, the accumulated tool schemas
and retrieved text. Output moves the other way: unaided answers ran to the
full 8 000 token budget, while tool-backed answers finished in 107–1 628
tokens. Grounding costs input and saves output — and on five of six
questions it was also faster end to end, because the model stops ruminating
once it has something to read.

**Retrieval was chosen, not prompted.** No question named a source. The
model decided to search in all six cases, and picked sensible tools
unprompted: `lips_news` for the recent event, `lips_search` then
`lips_retrieve` for the rest, `lips_verify` on three of them.

## Reproducing this

The harness is `tools/ab-test.js`: it reads the tool list from the MCP
server, runs both arms of each question, scores against the expected facts
and writes every answer to `answers-<n>-<arm>.txt`. `LIPS_LLM`, `LIPS_MCP`
and `LIPS_MODEL` point it at a different endpoint or model. An arm whose answer file is already present and
complete is reused, so changing one question re-runs two calls rather than
twelve.

Scoring keys live beside the questions in that file. When adding a question,
pick facts the corpus actually holds — verify with a direct query first —
and prefer keys that cannot match a near-miss: on question 3, "37" and "12"
matched coordinates 3.7 km wrong.
