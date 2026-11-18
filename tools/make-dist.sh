#!/bin/bash
# Assemble the two distributions.
#
#   tools/make-dist.sh [--name NAME] [--out DIR]
#
#   1. dist/<name>-src/   the git repo: downloads and builds the tables,
#                         then merges corpus and indexes it. No data.
#   2. dist/<name>/       the runtime: enough to serve the MCP and the
#                         web UI, plus setup.sh to fetch the corpus and
#                         optionally kiwix and the archives. No build
#                         scripts.
#
# Both share web/ verbatim, which is why the runtime had to be made
# relocatable first: every path derives from LIPS, set by
# server_conf.js from its own location, so an unpacked tarball works
# wherever it lands.
#
# Nothing here is committed or published; it only stages trees.
set -u
LIPS=${LIPS:-$(cd "$(dirname "$0")/.." && pwd)}
NAME=alpacalips
OUT=$LIPS/dist

while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME="$2"; shift 2 ;;
        --out)  OUT="$2";  shift 2 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done

SRC=$OUT/$NAME-src
RUN=$OUT/$NAME
rm -rf "$SRC" "$RUN"
mkdir -p "$SRC" "$RUN"

say() { printf "  %-34s %s\n" "$1" "$2"; }

# ---------------------------------------------------------------- repo
echo "=== git repo tree: $SRC"
fsize_or_dash() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo "-"; }

for d in import extract tools web; do
    mkdir -p "$SRC/$d"
    # Scripts only. No logs, no .bak, no data, no __pycache__.
    # .txt and .png matter: tools/download/kiwix-urls.txt is the archive
    # list the build starts from, and tools/news-illustration.png is the
    # 48x48 icon zimwriterfs refuses to build the news ZIM without.
    (cd "$LIPS/$d" && find . -type f \
        \( -name '*.js' -o -name '*.sh' -o -name '*.py' -o -name '*.json' \
           -o -name '*.html' -o -name '*.md' -o -name '*.txt' \
           -o -name '*.png' \) \
        ! -path './logs/*' ! -name '*.bak*' ! -name '*.pid' \
        ! -name 'server_conf.js' ! -path '*__pycache__*' -print0 2>/dev/null) \
      | (cd "$LIPS/$d" && xargs -0 -I{} cp --parents {} "$SRC/$d/" 2>/dev/null)
    say "$d/" "$(find "$SRC/$d" -type f | wc -l) files"
done

for f in DESIGN.md config.sh README.md; do
    [ -f "$LIPS/$f" ] && cp "$LIPS/$f" "$SRC/" && say "$f" "copied"
done

# The build, at the top of the repo tree where it is run from. Not in
# the runtime: that tree installs a prebuilt corpus, it does not build.
if [ -f "$LIPS/build.sh" ]; then
    cp "$LIPS/build.sh" "$SRC/build.sh"; chmod +x "$SRC/build.sh"
    say "build.sh" "repo tree only"
fi

# The three measurement summaries DESIGN.md quotes its numbers from. The
# rest of notes/ -- logs, derived lists, probes, the per-site ratio
# files -- is working material and stays behind.
mkdir -p "$SRC/notes"
for f in corpus-by-source.txt corpus-index-phases.tsv merge-plan.txt; do
    [ -f "$LIPS/notes/$f" ] && cp "$LIPS/notes/$f" "$SRC/notes/" \
        && say "notes/$f" "measurement DESIGN.md quotes"
done

# Superseded or host-specific one-offs. Dropped rather than shipped, and
# listed so the choice is visible instead of silent: watchdog v5 is the
# one that runs, so v1-v4 are history, and copy-enwiki/so-import were
# single-use migrations against this machine's paths.
SKIP="watchdog.sh watchdog-v2.sh watchdog-v3.sh watchdog-v4.sh
      copy-enwiki.sh so-import.sh catcheck.sh verify-so.js"
dropped=""
for f in $SKIP; do
    if [ -f "$SRC/tools/$f" ]; then rm -f "$SRC/tools/$f"; dropped="$dropped $f"; fi
done
[ -n "$dropped" ] && say "skipped (superseded/one-off)" "$(echo $dropped | tr " " ",")"

# The repo root's .gitignore is the authority; copy it rather than
# writing a second copy that can drift.
if [ -f "$LIPS/.gitignore" ]; then
    cp "$LIPS/.gitignore" "$SRC/.gitignore"
else
    echo "  no .gitignore at the repo root to copy" >&2
fi
say ".gitignore" "excludes build/, downloads, archives, logs"

# ------------------------------------------------------------- runtime
echo "=== runtime tree: $RUN"
mkdir -p "$RUN/web/apps" "$RUN/web/lib" "$RUN/web/html" "$RUN/web/logs" "$RUN/tools"
# The body, not server_conf.js: setup.sh generates that from this plus
# the answers it collects, so a shipped one would be someone else's.
cp "$LIPS/web/server_conf.body.js" "$RUN/web/"
cp "$LIPS/web/apps/"*.js       "$RUN/web/apps/"
# Every lib, not tools.js by name: lib/db.js was added later and a
# named copy silently shipped a runtime whose search 500s on "could not
# resolve module id".
cp "$LIPS/web/lib/"*.js        "$RUN/web/lib/"
cp "$LIPS/web/html/index.html" "$RUN/web/html/"
say "web/" "$(find "$RUN/web" -type f | wc -l) files"
# Only the tools a runtime needs: find or install rampart, start kiwix,
# and install kiwix.
for f in zim-serve.sh setup-kiwix.sh rampart-find.sh net-helpers.sh write-conf.sh; do
    [ -f "$LIPS/tools/$f" ] && cp "$LIPS/tools/$f" "$RUN/tools/" && say "tools/$f" "runtime tool"
done
# Not a script: setup.sh unpacks it to find out whether this system's tar
# can decompress zstd by itself, which decides whether the zstd binary is
# required here.
if [ -f "$LIPS/tools/zstd-probe.tar.zst" ]; then
    cp "$LIPS/tools/zstd-probe.tar.zst" "$RUN/tools/"
    say "tools/zstd-probe.tar.zst" "$(fsize_or_dash "$LIPS/tools/zstd-probe.tar.zst") byte zstd capability probe"
fi
# setup.sh and servers.sh go at the TOP of both trees, under those
# names, because they are the first things anyone runs: the tarball
# unpacks to alpacalips/setup.sh, in plain sight beside the README,
# rather than buried in a subdirectory.
for f in setup.sh servers.sh; do
    [ -f "$LIPS/$f" ] || { echo "  missing $LIPS/$f" >&2; continue; }
    cp "$LIPS/$f" "$RUN/$f"; chmod +x "$RUN/$f"
    cp "$LIPS/$f" "$SRC/$f"; chmod +x "$SRC/$f"
    say "$f" "at the root of both trees"
done

echo
say "repo tree"    "$(du -sh "$SRC" | cut -f1)"
say "runtime tree" "$(du -sh "$RUN" | cut -f1)"
echo
echo "Neither tree contains data. Next: tools/make-payloads.sh to build"
echo "the hosted payloads, and setup.sh inside the runtime to fetch them."
