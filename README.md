<img src="alpacalips.png" alt="alpacaLIPS" width="200">

# alpacaLIPS — a Local Index of Public Sources

An offline library: 51,339,851 documents drawn from 215 public archives,
plus a rolling window of current news, searched by keyword with no
network at query time. It answers two kinds of caller from one index:

* a **local LLM**, over MCP — search, fetch a document, read a passage;
* a **person**, over HTTP — a search box, results with highlights, and a
  link to the original page in its own archive.

It is built with [rampart](https://rampart.dev) and its SQL engine, and
it is sized to run on one machine: the published corpus is 276 GiB
installed, and everything in it is publicly available material.

This repository is the **build** side: the scripts that fetch the
archives, extract them, load them into tables, merge those into one
corpus, and index it. The result is a database, not a program.

**If you only want to use it, you do not want this repository.** Take the
runtime instead:

```sh
curl -fsSL https://rampart.dev/install-alpacalips.sh | sh
```

That fetches an 80 KB tarball into `./alpacalips`, checks it against its
published checksum, asks what to install, and downloads it. It needs
[rampart 0.7.5](https://rampart.dev/download.html) and installs it in the 
same directory if rampart is not already installed. 

You may pass options through the pipe with `sh -s --`, for instance 
`sh -s -- --dir /opt/alpacalips --corpus`, and `--help` lists them.

What it costs, as `setup.sh` reports it:

| | download | on disk |
|---|---|---|
| **the corpus** — search, the MCP endpoint, the stored page text | 115 GiB | 276 GiB |
| **the ZIM archives** (optional download) — the original pages, images and tables, read offline | 530 GiB | 530 GiB |
| **the news window** — a rolling three months, refreshed daily | 70 MiB | 82 MiB |
| everything | 645 GiB | 806 GiB |

The corpus is the base install and the archives are optional: search,
citations and the MCP tools all work without them, and what you give up is
reading the original, formatted page with links and images rather than just
its text.  The archives take the same space they download, since a ZIM is
already compressed.

The corpus unpacks as it streams, so it needs about **286 GiB** free at
peak: the database plus the couple of 5 GiB parts in flight. `setup.sh`
checks free space before it starts. `--keep-parts` keeps every part
instead, which needs 391 GiB and makes a retry cheap.

Re-running it is how you update: the program files are replaced and the
corpus, the archives and your settings are left alone.

Building the corpus yourself instead costs up to a week of machine time
and 2.5 TB of working space.

---

## What is in it

| collection | documents | from |
|---|---:|---|
| Stack Overflow | 24,145,596 | `stackoverflow.com_en_all` |
| Wiktionary | 9,086,361 | `wiktionary_en_all_nopic` |
| Stack Exchange (161 sites) | 8,194,062 | `*.stackexchange.com_en_all` |
| Wikipedia (incl. medicine) | 7,391,850 | `wikipedia_en_all_maxi` |
| Wikisource | 700,131 | `wikisource_en_all_maxi` |
| iFixit | 103,486 | `ifixit_en_all` |
| Wikibooks | 102,874 | `wikibooks_en_all_maxi` |
| Wikiquote | 73,926 | `wikiquote_en_all_maxi` |
| Project Gutenberg | 60,672 | 39 `gutenberg_en_lcc-*` slices |
| Wikiversity | 54,279 | `wikiversity_en_all_maxi` |
| Wikivoyage | 34,599 | `wikivoyage_en_all_maxi` |
| zimgit survival guides | 107 | `zimgit-*` |
| **news window** | ~2,000 items | Wikipedia current events + the pages they cite |

Everything comes from [Kiwix](https://library.kiwix.org) ZIM archives,
which is what makes the second half of the system possible: the same
archives that were imported are also served, so every search result can
link to the original page, offline, with its pictures.

## How it is put together

**One table, one index.** 215 archives land in 51 per-collection tables
and are then copied into a single `corpus` table with one fulltext index
over `(Doc, Source)`. Every query is one search over everything, and
ranking is comparable across collections because it comes from one index.

**Keyword search, not vectors.** Measured, not assumed. Over 700,131
documents, asked 80 questions whose right answer was known in advance:
keyword put it first 84% of the time, vectors alone 26%, and the two
fused by Reciprocal Rank Fusion 49%. Fusion cost 28 of those 80 first
places while leaving recall@10 flat (91% to 89%) -- so the models we
tested gained nothing from the vector side and lost precision to it.
Sweeping the index and pool settings did not move vector hit@1 off 26%.
The corpus therefore ships with keyword ranking only: no model to load at
query time and no embedding pass over 50M documents.

**The text is stored, the pictures are not.** The corpus table holds the
plain text of each page — 189 GB of it. Pictures, styling and layout
stay in the ZIM archives, so every result offers two links: the stored
text, and the original page in its archive with its pictures intact.
A corpus-only install is 275 GB; adding the archives is another 530 GB.
The smaller download is not a preview: the text of every document is
complete, so an answer can still quote its source and cite it. The
archives add a faithful offline copy of that source — the page as
published, pictures and formatting and all.

`DESIGN.md` is the long version: every measurement, the rejected
alternatives and why, and the open questions.

## Requirements

* **rampart 0.7.6 or newer to build**, 0.7.5 to run —
  `curl -fsSL https://get.rampart.dev/ | sh`.  The build needs 0.7.6:
  the merge and the index use settings older versions have not got.
  Serving a corpus someone else built needs only 0.7.5, and a 0.7.6
  build writes the same index files either way.
  Unlike the runtime, the build needs one already installed; 
  `./build.sh check` reports what it finds.  **The runtime installs its own
  if it has to**: when `setup.sh` finds no rampart of 0.7.5 or newer on
  `PATH` or in the usual prefixes, it offers to install one into `rampart/`
  *inside the unpacked directory* — `--prefix`, no root, nothing touched
  outside the tree — and records which interpreter it settled on in
  `alpacalips.conf`, so `servers.sh` and later runs use the same one.
* **rampart's python** (`python3r`) with `libzim` — `pip3r install libzim`
* **curl**
* **zim-tools** (`zimwriterfs`) — only for the news window
* **kiwix-tools** (`kiwix-serve`, `kiwix-manage`) — only to serve the
  archives; `tools/setup-kiwix.sh` installs them into `zim/bin`
* Space: ~570 GB of archives, up to 1.7 TB of extracted staging (can be
  dropped as it goes), ~800 GB of database
* Time: a few days of downloading, about two days of importing, and
  about half a day of indexing

`./build.sh check` reports on all of this before you start.

## The build

```sh
git clone git@github.com:aflin/alpacaLIPS.git && cd alpacaLIPS
./build.sh check              # prerequisites, space, progress
./build.sh all                # fetch meta import merge index links news
```

Everything it writes stays inside the clone, and all of it is excluded
by `.gitignore`:

```
downloads/    what it fetches: kiwix/ the archives (570 GB), meta/ the
              job lists, staging/ the extracted JSONL (up to 1.7 TB),
              and alpacalips/ the payloads packed for publishing
build/        the tables and their indexes: corpus/ the corpus (~800 GB),
              news/ and news-src/ the news window
zim/          what kiwix serves: the imported archives, hard linked
              from downloads/kiwix so they cost nothing twice, plus
              library.xml and (optionally) the kiwix binaries
notes/        run logs and the lists the build derives as it goes
dist/         the two trees tools/make-dist.sh assembles
```

That is ~2.4 TB on one disk, and nothing is written outside the clone:
no system directories, no sibling staging tree, and the only links are
hard links inside it. `rm -rf` on the clone therefore reclaims
everything, and a copy of the tree is a copy of the build.

To put the big half somewhere else, write
`config.local.sh` beside `config.sh` — it is read first and nothing
below it is in the repo:

```sh
DATA=${DATA:-/mnt/big/alpacalips}      # archives, job lists, staging
```

`./build.sh --data DIR` does the same for one run, and `--db DIR`
moves the corpus database on its own.

`all` is the whole thing, and any stage can be run on its own:

| stage | what it does | cost |
|---|---|---|
| `check` | prerequisites, free space, how far the build has got | — |
| `urls` | move the archive list on to the dumps kiwix serves today | a minute |
| `fetch` | download every archive, hash-verified | days |
| `meta` | read each archive's own metadata → `notes/zim-meta.json` | minutes |
| `import` | extract to JSONL and import, archive by archive | ~2 days |
| `merge` | copy the per-collection tables into `corpus` | ~3 h |
| `index` | build `corpus_cx`, `corpus_src`, `corpus_ttl` | ~12 h |
| `links` | symlink the imported archives into `zim/`, for kiwix | seconds |
| `news` | fetch the news window, build its ZIM and its table | ~2 h first run |

**Re-running a stage is how you resume one.** Nothing repeats work: a
download skips a file that is already the right size, the importer skips
an archive already in `lips_sources`, the merge skips a table already in
`corpus_merged`, and the index stage skips an index already in
`SYSINDEX`. Each stage also writes `notes/build-<stage>.log`.

`urls` is deliberately **not** part of `all`. Kiwix keeps only the last
dump or two of each archive, so a list written in October will 404 by
December; `tools/download/refresh-urls.sh` moves it on. Run it on a
fresh machine before `fetch` — and understand that on a machine that has
already downloaded archives it means wanting newer ones. The seven
maxi-flavour archives are named with their dates in
`tools/download/maxijobs.js` and are moved by hand; `refresh-urls.sh`
prints what is current.

## The news window

The corpus is a set of snapshots, so the newest thing in it is as old as
the Wikipedia dump. The news window fills that gap: Wikipedia's
`Portal:Current_events` for every day since the dump was built (with a
30-day floor), the articles those days link to, and the pictures in
them, packed into their own ZIM and their own small table.

It is separate on purpose. The corpus index is never rebuilt for it, the
window can be replaced daily, and it is a 70 MB download rather than a
275 GB one.

```sh
tools/news-daily.sh            # the whole thing, safe from cron
tools/news-daily.sh --publish  # and stage it for download
```

```cron
0 5 * * *  /path/to/alpacalips/tools/news-daily.sh --publish >> notes/news-daily.log 2>&1
```

## Serving it

```sh
tools/setup-kiwix.sh                      # kiwix-tools into zim/bin, library.xml from zim/
./servers.sh start -H 10.0.0.9 -p 8099    # the rampart server, and kiwix behind it
./servers.sh status
```

`servers.sh` writes `web/server_conf.js` from `web/server_conf.body.js`
and the address, port and citation URL it was given, because on macOS a
daemon goes through launchd and the environment does not survive the
trip. The database it serves is `build/corpus` and `build/news` — the same
layout the runtime installs, so the build tree serves itself.

`web/` is shared verbatim with the runtime distribution: `apps/search.js`
(the web UI), `apps/mcp.js` (the MCP endpoint), `apps/doc.js` (documents
and redirects into the archives), `lib/tools.js` (the tools themselves),
`lib/db.js` (handles that notice when a database is replaced under them),
`lib/mcp-instructions.js` (what an MCP client is told at `initialize`) and
`lib/corpus-inventory.js` (what the corpus holds — written by the merge
stage from `lips_sources`, and committed, so a fresh clone describes
itself correctly before anything is built).

Every path the server uses is derived from where `server_conf.js` sits,
so the tree can be moved without editing anything.

## Does the corpus help?

[EVALUATION.md](EVALUATION.md) puts six questions to a local model twice —
once on its own, once with this MCP server available — and prints both
answers. The model got **9 of 21** checkable facts unaided and **20 of 21**
with the corpus, but the scores are the dull part. Unaided it invented a
repair guide's step count and attributed it to iFixit, invented a Swedish
word and its plural, and gave coordinates for a place 3.7 km from the one
asked about. Each answer was fluent and confident.

The two questions where the corpus added citations rather than corrections,
and the one question whose subject predates the model's training cutoff, are
reported rather than dropped — along with what the keyword scoring misses
and what grounding costs in tokens.

## Publishing

```sh
tools/make-dist.sh             # dist/alpacalips-src/ (repo) and dist/alpacalips/ (runtime)
tools/make-payloads.sh         # the hosted tarballs: corpus, archives, news, runtime
```

`make-payloads.sh` writes split, hash-verified tarballs and the MANIFEST
that `setup.sh` checks against, so an interrupted download resumes and a
truncated part is caught before it is unpacked.

The runtime tarball unpacks to one directory with `setup.sh` and
`servers.sh` at the top of it:

```
tar xzf alpacalips-run.tar.gz
cd alpacalips
./setup.sh
```

## Layout

```
config.sh              LIPS (this tree) and DATA (everything downloaded)
DESIGN.md              the measurements, the decisions, the open questions
EVALUATION.md          six questions, answered with and without the corpus
build.sh               the build, stage by stage
tools/download/        job lists and the download pool
extract/               ZIM -> JSONL extraction
import/                the importer, the family selectors, the news pipeline
tools/                 merge, index, link, package, serve
web/                   the server: MCP endpoint, web UI, the tools
setup.sh               installs a prebuilt corpus, for people who are not building one
servers.sh             start, stop, status
```

Built data is not in the repository: `downloads/`, `build/`, `zim/`,
`notes/` and `dist/` are all produced by the build and excluded in
`.gitignore`, as is `config.local.sh`.

Nor are the experiments. The measurements behind DESIGN.md were taken
with a few dozen probes and one-off diagnostics -- extraction-ratio
samplers, index cost models, a PDF import trial, a vector-subset
builder, the import watchdog, and the `t-*.js` checks written beside
each stage. They live in the build tree they were written in, not here.
The one exception is `import/t-families.js`, which `run-import.sh
--list` calls: it checks families.js against the archives on disk and
catches the duplicate-flavour mistake that would otherwise import six
wikis twice.
