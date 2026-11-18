#!/bin/bash
# One download job.  Argument is a jobs.tsv line:
#   dest <TAB> sha256-or-dash <TAB> bytes <TAB> url [<TAB> alt-url ...]
# Resumable, walks each mirror in turn, verifies sha256 when the
# Metalink supplied one, and skips anything already complete.
#
# WARNING: never write a finished file over a path a running `wget -c`
# still holds open -- it treats the complete file as a partial, resumes
# from the end and appends.  Stop the fetcher, or stage elsewhere first.
source "$(dirname "$0")/../../config.sh"
IFS=$'\t' read -r -a F <<< "$1"
DEST="${F[0]}"; SHA="${F[1]}"; WANT="${F[2]}"
URLS=("${F[@]:3}")
LOG=$META/progress.log
UA='rampart-keep/0.7 (offline corpus build; contact: admin@rampart.dev)'
say () { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# A VERIFIED CHECKSUM IS WRITTEN BESIDE THE ARCHIVE, as <file>.sha256,
# the same format make-payloads.sh publishes and setup.sh checks. Three
# things it buys:
#
#   1. hashing a complete pool took 40 minutes of reading on every
#      fetch, because nothing remembered the last result;
#   2. the record travels with the file, so a pool copied elsewhere
#      carries its own proof;
#   3. comparing the recorded hash against the metalink's hash in
#      jobs.tsv catches a dump RE-CUT UNDER THE SAME NAME, which no
#      size or date comparison can see -- and catches it without
#      reading the archive at all.
#
# A sidecar is trusted only while it is newer than the archive, so
# replacing the archive invalidates it. REVERIFY=1 ignores sidecars and
# hashes everything, for when bit rot is the question.
sha_read () {      # the 64 hex digits in sidecar $1, or nothing
    local h
    h=$(cut -d' ' -f1 < "$1" 2>/dev/null | tr -d '\r\n')
    case "$h" in
        [0-9a-f][0-9a-f]*) [ ${#h} -eq 64 ] && printf '%s' "$h" ;;
    esac
}
sha_write () {     # record hash $2 for archive $1
    printf '%s\n' "$2" > "$1.sha256.tmp" 2>/dev/null &&
        mv -f "$1.sha256.tmp" "$1.sha256" 2>/dev/null
}

mkdir -p "$(dirname "$DEST")"
BASE="$(basename "$DEST")"

if [ -f "$DEST" ]; then
    HAVE=$(stat -c %s "$DEST" 2>/dev/null || echo 0)
    if [ "$WANT" != "0" ] && [ "$HAVE" = "$WANT" ]; then
        if [ "$SHA" = "-" ]; then say "SKIP  $BASE (size ok)"; exit 0; fi
        KNOWN=""
        if [ "${REVERIFY:-0}" != "1" ] && [ "$DEST.sha256" -nt "$DEST" ]; then
            KNOWN=$(sha_read "$DEST.sha256")
        fi
        if [ -n "$KNOWN" ]; then
            if [ "$KNOWN" = "$SHA" ]; then
                say "SKIP  $BASE (sha on record)"; exit 0
            fi
            # Our bytes were verified against a DIFFERENT hash from the
            # one the metalink carries now: the publisher re-cut the
            # dump under the same name. Fetch it again.
            say "REDO  $BASE (upstream hash changed)"
            rm -f "$DEST" "$DEST.sha256"
        else
            GOT=$(sha256sum "$DEST" | cut -d" " -f1)
            if [ "$GOT" = "$SHA" ]; then
                sha_write "$DEST" "$GOT"
                say "SKIP  $BASE (sha ok, recorded)"; exit 0
            fi
            say "REDO  $BASE (sha mismatch)"; rm -f "$DEST" "$DEST.sha256"
        fi
    fi
fi

# INTO .part, THEN MOVE. wget -O creates the file before it knows the
# transfer will work, so downloading straight to $DEST left a 0-byte
# .zim in the pool whenever every mirror failed -- and zim-meta.py, the
# picker and the importer would all treat that as an archive. Deleting
# it afterwards is not the answer either: -c exists so that most of a
# 114 GB transfer survives a dead network. Staging keeps both, and is
# what get-gutenberg.sh does.
PART=$DEST.part
for U in "${URLS[@]}"; do
    [ -z "$U" ] && continue
    case "$U" in https://*|http://*) ;; *) continue ;; esac
    say "GET   $BASE  <- ${U#*://}"
    if wget -q -c --timeout=60 --tries=3 --waitretry=10 \
            --user-agent="$UA" -O "$PART" "$U"; then
        HAVE=$(stat -c %s "$PART" 2>/dev/null || echo 0)
        if [ "$WANT" != "0" ] && [ "$HAVE" != "$WANT" ]; then
            say "SHORT $BASE  $HAVE/$WANT"; continue
        fi
        if [ "$SHA" != "-" ]; then
            GOT=$(sha256sum "$PART" | cut -d" " -f1)
            if [ "$GOT" != "$SHA" ]; then
                # Not a resumable condition: the bytes are wrong, so
                # start this mirror over rather than resume into them.
                say "BADSHA $BASE"; rm -f "$PART"; continue
            fi
        fi
        mv -f "$PART" "$DEST" || { say "MVFAIL $BASE"; exit 1; }
        [ "$SHA" != "-" ] && sha_write "$DEST" "$GOT"
        say "OK    $BASE  $HAVE bytes"
        exit 0
    fi
    say "FAIL  $BASE  <- ${U#*://}"
done
# The .part stays for the next run to resume from.
say "GIVEUP $BASE"
exit 1
