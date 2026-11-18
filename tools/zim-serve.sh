#!/bin/bash
# Serve the linked ZIM archives with kiwix-serve.
#
#   tools/zim-serve.sh start|library|refresh|stop|status|verify
#
# `library` builds library.xml and stops there, which is what a build
# wants: the file the news stage adds its ZIM to, with no server
# running. On an existing library it tops it up, the same as refresh.
#
# The archives in ../zim are hard links to the pool copies, so nothing is
# copied. kiwix-serve reads them through the links.
#
# `verify` checks that every linked archive is actually reachable at the
# content path tools.js builds for it. That path is the ZIM FILENAME minus
# .zim -- verified against the catalog for all 171 archives. Note it is
# NOT the `name` attribute in library.xml, which differs (name
# "wikiquote_en_all" for wikiquote_en_all_maxi_2026-10.zim); an earlier
# books.json mapping existed to paper over that confusion and was deleted
# once the catalog settled it.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
ZIMDIR="$ROOT/zim"
LIB="$ZIMDIR/library.xml"
PIDF="$ZIMDIR/kiwix-serve.pid"
LOG="$ROOT/web/logs/kiwix-serve.log"
PORT="${ZIM_PORT:-8098}"

find_bin() {    # apt-installed, or dropped into zim/bin for a no-sudo setup
    for c in kiwix-serve "$ZIMDIR/bin/kiwix-serve"; do
        command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
        [ -x "$c" ] && { echo "$c"; return 0; }
    done
    return 1
}
find_manage() {
    for c in kiwix-manage "$ZIMDIR/bin/kiwix-manage"; do
        command -v "$c" >/dev/null 2>&1 && { echo "$c"; return 0; }
        [ -x "$c" ] && { echo "$c"; return 0; }
    done
    return 1
}

# A library is worth the extra step at this count: kiwix-serve with 215
# file arguments is unwieldy, and the library carries the book names.
#
# Usage is `kiwix-manage LIBRARYPATH add ZIMPATH ...` -- the library
# comes FIRST, and one call takes every archive. Errors are shown, not
# swallowed: a library that silently ends up empty is worse than a
# visible failure.
build_library() {
    local n MANAGE z
    n=$(ls -1 "$ZIMDIR"/*.zim 2>/dev/null | wc -l | tr -d " ")
    [ "$n" -gt 0 ] || { echo "no archives in $ZIMDIR -- run ./build.sh links"; return 1; }
    MANAGE=$(find_manage) || { echo "kiwix-manage not found; cannot build $LIB"; return 1; }
    rm -f "$LIB"
    echo "building library from $n archives (reads metadata from each)"
    if ! "$MANAGE" "$LIB" add "$ZIMDIR"/*.zim; then
        echo "kiwix-manage reported errors; retrying one at a time to" \
             "identify them"
        for z in "$ZIMDIR"/*.zim; do
            "$MANAGE" "$LIB" add "$z" || echo "  FAILED: $(basename "$z")"
        done
    fi
    [ -s "$LIB" ] || { echo "library is empty" >&2; return 1; }
    echo "library has $(grep -c '<book ' "$LIB" 2>/dev/null) books"
}

case "${1:-status}" in

start)
    SERVE=$(find_bin) || {
        # No apt here: this runs on macOS and FreeBSD too, and the
        # project ships its own installer that picks the right build.
        echo "kiwix-serve not found. Install it with:"
        echo "  $ROOT/setup.sh --kiwix"
        echo "which downloads the kiwix-tools build for this platform into"
        echo "$ZIMDIR/bin/ and changes nothing outside this tree."
        echo "A kiwix-serve already on PATH is used instead, if you have one."
        exit 1
    }
    n=$(ls -1 "$ZIMDIR"/*.zim 2>/dev/null | wc -l | tr -d " ")
    [ "$n" -gt 0 ] || { echo "no archives in $ZIMDIR -- run tools/zim-link.js"; exit 1; }

    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
        echo "already running, pid $(cat "$PIDF") on port $PORT"; exit 0
    fi

    [ -s "$LIB" ] || build_library || exit 1

    mkdir -p "$(dirname "$LOG")"
    # --nolibrarybutton is a boolean flag, not a key=value option.
    nohup "$SERVE" --port="$PORT" --library "$LIB" \
          --threads=4 --monitorLibrary >>"$LOG" 2>&1 </dev/null &
    echo $! > "$PIDF"
    sleep 3
    if kill -0 "$(cat "$PIDF")" 2>/dev/null; then
        echo "kiwix-serve pid $(cat "$PIDF") on port $PORT, $n archives"
        echo "  log: $LOG"
    else
        echo "failed to start; last log lines:"; tail -5 "$LOG"; exit 1
    fi
    ;;

stop)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
        kill "$(cat "$PIDF")" && echo "stopped pid $(cat "$PIDF")"
        rm -f "$PIDF"
    else
        echo "not running"
    fi
    ;;

status)
    n=$(ls -1 "$ZIMDIR"/*.zim 2>/dev/null | wc -l | tr -d " ")
    echo "archives linked : $n"
    echo "library         : $([ -s "$LIB" ] && echo "$LIB" || echo '(not built)')"
    echo "binary          : $(find_bin 2>/dev/null || echo '(not installed)')"
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
        echo "running         : pid $(cat "$PIDF") port $PORT"
    else
        echo "running         : no"
    fi
    ;;

library)
    # Build it, or top up an existing one, and stop there. No server.
    if [ -s "$LIB" ]; then exec "$0" refresh; fi
    build_library || exit 1
    exit 0
    ;;

refresh)
    # Add newly linked archives to the library WITHOUT restarting.
    #
    # `start` cannot do this: its already-running check returns before the
    # `[ ! -s "$LIB" ]` build, so a running server never regenerates the
    # library. kiwix-serve is started with --monitorLibrary, so it reloads
    # the file when it changes -- hence build a copy and rename it into
    # place, rather than editing the file the server is watching and
    # letting it read a half-written one.
    MANAGE=$(find_manage) || { echo "kiwix-manage not found"; exit 1; }
    [ -s "$LIB" ] || { echo "no library yet -- use start"; exit 1; }
    new="$LIB.new.$$"
    cp "$LIB" "$new" || exit 1
    added=0; skipped=0
    for z in "$ZIMDIR"/*.zim; do
        [ -e "$z" ] || continue
        b=$(basename "$z")
        # The library records each book's path, so its basename appearing
        # means that archive is already in.
        if grep -q -- "$b" "$new" 2>/dev/null; then
            skipped=$((skipped+1)); continue
        fi
        if "$MANAGE" "$new" add "$z"; then
            echo "  added $b"; added=$((added+1))
        else
            echo "  FAILED $b" >&2
        fi
    done
    if [ "$added" -eq 0 ]; then
        rm -f "$new"
        echo "nothing new ($skipped already in the library)"
        exit 0
    fi
    books=$(grep -c '<book ' "$new" 2>/dev/null)
    [ "$books" -gt 0 ] || { rm -f "$new"; echo "new library is empty -- kept the old one" >&2; exit 1; }
    mv -f "$new" "$LIB" || exit 1
    echo "library now has $books books (+$added); --monitorLibrary picks it up"
    ;;

verify)
    # Does every archive answer at the content path tools.js constructs?
    n=0; ok=0; bad=""
    for z in "$ZIMDIR"/*.zim; do
        b=$(basename "$z" .zim)
        n=$((n+1))
        code=$(curl -s -o /dev/null -m 30 -w "%{http_code}" \
               "http://127.0.0.1:$PORT/content/$b/" 2>/dev/null)
        case "$code" in
            200|30*) ok=$((ok+1)) ;;
            *) bad="$bad\n  $code  $b" ;;
        esac
    done
    echo "$ok of $n archives answer at /content/<filename-without-.zim>/"
    [ -n "$bad" ] && { printf 'unreachable:%b\n' "$bad"; exit 1; }
    ;;

*)
    echo "usage: $0 start|refresh|stop|status|verify"; exit 2 ;;
esac
