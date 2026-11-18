#!/bin/bash
# Fetch the maxi-flavour ZIMs (images included) into the corpus directory.
# Small archives first so they land quickly; Wikipedia's 118.67 GB is the
# long pole and runs alongside. sha256 verified by worker.sh on arrival.
set -u
source "$(dirname "$0")/../../config.sh"
BIN="$(cd "$(dirname "$0")" && pwd)"
chmod +x "$BIN/worker.sh"
# order smallest-first within the pool
sort -t$'\t' -k3 -n "$META/jobs-maxi.tsv" > "$META/jobs-maxi-sorted.tsv"
printf '[%s] maxi pool: %s job(s), %s GB\n' "$(date '+%F %T')" \
  "$(grep -c . "$META/jobs-maxi-sorted.tsv")" \
  "$(awk -F'\t' '{s+=$3} END {printf "%.1f", s/1073741824}' "$META/jobs-maxi-sorted.tsv")" \
  >> "$META/progress.log"
xargs -a "$META/jobs-maxi-sorted.tsv" -d '\n' -P 3 -I{} "$BIN/worker.sh" {}
printf '[%s] maxi pool: finished\n' "$(date '+%F %T')" >> "$META/progress.log"
