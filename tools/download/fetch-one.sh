#!/bin/bash
# Fetch one archive by name, for adding a single ZIM to the corpus.
#
#   tools/download/fetch-one.sh appropedia
#   tools/download/fetch-one.sh wikiversity_en
#
# The pattern matches against the Metalink URL list, and must match
# exactly one archive. The archive lands where the configuration says
# archives go, is verified against the Metalink's sha-256, and resumes if
# a previous attempt stopped part way.
#
# This exists because the destination must come from the configuration,
# not from a default: run on its own, mkjobs.js has no $KIWIX to read and
# falls back to <data>/archives, which on an install that keeps archives
# elsewhere is the wrong disk. config.sh assigns without exporting, so
# sourcing alone is not enough -- the exports below are what the child
# rampart process actually reads.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../../config.sh"
export LIPS DATA META KIWIX STAGE DB DOWNLOAD_DIR

[ $# -ge 1 ] || { echo "usage: $(basename "$0") <name-pattern>" >&2; exit 1; }
PAT=$1

rampart "$HERE/mkjobs.js" --name "$PAT"

ONE=$META/jobs-one.tsv
[ -s "$ONE" ] || { echo "no job list at $ONE" >&2; exit 1; }

n=$(grep -c . "$ONE")
if [ "$n" -ne 1 ]; then
    echo "pattern '$PAT' matched $n archives; narrow it:" >&2
    cut -f1 "$ONE" | xargs -n1 basename >&2
    exit 1
fi

echo "=== fetching:"
cut -f1 "$ONE" | sed 's/^/    /'

# One line, so read it rather than looping. worker.sh skips a file that is
# already complete, which makes re-running this harmless.
bash "$HERE/worker.sh" "$(cat "$ONE")"

echo "=== done; $(basename "$(cut -f1 "$ONE")") is in $KIWIX"
echo "    next: tools/run-import.sh --db \$DB <that name>"
