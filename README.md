<img src="alpacalips.png" alt="alpacaLIPS" width="200">

# alpacaLIPS — a Local Index of Public Sources

An offline library: 51,746,725 documents drawn from 227 public archives,
plus a rolling window of current news, searched by keyword with no
network at query time. It answers two kinds of caller from one index:

* a **local LLM**, over MCP — search, fetch a document, read a passage;
* a **person**, over HTTP — a search box, results with highlights, and a
  link to the original page in its own archive.

It is built with [rampart](https://rampart.dev) and its SQL engine, and
it is sized to run on one machine: the published corpus is 279 GiB
installed, and everything in it is publicly available material.

This repository is the **build** side: the scripts that fetch the
archives, extract them, load them into tables, merge those into one
corpus, and index it. The result is a database, not a program.

**If you only want to use it, you do not want this repository.** Take the
runtime instead:

```sh
curl -fsSL https://rampart.dev/install-alpacalips.sh | sh
```

That fetches an 88 KB tarball into `./alpacalips`, checks it against its
published checksum, asks what to install, and downloads it. It needs
[rampart 0.7.5](https://rampart.dev/download.html) and installs it in the 
same directory if rampart is not already installed. 

You may pass options through the pipe with `sh -s --`, for instance 
`sh -s -- --dir /opt/alpacalips --corpus`, and `--help` lists them.

What it costs, as `setup.sh` reports it:

| | download | on disk |
|---|---|---|
| **the corpus** — search, the MCP endpoint, the stored page text | 115 GiB | 279 GiB |
| **the ZIM archives** (optional download) — the original pages, images and tables, read offline | 538 GiB | 538 GiB |
| **the news window** — a rolling three months, refreshed daily | 70 MiB | 82 MiB |
| everything | 653 GiB | 817 GiB |

The corpus is the base install and the archives are optional: search,
citations and the MCP tools all work without them, and what you give up is
reading the original, formatted page with links and images rather than just
its text.  The archives take the same space they download, since a ZIM is
already compressed.

The corpus unpacks as it streams, so it needs about **286 GiB** free at
peak: the database plus the couple of 5 GiB parts in flight. `setup.sh`
checks free space before it starts. `--keep-parts` keeps every part
instead, which needs 391 GiB and makes a retry cheap.

Updating is `./setup.sh --upgrade`: it takes the published runtime and
replaces the program files, leaving the corpus, the archives and your
settings alone. A plain `./setup.sh` says when something newer exists and
offers it.

Building the corpus yourself instead costs up to a week of machine time
and 2.5 TB of working space.

---

## What is in it

| collection | documents | from |
|---|---:|---|
| Stack Overflow | 24,145,596 | `stackoverflow.com_en_all` |
| Wiktionary | 10,478,247 | `wiktionary_en_all_nopic` |
| Stack Exchange (162 sites) | 8,362,419 | `*.stackexchange.com_en_all`, `mathoverflow.net_en_all` |
| Wikipedia | 7,318,951 | `wikipedia_en_all_maxi` |
| Wikisource | 700,131 | `wikisource_en_all_maxi` |
| iFixit | 103,486 | `ifixit_en_all` |
| Wikibooks | 102,874 | `wikibooks_en_all_maxi` |
| ProofWiki | 76,240 | `proofwiki.org_en_all_maxi` |
| Wikiquote | 73,926 | `wikiquote_en_all_maxi` |
| Wikipedia (medicine) | 72,899 | `wikipedia_en_medicine_maxi` |
| ManKier — man pages | 72,055 | `www.mankier.com_en_all` |
| Project Gutenberg | 60,672 | 39 `gutenberg_en_lcc-*` slices |
| Wikiversity | 54,254 | `wikiversity_en_all_maxi` |
| Wikivoyage | 34,599 | `wikivoyage_en_all_maxi` |
| Gardenology — plant cultivation | 23,015 | `gardenology.org_en_all` |
| Appropedia — appropriate technology | 22,279 | `appropedia_en_all_maxi` |
| CD3WD — development and repair manuals | 12,760 | `cd3wdproject.org_en_all` |
| Gentoo Wiki | 11,726 | `gentoo_en_all_maxi` |
| Energypedia — off-grid energy | 10,440 | `energypedia_en_all_nopic` |
| ArchWiki | 4,576 | `archlinux_en_all_maxi` |
| Libre Pathology | 2,223 | `librepathology_en_all_maxi` |
| CDC travellers' health | 1,859 | `wwwnc.cdc.gov_en_all` |
| NHS medicines A to Z | 1,344 | `nhs.uk_en_medicines` |
| zimgit survival guides | 154 | `zimgit-*` |
| **news window** | ~2,000 items | Wikipedia current events + the pages they cite |

Everything comes from [Kiwix](https://library.kiwix.org) ZIM archives,
which is what makes the second half of the system possible: the same
archives that were imported are also served, so every search result can
link to the original page, offline, with its pictures.

## How it is put together

**One table, one index.** 227 archives land in 227 staging tables, one
each, and are then copied into a single `corpus` table with one fulltext index
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
plain text of each page — 217 GB of it. Pictures, styling and layout
stay in the ZIM archives, so every result offers two links: the stored
text, and the original page in its archive with its pictures intact.
A corpus-only install is 279 GiB; adding the archives is another 538 GiB.
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
* Space: ~535 GiB of archives, up to 1.7 TB of extracted staging (can be
  dropped as it goes), ~800 GB of database
* Time: a few days of downloading, about two days of importing, and
  about half a day of indexing

`./build.sh check` reports on all of this before you start.

## The build

```sh
git clone git@github.com:aflin/alpacaLIPS.git && cd alpacaLIPS
./build.sh check              # prerequisites, space, progress
./build.sh all                # urls fetch meta import merge index links kiwix news
```

Everything it writes stays inside the clone, and all of it is excluded
by `.gitignore`:

```
downloads/    archives/ the ZIM archives (~535 GiB), meta/ the job
              lists, staging/ the extracted JSONL (up to 1.7 TB), and
              alpacalips/ the payloads packed for publishing
build/        the tables and their indexes: corpus/ the corpus (~800 GB),
              news/ and news-src/ the news window
zim/          what serving needs and nothing else: library.xml, the
              kiwix binaries, the pid file. NOT the archives -- those
              live in archives/, where they are also served from
notes/        run logs and the lists the build derives as it goes
dist/         the two trees tools/make-dist.sh assembles
```

That is ~2.4 TB on one disk, and nothing is written outside the clone:
no system directories, no sibling staging tree, and **no links at all** --
every archive is one file in the one directory it is read from and served
from. `rm -rf` on the clone therefore reclaims everything, and a copy of
the tree is a copy of the build.

To put the big half somewhere else, write
`config.local.sh` beside `config.sh` — it is read first and nothing
below it is in the repo:

```sh
DATA=${DATA:-/mnt/big/alpacalips}            # job lists and staging
DOWNLOAD_DIR=${DOWNLOAD_DIR:-/srv/www/alpacalips}  # the archives, and
                                             # what is published
```

`./build.sh --data DIR` does the same for one run, `--db DIR` moves the
corpus database on its own, and `--download-dir DIR` sets where the
archives are fetched to and the payloads are published. All three are
remembered in `config.local.sh`.

The archives go straight to the download directory, because that is
where a web server publishes them: they are fetched once, read there by
the importer, served from there by kiwix, and published from there. The
database stays on local disk, which is the only part of the build that
is latency-bound.

`all` is the whole thing, and any stage can be run on its own:

| stage | what it does | cost |
|---|---|---|
| `check` | prerequisites, free space, how far the build has got | — |
| `urls` | move the archive list on to the dumps kiwix serves today | a minute |
| `fetch` | download every archive, hash-verified | days |
| `meta` | read each archive's own metadata → `notes/zim-meta.json` | minutes |
| `import` | extract to JSONL and import, archive by archive | ~2 days |
| `merge` | copy the per-collection tables into `corpus` | ~35 min |
| `index` | build `corpus_Doc_Source_ftx`, `corpus_SrcPath_x`, `corpus_Title_x` | ~4.5 h |
| `links` | check every archive the corpus cites is present and the right size | seconds |
| `kiwix` | kiwix-tools into `zim/bin`, and `library.xml` from the archives | a minute |
| `news` | fetch the news window, build its ZIM and its table | ~2 h first run |

Three more are **not** in `all`, because publishing is a separate
decision from building:

| stage | what it does | cost |
|---|---|---|
| `package` | the runtime tarball, news, kiwix-tools and the archive manifest | a minute |
| `corpus` | the corpus download payload, in 5 GiB gzip parts | hours |
| `copy` | publish payloads built elsewhere to `--download-dir` | minutes |

`corpus` is separate from `package` because it is the only expensive one:
it builds into `corpus-new/`, then renames `corpus/` to `corpus-old/` and
`corpus-new/` to `corpus/`, so what is served is always a complete
payload and the previous one can be put back.

**Re-running a stage is how you resume one.** Nothing repeats work: a
download skips a file that is already the right size, the importer skips
an archive already in `lips_sources`, the merge skips a table already in
`corpus_merged`, and the index stage skips an index already in
`SYSINDEX`. Each stage also writes `notes/build-<stage>.log`.

`urls` leads `all`, and it is worth knowing what it does. Kiwix keeps
only the last dump or two of each archive, so a list written in October
will 404 by December; `tools/download/refresh-urls.sh` moves it on to
what is current. That means a refresh **wants newer archives than the
ones already on disk** — which is the point of running it, and a surprise
if it was not expected. To rebuild from the material already downloaded,
name the stages instead of `all`. The seven maxi-flavour archives are
named with their dates in `tools/download/maxijobs.js` and are moved by
hand; `refresh-urls.sh` prints what is current.

## The news window

The corpus is a set of snapshots, so the newest thing in it is as old as
the Wikipedia dump. The news window fills that gap: Wikipedia's
`Portal:Current_events` for every day since the dump was built (with a
30-day floor), the articles those days link to, and the pictures in
them, packed into their own ZIM and their own small table.

It is separate on purpose. The corpus index is never rebuilt for it, the
window can be replaced daily, and it is a 70 MB download rather than a
276 GiB one.

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
truncated part is caught before it is unpacked. In a build tree, prefer
the stages: `./build.sh package` for everything cheap and
`./build.sh corpus` for the payload that takes hours.

The release number lives in `VERSION` at the repo root. Edit it by hand,
or use `./build.sh --version 1.2.3` or `./build.sh --bump [patch|minor|major]`;
`package` copies it into the published `version.txt` together with the
runtime tarball's sha256. An install compares that file and offers to
upgrade itself:

```sh
./setup.sh --upgrade     # take the published runtime and stop
./setup.sh               # say if something newer exists, and offer it
```

The runtime fetches the ZIM archives from the kiwix mirrors before
falling back to this project's own host, which is why `archives/MIRRORS`
and `archives/UPSTREAM` are published alongside them: the first lists
the mirrors, the second says where each archive sits on them and which
of them actually have it. `tools/publish-mirrors.js` writes both, and
has to be re-run whenever the archive set changes.

The runtime tarball unpacks to one directory with `setup.sh` and
`servers.sh` at the top of it:

```
tar xzf alpacalips-run.tar.gz
cd alpacalips
./setup.sh
```

## Licences

Every source keeps its own terms, and the corpus records them per source
in `lips_licenses`. A document page shows the licence for the source it
came from, so a citation link leads to the terms as well as the text.

Two things a bulk download should know, because no page is involved:

- **iFixit's 103,486 repair guides are CC BY-NC-SA 3.0 — non-commercial.**
  They are a tenth of a per cent of the documents and the only source
  with that restriction, but the restriction travels with any copy of the
  corpus.
- **Ten sources have terms nobody has established.** The five `zimgit`
  collections are PDFs from several publishers, ManKier is one licence
  per man page, CD3WD is a compilation of other publishers' manuals, and
  Energypedia, LibrePathology and Gardenology state nothing we could
  find. They are marked unverified rather than assumed free.

The rest is Creative Commons (CC BY-SA, mostly 4.0), ArchWiki under GFDL
1.3, CDC's travel pages in the US public domain, the NHS medicines pages
under the Open Government Licence v3.0, and Project Gutenberg's texts
public domain in the United States.

`rampart tools/make-licenses.js --db <db> --list` prints the table, and
the published `version.txt` carries a `licenses` line counting what is
recorded, restricted and unverified.

## Layout

```
config.sh              LIPS (this tree), DATA (job lists and staging),
                       KIWIX (the archives, inside the download directory)
VERSION                the release number, edited by hand or by --bump
DESIGN.md              the measurements, the decisions, the open questions
EVALUATION.md          six questions, answered with and without the corpus
build.sh               the build, stage by stage
tools/download/        job lists and the download pool
extract/               ZIM -> JSONL extraction
import/                the importer, the family selectors, the news pipeline
tools/                 merge, index, verify, package, publish, serve
web/                   the server: MCP endpoint, web UI, the tools
setup.sh               installs a prebuilt corpus, for people who are not building one
servers.sh             start, stop, status
```

Built data is not in the repository: `downloads/`, `build/`, `zim/`,
`notes/` and `dist/` are all produced by the build and excluded in
`.gitignore`, as are `config.local.sh`, `alpacalips.conf` and
`version.txt` — the last being what an *install* records about the
release it took, not to be confused with the committed `VERSION`.

Nor are the experiments. The measurements behind DESIGN.md were taken
with a few dozen probes and one-off diagnostics -- extraction-ratio
samplers, index cost models, a PDF import trial, a vector-subset
builder, the import watchdog, and the `t-*.js` checks written beside
each stage. They live in the build tree they were written in, not here.
The one exception is `import/t-families.js`, which `run-import.sh
--list` calls: it checks families.js against the archives on disk and
catches the duplicate-flavour mistake that would otherwise import six
wikis twice.
