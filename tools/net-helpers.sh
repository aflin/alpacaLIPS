# Shell helpers for the listen address. Sourced by setup.sh and
# servers.sh after rampart-find.sh.
#
# The server binds ADDRESSES, not names: rampart-server takes ipAddr and
# a host name there does not fail softly -- it fails to bind at all, and
# the server never comes up. So a name typed into setup.sh is resolved
# here, at the point of use, rather than stored as an address that goes
# stale when DHCP moves.

# resolve_host NAME -> an address on stdout, or nothing and non-zero.
# Every platform spells its resolver differently: getent is glibc-only,
# macOS has dscacheutil, dig and host are often not installed, so this
# tries them in turn and gives up quietly.
resolve_host() {
    local n="${1:-}" ip=""
    case "$n" in
        "" | *[!A-Za-z0-9.-]*) return 1 ;;   # not a name worth looking up
    esac
    if command -v getent >/dev/null 2>&1; then
        ip=$(getent ahostsv4 "$n" 2>/dev/null | head -1 | cut -d' ' -f1)
        [ -z "$ip" ] && ip=$(getent hosts "$n" 2>/dev/null | head -1 | cut -d' ' -f1)
    fi
    if [ -z "$ip" ] && command -v dscacheutil >/dev/null 2>&1; then
        ip=$(dscacheutil -q host -a name "$n" 2>/dev/null |
             sed -n 's/^ip_address: *//p' | head -1)
    fi
    if [ -z "$ip" ] && command -v dig >/dev/null 2>&1; then
        ip=$(dig +short +time=3 +tries=1 "$n" A 2>/dev/null |
             grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
    fi
    if [ -z "$ip" ] && command -v python3 >/dev/null 2>&1; then
        ip=$(python3 -c 'import socket,sys
try: print(socket.gethostbyname(sys.argv[1]))
except Exception: pass' "$n" 2>/dev/null)
    fi
    ip=$(printf '%s' "${ip:-}" | tr -d '[:space:]')
    [ -n "$ip" ] || return 1
    echo "$ip"
}

# Is this already something the server can bind, rather than a name?
is_bind_literal() {
    case "${1:-}" in
        localhost | all | 0.0.0.0 | '*') return 0 ;;
        *:*)                             return 0 ;;   # IPv6 literal
        *[!0-9.]*)                       return 1 ;;   # has letters: a name
        ?*)                              return 0 ;;   # bare IPv4
    esac
    return 1
}

# What the server should be given for a configured address: keywords and
# literals pass through, a name is resolved. Prints nothing and returns
# non-zero when a name cannot be resolved, so callers can say so instead
# of starting a server that binds the wrong interface.
bind_addr() {
    local v="${1:-localhost}"
    if is_bind_literal "$v"; then echo "$v"; return 0; fi
    resolve_host "$v"
}

# The same over a comma separated list, preserving order. Fails, naming
# the offender, if any element is a name that does not resolve.
bind_list() {
    local spec="${1:-localhost}" out="" tok a
    local IFS=,
    for tok in $spec; do
        tok=$(printf '%s' "$tok" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
        [ -n "$tok" ] || continue
        if ! a=$(bind_addr "$tok"); then
            echo "cannot resolve $tok" >&2
            return 1
        fi
        if [ -z "$out" ]; then out=$a; else out="$out, $a"; fi
    done
    [ -n "$out" ] || out=localhost
    echo "$out"
}

# An address a local probe can actually connect to, given the list.
probe_addr() {
    local first
    first=$(printf '%s' "${1:-localhost}" | cut -d, -f1 |
            sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    case "$first" in
        all|0.0.0.0|'*'|localhost|"") echo "127.0.0.1" ;;
        \[*\])                        echo "$first" ;;
        *) echo "$first" ;;
    esac
}
