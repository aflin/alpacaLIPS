#!/bin/bash
# Publish the staged payloads to Cloudflare R2.
#
#   tools/publish-r2.sh                     publish what is staged
#   tools/publish-r2.sh --dry-run           show what would change
#   tools/publish-r2.sh --archives          include the .zim files too
#   tools/publish-r2.sh --remote r2:bucket  a different bucket
#   tools/publish-r2.sh --public URL        the public host, for the checks
#
# ORDER IS THE WHOLE POINT. corpus-current.txt names the payload a client
# should fetch, so it goes up LAST and alone: while it still names the
# previous payload, a half-uploaded new one is invisible rather than
# broken. Nothing is renamed, because R2 has no directory rename -- it
# would copy every part -- and because renaming moves files out from
# under a download already running.
#
# THREE PHASES, because the right cache lifetime differs:
#
#   A  corpus-2*/            immutable. A dated payload never changes, so
#                            it can be cached forever
#   B  everything else       five minutes. version.txt and the inventory
#                            change when a build does
#   C  corpus-current.txt    no-store. A cached pointer means installs
#                            keep fetching the payload you replaced
#
# The headers are set on upload so this holds even if the Cloudflare
# cache rules are missing or wrong: correctness does not depend on a
# dashboard setting.
#
# Each phase deletes what is no longer staged (--delete-after, so
# removals happen only after the transfers succeed). That is what carries
# the week-retention prune to the bucket. Filters protect everything a
# phase does not own, so no phase can delete another's files -- which is
# why the pointer survives phase A and B.
#
# archives/ is 530 GB and is NOT published by default. It is excluded by
# filter rather than omitted, so a bucket that already has it keeps it.
set -u
# No pathname expansion: the filter patterns below are expanded unquoted
# so they word-split into rclone's arguments, and that also exposes them
# to globbing. Run from a directory that happens to contain archives/ or
# corpus-2026-11-26/ and a pattern would expand to real filenames.
set -f

LIPS=${LIPS:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}
# shellcheck source=/dev/null
[ -f "$LIPS/config.sh" ] && . "$LIPS/config.sh"

REMOTE=${LIPS_R2_REMOTE:-r2:alpacalips}
# The project's own prefix in the bucket. The root is left for other
# projects, and the sync cannot reach outside this.
PREFIX=${LIPS_R2_PREFIX:-alpacalips}
STAGE_DIR=${DOWNLOAD_DIR:-$LIPS/downloads/alpacalips}
PUBLIC=${LIPS_PUBLIC_BASE:-https://dl.moatxing.com}
WANT_ARCHIVES=0
# --news: the daily refresh. Only news/ goes up, and nothing that
# describes the corpus is touched.
ONLY_NEWS=0
DRY=0
YES=0
NOTES=${NOTES:-$LIPS/notes}

while [ $# -gt 0 ]; do
    case "$1" in
        --remote)   REMOTE=$2; shift 2 ;;
        --prefix)   PREFIX=${2#/}; PREFIX=${PREFIX%/}; shift 2 ;;
        --stage)    STAGE_DIR=$2; shift 2 ;;
        --public)   PUBLIC=${2%/}; shift 2 ;;
        --archives) WANT_ARCHIVES=1; shift ;;
        --news)     ONLY_NEWS=1; shift ;;
        --dry-run)  DRY=1; shift ;;
        -y|--yes)   YES=1; shift ;;
        -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

DEST=$REMOTE${PREFIX:+/$PREFIX}
PUBDIR=$PUBLIC${PREFIX:+/$PREFIX}

say() { printf "  %-28s %s\n" "$1" "$2"; }
die() { echo "$*" >&2; exit 1; }

command -v rclone >/dev/null 2>&1 || die "rclone is not on PATH"
RV=$(rclone version 2>/dev/null | head -1 | sed 's/^rclone v//')
case "$RV" in
    1.4*|1.5[0-4]*) die "rclone $RV predates R2 support; install 1.55 or newer" ;;
esac
[ -d "$STAGE_DIR" ] || die "no staging directory at $STAGE_DIR"

# The one mistake with no recovery: a pointer naming a payload that is
# not there. Clients would read it, fetch nothing, and the previous
# payload would already have stopped being current.
PTR=$STAGE_DIR/corpus-current.txt
if [ "$ONLY_NEWS" -eq 1 ]; then
    [ -d "$STAGE_DIR/news" ] || die "no news payload staged in $STAGE_DIR/news"
    [ -f "$STAGE_DIR/news/MANIFEST" ] \
        || die "$STAGE_DIR/news has no MANIFEST -- it was never finished"
    echo "=== publish the news payload to R2"
    # The news page describes the window, which this run has just changed.
    if [ -f "$LIPS/tools/make-download-index.js" ]; then
        rampart "$LIPS/tools/make-download-index.js" --stage "$STAGE_DIR" \
            >/dev/null 2>&1 || say "note" "could not regenerate the pages"
    fi
    say "from" "$STAGE_DIR/news"
    say "to" "$REMOTE${PREFIX:+/$PREFIX}/news"
    rclone lsjson --max-depth 1 "$REMOTE" >/dev/null 2>&1 \
        || die "cannot list $REMOTE -- check the remote and the token's scope"
    rclone sync "$STAGE_DIR/news" "$REMOTE${PREFIX:+/$PREFIX}/news" \
        --delete-after --header-upload "Cache-Control: public, max-age=300" \
        --transfers 4 --checkers 8 --s3-chunk-size 64M \
        --stats-one-line --stats 30s 2>&1 | tail -3 | sed 's/^/  /'
    _ph=$(printf '%s' "${PUBLIC:-}" | sed -e 's#^https\{0,1\}://##' -e 's#/.*##')
    if [ -n "$_ph" ] && getent hosts "$_ph" >/dev/null 2>&1; then
        _nm=$(curl -fsL --max-time 60 "$PUBLIC${PREFIX:+/$PREFIX}/news/MANIFEST" \
                  2>/dev/null | grep -c . || echo 0)
        say "readable" "$_nm manifest lines through $_ph"
    else
        say "checks skipped" "${_ph:-the public host} does not resolve here"
    fi
    say "done" "news only; the corpus pointer was not touched"
    exit 0
fi
[ -f "$PTR" ] || die "no corpus-current.txt in $STAGE_DIR -- nothing has been packed"
CUR=$(tr -d ' \t\r\n' < "$PTR")
[ -n "$CUR" ] || die "corpus-current.txt is empty"
[ -d "$STAGE_DIR/$CUR" ] || die "corpus-current.txt names $CUR, which is not in $STAGE_DIR"
[ -f "$STAGE_DIR/$CUR/MANIFEST" ] || die "$CUR has no MANIFEST -- it was never finished"

echo "=== publish to R2"
say "from" "$STAGE_DIR"
say "to" "$DEST"
say "current payload" "$CUR ($(du -sh "$STAGE_DIR/$CUR" 2>/dev/null | cut -f1), $(grep -c . "$STAGE_DIR/$CUR/MANIFEST") parts)"
say "public host" "$PUBLIC"
say "rclone" "$RV"
[ "$WANT_ARCHIVES" -eq 1 ] && say "archives" "ZIMs included (hundreds of GB)" \
                           || say "archives" "metadata only; ZIMs come from the mirrors"

# Reachability, with the token that is configured rather than in theory.
# A bucket-scoped token cannot list buckets, so this lists the bucket.
rclone lsjson --max-depth 1 "$REMOTE" >/dev/null 2>&1 \
    || die "cannot list $REMOTE -- check the remote name and the token's bucket scope"
say "remote" "reachable"

# Before anything is uploaded: what goes up must describe what goes up.
if [ -x "$LIPS/tools/make-download-index.js" ] || [ -f "$LIPS/tools/make-download-index.js" ]; then
    rampart "$LIPS/tools/make-download-index.js" --stage "$STAGE_DIR" \
        --base "${LIPS_CANON_BASE:-https://rampart.dev/downloads/alpacalips}" \
        --install "${LIPS_INSTALL_URL:-https://rampart.dev/install-alpacalips.sh}" \
        2>&1 | sed 's/^/  /' \
        || say "note" "could not regenerate index.html"
fi

IMMUTABLE="Cache-Control: public, max-age=31536000, immutable"
SHORT="Cache-Control: public, max-age=300"
NOSTORE="Cache-Control: no-store"
TUNE="--transfers 4 --checkers 8 --s3-chunk-size 64M --s3-upload-concurrency 4"

# Phase A owns the dated payloads and nothing else, so its --delete-after
# removes exactly the payloads the local prune removed.
A_FILTER="--include corpus-2*/**"
# Phase B owns the small published files. corpus-2* is excluded so B
# cannot delete a payload, the pointer so B cannot delete or stale it,
# and the old corpus/ and corpus-old/ because the dated layout replaced
# them -- they are left alone rather than deleted, until you say so.
# Both phases work inside $DEST, so anything elsewhere in the bucket --
# another project, speedtest/ -- is already out of reach of --delete-after.
B_FILTER="--exclude corpus-2*/** --exclude corpus-current.txt \
          --exclude corpus/** --exclude corpus-old/**"
# The ZIMs, not the directory: MIRRORS, UPSTREAM, MANIFEST and the
# per-archive .sha256 files are what an install needs in order to fetch
# the archives from the mirrors that already carry them.
[ "$WANT_ARCHIVES" -eq 1 ] || B_FILTER="$B_FILTER --exclude archives/*.zim"

plan() {   # plan <label> <filters...>
    local label=$1; shift
    printf "\n  --- %s, what would change ---\n" "$label"
    # shellcheck disable=SC2086
    rclone sync "$STAGE_DIR" "$DEST" $* --delete-after --dry-run 2>&1 \
        | grep -E "^(NOTICE|INFO)?.*(Copied|Deleted|Updated|Skipped|would)" \
        | head -12 | sed 's/^/    /'
}

if [ "$DRY" -eq 1 ]; then
    plan "payloads" $A_FILTER
    plan "everything else" $B_FILTER
    printf "\n  pointer would be set to: %s\n" "$CUR"
    echo "  --dry-run: nothing uploaded."
    exit 0
fi

if [ "$YES" -eq 0 ]; then
    plan "payloads" $A_FILTER
    plan "everything else" $B_FILTER
    printf "\n  This uploads to %s and deletes what is no longer staged.\n" "$REMOTE"
    printf "  Proceed? [y/N] "
    read -r ans
    case "$ans" in y|Y|yes|YES) ;; *) echo "  stopped."; exit 0 ;; esac
fi

mkdir -p "$NOTES"
LOG=$NOTES/publish-r2.log
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') publish $CUR to $REMOTE" >> "$LOG"

# shellcheck disable=SC2086
run_phase() {   # run_phase <label> <header> <filters...>
    local label=$1 hdr=$2; shift 2
    printf "\n=== %s\n" "$label"
    rclone sync "$STAGE_DIR" "$DEST" $* --delete-after \
        --header-upload "$hdr" $TUNE --progress --stats-one-line 2>&1 \
        | tee -a "$LOG" | tail -4 | sed 's/^/  /'
    return "${PIPESTATUS[0]}"
}

run_phase "A: dated payloads (immutable)" "$IMMUTABLE" $A_FILTER \
    || die "payload upload failed -- corpus-current.txt NOT changed, so the
previous payload is still the current one. Fix and run again."

run_phase "B: runtime, inventory, news, kiwix (5 min)" "$SHORT" $B_FILTER \
    || die "upload failed -- corpus-current.txt NOT changed. Fix and run again."

# Phase C, alone and last: this is the publish.
printf "\n=== C: the pointer\n"
rclone copy "$PTR" "$DEST" --header-upload "$NOSTORE" 2>&1 \
    | tee -a "$LOG" | tail -2 | sed 's/^/  /'
say "published" "$CUR"

# Read it back through the public host, because that is what an install
# uses -- and because a cached pointer or a missing cache rule shows up
# here and nowhere else.
printf "\n=== the bucket root\n"
# The bucket root. Built from the bucket's own top-level prefixes, so a
# project added later appears without editing this, and COPIED rather
# than synced: a sync of the root is the one thing that could delete
# another project's files.
RIDX=$LIPS/notes/.root
mkdir -p "$RIDX"
{
    printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    printf '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    printf '<title>dl.moatxing.com</title>\n<style>\n'
    printf ':root{--bg:#fff;--fg:#111;--dim:#555;--acc:#0b5}\n'
    printf '@media (prefers-color-scheme:dark){:root:not([data-theme=light]){'
    printf '--bg:#15171a;--fg:#e8e8e8;--dim:#a0a4aa;--acc:#2db36a}}\n'
    printf 'body{margin:0;padding:2rem 1rem;background:var(--bg);color:var(--fg);'
    printf 'font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Helvetica,sans-serif}\n'
    printf 'main{max-width:40rem;margin:0 auto}h1{font-size:1.3rem;margin:0 0 .5rem}\n'
    printf 'ul{padding-left:1.1rem}li{margin:.3rem 0}a{color:var(--acc)}\n'
    printf 'p{color:var(--dim);font-size:.92rem}\n'
    printf 'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}\n'
    printf '</style>\n</head>\n<body>\n<main>\n'
    printf '<h1>dl.moatxing.com</h1>\n'
    printf '<p>Downloads for rampart projects.</p>\n<ul>\n'
    rclone lsf --dirs-only "$REMOTE" 2>/dev/null | while read -r d; do
        printf '<li><a href="%s">%s</a></li>\n' "$d" "$d"
    done
    printf '</ul>\n'
    printf '<p>Object storage, so there is no automatic index: a directory URL\n'
    printf 'works because a rule appends <code>index.html</code>, and each\n'
    printf 'project directory carries its own page.</p>\n'
    printf '<p>Generated %s.</p>\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
    printf '</main>\n</body>\n</html>\n'
} > "$RIDX/index.html"
if rclone copy "$RIDX/index.html" "$REMOTE" --header-upload "$SHORT" 2>/dev/null; then
    say "root listing" "$(rclone lsf --dirs-only "$REMOTE" 2>/dev/null | grep -c .) directories"
else
    say "root listing" "could not upload"
fi

printf "\n=== checking through %s\n" "$PUBLIC"
# The upload used the S3 endpoint; these checks use the public hostname,
# which is a different name and may not resolve here yet -- a resolver
# that negative-cached it before the record existed will say nothing.
# Reporting that as "not published" would be wrong and alarming.
PUBHOST=$(printf '%s' "$PUBLIC" | sed -e 's#^https\{0,1\}://##' -e 's#/.*##')
if ! getent hosts "$PUBHOST" >/dev/null 2>&1; then
    say "checks skipped" "$PUBHOST does not resolve from this host"
    say "" "the upload itself is fine: it used the S3 endpoint, not this name"
    say "" "check from elsewhere, or pin the address:"
    say "" "curl --resolve $PUBHOST:443:ADDR $PUBDIR/corpus-current.txt"
    printf "\n  published %s\n" "$CUR"
    exit 0
fi
GOT=$(curl -fsL --max-time 60 "$PUBDIR/corpus-current.txt" 2>/dev/null | tr -d ' \t\r\n')
if [ "$GOT" = "$CUR" ]; then
    say "pointer" "$GOT"
else
    say "pointer" "reads '$GOT', expected '$CUR'"
    say "" "if it names the previous payload, the pointer is being cached:"
    say "" "set a no-store cache rule for corpus-current.txt on the zone"
fi
curl -fsL --max-time 60 "$PUBDIR/$CUR/MANIFEST" >/dev/null 2>&1 \
    && say "MANIFEST" "readable" || say "MANIFEST" "NOT readable at $PUBDIR/$CUR/"
P0=$(awk 'NR == 1 { print $1; exit }' "$STAGE_DIR/$CUR/MANIFEST")
# -L because a redirect in front of the host would otherwise make this
# check pass on the 3xx without the object existing.
if [ -n "$P0" ]; then
    SZ=$(curl -fsIL --max-time 60 "$PUBDIR/$CUR/$P0" 2>/dev/null \
            | awk 'tolower($1) == "content-length:" { print $2 }' | tr -d '\r' | tail -1)
    WANT=$(awk -v p="$P0" '$1 == p { print $2 }' "$STAGE_DIR/$CUR/MANIFEST")
    if [ -n "$SZ" ] && [ "$SZ" = "$WANT" ]; then
        say "$P0" "$SZ bytes, as the manifest says"
    else
        say "$P0" "served ${SZ:-nothing}, manifest says $WANT"
    fi
fi
printf "\n  install with: BASE=%s ./setup.sh --corpus\n" "$PUBDIR"
