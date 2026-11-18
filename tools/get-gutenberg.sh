#!/bin/bash
# Download the Project Gutenberg ZIM slices into the archive pool, in
# priority order so the useful ones land first and the run can be stopped
# at any point.
#
#   tools/get-gutenberg.sh [--list]
#
# Slices partition gutenberg_en_all (~208 GiB / ~85k books across 39
# files). Downloading slices rather than the single en_all file lets each
# become its own table, per the import plan, and lets us stop early.
#
# Only download.kiwix.org carries these: the US mirrors
# (dumps.wikimedia.org, ftpmirror.your.org) mirror the Wikimedia families
# only. Measured 8.7 MB/s from that host, so the full set is ~6.7 h.
#
# DATES ARE PER SLICE, NOT PER DUMP. A given month's run does not rebuild
# every letter -- lcc-c and lcc-d exist only at 2025-12 while the rest are
# at 2026-03 -- so a single hardcoded $DATE 404s on whatever was skipped.
# The newest date per slice is read from the server index instead.
set -u
LIPS=${LIPS:-$(cd "$(dirname "$0")/.." && pwd)}
. "$LIPS/config.sh"
POOL=${POOL:-$KIWIX}
BASE=https://download.kiwix.org/zim/gutenberg

# literature and philosophy first -- the thin primary tier is the reason
# for doing this at all; then science/technology; then the rest.
ORDER="pr ps pz b t q d n e f a g h s pq m pn z r v c u pe pt l pa j pg pj k pc pl pk pb ph pm p pd pf"

IDX=$(mktemp) || exit 1
trap 'rm -f "$IDX"' EXIT
# -L matters: download.kiwix.org redirects to lb.download.kiwix.org, and
# without it the body is a 162-byte redirect stub, not the listing.
if ! curl -sL --max-time 120 "$BASE/" -o "$IDX" || [ ! -s "$IDX" ]; then
    echo "cannot read $BASE/ -- no index, no per-slice dates" >&2; exit 1
fi

# Newest filename for one slice. The trailing _ in the pattern keeps
# lcc-p from matching lcc-pa; dates sort lexically as YYYY-MM.
newest() {
    grep -o -E "gutenberg_en_lcc-$1_[0-9]{4}-[0-9]{2}\.zim" "$IDX" \
        | sort -u | tail -1
}

if [ "${1:-}" = "--list" ]; then
    for s in $ORDER; do
        f=$(newest "$s")
        echo "${f:-"(none for lcc-$s)"}"
    done
    exit 0
fi

mkdir -p "$POOL" || exit 1
ok=0; skip=0; fail=0; miss=0
for s in $ORDER; do
    f=$(newest "$s")
    if [ -z "$f" ]; then
        echo "ABSENT no lcc-$s in the index"; miss=$((miss+1)); continue
    fi
    # Any dated copy counts as present: re-running must not re-fetch 15 GiB
    # because a newer dump appeared. Replacing one is a deliberate act.
    #
    # MIN guards against treating a truncated or clobbered file as done --
    # the smallest real slice is ~10 MB, so anything under 1 MB is wreckage,
    # not an archive. A plain -s test passed a 2-byte file.
    have=""
    for c in "$POOL"/gutenberg_en_lcc-"$s"_*.zim; do
        [ -f "$c" ] || continue
        if [ "$(stat -c %s "$c")" -lt 1048576 ]; then
            echo "SHORT  $(basename "$c") -- ignoring, will re-fetch"
        else
            have="$c"
        fi
    done
    if [ -n "$have" ]; then
        echo "have   $(basename "$have")"; skip=$((skip+1)); continue
    fi
    echo "get    $f"
    # -C - resumes a partial file; write to .part so an interrupted
    # download is never mistaken for a complete archive.
    #
    # --speed-limit/--speed-time matter on the big slices: a connection
    # that goes quiet without closing leaves curl waiting forever, and
    # --retry never fires because nothing has failed yet. lcc-d hung at
    # 27.4 of 37.5 GiB and sat there 23 minutes until killed by hand.
    # Below 100 KB/s averaged over 2 minutes, curl now aborts, and
    # --retry-all-errors resumes it from the .part.
    if curl -fL --retry 5 --retry-delay 10 --retry-all-errors \
            --speed-limit 102400 --speed-time 120 -C - \
            -o "$POOL/$f.part" "$BASE/$f"; then
        mv "$POOL/$f.part" "$POOL/$f"
        echo "ok     $f  $(du -h "$POOL/$f" | cut -f1)"
        ok=$((ok+1))
    else
        echo "FAILED $f"; fail=$((fail+1))
    fi
done
echo "done: $ok downloaded, $skip already present, $fail failed, $miss absent upstream"
