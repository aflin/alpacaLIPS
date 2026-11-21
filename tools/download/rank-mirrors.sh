#!/bin/sh
# Measure the kiwix mirrors and leave the order on disk for mkjobs.js.
#
#   tools/download/rank-mirrors.sh <meta-dir> [<test-path>]
#
# mkjobs.js rotates each job's mirror list by job index, which spreads
# load evenly but knows nothing about speed -- and these mirrors are not
# comparable. Measured from this machine, same file, same minute:
#
#   mirrors.dotsrc.org          7.8 MB/s one stream, 41 at sixteen
#   ftpmirror.your.org          7.5
#   dumps.wikimedia.org         4.5
#   ftp.nluug.nl                3.9
#   mirror.download.kiwix.org   0.3        <- a quarter of jobs start here
#
# So the rotation still happens, but over mirrors sorted by measurement
# rather than by whatever order the metalink listed.
#
# What this cannot do is pick a single winner: three successive probes
# named three different mirrors fastest, because an 8 MB sample is mostly
# TCP slow-start and mirror load moves minute to minute. It is reliable
# at spotting the broken one, which is the decision that matters.
#
# Coverage is partial -- Your.Org and dumps.wikimedia 404 the whole
# zim/other/ directory -- so each mirror is measured with a path taken
# from a job that lists that mirror, never one fixed path for all.

META=${1:?usage: rank-mirrors.sh <meta-dir> [<test-path>]}
JOBS="$META/jobs.tsv"
OUT="$META/mirror-rank.txt"
[ -f "$JOBS" ] || { echo "rank-mirrors: no $JOBS" >&2; exit 1; }

# Every mirror named anywhere in the job list, and for each one a path it
# is known to serve.
MIRRORS=$(awk -F'\t' '{ for (i = 4; i <= NF; i++) if ($i ~ /^https?:/) {
        u = $i; sub(/^https?:\/\//, "", u); sub(/\/.*/, "", u); print u } }' \
    "$JOBS" | sort -u)

: > "$OUT.new"
for h in $MIRRORS; do
    # A URL for this mirror out of the job list itself, so the file is
    # one it actually has.
    U=$(awk -F'\t' -v h="$h" '{ for (i = 4; i <= NF; i++)
            if (index($i, "://" h "/")) { print $i; exit } }' "$JOBS" \
        | head -1)
    [ -n "$U" ] || continue
    SP=$(curl -s -o /dev/null -m 15 -r 0-8388607 \
              -w '%{speed_download}' "$U" 2>/dev/null)
    SP=${SP%%.*}; SP=${SP:-0}
    printf '%s\t%s\n' "$SP" "$h" >> "$OUT.new"
    awk -v s="$SP" -v h="$h" 'BEGIN{ printf "  %-28s %6.2f MB/s\n", h, s/1048576 }'
done

sort -rn "$OUT.new" | awk -F'\t' '{ print $2 }' > "$OUT"
rm -f "$OUT.new"
echo "rank-mirrors: order written to $OUT"
