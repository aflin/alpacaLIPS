# Find a rampart to run this with, or install one into the runtime's own
# directory.  Sourced by setup.sh and servers.sh, so it defines functions
# and sets one thing: RAMPART, the interpreter to use.
#
# The engine is not vendored in the tarball because a machine may already
# have one, and because rampart publishes per-platform builds (two glibc
# tiers, macOS, FreeBSD) that its own installer picks between far better
# than a tarball could.  When none is found we install with --prefix,
# which puts everything under one directory and touches nothing else: no
# /usr/local/bin links, no shell rc edits.  rampart locates its modules
# relative to its own binary, so a tree installed that way runs from
# anywhere.
#
# Candidate order mirrors rampart-studio's setup.sh: an explicit RAMPART=
# wins, then the one a previous run chose, then a local copy, then
# whatever is on PATH, then the two standard install prefixes.  A machine
# with a good rampart is left alone.
#
# Callers set HERE (the runtime directory) before sourcing this.

# THE RUNTIME FLOOR. An install reads the published corpus and serves
# it; it uses nothing newer. The build sets its own, higher floor in
# build.sh, because the merge and the index use sql.set() keys that
# arrived in 0.7.6.
MIN_RAMPART=${MIN_RAMPART:-0.7.5}
RAMPART_INSTALLER=${RAMPART_INSTALLER:-https://get.rampart.dev/}
RAMPART_CONF=${RAMPART_CONF:-$HERE/alpacalips.conf}
# The project was called apocalypso while this was being built. Carry an
# existing conf over rather than silently starting from defaults and
# losing someone's address, port and citation host.
for old_conf in apocalypso.conf; do
    if [ ! -f "$RAMPART_CONF" ] && [ -f "$HERE/$old_conf" ]; then
        mv "$HERE/$old_conf" "$RAMPART_CONF" 2>/dev/null \
          && echo "  (carried $old_conf over to $(basename "$RAMPART_CONF"))"
    fi
done

ver_ge() {   # dotted version $1 >= $2
    awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".")
        for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0
                                   if (x[i] + 0 < y[i] + 0) exit 1 }
        exit 0 }'
}

rampart_version() { "$1" --version 2>/dev/null | awk '$1 == "version:" { print $2; exit }'; }

# Values may contain spaces and commas now (an address list), so this
# takes the whole line after the "=" and trims only surrounding space.
# The old pattern stopped at the first space and silently truncated
# "10.0.0.9, localhost" to "10.0.0.9,".
conf_get() {
    sed -n "s/^$1=//p" "$RAMPART_CONF" 2>/dev/null | tail -1 |
        sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr -d '"'
}
conf_set() {   # KEY VALUE: rewrite KEY in the conf file, or append it
    if [ -f "$RAMPART_CONF" ] && grep -q "^$1=" "$RAMPART_CONF" 2>/dev/null; then
        # Replace the whole line: a value with spaces in it cannot be
        # rewritten by matching up to the first space.
        awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; next } { print }' \
            "$RAMPART_CONF" > "$RAMPART_CONF.tmp" && mv "$RAMPART_CONF.tmp" "$RAMPART_CONF"
    else
        printf '%s=%s\n' "$1" "$2" >> "$RAMPART_CONF"
    fi
}

# A rampart of the right version can still be the wrong build: these
# three modules are what the server and the MCP endpoint import, and a
# missing one fails at request time, not at start.  Cheaper to find out
# here.
rampart_modules_ok() {
    "$1" -c 'require("rampart-sql"); require("rampart-curl");
             require("rampart-webserver");' >/dev/null 2>&1
}

# Sets RAMPART to the first usable candidate, or empty.  RAMPART_WHY
# collects what was rejected and why, for the caller to print.
#
# RAMPART_ONLY restricts the search to that one path -- an explicit
# RAMPART= or --own-rampart is a choice, not a preference, so the other
# candidates must not quietly win instead.
rampart_find() {
    local r v
    RAMPART=""; RAMPART_WHY=""
    while IFS= read -r r; do
        [ -n "$r" ] && [ -x "$r" ] || continue
        v=$(rampart_version "$r")
        if [ -z "$v" ] || ! ver_ge "$v" "$MIN_RAMPART"; then
            RAMPART_WHY="$RAMPART_WHY  $r: version ${v:-unknown}, need $MIN_RAMPART
"
            continue
        fi
        if ! rampart_modules_ok "$r"; then
            RAMPART_WHY="$RAMPART_WHY  $r: $v, but rampart-sql/curl/webserver will not load
"
            continue
        fi
        RAMPART=$r
        return 0
    done <<EOF
$(if [ -n "${RAMPART_ONLY:-}" ]; then
      echo "$RAMPART_ONLY"
  else
      conf_get RAMPART
      echo "$HERE/rampart/bin/rampart"
      command -v rampart 2>/dev/null || true
      echo "$HOME/.rampart/bin/rampart"
      echo "/usr/local/rampart/bin/rampart"
  fi)
EOF
    return 1
}

# Install into $HERE/rampart.  The installer script picks the build for
# this platform and refuses with a reason on an unsupported one, so none
# of that is second-guessed here.
rampart_install() {
    local tmp bundle rc
    command -v curl >/dev/null 2>&1 || {
        echo "curl is needed to download rampart" >&2; return 1; }
    tmp=$(mktemp -d) || return 1
    echo "  downloading the rampart installer"
    if ! curl -fsSL "$RAMPART_INSTALLER" -o "$tmp/get-rampart.sh"; then
        echo "could not fetch $RAMPART_INSTALLER" >&2; rm -rf "$tmp"; return 1
    fi
    # RAMPART_NO_RUN leaves the platform bundle on disk instead of
    # running it, so it can be run with --prefix.
    if ! ( cd "$tmp" && RAMPART_NO_RUN=1 sh get-rampart.sh ); then
        echo "could not download rampart" >&2; rm -rf "$tmp"; return 1
    fi
    bundle=$(ls "$tmp"/rampart-install-* 2>/dev/null | grep -v '\.sha1$' | head -1)
    [ -n "$bundle" ] || { echo "no installer bundle downloaded" >&2; rm -rf "$tmp"; return 1; }
    if ! "$bundle" --help 2>/dev/null | grep -q -- '--prefix'; then
        cat >&2 <<EOF
This rampart installer cannot install into a directory of its own, so it
would change /usr/local and your shell startup files.  Install rampart
yourself and run setup.sh again:
    curl -fsSL https://get.rampart.dev/ | sh
or point setup.sh at one you already have:
    RAMPART=/path/to/bin/rampart ./setup.sh
EOF
        rm -rf "$tmp"; return 1
    fi
    # Created first: the installer asks for root for a prefix under
    # /usr unless the directory is already ours.
    mkdir -p "$HERE/rampart"
    "$bundle" --auto --prefix "$HERE/rampart"; rc=$?
    rm -rf "$tmp"
    [ "$rc" -eq 0 ] || { echo "the rampart installer failed" >&2; return 1; }
    [ -x "$HERE/rampart/bin/rampart" ] || {
        echo "installed, but no $HERE/rampart/bin/rampart" >&2; return 1; }
    return 0
}
