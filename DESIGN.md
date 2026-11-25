# alpacaLIPS — design

An offline library of 49,947,943 documents drawn from 215 public
archives, searched by keyword with no network at query time, answering
both a local LLM over MCP and a person over HTTP. It runs on one
machine: 275 GB installed for the text and its index, another 530 GB if
you also want the original pages with their pictures.

This document says what the system is and why it is built that way.
Every number in it was measured on the machine that built the corpus — a
DGX Spark, 20 ARM cores, 128 GB unified memory, archives on an NFS array
and the database on local NVMe. Where a decision had a plausible
alternative, the measurement that settled it is here too, because the
decisions only make sense alongside what they cost.

---

## 1. What is in it

One table, `corpus`, with one row per document:

| collection | documents | source archive |
|---|---:|---|
| Stack Overflow | 24,145,596 | `stackoverflow.com_en_all` |
| Wiktionary | 9,086,361 | `wiktionary_en_all_nopic` |
| Stack Exchange | 8,194,062 | 161 `*.stackexchange.com_en_all` |
| Wikipedia | 7,318,951 | `wikipedia_en_all_maxi` |
| Wikisource | 700,131 | `wikisource_en_all_maxi` |
| iFixit | 103,486 | `ifixit_en_all` |
| Wikibooks | 102,874 | `wikibooks_en_all_maxi` |
| Wikiquote | 73,926 | `wikiquote_en_all_maxi` |
| Wikipedia (medicine) | 72,899 | `wikipedia_en_medicine_maxi` |
| Project Gutenberg | 60,672 | 39 `gutenberg_en_lcc-*` slices |
| Wikiversity | 54,279 | `wikiversity_en_all_maxi` |
| Wikivoyage | 34,599 | `wikivoyage_en_all_maxi` |
| survival guides | 107 | 5 `zimgit-*` |

Plus a **news window** of roughly 2,000 current-events items in its own
small table, rebuilt daily (§7).

**Everything comes from Kiwix ZIM archives.** That one decision shapes
the rest of the system: the same archives that were imported can also be
*served*, so every search result can link to the original page, offline,
with its pictures and formatting — which no text-only corpus can do.
The alternative considered was building Wikipedia from the `wikitext`
dumps with our own parser; the ZIM won on freshness, bundled images and
having an offline viewer already written.

**One dump per archive, best flavour.** `maxi` beats `nopic` beats
`mini`, and a newer dump beats an older one of the same flavour. The
picker reads the archives' own metadata rather than their filenames, and
refuses to import two dumps of the same thing — a mistake that would
silently double a collection. `wikipedia_en_top1m` is excluded for the
same reason: it is a subset of `wikipedia_en_all`, and importing it
added 5.9 M duplicate entries once.

### What is deliberately not in it

Four tiers were sized, downloaded in part, and then left out:

* **pile-of-law** (~250 GB of statutes and case law) — nobody wants a
  paraphrased statute, and a research snapshot is not a live legal
  source. The failure mode of a confidently wrong citation is worse here
  than the absence.
* **fineweb-edu** (420 GB of web prose) — head-ish general text, not
  citable, and largely what a model already knows.
* **Europe PMC** (191 GB of JATS XML) — kept on disk, never imported.
  A separate tool now serves it, which is the right home for a corpus
  with its own identifiers and licence terms.
* **A 2023 Wikipedia snapshot** — kept, frozen, as the fixed baseline
  for the recency comparison in §9. Never refreshed, by design.

---

## 2. One table, one index

The 215 archives land in 51 per-collection staging tables and are then
copied into a single `corpus` table with one fulltext index.

**Why not keep the 51 tables.** Each one would need its own query and a
fusion step per search, and relevance would be incomparable across them
(a term's weight depends on how rare it is, which is per-table). One
table gives one query, global term statistics, and one index to
maintain. The cost is that refreshing a single collection means
re-merging rather than rebuilding one small table, and the index rebuild
is all-or-nothing — accepted, because a search is answered thousands of
times for every rebuild.

### Schema

```
corpus (Id counter, Source varchar(32), Site varchar(64),
        SrcPath varchar(512), Title varchar(256),
        Doc varchar(4096), Nbytes int, Sha varchar(64))
```

* `Source` is the collection (`wikipedia`, `stackexchange`, …) and
  `Site` the member within it (`askubuntu`, `lcc-pd`, `water`), so a
  result can say where it came from and a query can be narrowed to one.
* `SrcPath` is the entry path inside the archive. It is what turns a row
  back into a link to the original page.
* `Doc` holds the extracted plain text; `varchar(4096)` is a size *hint*
  from the measured mean, not a limit — a 303,934-byte document stores
  fine against it.
* `Nbytes` is the UTF-8 byte length of `Doc` (§5).

**The column order is load-bearing.** The merge inserts positionally,
because the named-column form (`insert into corpus (Id, Source, …)
select …`) is accepted, inserts nothing, and reports no error.

### Two registries

`lips_sources` holds one row per imported archive — its ZIM name, dump
date, scraper, the selectors used, document and byte counts. Everything
uniform across an archive lives there instead of being repeated on
millions of rows. It is also the idempotency key: an archive already in
it is skipped, which is what makes a two-day import resumable.

`corpus_merged` records which staging tables have been copied into
`corpus`. Without it, working out what was still outstanding meant
comparing file timestamps and reasoning about row-count shortfalls; a
six-row canary was enough to hide 1.9 M missing rows once.

### Insertion order is the tie-breaker

Broad queries tie, heavily. On a test corpus, **7 of 13 rank groups
inside the top 40 were ties**, one of them ten documents deep at the
same rank. Across 50 M rows that is the common case rather than an edge
case, so for any broad query insertion order is effectively the ranking
function among the top candidates.

It *fully* determines tie order. Confirmed by building the same corpus
twice with two collections swapped: same query, same documents, same
ranks, and every tied group exactly reversed.

What it does not determine is membership. iFixit holds more documents
than Wikipedia's medicine subset — 103,486 against 72,899 — and took 0
of the top 40 for "water", because repair guides do not discuss it.
Content decides who qualifies; insertion order decides the order among
those who do, which bounds the damage a wrong choice can do.

So the collections are merged in **quality-descending** order:

```
wikipedia_en → wikipedia_en_medicine → wikisource_en → wikiversity_en
→ wikiquote_en → wikivoyage_en → wiktionary_en → stackexchange
→ stackoverflow → ifixit → zimgit
```

Three placements are deliberate and none is about size:

* **Wiktionary 7th.** 9.1 M short dictionary entries would otherwise win
  ties against prose on any single word. Single-word lookups are a
  separate tool call instead.
* **Stack Overflow 9th**, despite being half the corpus by document
  count.
* **iFixit and the survival guides last** — not because they are poor,
  but because they are specialists. A question that wants them is better
  served by restricting the search to the collection, which is what the
  compound index on `(Doc, Source)` exists for.

That mitigation was later seen working: in an end-to-end evaluation a
model reached a Wiktionary entry from 7th place, and surfaced one of the
107 survival-guide documents by restricting to that collection
deliberately — then reported a genuine conflict between a military
medical handbook and a Stack Exchange answer, attributing both rather
than silently choosing.

**This is the other reason the per-collection staging tables are kept.**
They let `corpus` be rebuilt in a different order without re-extracting
or re-importing anything, and insertion order is the one property that
appending to an existing corpus can never change.

### Stack Exchange is 161 sites in one table

Not 161 tables. The sites share a template family, so they share
selectors, and the site identity lives in the `Site` column. The same
shape holds Gutenberg's 39 LCC slices under `Source = 'gutenberg'`.

---

## 3. Keyword search, not vectors

This is the decision the whole system rests on, and it was measured
rather than assumed.

A vector table was built over all 700,131 Wikisource documents —
`chunkembed(Doc, '', Title)` with all-MiniLM-L6-v2 f16, 384 dimensions,
IVFPQ plus the fulltext index, 19.53 GiB. Then 80 probes, each a
verbatim 18-word sentence lifted from the middle of a known document, so
the expected answer needed no human judgement. Production settings:
`likevRows 300`, `likevPqNprobe 256`, `likeprows 100`.

| mode | hit@1 | hit@10 | missed entirely |
|---|---:|---:|---:|
| keyword | **84%** | 91% | 7 |
| vector | 26% | 39% | 49 |
| fused (RRF) | 49% | **89%** | 9 |

**Fusion cost 28 of 80 first places and left recall@10 unchanged.** That
is inherent to Reciprocal Rank Fusion, not a bug: a document ranked 1 by
keyword and absent from the vector list scores below one ranked 3 by
keyword and 2 by vector, so fusion reshuffles inside the top ten and
demotes exact hits.

A 12-point sweep (`nprobe` 64 → 4096, `likevRows` 300 → 3000) pinned
vector hit@1 at **26%** and plateaued hit@10 at 45%. At the top of that
range the candidates are re-sorted against the stored full-precision
vectors, so it is effectively exact search: the ceiling is the
representation, not the index or the pool size.

Extrapolated from the Wikisource table, vectors for the whole corpus
would be about **500 GB** — nearly doubling the install — for no
measured gain. So the corpus ships with keyword ranking only, which also
means no model to load at query time and no embedding pass over 50 M
documents (measured at 36 docs/s, which is 16 days for the corpus).

**What this costs, honestly.** The verbatim-sentence oracle is keyword's
best case and fusion's worst framing; it measures the downside risk, not
the semantic upside. On a 4,000-document pilot the vector side did win
two paraphrase queries that keyword missed entirely — so the upside is
real, just unquantified, because writing the paraphrases would have made
the author the oracle. The system compensates in a different direction
instead: it tells the model *how many* documents matched, lets it locate
terms inside a document, and makes absence inspectable (§4, §10).

---

## 4. The index, and how ranking behaves

One fulltext index, `corpus_Doc_Source_ftx`, over `(Doc, Source)`, with four word
expressions:

| expression | what it captures |
|---|---|
| `[\ualnum]{2,99}` | ordinary words, Unicode-aware |
| `[\ualnum$%@\-_+#]{2,99}` | identifiers and symbols: `C#`, `node_modules`, `$rank` |
| `\digit{1,99}\.=[0-9.]{1,99}` | decimals and dotted numbers: `4.8.5`, `192.168.1.1` |
| `\bound[CDR]=\F\space` | single capitals as words |

`\ualnum` rather than `\uword`: `\uword` admits combining marks, so
decomposed text would index with the mark attached and never match a
precomposed query. In the decimal expression the dot needs its own `\.=`
because a repetition operator binds to the longest preceding
expression — without it, `999.99` truncates to `999.9`.

**Changing this list requires dropping the index.** A fulltext index can
be re-created with the *same* expressions, which texis treats as an
optimize; re-created with *different* ones it returns success and
silently keeps the old expressions.

### Three facts about ranking that shape the tools

**`likepRows` ranks, it does not filter.** By default LIKEP ranks only
its top 100 matching documents; raising it does not change which
documents match, only how many are ranked. Anything that reports on a
result set — "also in", collection counts, totals — must therefore ask
for counts separately rather than inferring them from the ranked rows.

**Never `ORDER BY $rank`.** The rows already arrive in rank order. Asking
for it explicitly forces full materialization instead of early-out: 11×
slower on the corpus, and it defeats the lazy select list, so an
`abstract()` in the projection runs for every candidate instead of the
handful returned.

**Cost is proportional to the number of matching documents,** not to
corpus size. A rare term is fast against 50 M rows; a common one is slow
against 50 M rows. This is why the tools encourage narrowing and report
match counts.

---

## 5. Text, not markup

`Doc` holds plain text. Markdown was built, measured and rejected:
across ten collections it cost **21.2% more bytes** — 18.8 GB against
14.8 GB — and the structure it preserved is not what retrieval matches
on.

Where that cost falls is the useful part. Prose archives barely moved:
Wikipedia's medicine subset is 67.7% pipe tables and grew only 7.2%,
because every cell's text is emitted either way and only the pipes go.
**Wiktionary grew 38.4% on its own** — 3.7 GB — because its entries
average 686 bytes and are almost entirely nested definition lists, where
a per-item `*` or `1.` marker is a large share of the document. The
markup was the cheap part; list markers on short documents were not.

The original formatting is never lost — it is in the archive, one link
away.

**One ruler for byte offsets.** `Nbytes` is the UTF-8 length of the
stored text, which is the same ruler passage offsets use. Three other
counts disagree and all three are wrong for this purpose: JavaScript
string length counts UTF-16 units, SQL `length()` counts codepoints, and
the obvious buffer conversion yields CESU-8, which spends six bytes on
an astral character instead of four. Getting this wrong puts every
derived offset mid-character on non-ASCII text.

**Passages come from the stored text.** `excerpt()` returns the matching
region of a long document with its surroundings, so the MCP can hand a
model the relevant few hundred bytes of a 300 KB article and a byte
range to read more.

---

## 6. How a document gets in

```
ZIM archive ──zim2jsonl.py──▶ JSONL ──kiwix-import.js──▶ rows
            (libzim, Python)          (selectors, text, SQL)
```

**Two languages, one hand-off.** libzim's bindings are Python and
everything else is rampart, so the extractor walks the archive and
writes one JSON object per article (`path`, `title`, `html`) and the
importer applies the selectors, converts to text and inserts. The JSONL
is also what makes the import resumable and re-runnable: changing a
selector costs a re-import, not a re-extraction.

Staging is kept rather than deleted — 1.7 TB for the full corpus, about
**six hours** to rebuild at the measured 82 MB/s, with `stackoverflow`
(739 GB) and `wikipedia_en` (525 GB) three quarters of it. Whole-page
HTML runs about 10× the text it yields. Keeping it also allows `corpus`
to be re-merged in a different insertion order (§2) without touching
the archives.

### Selectors, per template family

Each scraper family (`mwoffliner`, `sotoki`, `gutenberg2zim`,
`nautiluszim`, iFixit) has an include path prefix and an exclude set:
scope to the content container, then drop the known furniture. **Order
matters** — delete the exclude set first, then take the include
container, or removed navigation reappears inside it.

The family comes from the archive's own `Scraper` metadata rather than
its filename, because the filename lies more often. A length ratio
cannot validate a selector: a plausible 84–98% retention can still be
keeping navigation and dropping content.

### The PDF branch

Five `zimgit-*` archives are `nautiluszim` *file collections* — a
landing page, a bundled viewer, and the content as `files/*.pdf`. The
HTML selectors get nothing from them, so they go through a separate
path: extract the PDFs, read their text (OCR where there is no text
layer), one row per document rather than per page, because these are
whole books and `excerpt()` already locates the passage inside one.

The collections overlap: 155 PDFs, 107 distinct documents, 23% of the
bytes redundant. Identity is a SHA-256 of the PDF bytes — nothing
cheaper works, because the archives renumber their files and each gives
the same book a different title. The specific collections are imported
before the catch-all bundle so the surviving row keeps the better title.

---

## 7. The news window

A corpus of snapshots has a floor on its freshness: the newest thing in
it is as old as the newest dump. The news window fills that gap without
touching anything else.

**What it is.** Wikipedia's `Portal:Current_events` for every day since
the Wikipedia dump was built — with a 30-day floor, so there is always
something recent — plus every article those days link to, plus the
pictures in them, packed into their own ZIM and their own small table.
About 2,000 items over a rolling three months.

**Why it is separate.** The corpus index is never rebuilt for it, the
whole window can be replaced daily, and it is a 70 MB download rather
than a 275 GB one. The news table is replaced whole rather than edited;
the server fingerprints the files behind its open handle and reopens
when they change, so a swap is picked up with no restart.

**Why it has its own ZIM.** The same reason the corpus has archives: a
news item should link to the page it refers to, offline, with its
pictures — including pages that post-date the Wikipedia dump and exist
nowhere else in the system.

One command rebuilds it, safely from cron: fetch today's portal and any
new or changed pages, rebuild the ZIM, build a fresh database, swap it
in, and refresh the kiwix library.

---

## 8. Serving it

Two processes, one port:

* **rampart** serves the web UI, the MCP endpoint, documents from the
  corpus, and a reverse proxy that puts kiwix on the same port.
* **kiwix-serve** serves the archives, bound to loopback, reached through
  that proxy — so it needs no public port of its own.

### Two flavours

| | download | what you get |
|---|---:|---|
| corpus only | 112 GB → 275 GB installed | every document's full text, searchable and citable |
| plus archives | +530 GB | the original pages, with pictures and formatting |

The smaller one is not a preview. The text is complete, so an answer can
quote its source and cite it; the archives add fidelity, not content.
Presence of the `zim/` directory is the only switch between them.

### Every result carries two links

The stored text, and the original page in its archive. The second is why
the archives are worth 530 GB to anyone who has the disk: a citation you
can open and read as published, with no network.

### The MCP surface

Nine tools over the one table, each for a different question a model
actually asks:

| tool | what it is for |
|---|---|
| `lips_search` | rank documents for a query, return the best passage of each |
| `lips_retrieve` | read the passages of documents a search listed |
| `lips_survey` | breadth: many documents, one line each, grouped by collection |
| `lips_research` | a goal plus 2–6 queries in one call, merged |
| `lips_fetch` | one document by id, with a byte range for the rest |
| `lips_locate` | **every** occurrence of a string in one document, with offsets |
| `lips_verify` | check a claim against the corpus *before* asserting it |
| `lips_sources` | the collections and their counts, to decide where to look |
| `lips_news` | the news window; present only when its table exists |

The split between `search` and `survey` is deliberate: one is for
reading, the other for finding out what exists and where. `locate` is
exhaustive where `search` ranks — it is how a model counts mentions or
finds a figure rather than guessing from the best passage. `verify`
takes plain words and writes the right query for each kind of term
itself, because the whole point is to be used before a claim is made,
not after.

The design rule behind them: **an exhaustive answer must state its
total and say that it is complete.** An enumeration that truncates
silently is worse than none, because the model cannot tell the
difference between "that is all of them" and "that is all I showed you".

### Nothing is compiled in

Every path derives from where the server's config file sits, so an
unpacked tarball runs wherever it lands. Settings are *generated* into
that file rather than passed in the environment: on macOS the server is
daemonized through launchd, whose plist carries only `HOME` and `PATH`,
so an address handed over in the environment silently became loopback.

---

## 9. Sizes and times, measured

**Storage multiplier, over 48 M rows and 167 GB of text:**

| component | ratio to text |
|---|---:|
| table | 1.051× |
| fulltext index | 0.311× |
| btree indexes | 0.075× |
| **total** | **1.437×** |

That number is the reason the design is affordable: the index is a third
of the text, not a multiple of it. Adding f16 vectors and their index
would have made it 2.55×.

**The build, end to end:**

| stage | cost |
|---|---|
| download, 215 archives | 530 GB, days on a home line |
| extract to JSONL | ~6 h, 1.7 TB kept |
| import | ~2 days; Stack Overflow alone 12 h 45 m for 24.1 M rows |
| merge into `corpus` | hours; measured 22.2 min for 1.9 M rows |
| build the three indexes | 11.8 h |
| news window, first run | ~2 h of paced fetching; ~1 min daily after |

**Insert rate depends on document size, not row count:** 1,364 rows/s
for Wiktionary's short entries, 375 rows/s for Wikisource's pages.

**On disk when built:** 781 GB for the database — `corpus.tbl` 200 GB,
the fulltext index 56 GB, the rest staging tables that the merge
consumed and the per-collection indexes it discarded.

---

## 10. Limits, and what is still open

**False absence is the failure that matters.** Keyword search returns a
hard zero when no term matches, and a model reasonably concludes the
answer does not exist. Vector search never returns empty, which is a
different failure: it always offers something, so the model may ground
on an irrelevant passage. We chose the first failure deliberately (§3)
and mitigate it with match counts, term diagnostics and `lips_locate`,
so "I did not find it" and "it is not here" can be told apart. **How
often it still misleads a model is not measured.** That is the most
valuable experiment left.

**No semantic recall.** A question whose wording shares nothing with the
document will not be found. Measured upside exists but is unquantified
(§3). If it is ever revisited, the thing to test is a *better
representation*, not a different fusion — the 26% ceiling held across a
64× sweep of search breadth.

**Dump replacement is not implemented.** The importer keys on the
archive's filename, which contains the dump date, so a newer dump is a
new archive to it: it would append a second copy of a collection rather
than replace the first. Refreshing a collection today means a rebuild.
The pieces are there — the picker prefers the newer dump, the registry
records what came from where — but nothing deletes the old rows.

**The Gutenberg slices are unverified.** They come from a directory
listing rather than the Kiwix Metalink catalogue, so they have no
published checksum and the only integrity test is a size floor. Every
other archive in the pool is verified against the publisher's sha256 and
carries that hash beside it.

**One collection, one model, 80 probes.** The retrieval measurement in
§3 is Wikisource only. It is the measurement the decision rests on, and
it is narrower than the decision.
