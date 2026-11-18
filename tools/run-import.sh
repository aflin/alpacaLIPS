#!/bin/bash
# Stage and import archives into the corpus, one at a time.
#
#   tools/run-import.sh [--db DIR] [--delete-staging] [--no-index]
#                       <name> [<name> ...]
#   tools/run-import.sh --list                 # what families.js picks
#
# --no-index skips the closing mkindex pass. mkindex indexes EVERY table
# in lips_sources, so a run that adds staging tables destined to be merged
# would otherwise fulltext-index all of them -- and every other unindexed
# table too -- for indexes the merge discards.
#
# For each archive: stage to JSONL if not already staged, then import.
# Both steps are skippable, so the script is resumable: the importer
# consults lips_sources and skips an archive already in, and staging is
# skipped when the .jsonl and its sidecar exist.
#
# Staging files are KEPT (DESIGN.md §19): re-ingesting for vectors, or
# re-running after a selector change, then costs no re-extraction. The
# budget is up to ~3 TB on the NFS array, which is affordable there and
# buys speed on any second pass. Whole-page HTML runs about 10x the
# text it yields -- math.stackexchange staged 48.4 GB for 4.4 GB
# stored -- so the full corpus lands near a terabyte. --delete-staging
# removes each file after a successful import if that budget is ever
# the binding constraint.

set -u
# This tree, from where this script sits, so a clone anywhere works;
# config.sh then puts the pool and the staging directory under it.
LIPS=${LIPS:-$(cd "$(dirname "$0")/.." && pwd)}
. "$LIPS/config.sh"
DB=${DB:-$LIPS/build/corpus}
KEEP=1
INDEX=1

while [ $# -gt 0 ]; do
    case "$1" in
        --db)           DB="$2"; shift 2 ;;
        --delete-staging) KEEP=0; shift ;;
        --no-index)     INDEX=0; shift ;;
        # The summary half of t-families.js, but its complaint in full:
        # filtering first swallowed the "run build.sh meta" message and
        # printed nothing at all.
        --list)         out=$(rampart "$LIPS/import/t-families.js") \
                            || { printf '%s\n' "$out"; exit 1; }
                        printf '%s\n' "$out" | sed -n '/-> /,$p'
                        exit 0 ;;
        --)             shift; break ;;
        -*)             echo "unknown option $1" >&2; exit 1 ;;
        *)              break ;;
    esac
done

if [ $# -eq 0 ]; then
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
fi

mkdir -p "$STAGE"
total=$#
i=0

for name in "$@"; do
    i=$((i + 1))
    zim="$name"
    case "$zim" in *.zim) ;; *) zim="$zim.zim" ;; esac
    src="$KIWIX/$zim"
    if [ ! -f "$src" ]; then
        echo "[$i/$total] MISSING $src" >&2
        continue
    fi

    short=$(echo "$zim" \
        | sed -e 's/\.zim$//' \
              -e 's/\.stackexchange\.com_en_all_[0-9-]*$//' \
              -e 's/\.com_en_all_[0-9-]*$//' \
              -e 's/_all_\(maxi\|nopic\|mini\)_[0-9-]*$//' \
              -e 's/_[0-9][0-9][0-9][0-9]-[0-9][0-9]$//')
    out="$STAGE/$short.jsonl"

    echo "[$i/$total] $(date +%H:%M:%S) $short"

    staged_here=0
    if [ -s "$out" ] && [ -s "$out.meta.json" ]; then
        echo "    staged already ($(du -h "$out" | cut -f1))"
    else
        if ! python3r -I "$LIPS/extract/zim2jsonl.py" "$src" "$out"; then
            echo "    STAGING FAILED $zim" >&2
            rm -f "$out" "$out.meta.json"
            continue
        fi
        staged_here=1
    fi

    if rampart "$LIPS/import/kiwix-import.js" --db "$DB" --src "$out"; then
        # Only remove staging this run created, and only after the
        # import reported success: an interrupted import leaves the
        # file in place so the retry does not re-extract.
        if [ "$KEEP" -eq 0 ] && [ "$staged_here" -eq 1 ]; then
            rm -f "$out" "$out.meta.json"
            echo "    staging removed"
        fi
    else
        echo "    IMPORT FAILED $zim" >&2
    fi
done

if [ "$INDEX" -eq 1 ]; then
    echo "=== $(date +%H:%M:%S) run-import finished; building indexes"
    rampart "$LIPS/import/mkindex.js" --db "$DB"
else
    echo "=== $(date +%H:%M:%S) run-import finished; --no-index, indexes not built"
fi
echo "=== $(date +%H:%M:%S) done"
