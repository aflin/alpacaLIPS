#!/bin/sh
# news-cron.sh -- refresh the news window, then publish it.
#
#   tools/news-cron.sh [--publish DIR]
#
# Two things, in order: build the rolling news window from the current
# events portal, then stage the news payload where downloads are served
# from. Without the second step the window is rebuilt and nobody can
# fetch it, and `setup.sh --news` on an installed copy keeps finding the
# same sha256 it already has.
#
# Written for cron, so it is quiet when it works: the build's output goes
# to notes/news-cron.log and only a failure prints, which is what cron
# mails. Exit status is 0 for a refresh and 0 for a skipped run; non-zero
# only when something actually broke.
#
# --publish defaults to PUBLISH in config.local.sh, and to
# downloads/alpacalips in the tree if that is not set either.

set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"

# PUBLISH rather than STAGE, deliberately: config.sh uses STAGE for the
# JSONL staging directory, and a wrapper that sourced config.sh and let
# that name through would hand make-payloads.sh the extraction tree to
# publish into.
PUBLISH=""
while [ $# -gt 0 ]; do
    case $1 in
        --publish) PUBLISH=${2:?--publish needs a directory}; shift 2 ;;
        -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done
# DOWNLOAD_DIR is what build.sh writes and what --download-dir sets.
# PUBLISH was an earlier name for the same directory and is still read,
# so a config.local.sh written before the rename keeps working.
if [ -z "$PUBLISH" ] && [ -r config.local.sh ]; then
    for n in DOWNLOAD_DIR PUBLISH; do
        PUBLISH=$(sed -n "s/^$n=//p" config.local.sh |
                  sed 's/^\${[A-Z_]*:-//; s/}$//' | tr -d '"' | head -1)
        [ -n "$PUBLISH" ] && break
    done
fi
PUBLISH=${PUBLISH:-$HERE/downloads/alpacalips}
# Where the payload is published to, if anywhere. Same default as
# publish-r2.sh, and overridable the same way.
LIPS_R2_REMOTE=${LIPS_R2_REMOTE:-r2:alpacalips}
export LIPS_R2_REMOTE

mkdir -p "$HERE/notes"
LOG=$HERE/notes/news-cron.log
log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG"; }

# Three runs a day append the build's output each time, so keep the log
# from growing without bound.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 2000000 ]; then
    tail -n 2000 "$LOG" > "$LOG.trim" && mv -f "$LOG.trim" "$LOG"
fi

# Skip rather than queue. A stalled build must not be joined by the next
# run writing the same tables, and the next scheduled refresh is hours
# away: a missed one costs nothing.
if command -v flock >/dev/null 2>&1; then
    exec 9>"$HERE/notes/.news-cron.lock"
    if ! flock -n 9; then
        log "skipped -- another run still holds the lock"
        exit 0
    fi
fi

log "start"
if ! ./build.sh --yes news >> "$LOG" 2>&1; then
    log "FAILED -- the news build"
    echo "alpacaLIPS: the news build failed. See $LOG" >&2
    exit 1
fi
if ! tools/make-payloads.sh --news --sha --stage "$PUBLISH" >> "$LOG" 2>&1; then
    log "FAILED -- publishing to $PUBLISH"
    echo "alpacaLIPS: publishing the news payload failed. See $LOG" >&2
    exit 1
fi

# Downloads are served from object storage, so staging is not the last
# step any more: an install asks the download host, not this disk. Skipped
# quietly where no remote is configured, which is every machine that
# builds the news for itself.
if [ -x tools/publish-r2.sh ] && command -v rclone >/dev/null 2>&1 \
   && rclone listremotes 2>/dev/null | grep -q "^${LIPS_R2_REMOTE%%:*}:"; then
    if ! tools/publish-r2.sh --news -y >> "$LOG" 2>&1; then
        log "FAILED -- uploading the news payload"
        echo "alpacaLIPS: the news payload was staged but not uploaded. See $LOG" >&2
        exit 1
    fi
    log "uploaded to ${LIPS_R2_REMOTE}"
fi

# The window that is now live, so the log says what each run achieved
# rather than only that it ran.
Z=$(sed -n 's/.*"zim": *"\([^"]*\)".*/\1/p' "$PUBLISH/news/window.json" 2>/dev/null | head -1)
log "done -- ${Z:-news payload} published to $PUBLISH"
exit 0
