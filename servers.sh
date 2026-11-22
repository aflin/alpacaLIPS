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

# Wait up to <n> seconds for the server to be gone.
stop_wait() {   # stop_wait <seconds>
    local i=0
    while [ "$i" -lt "${1:-5}" ]; do
        rampart_pids >/dev/null 2>&1 || return 0
        sleep 1
        i=$((i + 1))
    done
    return 1
}

# Wait up to <n> seconds for nothing to be listening on our port.
port_free() {   # port_free <seconds>
    local i=0 p
    while [ "$i" -lt "${1:-10}" ]; do
        p=$(port_pids | tr '\n' ' ')
        [ -z "${p// /}" ] && return 0
        sleep 1
        i=$((i + 1))
    done
    return 1
}

# Is this pid this install's server? The daemon's argv carries the
# absolute path of its own config, which no other process has.
is_our_server() {   # is_our_server <pid>
    local a
    a=$(ps -o args= -p "$1" 2>/dev/null) || return 1
    case "$a" in
        *"$WEB/server_conf.js"*) return 0 ;;
    esac
    return 1
}

# Whatever is listening on our port, if anything. Used as a last resort
# and as the check that a stop actually freed the port.
port_pids() {
    local pt
    pt=$(listen_port)
    if command -v ss >/dev/null 2>&1; then
        ss -ltnpH "sport = :$pt" 2>/dev/null \
            | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
    elif command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$pt" -sTCP:LISTEN -t 2>/dev/null | sort -u
    fi
}

# Every pid that is this install's server: the pid file when it is
# telling the truth, plus an exact scan of argv. A stale or missing pid
# file no longer means "not running".
rampart_pids() {
    local f="$WEB/server.pid" p out=""
    if [ -f "$f" ]; then
        p=$(cat "$f" 2>/dev/null)
        if [ -n "${p:-}" ] && kill -0 "$p" 2>/dev/null && is_our_server "$p"
        then out="$p"; fi
    fi
    # THE NEEDLE GOES THROUGH THE ENVIRONMENT. Passed as an argument it
    # lands in awk's own argv, and the search matches itself: every call
    # returns a fresh pid, and killing it can hit whatever inherited the
    # number. pgrep -f is unsafe for the same reason.
    local q
    for q in $(LIPS_MATCH="$WEB/server_conf.js" ps -eo pid=,args= 2>/dev/null \
               | LIPS_MATCH="$WEB/server_conf.js" \
                 awk 'index($0, ENVIRON["LIPS_MATCH"]) { print $1 }'); do
        [ "$q" = "$$" ] && continue
        # Confirmed again from its argv: anything transient is gone by
        # now, and whatever is left has to still look like our server.
        is_our_server "$q" || continue
        case " $out " in *" $q "*) ;; *) out="$out $q" ;; esac
    done
    out=$(printf '%s\n' $out)
    [ -n "$out" ] || return 1
    printf '%s\n' $out
}

# The old name, kept for the callers that only want one pid.
# One pid, or failure. NOT `rampart_pids | head -1`: a pipeline's status
# is head's, and head exits 0 on empty input -- so this returned success
# with no pid, and start_rampart concluded the server was already up and
# would not start it.
rampart_pid() {
    local p
    p=$(rampart_pids 2>/dev/null | head -1)
    [ -n "$p" ] || return 1
    printf '%s\n' "$p"
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
    if rampart_pids >/dev/null; then
        say "rampart" "running (pid $(rampart_pids | tr '\n' ' '))"
        need_rampart || exit 1
        # Ask it to stop first: that is also what unloads the launchd job
        # on macOS, where the label carries the port, so it must be run
        # with the same port and address as start.
        ( cd "$WEB" && "$RAMPART" server_conf.js stop >/dev/null 2>&1 )
        stop_wait 5
        # Signal exactly the pids that were identified, read once: a
        # second call could return a different set, and the gap between
        # deciding and killing is where a recycled pid gets hurt.
        left=$(rampart_pids | tr '\n' ' ')
        if [ -n "${left// /}" ]; then
            say "" "did not stop on request; sending TERM to $left"
            kill $left 2>/dev/null
            stop_wait 8
        fi
        left=$(rampart_pids | tr '\n' ' ')
        if [ -n "${left// /}" ]; then
            say "" "still there; sending KILL to $left"
            kill -9 $left 2>/dev/null
            stop_wait 5
        fi
        if rampart_pids >/dev/null; then
            say "rampart" "STILL RUNNING (pid $(rampart_pids | tr '\n' ' '))"
        else
            say "rampart" "stopped"
            rm -f "$WEB/server.pid"
        fi
    else
        say "rampart" "not running"
        # A stale pid file left behind by a crash would otherwise make
        # the next start believe the server is already up.
        [ -f "$WEB/server.pid" ] && rm -f "$WEB/server.pid" \
            && say "" "removed a stale $WEB/server.pid"
        # Something else may still hold the port, which is what makes a
        # later start fail with no explanation.
        op=$(port_pids | tr '\n' ' ')
        if [ -n "${op// /}" ]; then
            say "port $(listen_port)" "held by pid $op -- not ours, left alone"
        fi
    fi
    ;;
restart)
    "$0" stop  ${OPTS[@]+"${OPTS[@]}"}
    # Wait for the port, rather than sleeping a second and hoping: a
    # start that races a stop either fails to bind or leaves two
    # servers, and both look like "restart did nothing".
    port_free 10 || say "warning" "port $(listen_port) still held; starting anyway"
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
