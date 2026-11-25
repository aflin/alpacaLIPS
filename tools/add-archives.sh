#!/bin/bash
# Fetch and import archives by name, one at a time.
#
#   tools/add-archives.sh mdwiki archlinux gentoo
#
# Each name must match exactly one Metalink in the url list. For each
# archive in turn: fetch it (resumable, verified against the Metalink's
# sha-256, skipped if already complete), then stage and import it into
# its own table.
#
# THE CORPUS IS NOT TOUCHED. Merging is deliberate and separate, because
# insertion order is a ranking policy (DESIGN.md §2) and because the
# fulltext index does not maintain itself. When this finishes:
#
#   rampart tools/merge-into-corpus.js --db $DB --list     # see the plan
#   rampart tools/merge-into-corpus.js --db $DB --go       # append
#
# One archive failing does not stop the others; the summary at the end
# names what failed and at which step.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
LIPS=$(cd "$HERE/.." && pwd)
source "$LIPS/config.sh"
# config.sh assigns without exporting, and the children read the
# environment, so these have to be exported here.
export LIPS DATA META KIWIX STAGE DB DOWNLOAD_DIR

if [ $# -lt 1 ]; then
    echo "usage: $(basename "$0") <name> [<name> ...]" >&2
    echo "  each name matches one archive in the Metalink url list" >&2
    exit 1
fi

t0=$(date +%s)
ok=0
fail=0
failed=""

for pat in "$@"; do
    echo
    echo "################ $pat   $(date '+%F %T')"

    if ! bash "$HERE/download/fetch-one.sh" "$pat"; then
        echo "FETCH FAILED: $pat" >&2
        fail=$((fail + 1)); failed="$failed $pat(fetch)"
        continue
    fi

    # fetch-one.sh leaves the job it ran in jobs-one.tsv, so the archive
    # name comes from there rather than being guessed from the pattern.
    zim=$(basename "$(cut -f1 "$META/jobs-one.tsv")")
    if [ -z "$zim" ]; then
        echo "NO ARCHIVE NAME for $pat" >&2
        fail=$((fail + 1)); failed="$failed $pat(name)"
        continue
    fi

    echo "---- importing $zim   $(date '+%T')"
    if ! bash "$HERE/run-import.sh" --db "$DB" "$zim"; then
        echo "IMPORT FAILED: $zim" >&2
        fail=$((fail + 1)); failed="$failed $pat(import)"
        continue
    fi
    ok=$((ok + 1))
done

echo
echo "################ $ok imported, $fail failed, $(( ($(date +%s) - t0) / 60 )) min"
[ -n "$failed" ] && echo "    failures:$failed"
echo
if [ "$ok" -gt 0 ]; then
    echo "The corpus is unchanged. To see what would be appended:"
    echo "    rampart tools/merge-into-corpus.js --db $DB --list"
fi
[ "$fail" -eq 0 ]
