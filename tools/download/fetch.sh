#!/bin/bash
# Run download jobs from $META/jobs.tsv.
#   fetch.sh <tag> <grep-pattern> [parallel]
# e.g.  fetch.sh kiwix /kiwix/ 4
#       fetch.sh hf    /hf/    4
#
# Mirror choice matters: the rotated Metalink pool measured 1.78 MB/s
# where ftp.fau.de sustained ~13 MB/s on the same files.  Prefer a
# known-fast mirror for bulk work and keep the Metalink hash check.
set -u
source "$(dirname "$0")/../../config.sh"
BIN="$(cd "$(dirname "$0")" && pwd)"
TAG="${1:?tag}"; PAT="${2:?grep pattern}"; P="${3:-4}"
chmod +x "$BIN/worker.sh"
grep -- "$PAT" "$META/jobs.tsv" > "$META/jobs-$TAG.tsv"
printf '[%s] pool %s: %s job(s), %s parallel\n' "$(date '+%F %T')" \
       "$TAG" "$(grep -c . "$META/jobs-$TAG.tsv")" "$P" >> "$META/progress.log"
xargs -a "$META/jobs-$TAG.tsv" -d '\n' -P "$P" -I{} "$BIN/worker.sh" {}
printf '[%s] pool %s: finished\n' "$(date '+%F %T')" "$TAG" >> "$META/progress.log"
