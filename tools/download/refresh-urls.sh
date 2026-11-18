#!/bin/bash
# Move the archive list on to the dumps kiwix is serving today.
#
#   tools/download/refresh-urls.sh [--list] [--out FILE]
#
#   --list   show what would change and write nothing
#   --out    write somewhere other than $META/kiwix-urls.txt
#
# kiwix-urls.txt names one Metalink per archive and each filename carries
# the dump date (..._2026-10.zim.meta4). Kiwix keeps only the last dump or
# two, so a list written in October 404s by December. This reads ONE
# directory index per collection -- ten requests, not 176 -- and rewrites
# each line to the newest dated file with the same base name.
#
# WHICH archives, and which flavour of each, is a deliberate choice and is
# never touched here: only the date moves. The list that ships in the repo
# stays as the record of what the published corpus was built from; the
# refreshed copy is written under $META, which is what mkjobs.js reads.
#
# -L matters on every request: download.kiwix.org redirects to
# lb.download.kiwix.org, and without it the body is a redirect stub.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/../../config.sh"

LIST=0
OUT=$META/kiwix-urls.txt
while [ $# -gt 0 ]; do
    case "$1" in
        --list) LIST=1; shift ;;
        --out)  OUT="$2"; shift 2 ;;
        -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done

IN=$META/kiwix-urls.txt
[ -f "$IN" ] || IN=$HERE/kiwix-urls.txt
[ -f "$IN" ] || { echo "no url list at $META/kiwix-urls.txt or $HERE/kiwix-urls.txt" >&2; exit 1; }
echo "reading $IN"

WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT

# One directory index per collection, fetched once and re-used.
index_for() {
    local dir="$1" key
    key=$(printf '%s' "$dir" | tr -c 'A-Za-z0-9' '_')
    if [ ! -f "$WORK/$key" ]; then
        curl -sL --max-time 120 "$dir" -o "$WORK/$key" || :
        [ -f "$WORK/$key" ] || : > "$WORK/$key"
        [ -s "$WORK/$key" ] || echo "  cannot read $dir" >&2
        sleep 1
    fi
    printf '%s' "$WORK/$key"
}

# Newest dated archive in that listing with the same base name. The
# listing links the .zim files only -- the .meta4 beside each one is real
# but not linked -- so the match is on .zim and the caller adds .meta4.
# The leading _ keeps a prefix from matching a longer sibling (lcc-p vs
# lcc-pa), and the dates sort lexically as YYYY-MM.
newest_in() {
    grep -o -E "$1_[0-9]{4}-[0-9]{2}\.zim" "$2" | sort -u | tail -1
}

same=0; moved=0; gone=0
: > "$WORK/out"
while IFS= read -r url; do
    case "$url" in ""|\#*) printf '%s\n' "$url" >> "$WORK/out"; continue ;; esac
    file=${url##*/}
    dir=${url%/*}/
    zim=${file%.meta4}
    base=$(printf '%s' "$zim" | sed 's/_[0-9][0-9][0-9][0-9]-[0-9][0-9]\.zim$//')
    if [ "$base" = "$zim" ]; then         # no date to move
        printf '%s\n' "$url" >> "$WORK/out"; same=$((same+1)); continue
    fi
    idx=$(index_for "$dir")
    new=$(newest_in "$base" "$idx")
    if [ -z "$new" ]; then
        echo "  GONE    $zim  (nothing named $base in $dir)"
        printf '%s\n' "$url" >> "$WORK/out"; gone=$((gone+1)); continue
    fi
    if [ "$new" = "$zim" ]; then
        same=$((same+1))
    else
        echo "  moved   $zim  ->  $new"
        moved=$((moved+1))
    fi
    printf '%s%s.meta4\n' "$dir" "$new" >> "$WORK/out"
done < "$IN"

echo
echo "$moved moved, $same unchanged, $gone no longer listed upstream"

if [ "$LIST" -eq 1 ]; then
    echo "--list given, nothing written"
else
    mkdir -p "$(dirname "$OUT")" || exit 1
    [ -f "$OUT" ] && cp -p "$OUT" "$OUT.prev"
    mv "$WORK/out" "$OUT" || exit 1
    echo "wrote $OUT$( [ -f "$OUT.prev" ] && printf ' (previous kept as %s.prev)' "$OUT" )"
fi

# The seven maxi archives are named explicitly in maxijobs.js, with their
# dates, because each is chosen by flavour rather than listed. Advisory
# only: the file is not edited here.
MAXI=$HERE/maxijobs.js
if [ -f "$MAXI" ]; then
    echo
    echo "maxi archives named in maxijobs.js:"
    grep -o -E '\["[a-z]+", *"[A-Za-z0-9_.-]+\.zim"\]' "$MAXI" |
    while IFS= read -r pair; do
        coll=$(printf '%s' "$pair" | sed 's/^\["\([a-z]*\)".*/\1/')
        file=$(printf '%s' "$pair" | sed 's/.*"\([A-Za-z0-9_.-]*\.zim\)"\]$/\1/')
        base=$(printf '%s' "$file" | sed 's/_[0-9][0-9][0-9][0-9]-[0-9][0-9]\.zim$//')
        idx=$(index_for "https://lb.download.kiwix.org/zim/$coll/")
        new=$(newest_in "$base" "$idx")
        if [ -z "$new" ]; then
            printf '  %-46s NOT LISTED upstream any more\n' "$file"
        elif [ "$new" = "$file" ]; then
            printf '  %-46s current\n' "$file"
        else
            printf '  %-46s newest upstream is %s\n' "$file" "$new"
        fi
    done
    echo "  edit that list by hand to move them."
fi
