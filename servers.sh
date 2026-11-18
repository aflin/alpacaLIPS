#!/bin/bash
# Start, stop and inspect both servers.
#
#   ./servers.sh start      [-H ADDR] [-p PORT] [--no-kiwix]
#   ./servers.sh stop       [-H ADDR] [-p PORT] [--no-kiwix]
#   ./servers.sh restart    [-H ADDR] [-p PORT] [--no-kiwix]
#   ./servers.sh status     [-H ADDR] [-p PORT]
#
# -H and -p override, for this run only, the address and port setup.sh
# recorded in alpacalips.conf. "-H all" listens on every interface.
#
# Two processes serve this thing:
#   rampart (8099)  the web UI, the MCP endpoint, /apps/doc, and the
#                   reverse proxy that puts kiwix on the same port
#   kiwix-serve     the ZIM archives, bound to localhost only; it is
#                   reached through the rampart proxy at /zim/ and
#                   /content/, so it needs no public port of its own
#
# Order matters on start only for tidiness, not correctness: apps/doc.js
# probes kiwix per request, so starting kiwix later is picked up within
# ~15 seconds with no restart.
#
# Everything is found relative to this script, so the unpacked tarball
# works wherever it lands.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB=$HERE/web
DATA=${DATA:-$HERE/build}
WITH_KIWIX=1

# Which rampart: the one setup.sh settled on, or the same search it
# uses. Nothing here installs anything -- that is setup.sh's job.
[ -r "$HERE/tools/net-helpers.sh" ] && . "$HERE/tools/net-helpers.sh"
[ -r "$HERE/tools/write-conf.sh" ]  && . "$HERE/tools/write-conf.sh"
if [ -r "$HERE/tools/rampart-find.sh" ]; then
    . "$HERE/tools/rampart-find.sh"
    RAMPART_ONLY=${RAMPART:-}
    rampart_find || true
else
    RAMPART=$(command -v rampart 2>/dev/null || true)
fi
# The citation host setup.sh recorded. "request-host" (or nothing) means
# links are built from whatever host each client used, which the config
# header spells as an empty confBase.
# Command line beats environment beats alpacalips.conf beats default.
listen_bind() {
    local v
    v=${BIND_OVERRIDE:-${LIPS_BIND:-$(conf_get BIND 2>/dev/null)}}
    echo "${v:-localhost}"
}
listen_port() {
    local v
    v=${PORT_OVERRIDE:-${LIPS_PORT:-$(conf_get PORT 2>/dev/null)}}
    echo "${v:-8099}"
}

cite_base() {
    local c
    c=$(conf_get BASE_URL 2>/dev/null)
    [ "$c" = "request-host" ] && c=""
    echo "$c"
}

need_rampart() {
    [ -n "${RAMPART:-}" ] && return 0
    echo "no rampart $MIN_RAMPART or newer found." >&2
    [ -n "${RAMPART_WHY:-}" ] && printf "not usable:\n%s" "$RAMPART_WHY" >&2
    echo "Run ./setup.sh -- it can install one into ./rampart." >&2
    return 1
}

CMD=${1:-status}; shift 2>/dev/null || true
OPTS=()                 # kept verbatim so `restart` can pass them on
BIND_OVERRIDE=""; PORT_OVERRIDE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --no-kiwix) WITH_KIWIX=0; OPTS+=("$1"); shift ;;
        -H|--host)  BIND_OVERRIDE="${2:?-H needs an address}"; OPTS+=("$1" "$2"); shift 2 ;;
        -p|--port)  PORT_OVERRIDE="${2:?-p needs a port}";     OPTS+=("$1" "$2"); shift 2 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done

say() { printf "  %-16s %s\n" "$1" "$2"; }

rampart_pid() {
    # The pid file the webserver module keeps beside server_conf.js.
    local f="$WEB/server.pid"
    [ -f "$f" ] || return 1
    local p; p=$(cat "$f" 2>/dev/null)
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"
}
kiwix_pid() {
    local f="$HERE/zim/kiwix-serve.pid"
    [ -f "$f" ] || return 1
    local p; p=$(cat "$f" 2>/dev/null)
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"
}

start_rampart() {
    if rampart_pid >/dev/null; then say "rampart" "already running (pid $(rampart_pid))"; return 0; fi
    [ -f "$DATA/corpus/corpus.tbl" ] \
      || say "WARNING" "no corpus at $DATA/corpus -- run ./setup.sh first"
    need_rampart || return 1
    # Resolve here, not in the config: the server binds addresses, and a
    # name handed to it means no listener at all.
    local want addr
    want=$(listen_bind)
    if ! addr=$(bind_list "$want"); then
        say "rampart" "NOT STARTED"
        say "" "use addresses, localhost, or all"
        return 1
    fi
    # Rewrite the header so the file on disk IS the running config --
    # including -H/-p for this run. The body is a separate file, so
    # anything edited there survives.
    if ! write_server_conf "$addr" "$(listen_port)" "$(conf_get BASE_URL)" \
                           "$DATA" "$HERE/zim"; then
        say "rampart" "could not write $WEB/server_conf.js"; return 1
    fi
    # Keep the server's own output: a failed bind says why, and throwing
    # that away is what made "listening on <name>" look like a success.
    local log="$WEB/logs/start.log"
    mkdir -p "$WEB/logs"
    ( cd "$WEB" && "$RAMPART" server_conf.js start >"$log" 2>&1 )
    sleep 2
    if rampart_pid >/dev/null; then
        say "rampart" "started (pid $(rampart_pid))"
        if [ "$addr" = "$want" ]; then
            say "" "listening on $addr port $(listen_port)"
        else
            say "" "listening on $addr port $(listen_port)"
            say "" "from: $want"
        fi
    else
        say "rampart" "FAILED to start"
        [ -s "$log" ] && sed -n "1,12p" "$log" | sed "s/^/      /"
        say "" "full output: $log"
        return 1
    fi
}
start_kiwix() {
    [ -x "$HERE/tools/zim-serve.sh" ] || { say "kiwix" "tools/zim-serve.sh missing"; return 0; }
    n=$(ls -1 "$HERE/zim"/*.zim 2>/dev/null | wc -l | tr -d " ")
    if [ "$n" -eq 0 ]; then
        say "kiwix" "no archives in zim/ -- skipped (run ./setup.sh --archives)"
        return 0
    fi
    bash "$HERE/tools/zim-serve.sh" start 2>&1 | sed 's/^/    /'
}

case "$CMD" in
start)
    [ "$WITH_KIWIX" -eq 1 ] && start_kiwix
    start_rampart
    ;;
stop)
    if [ "$WITH_KIWIX" -eq 1 ] && [ -x "$HERE/tools/zim-serve.sh" ]; then
        bash "$HERE/tools/zim-serve.sh" stop 2>&1 | sed 's/^/    /'
    fi
    if rampart_pid >/dev/null; then
        need_rampart || exit 1
        # Same port and address as start: on macOS the launchd label
        # carries the port, so a stop computed from a different one does
        # not match the job it is meant to stop.
        ( cd "$WEB" && "$RAMPART" server_conf.js stop >/dev/null 2>&1 )
        sleep 1
        rampart_pid >/dev/null && say "rampart" "STILL RUNNING" || say "rampart" "stopped"
    else
        say "rampart" "not running"
    fi
    ;;
restart)
    "$0" stop  ${OPTS[@]+"${OPTS[@]}"}
    sleep 1
    "$0" start ${OPTS[@]+"${OPTS[@]}"}
    ;;
status)
    echo "runtime : $HERE"
    echo "data    : $DATA"
    if [ -n "${RAMPART:-}" ]; then
        echo "rampart : $(rampart_version "$RAMPART" 2>/dev/null) at $RAMPART"
    else
        echo "rampart : NOT FOUND -- run ./setup.sh"
    fi
    echo "listen  : $(listen_bind) port $(listen_port)"
    c=$(cite_base)
    [ -n "$c" ] && echo "cites   : $c" || echo "cites   : the host each client uses"
    echo
    p=$(rampart_pid) && say "rampart" "running, pid $p" || say "rampart" "not running"
    k=$(kiwix_pid)   && say "kiwix-serve" "running, pid $k" || say "kiwix-serve" "not running"
    say "corpus" "$([ -f "$DATA/corpus/corpus.tbl" ] && du -sh "$DATA/corpus" 2>/dev/null | cut -f1 || echo MISSING)"
    say "archives" "$(ls -1 "$HERE/zim"/*.zim 2>/dev/null | wc -l | tr -d " ") present"
    echo
    # Probe rather than trust the pid files: a live endpoint is the test.
    # NOTE these are ports, not processes -- a 200 here means something is
    # serving, which on a shared machine may be another instance.
    P=$(listen_port)
    PA=$(probe_addr "$(listen_bind)")
    echo "  endpoints (port $P; a 200 may be another instance):"
    for u in "http://$PA:$P/" "http://$PA:$P/apps/mcp.json" \
             "http://$PA:$P/zim/viewer" "http://127.0.0.1:8098/viewer"; do
        code=$(curl -s -o /dev/null -m 10 -w "%{http_code}" "$u" 2>/dev/null || echo "---")
        printf "  %-44s %s\n" "${u#http://}" "$code"
    done
    ;;
*)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
