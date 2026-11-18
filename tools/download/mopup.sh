#!/bin/bash
# Retry anything missing or short.  Single-URL jobs (Hugging Face) have
# no mirror to fall back on, so one transient failure ends them -- this
# is what recovers those.
#
# Do not gate the first pass on "all workers idle": during the initial
# fetch that parked three recoverable files behind an unrelated 107 GiB
# download for twelve hours.  Retry on a timer instead.
set -u
source "$(dirname "$0")/../../config.sh"
BIN="$(cd "$(dirname "$0")" && pwd)"
PASSES="${1:-8}"; WAIT="${2:-600}"
say () { printf '[%s] mopup: %s\n' "$(date '+%F %T')" "$*" >> "$META/progress.log"; }

for pass in $(seq 1 "$PASSES"); do
    rampart "$BIN/incomplete.js" > "$META/jobs-todo.tsv" 2>/dev/null
    n=$(grep -c . "$META/jobs-todo.tsv" 2>/dev/null || echo 0)
    say "pass $pass: $n incomplete"
    [ "$n" = "0" ] && { say "complete"; exit 0; }
    xargs -a "$META/jobs-todo.tsv" -d '\n' -P 4 -I{} "$BIN/worker.sh" {}
    sleep "$WAIT"
done
rampart "$BIN/incomplete.js" > "$META/jobs-todo.tsv" 2>/dev/null
say "done; $(grep -c . "$META/jobs-todo.tsv" 2>/dev/null || echo 0) still incomplete"
