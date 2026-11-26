#!/bin/bash
# Fetch what this runtime needs to serve the corpus.
#
#   ./setup.sh                 ask what to install
#   ./setup.sh --corpus        corpus only, no questions (search + MCP work)
#   ./setup.sh --kiwix         also install kiwix-serve
#   ./setup.sh --archives      also the ZIM archives (page images, originals)
#   ./setup.sh --news          update the news table (and its zim, if this
#                              install has archives). Asks nothing, so it
#                              is what a daily cron entry runs; exits 0
#                              without downloading when already current.
#   ./setup.sh --check         report what is out of date -- runtime, corpus,
#                              news, archives -- and ask about each. Downloads
#                              nothing on its own, and nothing at all without
#                              a terminal
#   ./setup.sh --upgrade       replace the program files with the published
#                              release and stop. Touches no data
#   ./setup.sh --replace-corpus  fetch the published corpus over the one here
#   ./setup.sh --no-news       leave the news window alone
#   ./setup.sh --keep-parts    keep every downloaded corpus part instead of
#                              deleting each as it is unpacked: a retry costs
#                              nothing, but it needs far more free space
#   ./setup.sh --accept-license  answer kiwix-tools' licence prompt
#   ./setup.sh -y              assume yes; with --check, install what is behind
#   ./setup.sh --force         with --upgrade, replace the program files even
#                              if they are already the published release
#   ./setup.sh --delete-first  only when the disk has no room for both: delete
#                              the corpus that is here to make space for the one
#                              being fetched. There is no corpus until the new
#                              one finishes, so -y does not imply this
#   ./setup.sh --check -y      the same, but install whatever is behind. A
#                              runtime upgrade happens first and the script
#                              then re-runs itself, so the rest is checked by
#                              the new release
#   ./setup.sh --own-rampart   install rampart into ./rampart even if the
#                              machine already has a usable one
#   ./setup.sh --no-rampart    do not look for or install rampart
#   ./setup.sh --corpus-dir D  fetch payload D (corpus-YYYY-MM-DD) instead of
#                              the published current one. Payloads stay up for
#                              a week, so this pins an install to one, or puts
#                              the previous one back, with nothing republished
#   ./setup.sh --base-url URL  set the citation host without being asked
#                              ("-" means use each client's own host)
#   ./setup.sh --bind LIST     listen on LIST, a comma separated set of
#                              "localhost", "all", or addresses. Taken
#                              verbatim: unlike the prompt, it does not
#                              add loopback for you.
#   ./setup.sh --port N        listen on port N
#
# With no flags and a terminal it asks which version you want, quoting
# the real sizes from the published manifests. Run it again later and it
# offers to add kiwix to a corpus-only install. Any flag, or no terminal
# (a pipe, a cron job), means no questions: that run does exactly what
# the flags say, which is what a script needs.
#
#   BASE=https://host/path ./setup.sh      download from somewhere else
#   DATA=/big/disk ./setup.sh              put the data on another disk
#   RAMPART=/path/to/bin/rampart ./setup.sh   use that rampart
#
# Every run also asks where the server should listen -- loopback and
# 8099 unless you say otherwise. Nothing here is exposed to a network
# until you ask for it.
#
# Every run asks which host citation links should name. Search results
# and MCP answers carry links back into this corpus, and the right host
# is not something the filesystem can tell us: it depends on where the
# readers of those answers are. The answer is kept in alpacalips.conf
# and offered back as the default next time.
#
# This serves with rampart 0.7.5 or newer. If the machine has one it is
# used as is; if not, setup.sh installs one into ./rampart with
# --prefix, which touches nothing outside that directory. The engine it
# settles on is recorded in alpacalips.conf, and servers.sh reads it.
#
# No build tools are needed: the corpus arrives prebuilt, because
# building it is hours of indexing plus a few hundred GB of source
# archives. Everything lands under DATA, and the server finds it through
# confData in web/server_conf.js -- the code stays where you unpacked it.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE=${BASE:-https://rampart.dev/downloads/alpacalips}
DATA=${DATA:-$HERE/build}
WANT_ARCHIVES=0
WANT_KIWIX=0
CHECK_ONLY=0
# -y/--yes, or LIPS_YES=1 in the environment. The environment form is
# what a re-exec uses: an older setup.sh ignores an unknown variable,
# where an unknown FLAG makes it exit with "unknown option".
YES=0
[ "${LIPS_YES:-0}" = "1" ] && YES=1
# --delete-first: when the disk holds the corpus being replaced and not
# much else, remove it to make room. Deliberately NOT implied by -y.
DELETE_FIRST=0
[ "${LIPS_DELETE_FIRST:-0}" = "1" ] && DELETE_FIRST=1
# --force: re-install the runtime even when the published hash is the one
# already recorded, for files that have been damaged.
FORCE=0
KEEP_PARTS=0
WANT_UPGRADE=0   # --upgrade: take the published runtime and stop
CHOSE=0          # did the command line already say what to install?
WANT_CORPUS=0    # set by --corpus, or below when no selector was given
ACCEPT_LIC=0     # --accept-license, passed through to setup-kiwix.sh
REPLACE_CORPUS=0 # --replace-corpus: fetch a newer corpus over the one here
# --corpus-dir: install a named payload instead of the current one. Old
# payloads stay published for a week, so this is how an install pins to
# one, or goes back to the previous one without waiting for a republish.
CORPUS_DIR_OPT=${LIPS_CORPUS_DIR:-}
OWN_RAMPART=0
WANT_RAMPART=1
WANT_NEWS=0
NEWS_SET=0       # did --news or --no-news decide it, rather than the prompt?
CHECK_FLAG=0      # --check was given, as opposed to "nothing" in the menu
# --news also sets CHECK_FLAG, to skip the prompts and leave the config
# alone. The currency report must NOT key off that, or the daily cron
# entry reports instead of updating the news.
CHECK_REPORT=0    # the currency report: --check only
CITE_SET=""
BIND_SET=""
PORT_SET=""
RAMPART_SET=${RAMPART:-}

while [ $# -gt 0 ]; do
    case "$1" in
        --corpus)   WANT_CORPUS=1; CHOSE=1; shift ;;
        --archives) WANT_ARCHIVES=1; CHOSE=1; shift ;;
        --kiwix)    WANT_KIWIX=1; CHOSE=1; shift ;;
        --check)    CHECK_ONLY=1; CHECK_FLAG=1; CHECK_REPORT=1; CHOSE=1; shift ;;
        -y|--yes)   YES=1; shift ;;
        --delete-first) DELETE_FIRST=1; shift ;;
        --force)    FORCE=1; shift ;;
        --news)     WANT_NEWS=1; NEWS_SET=1; CHOSE=1; CHECK_FLAG=1; shift ;;
        --no-news)  WANT_NEWS=0; NEWS_SET=1; shift ;;
        --base-url) CITE_SET="$2"; shift 2 ;;
        --bind)     BIND_SET="$2"; shift 2 ;;
        --port)     PORT_SET="$2"; shift 2 ;;
        --own-rampart) OWN_RAMPART=1; shift ;;
        --no-rampart)  WANT_RAMPART=0; shift ;;
        --upgrade)  WANT_UPGRADE=1; CHOSE=1; shift ;;
        --keep-parts) KEEP_PARTS=1; shift ;;
        --accept-license) ACCEPT_LIC=1; shift ;;
        --replace-corpus) REPLACE_CORPUS=1; WANT_CORPUS=1; CHOSE=1; shift ;;
        --corpus-dir) CORPUS_DIR_OPT=${2:-}; shift 2 ;;
        # The WHOLE header, not a line range: a fixed range silently
        # hides whatever is added past it, which is how --check and
        # --delete-first became invisible the moment they were documented.
        -h|--help)  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next }
                         NR > 1 { exit }' "$0"; exit 0 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done

# Nothing on the command line means the default install, and that is the
# corpus: it is what the menu offers first and what a bare run should do.
# A command line that named payloads gets those payloads and nothing else.
[ "$CHOSE" -eq 1 ] || WANT_CORPUS=1

if [ -r "$HERE/tools/rampart-find.sh" ]; then
    . "$HERE/tools/rampart-find.sh"
else
    echo "missing tools/rampart-find.sh" >&2; exit 1
fi
if [ -r "$HERE/tools/net-helpers.sh" ]; then
    . "$HERE/tools/net-helpers.sh"
else
    echo "missing tools/net-helpers.sh" >&2; exit 1
fi
WEB=$HERE/web
if [ -r "$HERE/tools/write-conf.sh" ]; then
    . "$HERE/tools/write-conf.sh"
else
    echo "missing tools/write-conf.sh" >&2; exit 1
fi

say() { printf "  %-30s %s\n" "$1" "$2"; }
# numfmt when it is here, awk when it is not: numfmt is GNU coreutils,
# so every macOS install took the fallback and printed raw byte counts.
hum() {
    numfmt --to=iec "${1:-0}" 2>/dev/null && return 0
    awk -v n="${1:-0}" 'BEGIN {
        split("K,M,G,T,P", u, ",")
        if (n < 1024) { printf "%d", n; exit }
        for (i = 1; i <= 5; i++) {
            n /= 1024
            if (n < 1024 || i == 5) {
                # One decimal under 10 units, and rounding away from
                # zero, which is what numfmt --to=iec does.
                if (n < 10) {
                    v = int(n * 10); if (n * 10 > v) v++
                    printf "%.1f%s", v / 10, u[i]
                } else {
                    v = int(n); if (n > v) v++
                    printf "%d%s", v, u[i]
                }
                exit
            }
        }
    }'
}

# Size of $1 in bytes, empty when it cannot be determined. GNU stat
# first, then BSD/macOS stat, then POSIX wc -c. Callers must treat empty
# as "unknown" and not as zero: a failed measurement is not a failed
# download, and conflating the two aborts a good 5 GiB transfer.
fsize() {
    local n
    n=$(stat -c %s "$1" 2>/dev/null) && case "$n" in *[0-9]*) echo "$n"; return 0 ;; esac
    n=$(stat -f %z "$1" 2>/dev/null) && case "$n" in *[0-9]*) echo "$n"; return 0 ;; esac
    n=$( { wc -c < "$1"; } 2>/dev/null | tr -dc 0-9); [ -n "$n" ] && echo "$n"
}

# Free bytes on the filesystem holding $1. --output is GNU-only, so fall
# back to POSIX df -k; empty means "could not tell", and the caller then
# skips the check rather than guessing.
freebytes() {
    local a
    a=$(df -B1 --output=avail "$1" 2>/dev/null | tail -1 | tr -dc 0-9)
    [ -n "$a" ] && { echo "$a"; return; }
    a=$(df -k "$1" 2>/dev/null | tail -1 | awk '{print $4}' | tr -dc 0-9)
    [ -n "$a" ] && echo $((a * 1024))
}

# curl, and only curl. Resuming needs care: "Range: bytes=N-" is capped
# at defaultRangeMBytes (8 MB) by a rampart server serving a mirror, and
# the client then stops believing it has the whole file. fetch() sends a
# BOUNDED range instead, built from the size in the MANIFEST, which no
# server caps. nginx is fine either way.
command -v curl >/dev/null 2>&1 || { echo "need curl" >&2; exit 1; }
# The fetcher's own chatter goes here, not onto the progress line. It is
# printed only when a transfer fails.
DLLOG=${TMPDIR:-/tmp}/alpacalips-fetch.$$.log
: > "$DLLOG" 2>/dev/null || DLLOG=/dev/null

# How a .tar.zst gets decompressed. The zstd binary when it is here: it
# is the reference implementation and what this is tested with. Failing
# that, a tar that can decompress zstd on its own -- libarchive's can,
# and GNU tar only shells out to the same missing binary -- which is
# decided by unpacking a tiny archive shipped for the purpose rather
# than by guessing from a version string.
# PATH first, then where the package managers put it. A non-interactive
# shell on macOS does not read .zshrc and so does not have
# /opt/homebrew/bin: without this, a Mac with zstd installed is told to
# install zstd.
find_zstd() {
    command -v zstd 2>/dev/null && return 0
    for d in /opt/homebrew/bin /usr/local/bin /opt/local/bin /usr/pkg/bin \
             /snap/bin /usr/local/opt/zstd/bin; do
        [ -x "$d/zstd" ] && { echo "$d/zstd"; return 0; }
    done
    return 1
}
ZBIN=$(find_zstd || true)
if [ -n "$ZBIN" ]; then
    ZSTD_DECOMP="$ZBIN -dc"
elif [ -f "$HERE/tools/zstd-probe.tar.zst" ] \
     && tar -tf "$HERE/tools/zstd-probe.tar.zst" >/dev/null 2>&1; then
    # This tar decompresses zstd itself. Apple's does not -- it runs the
    # zstd binary -- so this branch is for a libarchive built with it.
    ZSTD_DECOMP=cat
else
    ZSTD_DECOMP=""
fi
# Only reached when the payload really is .tar.zst: the published set is
# gzip, which every target system can already unpack.
need_zstd() {
    [ -n "$ZSTD_DECOMP" ] && return 0
    echo "This mirror publishes zstd-compressed payloads, which this system" >&2
    echo "cannot unpack. Install zstd and run this again:" >&2
    echo "  macOS         brew install zstd" >&2
    echo "  Debian/Ubuntu sudo apt install zstd" >&2
    echo "  Fedora/RHEL   sudo dnf install zstd" >&2
    return 1
}

fetch() {   # fetch <url> <outfile> [expected-bytes]
    local url="$1" out="$2" want="${3:-}" have=0 rc=1
    mkdir -p "$(dirname "$out")"
    if [ -f "$out.part" ]; then
        have=$(fsize "$out.part"); have=${have:-0}
        # A leftover at or past the full size tells us nothing useful --
        # start it again rather than reason about where it went wrong.
        if [ -n "$want" ] && [ "$have" -ge "$want" ] 2>/dev/null; then
            rm -f "$out.part"; have=0
        fi
    fi
    if [ -n "$want" ] && [ "$have" -gt 0 ] 2>/dev/null; then
        # Bounded range: the end offset is what keeps a rampart mirror
        # from capping this at 8 MB. Into a separate file, because
        # --retry re-issues the request and appending twice would
        # corrupt the part.
        say "resuming" "$(hum "$have") of $(hum "$want") already here" >&2
        if curl -fsS -L --retry 3 --retry-delay 5 \
                -r "$have-$((want - 1))" -o "$out.chunk" "$url" 2>>"$DLLOG"; then
            cat "$out.chunk" >> "$out.part" && rm -f "$out.chunk" && rc=0
        else
            rm -f "$out.chunk"
        fi
    fi
    if [ "$rc" -ne 0 ]; then
        rm -f "$out.part" "$out.chunk"
        curl -fsS -L --retry 3 --retry-delay 5 -o "$out.part" "$url" \
            2>>"$DLLOG" && rc=0
    fi
    if [ "$rc" -eq 0 ]; then mv -f "$out.part" "$out"; return 0; fi
    rm -f "$out.part" "$out.chunk"
    # Whatever curl said about it, now that the line is free.
    tail -3 "$DLLOG" 2>/dev/null >&2
    return 1
}

# ---- mirrors -------------------------------------------------------
# The archives are mirrored by people whose job it is, and those mirrors
# sit closer to most installs than this project's single port does. They
# are tried first so that being popular costs the mirrors' bandwidth
# rather than ours; what they have not got still comes from us.
MIRROR_BASES=""; MIRROR_PICK=""; UPSTREAM_MAP=""

# MIRRORS is one base URL per line, UPSTREAM is "<archive> <path>" --
# both published by the build, which verified every path upstream before
# writing it.
mirrors_remote() {
    [ -n "$MIRROR_BASES" ] && return 0
    UPSTREAM_MAP="$HERE/zim/.upstream"
    MIRROR_BASES=$(curl -fsL --max-time 60 "$BASE/archives/MIRRORS" 2>/dev/null)
    if curl -fsL --max-time 60 "$BASE/archives/UPSTREAM" \
            -o "$UPSTREAM_MAP.new" 2>/dev/null; then
        mv -f "$UPSTREAM_MAP.new" "$UPSTREAM_MAP"
    else
        rm -f "$UPSTREAM_MAP.new"
    fi
    [ -n "$MIRROR_BASES" ] && [ -s "$UPSTREAM_MAP" ]
}

upstream_path() {   # upstream_path <archive>  -> "<path> <mask>"
    [ -s "${UPSTREAM_MAP:-}" ] || return 1
    awk -v z="$1" '$1 == z { print $2, $3; found = 1; exit }
                   END { exit !found }' "$UPSTREAM_MAP"
}

# The base URL of mirror <n>, counting from 0 as the mask does.
mirror_base() {  # mirror_base <n>
    echo "$MIRROR_BASES" | awk -v n="$1" 'NR == n + 1 { print; exit }'
}

# A path this particular mirror is known to have. Measuring every mirror
# with one fixed path is what dropped two good mirrors on the first live
# run: coverage is partial, and a 404 is not slowness.
mirror_testpath() {  # mirror_testpath <n>
    awk -v n="$1" '{
        split($3, m, ",")
        for (i in m) if (m[i] == n) { print $2; exit }
    }' "$UPSTREAM_MAP"
}

# Measure, because the published order is no guide: kiwix's own endpoint
# measured 0.3 MB/s against dotsrc's 7.8 on the same machine and the same
# file. Latency is no guide either -- the mirror that answers fastest
# delivered least. And since three successive probes named three
# different winners, this drops what is broken rather than crowning one:
# whatever clears the floor shares the work.
# A mirror must clear both floors: half a megabyte a second at all, and
# a quarter of whatever the fastest one managed. The second is what keeps
# a 0.6 MB/s mirror from being handed a third of the chunks and deciding
# when the file finishes.
MIRROR_FLOOR=524288
MIRROR_RATIO=4
mirrors_pick() {
    [ -n "$MIRROR_PICK" ] && return 0
    [ -n "$MIRROR_BASES" ] || return 1
    nm=$(echo "$MIRROR_BASES" | grep -c .)
    say "mirrors" "measuring $nm (a few seconds)"
    mi=0
    MIRROR_PICK=$(while [ "$mi" -lt "$nm" ]; do
        m=$(mirror_base "$mi")
        tp=$(mirror_testpath "$mi")
        mi=$((mi + 1))
        [ -n "$m" ] && [ -n "$tp" ] || continue
        sp=$(curl -s -o /dev/null -m 12 -r 0-8388607 \
                  -w '%{speed_download}' "$m$tp" 2>/dev/null)
        printf '%s %s\n' "${sp%%.*}" "$m"
    done | sort -rn | awk -v f="$MIRROR_FLOOR" -v r="$MIRROR_RATIO" \
        'NR == 1 { best = $1 }
         $1 >= f && $1 * r >= best { print $2; n++ }
         n >= 3 { exit }' | tr '\n' ' ')
    if [ -z "$MIRROR_PICK" ]; then
        say "mirrors" "none fast enough; fetching from $BASE"
        return 1
    fi
    for m in $MIRROR_PICK; do
        say "" "$(echo "$m" | sed -e 's|https://||' -e 's|/.*||')"
    done
    return 0
}

# Round-robin pick, so consecutive chunks land on different mirrors.
spread_url() {  # spread_url <n> <url> [<url> ...]
    _n=$1; shift; _c=0
    for _u in "$@"; do
        [ "$_c" -eq "$_n" ] && { echo "$_u"; return 0; }
        _c=$((_c + 1))
    done
    echo "$1"
}

# One chunk, resuming from whatever of it is already on disk. A whole
# wave is what becomes durable in .part, so without this an interrupt
# loses every chunk in flight -- the entire file, for anything small
# enough to be a single wave.
spread_get() {   # spread_get <chunkfile> <from> <to> <url>
    _cf=$1; _cfrom=$2; _cto=$3; _cu=$4
    _need=$(( _cto - _cfrom + 1 ))
    _h=$(fsize "$_cf"); _h=${_h:-0}
    # Longer than its own range: a leftover from a run that chunked
    # differently. Not worth reasoning about.
    if [ "$_h" -gt "$_need" ]; then rm -f "$_cf"; _h=0; fi
    [ "$_h" -eq "$_need" ] && return 0
    if [ "$_h" -gt 0 ]; then
        curl -s -f -L -m 3600 --speed-limit 2048 --speed-time 45 \
             -r "$(( _cfrom + _h ))-$_cto" -o "$_cf.t" "$_cu" \
             2>>"$DLLOG" || return 1
        cat "$_cf.t" >> "$_cf" || return 1
        rm -f "$_cf.t"
        return 0
    fi
    # --speed-time: a connection that stops delivering is given up on, so
    # the chunk goes to the next mirror instead of holding the wave for
    # the whole -m budget.
    curl -s -f -L -m 3600 --speed-limit 2048 --speed-time 45 \
         -r "$_cfrom-$_cto" -o "$_cf" "$_cu" 2>>"$DLLOG"
}

# One archive over eight connections spread across the mirrors, because
# a single connection to any of them is shaped to a few MB/s while the
# link does far more. Measured 39 MB/s over three mirrors, a third each.
#
# Fixed 512 MB chunks rather than one range per connection: an
# interrupted run then resumes at the last whole chunk instead of
# restarting a 100 GB range, and chunks are appended to <out>.part in
# order and deleted as they land, so the disk never holds the archive
# twice. A chunk that comes back short is retried down the URL list --
# ours is last in it -- because a hole cannot be left behind.
SPREAD_CH=536870912
fetch_spread() {   # fetch_spread <out> <bytes> <url> [<url> ...]
    _o=$1; _want=$2; shift 2
    [ "$_want" -gt 0 ] 2>/dev/null || return 1
    [ $# -gt 0 ] || return 1
    _nu=$#
    mkdir -p "$(dirname "$_o")"
    # Chunk from the file, not a constant: at a fixed 512 MB a 1.6 GB
    # archive is three chunks and so runs three connections, which
    # measured a third of what eight do. Clamped so the huge ones still
    # move in pieces a resume can afford to lose.
    _ch=$(( _want / 8 ))
    [ "$_ch" -gt 536870912 ] && _ch=536870912
    [ "$_ch" -lt 16777216 ] && _ch=16777216
    _pos=0
    if [ -f "$_o.part" ]; then
        _pos=$(fsize "$_o.part"); _pos=${_pos:-0}
        if [ "$_pos" -ge "$_want" ] 2>/dev/null; then rm -f "$_o.part"; _pos=0; fi
        [ "$_pos" -gt 0 ] && say "resuming" \
            "$(hum "$_pos") of $(hum "$_want") already here" >&2
    fi
    _k=0
    while [ "$_pos" -lt "$_want" ]; do
        _j=0
        # The pids of this wave's chunks, and nothing else. A bare `wait`
        # here waits for every child of this shell -- including the
        # progress loop, which never exits -- and hangs the install at
        # 100% with no transfer running.
        _cpids=""
        while [ "$_j" -lt 8 ]; do
            _from=$(( _pos + _j * _ch ))
            [ "$_from" -ge "$_want" ] && break
            _to=$(( _from + _ch - 1 ))
            [ "$_to" -ge "$_want" ] && _to=$(( _want - 1 ))
            _u=$(spread_url $(( _k % _nu )) "$@")
            spread_get "$_o.c.$_j" "$_from" "$_to" "$_u" &
            _cpids="$_cpids $!"
            DL_CHUNK_PIDS=$_cpids        # so dl_stop can reach this wave
            _j=$((_j + 1)); _k=$((_k + 1))
        done
        for _cp in $_cpids; do wait "$_cp" 2>/dev/null; done
        DL_CHUNK_PIDS=""
        _i=0
        while [ "$_i" -lt "$_j" ]; do
            _from=$(( _pos + _i * _ch ))
            _to=$(( _from + _ch - 1 ))
            [ "$_to" -ge "$_want" ] && _to=$(( _want - 1 ))
            _exp=$(( _to - _from + 1 ))
            _got=$(fsize "$_o.c.$_i"); _got=${_got:-0}
            if [ "$_got" -ne "$_exp" ]; then
                # Down the list, ours last: a mirror that has not got
                # this archive costs the ranges it was handed, no more.
                for _u in "$@"; do
                    spread_get "$_o.c.$_i" "$_from" "$_to" "$_u" || continue
                    _got=$(fsize "$_o.c.$_i"); _got=${_got:-0}
                    [ "$_got" -eq "$_exp" ] && break
                done
            fi
            if [ "$_got" -ne "$_exp" ]; then rm -f "$_o.c".*; return 1; fi
            cat "$_o.c.$_i" >> "$_o.part" \
                || { rm -f "$_o.c".*; return 1; }
            rm -f "$_o.c.$_i"
            _i=$((_i + 1))
        done
        _pos=$(( _pos + _j * _ch ))
        [ "$_pos" -gt "$_want" ] && _pos=$_want
    done
    mv -f "$_o.part" "$_o"
}

# ---- versions ------------------------------------------------------
# version.txt at the download root: what the published release is. The
# copy beside this script is what this install took. Not VERSION:
# that name belongs to the repo's own release number, and an install
# run from a clone would overwrite it. The
# runtime hash is what actually decides whether an upgrade changes
# anything -- the date only says which way.
VER_REMOTE=""

ver_field() {  # ver_field <text> <key>
    printf '%s\n' "$1" | awk -v k="$2" '$1 == k { print $2; exit }'
}

ver_remote() {
    [ -n "$VER_REMOTE" ] && return 0
    VER_REMOTE=$(curl -fsL --max-time 30 "$BASE/version.txt" 2>/dev/null)
    [ -n "$VER_REMOTE" ]
}

ver_local() {
    [ -f "$HERE/version.txt" ] || return 1
    cat "$HERE/version.txt"
}

# Does the published release differ from what is installed? Prints a
# one-line reason when it does.
ver_newer() {
    ver_remote || return 1
    _rv=$(ver_field "$VER_REMOTE" version)
    _rs=$(ver_field "$VER_REMOTE" runtime_sha256)
    _lt=$(ver_local 2>/dev/null) || _lt=""
    _lv=$(ver_field "${_lt:-}" version)
    _ls=$(ver_field "${_lt:-}" runtime_sha256)
    [ -n "$_rs" ] || return 1
    if [ -z "$_lt" ]; then
        VER_WHY="this install has no recorded version"
        return 0
    fi
    if [ "$_rs" != "$_ls" ]; then
        VER_WHY="the runtime changed (published $_rv, installed ${_lv:-unknown})"
        return 0
    fi
    # The CORPUS is not judged here. version.txt is a copy of a
    # published file, so its corpus_documents says what was published
    # when the runtime was last stamped -- not what this install holds.
    # That lives in $DATA/corpus/.installed.version, and --check reads it.
    return 1
}

# Replace the runtime with the published one. Never continues afterwards:
# this script is one of the files it just overwrote.
do_upgrade() {
    ver_remote || { echo "cannot read $BASE/version.txt" >&2; return 1; }
    _rv=$(ver_field "$VER_REMOTE" version)
    _rs=$(ver_field "$VER_REMOTE" runtime_sha256)
    say "published" "${_rv:-unknown}"
    _lt=$(ver_local 2>/dev/null) || _lt=""
    [ -n "$_lt" ] && say "installed" "$(ver_field "$_lt" version)"
    # Same number, different build: without this the output is "published
    # 0.1.11, installed 0.1.11" followed by files being replaced, which
    # reads as either nothing happening or something pointless happening.
    # The hashes are what actually differ, so show them.
    _lvn=$(ver_field "${_lt:-}" version)
    _lsh=$(ver_field "${_lt:-}" runtime_sha256)
    if [ -n "$_lt" ] && [ "$_lvn" = "$_rv" ] && [ -n "$_rs" ] \
       && [ "$_rs" != "$_lsh" ]; then
        say "" "same version, rebuilt: $(printf '%.12s' "${_lsh:-none}") -> $(printf '%.12s' "$_rs")"
    fi
    # Nothing to do when the published hash is the one already recorded
    # here. Replacing identical files and announcing an upgrade to the
    # release you were on is worse than useless: it looks like something
    # happened. --force is for an install whose files are damaged, where
    # the recorded hash no longer describes what is on disk.
    if [ "$FORCE" -eq 0 ] && [ -n "$_rs" ] \
       && [ "$_rs" = "$(ver_field "${_lt:-}" runtime_sha256)" ]; then
        say "" "already on ${_rv:-this release}; nothing to do"
        say "" "--force replaces the program files anyway"
        return 0
    fi

    _ud=$HERE/.upgrade.$$
    rm -rf "$_ud"; mkdir -p "$_ud" || return 1
    say "fetching" "alpacalips-run.tar.gz"
    if ! curl -fsL --max-time 300 "$BASE/alpacalips-run.tar.gz" \
              -o "$_ud/run.tar.gz"; then
        rm -rf "$_ud"; echo "download failed" >&2; return 1
    fi
    # The hash version.txt published, so a truncated or substituted
    # tarball cannot overwrite a working install.
    if [ -n "$_rs" ] && [ "$_rs" != unknown ]; then
        _got=$(sha256_of "$_ud/run.tar.gz")
        if [ -z "$_got" ]; then
            rm -rf "$_ud"
            echo "cannot verify the download on this system" >&2; return 1
        fi
        if [ "$_got" != "$_rs" ]; then
            # version.txt and the tarball are separate cache entries that
            # expire independently, so just after a publish this pair can
            # be one release apart. Ask again with a query string no cache
            # has seen before calling it a bad download.
            say "" "hash mismatch; refetching past any cache"
            if curl -fsL --max-time 300 \
                    "$BASE/alpacalips-run.tar.gz?nocache=$$-$(date +%s 2>/dev/null)" \
                    -o "$_ud/run.tar.gz" 2>/dev/null; then
                _got=$(sha256_of "$_ud/run.tar.gz")
            fi
        fi
        if [ "$_got" != "$_rs" ]; then
            rm -rf "$_ud"
            echo "checksum mismatch -- not upgrading" >&2; return 1
        fi
        say "verified" "sha256 matches version.txt"
    fi
    if ! tar xzf "$_ud/run.tar.gz" -C "$_ud"; then
        rm -rf "$_ud"; echo "could not unpack" >&2; return 1
    fi
    _src=$_ud/alpacalips
    [ -d "$_src" ] || { rm -rf "$_ud"; echo "unexpected tarball layout" >&2
                        return 1; }
    # Only what the tarball holds. Data and alpacalips.conf are not in
    # it and are not touched.
    for _it in setup.sh servers.sh tools web; do
        [ -e "$_src/$_it" ] || continue
        rm -rf "$HERE/$_it.old"
        [ -e "$HERE/$_it" ] && mv -f "$HERE/$_it" "$HERE/$_it.old"
        if ! mv -f "$_src/$_it" "$HERE/$_it"; then
            echo "could not replace $_it -- the old one is at $_it.old" >&2
            rm -rf "$_ud"; return 1
        fi
        say "replaced" "$_it"
    done
    chmod +x "$HERE/setup.sh" "$HERE/servers.sh" 2>/dev/null
    printf '%s\n' "$VER_REMOTE" > "$HERE/version.txt"
    rm -rf "$_ud"
    for _it in setup.sh servers.sh tools web; do
        rm -rf "$HERE/$_it.old"
    done
    echo
    say "upgraded to" "${_rv:-unknown}"
    # Two callers, two endings. --upgrade stops here, so say what was and
    # was not done: "re-run to continue" reads as though the run failed.
    # --check passes "continuing" -- it re-execs the new script itself and
    # announces that -- so this says nothing.
    if [ "${1:-}" != "continuing" ]; then
        echo "  the program files only; the corpus, news and archives were"
        echo "  not touched. ./setup.sh --check says whether they are behind."
    fi
    return 0
}

# Bytes actually written. Allocated blocks rather than length, so a file
# that is sparse or preallocated still reads as what has arrived.
fbytes() {  # fbytes <file>
    if [ ! -e "$1" ]; then echo 0; return 0; fi
    if blk=$(stat -c %b "$1" 2>/dev/null) && bs=$(stat -c %B "$1" 2>/dev/null); then
        echo $((blk * bs))
    elif blk=$(stat -f %b "$1" 2>/dev/null); then
        echo $((blk * 512))
    else
        fsize "$1" || echo 0
    fi
}

# One self-updating line for the download in flight: which file of how
# many, how far in, how fast, how much longer.
PROG_PID=""
# The chunk fetchers of the wave in flight. dl_stop kills these; see the
# comment there about why a backgrounded job never sees the terminal's ^C.
DL_CHUNK_PIDS=""
progress_start() {  # progress_start <file> <bytes> <label>
    PROG_FILE=$1; PROG_WANT=${2:-0}; PROG_LABEL=$3
    if [ ! -t 2 ]; then
        # Not a terminal: one plain line, no cursor tricks.
        [ "$PROG_WANT" -gt 0 ] 2>/dev/null \
            && printf '  %s   %s\n' "$PROG_LABEL" "$(hum "$PROG_WANT")" >&2 \
            || printf '  %s\n' "$PROG_LABEL" >&2
        return 0
    fi
    progress_loop &
    PROG_PID=$!
}
progress_loop() {
    plast=0
    # A second's head start, so the first line drawn has real numbers
    # rather than the zeroes that are true only before anything arrives.
    sleep 1
    while :; do
        # curl writes <file>.part, and <file>.chunk as well when it is
        # resuming into an existing part. fbytes is 0 for whichever is
        # absent, so the sum is what is on disk at this moment.
        pnow=$(( $(fbytes "$PROG_FILE") + $(fbytes "$PROG_FILE.part") \
                 + $(fbytes "$PROG_FILE.chunk") ))
        # A spread fetch has up to eight chunks in flight that are not
        # in .part yet; without them the line sits still for a whole
        # wave and then jumps by gigabytes.
        for pc in "$PROG_FILE".c.*; do
            # .c.N.t holds bytes already counted in .c.N while a short
            # chunk is being resumed; counting both reads over 100%.
            case "$pc" in *.t) continue ;; esac
            [ -f "$pc" ] && pnow=$(( pnow + $(fbytes "$pc") ))
        done
        prate=$(( pnow - plast )); [ "$prate" -lt 0 ] && prate=0
        plast=$pnow
        ppct=""; peta=""; pdone=0
        if [ "${PROG_WANT:-0}" -gt 0 ] 2>/dev/null; then
            ppct=$(( pnow * 100 / PROG_WANT ))
            [ "$ppct" -ge 100 ] && { ppct=100; pdone=1; }
            ppct="$ppct%"
            if [ "$prate" -gt 0 ]; then
                pleft=$(( (PROG_WANT - pnow) / prate ))
                [ "$pleft" -lt 0 ] && pleft=0
                if [ "$pleft" -ge 60 ]; then peta="$((pleft / 60))m$((pleft % 60))s"
                else peta="${pleft}s"; fi
            fi
        fi
        if [ "$pdone" -eq 1 ]; then
            # Downloaded, and now waiting its turn through the checksum
            # and the unpacker. Saying so beats a frozen "0/s".
            printf '\r  %-24s %5s  %-22s\033[K' \
                   "$PROG_LABEL" "$ppct" "complete, checking" >&2
        else
            # \033[K: erase whatever the previous, longer line left to
            # the right of this one.
            printf '\r  %-24s %5s  %9s/s  ETA %-7s\033[K' \
                   "$PROG_LABEL" "$ppct" "$(hum "$prate")" "${peta:---}" >&2
        fi
        sleep 1
    done
}
progress_stop() {
    [ -n "$PROG_PID" ] || return 0
    kill "$PROG_PID" 2>/dev/null
    wait "$PROG_PID" 2>/dev/null || true
    PROG_PID=""
    # Erase the line rather than pad over it: padding assumes a width,
    # and when it guesses short the terminal wraps and the next line
    # lands below instead of on top. Only to a terminal -- in a log file
    # the escape is just noise.
    [ -t 2 ] && printf '\033[2K\r' >&2
    return 0
}

# ^C must be caught here. A background job in a non-interactive shell has
# SIGINT set to ignore, so the terminal's ^C reaches this script and not
# the progress loop or the fetcher: before this, the script exited and
# those two carried on, redrawing over the shell prompt and still
# downloading. They are killed by pid instead.
dl_stop() {
    if [ -n "${PROG_PID:-}" ]; then kill "$PROG_PID" 2>/dev/null; PROG_PID=""; fi
    if [ -n "${BG_PID:-}" ]; then
        pkill -P "$BG_PID" 2>/dev/null || true   # curl, under that shell
        kill "$BG_PID" 2>/dev/null || true
        BG_PID=""
    fi
    [ -n "${XPID:-}" ] && kill "$XPID" 2>/dev/null
    # The overlapped archive hash, backgrounded and therefore immune to
    # the terminal's ^C in the same way the progress loop was.
    if [ -n "${AVPID:-}" ]; then kill "$AVPID" 2>/dev/null; AVPID=""; fi
    # The wave of range requests, and the curl under each: eight
    # subshells that ^C passes by, which left an 8 GB archive still
    # downloading after the script had exited.
    for _p in ${DL_CHUNK_PIDS:-}; do
        pkill -P "$_p" 2>/dev/null || true
        kill "$_p" 2>/dev/null || true
    done
    DL_CHUNK_PIDS=""
    pkill -P $$ curl 2>/dev/null || true         # a foreground transfer
    [ -n "${FIFO:-}" ] && rm -f "$FIFO"
    # Chunk parts are left where they are: .part holds every whole chunk
    # and a re-run carries on from it. Only the half-written ones go.
    [ -n "${PROG_FILE:-}" ] && rm -f "$PROG_FILE".c.* 2>/dev/null
    rm -f "$DLLOG" 2>/dev/null
    return 0
}
trap '[ -t 2 ] && printf "\033[2K\r" >&2; dl_stop
      echo "interrupted." >&2
      echo "Re-run to carry on: whole parts already fetched are kept, and the" >&2
      echo "one in flight resumes from where it stopped." >&2
      exit 130' INT TERM HUP

# sha256 of $1, with whatever this system has. sha256sum on Linux;
# openssl next because it uses the CPU's SHA instructions like sha256sum
# does, where macOS shasum is perl and several times slower -- slow
# enough to become the bottleneck now that hashing overlaps the
# download. Empty output means nothing here can hash.
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" 2>/dev/null | awk '{print $NF}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

verify() {  # verify <file> <sha256url>
    local f="$1" u="$2"
    local want got
    want=$(curl -fsL --max-time 60 "$u" 2>/dev/null | awk '{print $1}')
    [ -n "$want" ] || { say "$(basename "$f")" "no published checksum"; return 0; }
    got=$(sha256_of "$f")
    # No hasher is a stopped install, not a skipped check: every Linux
    # has sha256sum and every macOS has shasum and openssl, so this
    # means something is badly wrong with the system rather than merely
    # unusual.
    [ -n "$got" ] || { say "$(basename "$f")" \
        "cannot verify -- no sha256sum, openssl or shasum on this system"
        return 1; }
    if [ "$want" = "$got" ]; then say "$(basename "$f")" "sha256 OK"; return 0; fi
    say "$(basename "$f")" "SHA256 MISMATCH -- deleting"
    rm -f "$f"; return 1
}

# The published manifests, fetched at most once each: the menu quotes
# them and the download blocks reuse them.
MF=""; EXTRACTED=""; AMF=""

# WHICH PAYLOAD THIS RUN USES, decided once. The corpus lives in a dated
# directory -- corpus-2026-11-25/ -- and corpus-current.txt names the
# current one. Nothing is ever renamed, so a download already running
# keeps working across a publish; resolving once is what extends that to
# a download running inside THIS script.
CPATH=""
# Strict, because the name arrives over the network and goes into a URL.
corpus_dir_ok() {
    case "$1" in
        corpus-2[0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]) return 0 ;;
        corpus-2[0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]-[0-9]) return 0 ;;
        corpus-2[0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]-[0-9][0-9]) return 0 ;;
    esac
    return 1
}
corpus_path() {
    [ -n "$CPATH" ] && return 0
    local started=""
    [ -f "$DATA/.parts/.from" ] \
        && started=$(cat "$DATA/.parts/.from" 2>/dev/null | tr -d " \t\r")
    # An explicit choice wins, including over a download in progress.
    if [ -n "$CORPUS_DIR_OPT" ]; then
        if ! corpus_dir_ok "$CORPUS_DIR_OPT"; then
            echo "--corpus-dir: not a payload directory name: $CORPUS_DIR_OPT" >&2
            return 1
        fi
        CPATH=$CORPUS_DIR_OPT
        say "corpus payload" "$CPATH (asked for)"
        return 0
    fi
    # Finish the payload an interrupted run started, while it is still
    # published: its parts are on disk and parts do not mix.
    if [ -n "$started" ] && corpus_dir_ok "$started" \
       && curl -fsIL --max-time 60 "$BASE/$started/MANIFEST" >/dev/null 2>&1; then
        CPATH=$started
        say "corpus payload" "$CPATH (finishing the one already started)"
        return 0
    fi
    CPATH=$(curl -fsL --max-time 60 "$BASE/corpus-current.txt" 2>/dev/null \
                | head -1 | tr -d " \t\r")
    if [ -z "$CPATH" ]; then
        echo "cannot read $BASE/corpus-current.txt, which names the current" >&2
        echo "corpus payload. Choose one with --corpus-dir corpus-YYYY-MM-DD." >&2
        return 1
    fi
    if ! corpus_dir_ok "$CPATH"; then
        echo "corpus-current.txt does not name a payload directory: $CPATH" >&2
        CPATH=""
        return 1
    fi
    if [ -n "$started" ] && [ "$started" != "$CPATH" ]; then
        say "corpus payload" "$CPATH"
        say "" "the payload you started ($started) is no longer published"
        say "" "its parts cannot be mixed with this one and will be refetched"
    else
        say "corpus payload" "$CPATH"
    fi
    return 0
}

corpus_remote() {
    [ -n "$MF" ] && return 0
    corpus_path || return 1
    MF=$(curl -fsL --max-time 120 "$BASE/$CPATH/MANIFEST" 2>/dev/null)
    EXTRACTED=$(curl -fsL --max-time 60 "$BASE/$CPATH/EXTRACTED" 2>/dev/null | tr -dc 0-9)
    [ -n "$MF" ]
}
NMF=""
news_remote() {
    [ -n "$NMF" ] && return 0
    NMF=$(curl -fsL --max-time 60 "$BASE/news/MANIFEST" 2>/dev/null)
    [ -n "$NMF" ]
}
archives_remote() {
    [ -n "$AMF" ] && return 0
    AMF=$(curl -fsL --max-time 120 "$BASE/archives/MANIFEST" 2>/dev/null)
    [ -n "$AMF" ]
}

# Bytes still to fetch for the archives: what the manifest lists, less
# what is already on disk at the right size. A resumed run therefore
# quotes and checks only the remainder.
archives_want() {
    local f sz rest have w=0
    while read -r f sz rest; do
        [ -n "$f" ] && [ -n "${sz:-}" ] || continue
        have=$(fsize "$HERE/zim/$f"); have=${have:-0}
        [ "$have" = "$sz" ] && continue
        if [ "$have" -lt "$sz" ] 2>/dev/null
            then w=$((w + sz - have))
            else w=$((w + sz)); fi
    done <<EOF
$AMF
EOF
    echo "$w"
}

[ -n "${ZBIN:-}" ] && case "$ZBIN" in
    /*) [ "$ZBIN" = "$(command -v zstd 2>/dev/null)" ] || echo "zstd    : $ZBIN" ;;
esac
echo "runtime : $HERE"
echo "data    : $DATA"
echo "source  : $BASE"
echo

# ---- is anything newer published? -----------------------------------
# --upgrade is the whole run: do_upgrade replaces this very script, so
# nothing may execute after it.
if [ "$WANT_UPGRADE" -eq 1 ]; then
    echo
    echo "upgrade from $BASE"
    do_upgrade || exit 1
    exit 0
fi

# A plain run just looks. One small file, and only worth a line when it
# says something.
VER_WHY=""
if ver_newer; then
    echo
    say "a newer release" "$(ver_field "$VER_REMOTE" version) -- $VER_WHY"
    if [ -t 0 ]; then
        printf '  upgrade the runtime now? [y/N] '
        read -r _ans
        case "$_ans" in
            y|Y|yes|YES)
                do_upgrade || exit 1
                exit 0 ;;
            *) say "" "left alone; ./setup.sh --upgrade when you want it" ;;
        esac
    else
        say "" "./setup.sh --upgrade takes it"
    fi
fi

# ---- what is already here ------------------------------------------
HAVE_CORPUS=0; HAVE_KIWIX=0
if [ -f "$DATA/corpus/corpus.tbl" ]; then
    HAVE_CORPUS=1
    say "corpus" "present ($(du -sh "$DATA/corpus" 2>/dev/null | cut -f1))"
else
    say "corpus" "MISSING"
fi
NZIM=$(ls -1 "$HERE/zim"/*.zim 2>/dev/null | wc -l | tr -d " ")
say "archives" "$NZIM present"
# `a || b && x || y` reads as (a||b) && x || y and reports the wrong
# thing on either side, so this stays an if.
if command -v kiwix-serve >/dev/null 2>&1 || [ -x "$HERE/zim/bin/kiwix-serve" ]; then
    HAVE_KIWIX=1; say "kiwix-serve" "installed"
else
    say "kiwix-serve" "not installed"
fi

# --own-rampart and RAMPART= both narrow the search to one path. They
# differ in what happens when it is not there: --own-rampart installs it,
# while an explicit RAMPART= is a path the user vouched for, so a miss is
# an error rather than a licence to install something else.
RAMPART_ONLY=""; MAY_INSTALL=1
if [ "$OWN_RAMPART" -eq 1 ]; then
    [ -z "$RAMPART_SET" ] || { echo "--own-rampart and RAMPART= conflict" >&2; exit 1; }
    RAMPART_ONLY=$HERE/rampart/bin/rampart
elif [ -n "$RAMPART_SET" ]; then
    RAMPART_ONLY=$RAMPART_SET; MAY_INSTALL=0
fi
RAMPART=""
if [ "$WANT_RAMPART" -eq 1 ]; then
    if rampart_find; then
        say "rampart" "$(rampart_version "$RAMPART") at $RAMPART"
    else
        say "rampart" "MISSING (need $MIN_RAMPART or newer)"
        # The reason belongs here, with the report: "MISSING" on a
        # machine that has 0.7.5 installed is otherwise baffling, and
        # --check never reaches the install step that would explain it.
        [ -n "${RAMPART_WHY:-}" ] && printf "%s" "$RAMPART_WHY"
    fi
else
    say "rampart" "not checked (--no-rampart)"
fi

# ---- which version -------------------------------------------------
# Only when the command line did not say and there is a terminal to ask.
if [ "$CHOSE" -eq 0 ] && [ -t 0 ]; then
    corpus_remote || true
    archives_remote || true
    CSIZE="size unpublished"
    if [ -n "$MF" ]; then
        CSIZE="$(hum "$(echo "$MF" | awk '{s+=$2} END{printf "%.0f", s}')") download"
        [ -n "$EXTRACTED" ] && CSIZE="$CSIZE, $(hum "$EXTRACTED") on disk"
    fi
    AW=0; ASIZE="size unpublished"
    if [ -n "$AMF" ]; then AW=$(archives_want); ASIZE="$(hum "$AW") download"; fi
    echo
    if [ "$HAVE_CORPUS" -eq 0 ]; then
        echo "What should I install?"
        echo
        echo "  1) corpus only       $CSIZE"
        echo "     full-text search, the MCP endpoint, and the stored page text"
        echo "  2) corpus and kiwix  the above plus $ASIZE"
        echo "     also the original pages -- images, tables, PDFs -- served locally"
        echo "  3) nothing           report only, download nothing"
        echo
        printf "choice [1]: "
        read -r ANS || ANS=""
        case "${ANS:-1}" in
            1)   ;;
            2)   WANT_KIWIX=1; WANT_ARCHIVES=1 ;;
            3)   CHECK_ONLY=1 ;;
            *)   echo "not one of the choices: $ANS" >&2; exit 1 ;;
        esac
    elif [ "$HAVE_KIWIX" -eq 0 ] || [ -z "$AMF" ] || [ "$AW" -gt 0 ]; then
        # The corpus is in and kiwix is not, or not completely: this is
        # the second run, so the only thing left to offer is the rest.
        # Say what this run would actually do. "530G download" is wrong
        # once the archives are here, and "0 download" says nothing at
        # all -- what is missing by then is the viewer, not the data.
        ARCH_NEED=0
        if [ -n "$AMF" ]; then
            [ "$AW" -gt 0 ] && ARCH_NEED=1
        elif [ "$NZIM" -eq 0 ]; then
            ARCH_NEED=1                 # no manifest to size it with
        fi
        if [ -n "$AMF" ]; then ASZ="$(hum "$AW")"; else ASZ="an unpublished amount"; fi
        if [ "$HAVE_KIWIX" -eq 0 ] && [ "$ARCH_NEED" -eq 1 ]; then
            WHAT="download $ASZ of archives, then install the kiwix server"
        elif [ "$HAVE_KIWIX" -eq 0 ]; then
            WHAT="install the kiwix server (the $NZIM archives are already here)"
        else
            WHAT="download the $ASZ of archives still missing"
        fi
        echo "The corpus is installed and searchable."
        if [ "$HAVE_KIWIX" -eq 0 ]; then
            echo "What is missing is the archive viewer: with it, a search result"
            echo "also links to the original page, with its images and tables."
        else
            echo "The kiwix server is installed, but not every archive is here,"
            echo "so some results have no original page to link to."
        fi
        echo
        echo "  1) yes               $WHAT"
        echo "  2) no                skip the archives"
        echo
        printf "choice [2]: "
        read -r ANS || ANS=""
        case "${ANS:-2}" in
            1)   WANT_KIWIX=1; WANT_ARCHIVES=1 ;;
            # Not CHECK_ONLY: that would end the run here, and there is
            # still the news window to ask about. Every payload checks
            # for itself whether it has anything to do.
            2)   : ;;
            *)   echo "not one of the choices: $ANS" >&2; exit 1 ;;
        esac
    else
        echo
        # Not CHECK_ONLY either: news may still be missing, and this is
        # the run where it is the only thing left to offer.
        say "installed" "corpus, archives and kiwix are all here"
    fi
fi

# A flagged --kiwix with no archives installs a server with nothing to
# serve. Said, not silently corrected: the flags do what they say.
if [ "$WANT_KIWIX" -eq 1 ] && [ "$WANT_ARCHIVES" -eq 0 ] && [ "$NZIM" -eq 0 ]; then
    say "note" "no archives here; kiwix will have nothing to serve"
    say "" "add --archives to fetch them"
fi

# ---- the news window ------------------------------------------------
# Asked here, with the other questions, so every decision is made before
# the first byte is fetched.
if [ "$NEWS_SET" -eq 0 ]; then
    if [ -f "$DATA/news/news.tbl" ]; then
        # Already installed: refresh it without asking. The daily cron
        # entry passes --news, which sets NEWS_SET and skips this.
        WANT_NEWS=1
    elif [ "${CHECK_ONLY:-0}" -eq 1 ]; then
        WANT_NEWS=0
    elif news_remote; then
        NTSZ=$(echo "$NMF" | awk '$1 ~ /^news\.tar\./ { printf "%.0f", $2; exit }')
        NZSZ=$(echo "$NMF" | awk '$1 ~ /\.zim$/ { printf "%.0f", $2 }')
        echo
        echo "The news window covers what happened after the Wikipedia dump:"
        echo "a rolling three months of articles, rebuilt daily."
        echo
        echo "  the text    $(hum "${NTSZ:-0}") download -- searchable, and the MCP news tool"
        NZHAVE=$(ls -1 "$HERE/zim"/*.zim 2>/dev/null |
                 grep -v wikipedia_en_news | wc -l | tr -d ' ')
        if [ "$WANT_ARCHIVES" -eq 1 ] || [ "${NZHAVE:-0}" -gt 0 ]; then
            echo "  the pages   $(hum "${NZSZ:-0}") more -- the articles themselves, read offline"
        fi
        echo
        if [ -t 0 ]; then
            printf "install the news window? [Y/n]: "
            read -r NANS || NANS=""
            case "${NANS:-y}" in
                [Nn]*) WANT_NEWS=0 ;;
                *)     WANT_NEWS=1 ;;
            esac
        else
            WANT_NEWS=1
            say "news" "including it -- pass --no-news to skip"
        fi
    fi
fi

# ---- where to listen ------------------------------------------------
# Loopback by default. Opening a corpus to the network is a decision,
# not a default, so this asks rather than assumes -- and it asks every
# run, because the answer moves with the machine.
BIND=$(conf_get BIND); BIND=${BIND:-localhost}
PORT=$(conf_get PORT); PORT=${PORT:-8099}
if [ -n "$BIND_SET" ]; then
    bind_list "$BIND_SET" >/dev/null || exit 1
    BIND=$BIND_SET; conf_set BIND "$BIND"
fi
[ -n "$PORT_SET" ] && { PORT=$PORT_SET; conf_set PORT "$PORT"; }
if [ -z "$BIND_SET$PORT_SET" ] && [ "$CHECK_FLAG" -eq 0 ] && [ -t 0 ]; then
    echo
    echo "Where should the web and MCP server listen?"
    echo "\"localhost\" keeps it on this machine; an address or name binds"
    echo "that interface; \"all\" accepts connections on every interface."
    echo "Several, comma separated, are allowed: \"10.0.0.9, localhost\"."
    echo "Square brackets mean IPv6: \"[::1]\"."
    echo
    printf "address [%s]: " "$BIND"
    read -r ANS || ANS=""
    [ -n "$ANS" ] && BIND=$ANS
    # One address and no comma: add loopback. Binding only a LAN address
    # cuts off everything local -- MCP clients, health checks, and this
    # project's own status probe all talk to 127.0.0.1. A comma means
    # the list is deliberate and is taken as given, so removing loopback
    # is possible and stays removed.
    case "$BIND" in
        *,*) ;;
        *)   case "$BIND" in
                 localhost|all|0.0.0.0|\*|127.0.0.1|"[::1]") ;;
                 *) BIND="$BIND, localhost"
                    say "added" "localhost, so local clients still reach it" ;;
             esac ;;
    esac
    # Names must resolve: rampart binds addresses, and handed a name the
    # bind fails outright rather than falling back.
    BIND_RESOLVED=$(bind_list "$BIND") || {
        echo >&2
        echo "Give addresses, \"localhost\", or \"all\" for every interface." >&2
        exit 1; }
    [ "$BIND_RESOLVED" = "$BIND" ] || say "resolves to" "$BIND_RESOLVED"
    printf "port [%s]: " "$PORT"
    read -r ANS || ANS=""
    case "$ANS" in
        "")            ;;
        *[!0-9]*)      echo "not a port number: $ANS" >&2; exit 1 ;;
        *)             PORT=$ANS ;;
    esac
    conf_set BIND "$BIND"; conf_set PORT "$PORT"
fi
BIND_RESOLVED=$(bind_list "$BIND" 2>/dev/null) || BIND_RESOLVED=""
if [ -z "$BIND_RESOLVED" ]; then
    say "listen on" "$BIND port $PORT (DOES NOT RESOLVE)"
elif [ "$BIND_RESOLVED" = "$BIND" ]; then
    say "listen on" "$BIND port $PORT"
else
    say "listen on" "$BIND port $PORT -> $BIND_RESOLVED"
fi

# ---- citation host --------------------------------------------------
# Asked on every run, because it is the one setting no amount of looking
# at this machine can determine: the links in search results and MCP
# answers have to name a host the READER can reach. Stored in
# alpacalips.conf and offered back as the default.
STORED=$(conf_get BASE_URL)
CITE_FIRST=$(printf '%s' "$BIND" | cut -d, -f1 | tr -d '[:space:]')
case "$CITE_FIRST" in
    all|0.0.0.0|\*|localhost|127.0.0.1|"") CITE_HOST=localhost ;;
    *)                                     CITE_HOST=$CITE_FIRST ;;
esac
CITE_DEF=${STORED:-http://$CITE_HOST:$PORT}
normalise_cite() {   # bare name -> url; bare name with no port -> :port
    case "$1" in
        ""|-|none|request-host) echo "request-host"; return ;;
        http://*|https://*) echo "${1%/}"; return ;;
    esac
    case "$1" in
        *:[0-9]*) echo "http://${1%/}" ;;
        *)        echo "http://${1%/}:$PORT" ;;
    esac
}
CITE=$CITE_DEF
if [ -n "$CITE_SET" ]; then
    CITE=$(normalise_cite "$CITE_SET"); conf_set BASE_URL "$CITE"
elif [ "$CHECK_FLAG" -eq 0 ] && [ -t 0 ]; then
    echo
    echo "Which host should citation links name?"
    echo "Search results and MCP answers link back here; a link is only"
    echo "useful if whoever reads the answer can open it."
    echo "A name or a URL, or \"-\" to use whatever host each client"
    echo "connected with."
    echo
    printf "citation base [%s]: " "$CITE_DEF"
    read -r ANS || ANS=""
    CITE=$(normalise_cite "${ANS:-$CITE_DEF}")
    conf_set BASE_URL "$CITE"
fi
if [ "$CITE" = "request-host" ]; then
    say "citation base" "each client's own host"
else
    say "citation base" "$CITE"
    # A stored citation base keeps naming the old port after the port
    # changes. Rewriting someone's deliberate answer would be worse, so
    # say it instead. A base with no port at all (behind a proxy on 80
    # or 443) is left alone.
    CPORT=${CITE##*:}
    case "$CPORT" in
        [0-9]*) [ "$CPORT" = "$PORT" ] || \
            say "note" "those links name port $CPORT, the server listens on $PORT" ;;
    esac
fi

# ---- what is out of date (--check) ---------------------------------
# Each test uses the same identity the installer verifies, so a thing
# already here is never fetched again.
NEED_RUNTIME=0; NEED_CORPUS=0; NEED_NEWS=0; NEED_ARCH=0
if [ "$CHECK_REPORT" -eq 1 ]; then
    echo
    echo "current?"

    # The runtime by its hash, not its version string: the hash is what
    # do_upgrade checks the download against.
    if ver_remote; then
        _prs=$(ver_field "$VER_REMOTE" runtime_sha256)
        _pv=$(ver_field "$VER_REMOTE" version)
        _lv=""; _lrs=""
        if _lt=$(ver_local 2>/dev/null); then
            _lv=$(ver_field "$_lt" version)
            _lrs=$(ver_field "$_lt" runtime_sha256)
        fi
        if [ -z "$_lrs" ]; then
            say "runtime" "no version recorded here; $_pv published"
            NEED_RUNTIME=1
        elif [ "$_lrs" != "$_prs" ]; then
            say "runtime" "${_lv:-unknown} here, $_pv published"
            NEED_RUNTIME=1
        else
            say "runtime" "${_lv:-unknown}, current"
        fi
    else
        say "runtime" "cannot read $BASE/version.txt"
    fi

    # THE RUNTIME GOES FIRST, and the rest is judged by the new script.
    # A release can change what the other checks even mean -- the
    # manifest format, a version.txt field, what payloads exist -- so an
    # old script's reading of them is not worth acting on. exec, not a
    # function call: a fresh process reads the replaced setup.sh from the
    # start, which is the hazard do_upgrade warns about.
    if [ "$NEED_RUNTIME" -eq 1 ]; then
        _dort=0
        if [ "$YES" -eq 1 ]; then
            _dort=1
        elif [ -t 0 ]; then
            printf "  upgrade the runtime first? [Y/n]: "
            read -r _a || _a=""
            case "$_a" in [Nn]*) _dort=0 ;; *) _dort=1 ;; esac
        fi
        if [ "$_dort" -eq 1 ]; then
            echo
            do_upgrade continuing || exit 1
            if [ -z "${LIPS_RECHECK:-}" ]; then
                echo
                say "re-checking" "with the new setup.sh"
                echo
                LIPS_RECHECK=1 LIPS_YES="$YES" BASE="$BASE" DATA="$DATA" \
                    exec "$HERE/setup.sh" --check
            fi
            # Already re-run once and still behind: say so rather than
            # loop on a hash that will not match.
            echo
            say "" "runtime replaced; re-run ./setup.sh --check for the rest"
            exit 0
        fi
    fi

    # The corpus by manifest_sha256, which is what identifies a payload.
    corpus_path 2>/dev/null || true
    _pcv=""
    [ -n "$CPATH" ] \
        && _pcv=$(curl -fsL --max-time 60 "$BASE/$CPATH/VERSION" 2>/dev/null)
    _pcs=$(printf '%s' "$_pcv" | awk '/^manifest_sha256/{print $2}')
    _pcd=$(printf '%s' "$_pcv" | awk '/^documents/{print $2}')
    if [ ! -f "$DATA/corpus/corpus.tbl" ]; then
        say "corpus" "not installed; ${_pcd:-?} documents published"
        NEED_CORPUS=1
    elif [ -z "$_pcs" ]; then
        say "corpus" "published version unknown -- leaving yours alone"
    else
        _ics=""
        [ -f "$DATA/corpus/.installed.version" ] && _ics=$(awk \
            '/^manifest_sha256/{print $2}' \
            "$DATA/corpus/.installed.version" 2>/dev/null)
        if [ -z "$_ics" ]; then
            say "corpus" "installed before versions were recorded"
            NEED_CORPUS=1
        elif [ "$_ics" != "$_pcs" ]; then
            say "corpus" "a newer corpus is published (${_pcd:-?} documents)"
            NEED_CORPUS=1
        else
            say "corpus" "current"
        fi
    fi

    # The news by its tarball's sha, the same comparison the news stage
    # makes before deciding to download.
    if news_remote; then
        _nt=$(echo "$NMF" | awk '$1 ~ /^news\.tar\./ { print $1; exit }')
        if [ -n "$_nt" ]; then
            _pns=$(curl -fsL --max-time 60 "$BASE/news/$_nt.sha256" 2>/dev/null \
                   | tr -dc '0-9a-f')
            _ins=$(cat "$DATA/news/.installed.sha" 2>/dev/null | tr -dc '0-9a-f')
            if [ -z "$_ins" ]; then
                say "news" "not installed"
                NEED_NEWS=1
            elif [ "$_pns" != "$_ins" ]; then
                say "news" "a newer window is published"
                NEED_NEWS=1
            else
                say "news" "current"
            fi
        fi
    fi

    # The archives per file by size. archives_want() totals only what is
    # missing or the wrong length, so an install that has them all reads
    # zero and is told so.
    if [ "$NZIM" -gt 0 ] && archives_remote; then
        _aw=$(archives_want)
        if [ "${_aw:-0}" -gt 0 ] 2>/dev/null; then
            say "archives" "$NZIM here, $(hum "$_aw") still to fetch"
            NEED_ARCH=1
        else
            say "archives" "$NZIM, current"
        fi
    elif [ "$NZIM" -eq 0 ]; then
        say "archives" "not installed (optional; ./setup.sh --archives)"
    fi

    _need=$((NEED_CORPUS + NEED_NEWS + NEED_ARCH))
    echo
    if [ "$_need" -eq 0 ]; then
        # The runtime is handled above. If it was declined, saying
        # everything is current would be untrue.
        if [ "$NEED_RUNTIME" -eq 1 ]; then
            say "" "the runtime is behind; everything else is current"
        else
            say "" "everything is current"
        fi
        exit 0
    fi
    if [ "$YES" -eq 0 ] && [ ! -t 0 ]; then
        say "" "$_need item(s) behind; --check -y installs them"
        exit 0
    fi

    # Ask, or take -y for granted. The flags set here are the ones the
    # ordinary flow below acts on, so nothing is reimplemented.
    _offer() {   # _offer <prompt>  -> 0 to do it
        [ "$YES" -eq 1 ] && return 0
        printf "  %s [Y/n]: " "$1"
        read -r _a || _a=""
        case "$_a" in [Nn]*) return 1 ;; *) return 0 ;; esac
    }
    [ "$NEED_CORPUS" -eq 1 ] && _offer "fetch the corpus?" \
        && { WANT_CORPUS=1; REPLACE_CORPUS=1; }
    [ "$NEED_ARCH" -eq 1 ] && _offer "fetch the missing archives?" \
        && WANT_ARCHIVES=1
    [ "$NEED_NEWS" -eq 1 ] && _offer "update the news window?" \
        && WANT_NEWS=1

    if [ "$WANT_CORPUS$WANT_ARCHIVES$WANT_NEWS" = "000" ]; then
        say "" "nothing chosen"
        exit 0
    fi
    CHECK_ONLY=0     # there is work to do, so fall through and do it
    echo
fi

# ---- write the server config ----------------------------------------
# The answers above become plain variables at the top of
# web/server_conf.js. Nothing is passed in the environment, because on
# macOS the launchd plist that daemonizes the server drops it.
#
# Also when --check fell through to install into a tree that has no
# config yet: a corpus with no server_conf.js cannot be served.
if [ "$CHECK_FLAG" -eq 0 ] || [ ! -f "$WEB/server_conf.js" ]; then
    BIND_ADDR=$(bind_list "$BIND") || exit 1
    if write_server_conf "$BIND_ADDR" "$PORT" "$CITE" "$DATA" "$HERE/zim"; then
        say "wrote" "web/server_conf.js"
    else
        echo "could not write web/server_conf.js" >&2; exit 1
    fi
fi

[ "$CHECK_ONLY" -eq 1 ] && exit 0

# ---- the engine ----------------------------------------------------
# Before the downloads: a 120 GB corpus is no use without something to
# serve it with, and this costs seconds.
if [ "$WANT_RAMPART" -eq 1 ] && [ -z "$RAMPART" ]; then
    echo
    echo "rampart $MIN_RAMPART or newer is needed to serve this."
    if [ "$MAY_INSTALL" -eq 0 ]; then
        echo "RAMPART=$RAMPART_SET cannot be used; nothing was installed." >&2
        exit 1
    fi
    DOIT=1
    if [ -t 0 ]; then
        echo
        echo "  1) install it into $HERE/rampart"
        echo "     about 30 MB, self-contained: no system files, no PATH changes"
        echo "  2) stop, and install it yourself"
        echo "     curl -fsSL https://get.rampart.dev/ | sh"
        echo
        printf "choice [1]: "
        read -r ANS || ANS=""
        case "${ANS:-1}" in
            1) ;;
            2) DOIT=0 ;;
            *) echo "not one of the choices: $ANS" >&2; exit 1 ;;
        esac
    fi
    if [ "$DOIT" -eq 0 ]; then
        echo "stopping. Run setup.sh again once rampart is installed." >&2
        exit 1
    fi
    rampart_install || exit 1
    RAMPART_ONLY=$HERE/rampart/bin/rampart
    rampart_find || { echo "the installed rampart is not usable" >&2
                      printf "%s" "${RAMPART_WHY:-}" >&2; exit 1; }
    say "rampart" "$(rampart_version "$RAMPART") at $RAMPART"
fi
# Remember it, so servers.sh and the next run use the same one.
[ -n "$RAMPART" ] && conf_set RAMPART "$RAMPART"

# ---- the news table ------------------------------------------------
# A separate, small download, replaced wholesale: the running server
# fingerprints the files behind its handle and reopens when they change,
# so a swap needs no restart. The zim is only fetched where there are
# already archives, or archives chosen for this same run -- a
# corpus-only install would have nothing to render it with.
if [ "$WANT_NEWS" -eq 1 ]; then
    echo
    echo "updating the news table"
    news_remote || { echo "no news payload at $BASE/news/" >&2; exit 1; }
    # Whatever the publisher compressed it with: the corpus parts and the
    # zim are named by the MANIFEST too, and this was the one name still
    # written out here, so a change of format broke every refresh.
    NTAR=$(echo "$NMF" | awk '$1 ~ /^news\.tar\./ { print $1; exit }')
    [ -n "$NTAR" ] || { echo "no news tarball listed at $BASE/news/" >&2; exit 1; }
    NEWSDIR=$DATA/news
    NDL=$DATA/.news-dl
    mkdir -p "$NDL"

    TARSHA=$(curl -fsL --max-time 60 "$BASE/news/$NTAR.sha256" 2>/dev/null | tr -dc '0-9a-f')
    HAVESHA=$(cat "$NEWSDIR/.installed.sha" 2>/dev/null | tr -dc '0-9a-f')
    NEWS_CHANGED=1
    if [ -n "$TARSHA" ] && [ "$TARSHA" = "$HAVESHA" ]; then
        say "news table" "already current"
        NEWS_CHANGED=0
    fi

    if [ "$NEWS_CHANGED" -eq 1 ]; then
        TSIZE=$(echo "$NMF" | awk -v t="$NTAR" '$1 == t { printf "%.0f", $2 }')
        FREE=$(freebytes "$DATA")
        if [ -n "${FREE:-}" ] && [ -n "${TSIZE:-}" ] && [ "$((TSIZE * 6))" -gt "$FREE" ]; then
            echo "NOT ENOUGH SPACE in $DATA for the news table" >&2
            exit 1
        fi
        say "downloading" "$NTAR ($(hum "${TSIZE:-0}"))"
        fetch "$BASE/news/$NTAR" "$NDL/$NTAR" >/dev/null 2>&1 \
          || { echo "news download failed" >&2; exit 1; }
        verify "$NDL/$NTAR" "$BASE/news/$NTAR.sha256" || exit 1
        rm -rf "$NDL/unpack"; mkdir -p "$NDL/unpack"
        case $NTAR in
            *.tar.zst) need_zstd || exit 1; NDECOMP=$ZSTD_DECOMP ;;
            *.tar.gz)  NDECOMP="gzip -dc" ;;
            *) echo "unrecognised news payload: $NTAR" >&2; exit 1 ;;
        esac
        $NDECOMP < "$NDL/$NTAR" | tar -xf - -C "$NDL/unpack" \
          || { echo "could not unpack the news table" >&2; exit 1; }
        [ -f "$NDL/unpack/news/news.tbl" ] \
          || { echo "the news payload has no news.tbl" >&2; exit 1; }
        [ -n "$TARSHA" ] && echo "$TARSHA" > "$NDL/unpack/news/.installed.sha"
        # Swap, do not edit in place: a half-written table would be read
        # by the running server, and the handle guard is built around a
        # directory appearing whole.
        rm -rf "$NEWSDIR.old"
        [ -d "$NEWSDIR" ] && mv "$NEWSDIR" "$NEWSDIR.old"
        mv "$NDL/unpack/news" "$NEWSDIR"
        rm -rf "$NEWSDIR.old" "$NDL/unpack" "$NDL/$NTAR"
        say "news table" "installed ($(du -sh "$NEWSDIR" 2>/dev/null | cut -f1))"
    fi

    # The zim, only where it can be served.
    # The LAST match, not the first: the window is in the filename, so
    # sorted by name the last line is the newest window. Taking the
    # first meant a server that held two served the older one.
    NZIM_NAME=$(echo "$NMF" | awk '$1 ~ /^wikipedia_en_news_.*\.zim$/ { n = $1 } END { print n }')
    # Archives already here, or chosen for this run: the zim is wanted in
    # both cases, and only the first was being counted -- so
    # `--corpus --archives --news` skipped the news pages even though the
    # archives arriving minutes later could serve them.
    HAVE_ARCH=$(ls -1 "$HERE/zim"/*.zim 2>/dev/null | grep -v wikipedia_en_news | wc -l | tr -d " ")
    [ "$WANT_ARCHIVES" -eq 1 ] && HAVE_ARCH=$((HAVE_ARCH + 1))
    HAVE_KIWIX_BIN=""
    command -v kiwix-manage >/dev/null 2>&1 && HAVE_KIWIX_BIN=kiwix-manage
    [ -x "$HERE/zim/bin/kiwix-manage" ] && HAVE_KIWIX_BIN="$HERE/zim/bin/kiwix-manage"
    if [ -z "$NZIM_NAME" ]; then
        say "news zim" "none published"
    elif [ "$HAVE_ARCH" -eq 0 ]; then
        say "news zim" "skipped: no archives here to serve it with"
    else
        ZSIZE=$(echo "$NMF" | awk -v n="$NZIM_NAME" '$1 == n { printf "%.0f", $2 }')
        ZHAVE=$(fsize "$HERE/zim/wikipedia_en_news.zim")
        if [ -n "$ZHAVE" ] && [ "$ZHAVE" = "$ZSIZE" ]; then
            say "news zim" "already current"
        else
            say "downloading" "$NZIM_NAME ($(hum "${ZSIZE:-0}"))"
            fetch "$BASE/news/$NZIM_NAME" "$NDL/$NZIM_NAME" >/dev/null 2>&1 \
              || { echo "news zim download failed" >&2; exit 1; }
            verify "$NDL/$NZIM_NAME" "$BASE/news/$NZIM_NAME.sha256" || exit 1
            mv -f "$NDL/$NZIM_NAME" "$HERE/zim/wikipedia_en_news.zim"
            say "news zim" "installed"
            if [ -n "$HAVE_KIWIX_BIN" ] && [ -f "$HERE/zim/library.xml" ]; then
                # Replace the entry rather than adding a second one: the
                # file name stays the same while its contents change, and
                # the library caches each book's metadata.
                OLDID=$("$HAVE_KIWIX_BIN" "$HERE/zim/library.xml" show 2>/dev/null |
                        awk '/^id:/ { id = $2 } /^path:.*wikipedia_en_news\.zim/ { print id; exit }')
                [ -n "$OLDID" ] && "$HAVE_KIWIX_BIN" "$HERE/zim/library.xml" remove "$OLDID" >/dev/null 2>&1
                ( cd "$HERE/zim" && "$HAVE_KIWIX_BIN" library.xml add wikipedia_en_news.zim >/dev/null 2>&1 ) \
                  && say "library" "updated ($(grep -c "<book " "$HERE/zim/library.xml") books)" \
                  || say "library" "could not add the zim"
            fi
        fi
    fi
    rmdir "$NDL" 2>/dev/null || true
    # `setup.sh --news` on its own is the daily refresh and has nothing
    # further to do. A normal install that happens to want news carries
    # on to the summary, which is where the refresh line and the
    # start-the-server lines are.
    if [ "$NEWS_SET" -eq 1 ] && [ "${WANT_CORPUS:-0}" -eq 0 ] \
       && [ "$WANT_ARCHIVES" -eq 0 ] && [ "$WANT_KIWIX" -eq 0 ]; then
        exit 0
    fi
fi

# ---- the corpus ----------------------------------------------------
if [ "$WANT_CORPUS" -eq 0 ] && [ ! -f "$DATA/corpus/corpus.tbl" ]; then
    echo
    say "corpus" "not here, and not asked for -- add --corpus for it"
fi
# A corpus is already here: is it the one being served? VERSION is a few
# hundred bytes, so this costs nothing and answers the question the old
# presence test could not.
if [ -f "$DATA/corpus/corpus.tbl" ] && [ "$CHECK_ONLY" -eq 0 ] \
   && [ "$CHECK_REPORT" -eq 0 ]; then
    corpus_path 2>/dev/null || true
    PV=""
    [ -n "$CPATH" ] \
        && PV=$(curl -fsL --max-time 60 "$BASE/$CPATH/VERSION" 2>/dev/null)
    IV=""
    [ -f "$DATA/corpus/.installed.version" ] \
        && IV=$(cat "$DATA/corpus/.installed.version" 2>/dev/null)
    PS=$(printf '%s' "$PV" | awk '/^manifest_sha256/{print $2}')
    IS=$(printf '%s' "$IV" | awk '/^manifest_sha256/{print $2}')
    if [ -z "$PS" ]; then
        say "corpus" "published version unknown -- leaving yours alone"
    elif [ -z "$IS" ]; then
        say "corpus" "installed before versions were recorded"
        say "" "pass --replace-corpus to fetch the published one"
    elif [ "$PS" = "$IS" ]; then
        say "corpus" "up to date"
    else
        echo
        echo "A NEWER CORPUS IS PUBLISHED."
        printf '%s\n' "$IV" | sed 's/^/  installed  /'
        printf '%s\n' "$PV" | sed 's/^/  published  /'
        echo
        echo "Fetching it downloads the corpus again and replaces the"
        echo "database in place. Stop the server first: a half-replaced"
        echo "database is new tables against old indexes."
        echo "  ./servers.sh stop && ./setup.sh --replace-corpus"
        [ "$REPLACE_CORPUS" -eq 1 ] || say "corpus" "left as it is"
    fi
fi

# Download when there is none, or when a replacement was asked for.
if [ "$WANT_CORPUS" -eq 1 ] \
   && { [ ! -f "$DATA/corpus/corpus.tbl" ] || [ "$REPLACE_CORPUS" -eq 1 ]; }; then
    echo
    echo "fetching the corpus (this is the big one)"
    # Said wherever a replacement happens, not only in the status block
    # above which --check skips: a half-replaced database is new tables
    # against old indexes.
    [ -f "$DATA/corpus/corpus.tbl" ] \
        && say "note" "stop the server first if it is running: ./servers.sh stop"
    mkdir -p "$DATA"
    corpus_remote || true
    PARTS=$(echo "$MF" | awk '{print $1}')
    [ -n "$PARTS" ] || { echo "no corpus MANIFEST at $BASE/${CPATH:-?}/" >&2; exit 1; }

    # Parts land in their own directory: when the payload tars the
    # database files at top level, the post-unpack move globs corpus*,
    # which would otherwise sweep corpus.tar.zst.part-* into corpus/.
    PDIR=$DATA/.parts
    # WHICH PAYLOAD THESE PARTS BELONG TO. Parts are split at exactly
    # 5 GiB, so every part but the last is the same size in every
    # payload and the "already here" size check cannot tell them apart.
    # Parts left from a payload that is no longer the target are
    # therefore unusable, and saying so beats a gzip CRC error 100 GB in.
    mkdir -p "$PDIR"
    _from=""
    [ -f "$PDIR/.from" ] && _from=$(cat "$PDIR/.from" 2>/dev/null | tr -d " \t\r")
    if [ -n "$_from" ] && [ "$_from" != "$CPATH" ]; then
        say "parts" "left over from $_from, which is not what this run fetches"
        for _sp in "$PDIR"/corpus.tar.*part-*; do
            [ -f "$_sp" ] || continue
            say "discarding" "$(basename "$_sp") ($(du -h "$_sp" 2>/dev/null | cut -f1))"
            rm -f "$_sp"
        done
    fi
    printf '%s\n' "$CPATH" > "$PDIR/.from"

    # Check the disk BEFORE starting, not 200 GB in. Two numbers matter:
    # what the extracted corpus needs, and the transient on top of it --
    # one part when streaming, every part when --keep-parts.
    DLSUM=$(echo "$MF" | awk '{s+=$2} END{printf "%.0f", s}')
    BIGGEST=$(echo "$MF" | awk '$2>m{m=$2} END{printf "%.0f", m}')
    FREE=$(freebytes "$DATA")
    if [ -n "${EXTRACTED:-}" ] && [ -n "${FREE:-}" ] && [ "${DLSUM:-0}" -gt 0 ]; then
        # Credit parts a previous run already fetched: they are on this
        # filesystem, so FREE already excludes them and charging for them
        # again would refuse a retry that actually fits.
        HAVEP=0
        for part in $PARTS; do
            n=$(fsize "$PDIR/$part"); HAVEP=$((HAVEP + ${n:-0}))
        done
        if [ "$KEEP_PARTS" -eq 1 ]; then TRANSIENT=$((DLSUM - HAVEP))
        else                             TRANSIENT=$((BIGGEST - HAVEP)); fi
        [ "$TRANSIENT" -lt 0 ] && TRANSIENT=0
        NEED=$((EXTRACTED + TRANSIENT))
        say "download" "$(hum "$DLSUM") in $(echo "$PARTS" | wc -w | tr -d " ") parts"
        [ "$HAVEP" -gt 0 ] && say "already fetched" "$(hum "$HAVEP") in $PDIR"
        say "extracts to" "$(hum "$EXTRACTED")"
        say "need / free" "$(hum "$NEED") / $(hum "$FREE")"
        # Would it fit if the corpus already here were removed? Its own
        # bytes are the ones in the way, so this is the common case on a
        # disk sized for one corpus.
        HAVE_SZ=0
        [ -d "$DATA/corpus" ] && HAVE_SZ=$(du -sb "$DATA/corpus" 2>/dev/null | cut -f1)
        HAVE_SZ=${HAVE_SZ:-0}
        if [ "$NEED" -gt "$FREE" ] && [ "$HAVE_SZ" -gt 0 ] \
           && [ "$NEED" -le $((FREE + HAVE_SZ)) ]; then
            echo
            say "space" "$(hum "$NEED") needed, $(hum "$FREE") free"
            say "" "the corpus here is $(hum "$HAVE_SZ"); deleting it would make room"
            _dofree=0
            if [ "$DELETE_FIRST" -eq 1 ]; then
                _dofree=1
            elif [ -t 0 ] && [ "$YES" -eq 0 ]; then
                echo
                echo "  Deleting it first is the only way to fit on this disk."
                echo "  You would have NO corpus until the new one finishes:"
                echo "  if the download fails you would start again from nothing."
                printf "  delete the corpus here and fetch the new one? [y/N]: "
                read -r _a || _a=""
                case "$_a" in [Yy]*) _dofree=1 ;; esac
            else
                # -y is not consent to this; say so and name the flag.
                echo >&2
                echo "NOT ENOUGH SPACE in $DATA: need $(hum "$NEED"), have $(hum "$FREE")." >&2
                echo "It fits if the corpus here ($(hum "$HAVE_SZ")) is deleted first." >&2
                echo "That leaves no corpus until the download finishes, so -y does" >&2
                echo "not do it: pass --delete-first to accept that." >&2
                exit 1
            fi
            if [ "$_dofree" -eq 1 ]; then
                # Check the source BEFORE deleting anything: a removed
                # corpus and an unreachable server is the worst outcome,
                # and one request rules it out.
                # PARTS is one name per line: take the FIRST, not the
                # first field of every line.
                _p0=$(echo "$PARTS" | awk 'NR == 1 { print $1; exit }')
                # -L: a redirecting mirror returns 3xx, which -f counts as
                # success, so without it this checks the redirector rather
                # than the object -- and then deletes the corpus.
                if ! curl -fsIL --max-time 60 "$BASE/$CPATH/$_p0" >/dev/null 2>&1; then
                    echo >&2
                    echo "cannot reach $BASE/$CPATH/$_p0 -- nothing deleted." >&2
                    exit 1
                fi
                say "source" "reachable; deleting the corpus here"
                rm -rf "$DATA/corpus" || { echo "could not delete it" >&2; exit 1; }
                FREE=$(freebytes "$DATA")
                say "free now" "$(hum "$FREE")"
                if [ "$NEED" -gt "$FREE" ]; then
                    echo >&2
                    echo "still not enough: need $(hum "$NEED"), have $(hum "$FREE")." >&2
                    exit 1
                fi
            fi
        fi
        if [ "$NEED" -gt "$FREE" ]; then
            echo >&2
            echo "NOT ENOUGH SPACE in $DATA: need $(hum "$NEED"), have $(hum "$FREE")." >&2
            # Only worth suggesting when the smaller requirement fits:
            # "drops to 819T" is arithmetic, not advice.
            ALT=$((BIGGEST - HAVEP)); [ "$ALT" -lt 0 ] && ALT=0
            if [ "$KEEP_PARTS" -eq 1 ] && [ $((EXTRACTED + ALT)) -le "$FREE" ]; then
                echo "Drop --keep-parts and it fits: streaming needs $(hum $((EXTRACTED + ALT)))." >&2
            fi
            echo "Point DATA= at a bigger disk, e.g. DATA=/big/disk ./setup.sh" >&2
            exit 1
        fi
    else
        say "space check" "skipped (no EXTRACTED/MANIFEST sizes published)"
    fi
    mkdir -p "$PDIR"

    # STREAMED, not download-then-extract. The parts are one split
    # stream, so they can be fed to a single tar as they arrive and
    # deleted the moment they are consumed. That matters for disk:
    # fetching all 112 GB first and then extracting 275 GB needs 387 GB
    # free to install a 275 GB corpus, where streaming needs the corpus
    # plus one part.
    #
    # The FIFO is opened ONCE, by the redirection on the whole loop --
    # `cat part > fifo` per part would signal EOF to tar on each close
    # and only the first part would land. Everything chatty inside the
    # loop goes to stderr, because stdout IS the tar stream and a stray
    # progress line would corrupt the archive.
    #
    # --keep-parts restores the two-phase behaviour: slower and far
    # hungrier for disk, but a failed part only costs that part, where a
    # broken stream costs the whole download.
    case "$(echo "$PARTS" | head -1)" in
        *.tar.zst*) need_zstd || exit 1
                    DECOMP="$ZSTD_DECOMP" ;;
        *.tar.gz*)  DECOMP="gzip -dc" ;;
        *) echo "unrecognised payload: $PARTS" >&2; exit 1 ;;
    esac

    if [ "$KEEP_PARTS" -eq 1 ]; then
        for part in $PARTS; do
            if [ -f "$PDIR/$part" ]; then
                want=$(echo "$MF" | awk -v p="$part" '$1==p{print $2}')
                got=$(fsize "$PDIR/$part")
                if [ -n "$want" ] && [ -n "$got" ] && [ "$want" != "$got" ]; then
                    echo "  $part: have $got of $want bytes, refetching" >&2
                    rm -f "$PDIR/$part"
                else
                    say "$part" "have"; continue
                fi
            fi
            KN=$(echo "$PARTS" | wc -w | tr -d ' '); KI=$((${KI:-0} + 1))
            progress_start "$PDIR/$part" "${want:-0}" "Downloading $KI of $KN"
            fetch "$BASE/$CPATH/$part" "$PDIR/$part" "$want" || { progress_stop
                echo "failed: $part" >&2; exit 1; }
            progress_stop
            verify "$PDIR/$part" "$BASE/$CPATH/$part.sha256" || exit 1
        done
        echo "unpacking"
        ORDERED=""
        for part in $PARTS; do ORDERED="$ORDERED $PDIR/$part"; done
        cat $ORDERED | $DECOMP | tar -xf - -C "$DATA"
    else
        FIFO="$DATA/.stream.$$"
        rm -f "$FIFO"; mkfifo "$FIFO" || { echo "cannot mkfifo" >&2; exit 1; }
        # stderr to a file: on ^C this end of the pipe reports a
        # truncated stream, which is expected and not worth printing.
        # The failure path below shows it when it matters.
        XLOG=$DATA/.extract.log
        ( $DECOMP < "$FIFO" | tar -xf - -C "$DATA" ) 2>"$XLOG" &
        XPID=$!
        FAILED=0
        {
            # One part ahead. part_start kicks off a download and returns;
            # the part already in hand is hashed and streamed while it
            # runs. exec >&2 inside the background shell matters: it would
            # otherwise hold the FIFO open and tar would never see EOF.
            BG_PID=""; BG_PART=""
            part_start() {   # part_start <part> <index> <total>
                BG_PART=$1
                pwant=$(echo "$MF" | awk -v p="$1" '$1==p{print $2}')
                if [ -f "$PDIR/$1" ]; then
                    pgot=$(fsize "$PDIR/$1")
                    if [ -n "$pwant" ] && [ "$pwant" = "$pgot" ]; then
                        BG_PID=""; say "part $2 of $3" "already here" >&2
                        return 0
                    fi
                    rm -f "$PDIR/$1"
                fi
                rm -f "$PDIR/.ok.$1"
                ( exec >&2
                  fetch "$BASE/$CPATH/$1" "$PDIR/$1" "$pwant" \
                      && : > "$PDIR/.ok.$1" ) &
                BG_PID=$!
                progress_start "$PDIR/$1" "${pwant:-0}" "Downloading $2 of $3"
            }
            part_wait() {    # part_wait <part>
                [ -n "$BG_PID" ] || return 0
                wait "$BG_PID"; BG_PID=""
                progress_stop
                [ -f "$PDIR/.ok.$1" ] || { echo "  download failed: $1" >&2; return 1; }
                rm -f "$PDIR/.ok.$1"
            }
            part_check() {   # part_check <part> <index> <total>
                pwant=$(echo "$MF" | awk -v p="$1" '$1==p{print $2}')
                pgot=$(fsize "$PDIR/$1")
                if [ -z "$pgot" ]; then
                    say "part $2 of $3" "size unreadable here, trusting sha256" >&2
                elif [ -n "$pwant" ] && [ "$pwant" != "$pgot" ]; then
                    echo "  part $2 of $3: $pgot bytes, expected $pwant" >&2
                    return 1
                fi
                # Quiet while it matches: a line per part would scroll the
                # progress line away. A mismatch prints and stops the run.
                vout=$(verify "$PDIR/$1" "$BASE/$CPATH/$1.sha256" 2>&1) || {
                    printf '%s\n' "$vout" >&2; return 1; }
            }

            set -- $PARTS
            NP=$#; idx=0
            [ "$NP" -gt 0 ] && part_start "$1" 1 "$NP"
            while [ $# -gt 0 ]; do
                part=$1; shift; idx=$((idx+1))
                part_wait "$part" || { FAILED=1; break; }
                # Start the next transfer BEFORE hashing and unpacking
                # this one, so the link stays busy through both.
                [ $# -gt 0 ] && part_start "$1" $((idx+1)) "$NP"
                part_check "$part" "$idx" "$NP" || { FAILED=1; break; }
                cat "$PDIR/$part"          # the ONLY writer to stdout here
                rm -f "$PDIR/$part"        # freed as soon as it is consumed
            done
            progress_stop
            say "downloaded" "$idx of $NP parts, each sha256 checked" >&2
        } > "$FIFO"
        wait "$XPID" || FAILED=1
        rm -f "$FIFO"
        [ "$FAILED" -eq 0 ] || { { echo "corpus download failed."
      [ -s "${XLOG:-}" ] && { echo "the unpacker said:"
                              tail -4 "$XLOG" | sed 's/^/  /'; }
      echo "Re-run to retry. The stream cannot rewind, so it restarts from the"
      echo "first part; any part already downloaded and not yet streamed is"
      echo "reused from $PDIR. Partly extracted files are left in $DATA and"
      echo "are overwritten by the next run -- delete them to reclaim the space."
      echo "With --keep-parts every downloaded part is kept instead, which"
      echo "costs $(hum "${DLSUM:-0}") of disk but makes a retry cheap."; } >&2; exit 1; }
    fi

    [ -f "$DATA/corpus/corpus.tbl" ] || [ -f "$DATA/corpus.tbl" ] \
        || { echo "unpack produced no corpus.tbl" >&2; exit 1; }
    # The payload tars the database files directly, so land them in corpus/.
    if [ -f "$DATA/corpus.tbl" ] && [ ! -f "$DATA/corpus/corpus.tbl" ]; then
        mkdir -p "$DATA/corpus"
        # lips_* rather than lips_sources*: lips_licenses.tbl was being
        # extracted and then left here, so the reader pages reported no
        # terms for every source. Parts are in .parts/, so none of these
        # globs can reach them.
        mv "$DATA"/corpus* "$DATA"/lips_* "$DATA"/SYS*.tbl \
           "$DATA/corpus/" 2>/dev/null
    fi
    rm -rf "$PDIR"
    rm -f "${XLOG:-}"
    # What this install now holds, for the comparison on the next run.
    curl -fsL --max-time 60 "$BASE/$CPATH/VERSION" \
        > "$DATA/corpus/.installed.version" 2>/dev/null || true
    # Which dated payload this came from, so --check can say what it is
    # comparing against and a later run can ask for the same one again.
    printf 'corpus_dir %s\n' "$CPATH" >> "$DATA/corpus/.installed.version"
    say "corpus" "unpacked to $DATA/corpus ($(du -sh "$DATA/corpus" 2>/dev/null | cut -f1))"
fi

# ---- kiwix, optional ------------------------------------------------
if [ "$WANT_KIWIX" -eq 1 ]; then
    echo
    # LIPS_DL_BASE: fetch the kiwix binaries from the same host as
    # everything else. Upstream is in France and slow enough to dominate
    # the install; the installer falls back to it if our copy is absent.
    if [ -x "$HERE/tools/setup-kiwix.sh" ]; then
        KARG=""
        [ "$ACCEPT_LIC" -eq 1 ] && KARG="--accept-license"
        LIPS_DL_BASE="$BASE" bash "$HERE/tools/setup-kiwix.sh" $KARG
    else
        say "kiwix" "tools/setup-kiwix.sh missing"
    fi
fi

# ---- archives, optional --------------------------------------------
if [ "$WANT_ARCHIVES" -eq 1 ]; then
    echo
    echo "fetching archives -- hundreds of GB; ctrl-c is safe, it resumes"
    mkdir -p "$HERE/zim"
    archives_remote || say "archives" "no MANIFEST at $BASE/archives/"
    # Mirrors first, this host last. Both lists come from here, so an
    # install needs nothing configured and nothing chosen.
    if mirrors_remote; then mirrors_pick || true; fi
    # Same pre-flight as the corpus, over what is still missing.
    WANT=$(archives_want)
    AFREE=$(freebytes "$HERE/zim")
    if [ "$WANT" -gt 0 ] && [ -n "${AFREE:-}" ]; then
        say "archives to fetch" "$(hum "$WANT")"
        say "need / free" "$(hum "$WANT") / $(hum "$AFREE")"
        if [ "$WANT" -gt "$AFREE" ]; then
            echo >&2
            echo "NOT ENOUGH SPACE in $HERE/zim: need $(hum "$WANT"), have $(hum "$AFREE")." >&2
            echo "The archives are optional -- the corpus serves text without them." >&2
            exit 1
        fi
    fi

    # MANIFEST is "<name> <bytes>", so a truncated copy is caught by size
    # without hashing hundreds of GB.
    ANUM=$(echo "$AMF" | grep -c . 2>/dev/null || echo 0)
    AIDX=0; AVPID=""
    # The previous archive is hashed while this one downloads: hashing
    # runs faster than the link, so it costs nothing to overlap and the
    # whole 530 GB set is checked without adding a pass over the disk.
    archive_hash_wait() {
        [ -n "$AVPID" ] || return 0
        wait "$AVPID" 2>/dev/null || true
        AVPID=""
    }
    # A here-document, NOT `echo | while`: the right side of a pipeline is
    # a subshell, and progress_start's pid would be set there while the
    # INT trap that has to kill it runs in this shell. That is how ^C came
    # to leave the progress line redrawing over the shell prompt.
    while read -r f sz rest; do
        [ -n "$f" ] || continue
        AIDX=$((AIDX+1))
        have=$(fsize "$HERE/zim/$f"); have=${have:--1}
        if [ -n "${sz:-}" ] && [ "$have" = "$sz" ]; then continue; fi
        [ "$have" != "-1" ] && say "$f" "size $have != $sz, refetching"
        progress_start "$HERE/zim/$f" "${sz:-0}" "Downloading $AIDX of $ANUM"
        # Mirrors in measured order with our own host last, so a dump
        # that has rotated out upstream, or a mirror having a bad day,
        # costs one failed range rather than the archive.
        AURLS=""
        if [ -n "$MIRROR_PICK" ] && AUP=$(upstream_path "$f"); then
            APATH=${AUP%% *}; AMASK=${AUP##* }
            # Only the mirrors that have this archive, in the order the
            # probe put them. A mirror missing one collection still
            # carries the others.
            for m in $MIRROR_PICK; do
                ai=0
                for b in $MIRROR_BASES; do
                    if [ "$b" = "$m" ]; then
                        case ",$AMASK," in
                            *",$ai,"*) AURLS="$AURLS $m$APATH" ;;
                        esac
                        break
                    fi
                    ai=$((ai + 1))
                done
            done
        fi
        AURLS="$AURLS $BASE/archives/$f"
        AOK=0
        if [ -n "${sz:-}" ] && [ "$sz" -gt 0 ] 2>/dev/null; then
            fetch_spread "$HERE/zim/$f" "$sz" $AURLS && AOK=1
        fi
        # Nothing spread cleanly: one plain resumable stream from here,
        # which is always there and always has every archive.
        if [ "$AOK" -eq 0 ]; then
            fetch "$BASE/archives/$f" "$HERE/zim/$f" "${sz:-}" || { progress_stop
                say "$f" "FAILED"; continue; }
        fi
        progress_stop
        got=$(fsize "$HERE/zim/$f")
        if [ -n "${sz:-}" ] && [ -n "$got" ] && [ "$got" != "$sz" ]; then
            say "$f" "WRONG SIZE ($got != $sz) -- removed"; rm -f "$HERE/zim/$f"
        else
            # The hash the build recorded when it verified this archive
            # is published beside it, so an archive can be checked the
            # same way the corpus parts are. verify() says so and
            # deletes a mismatch; with no published hash it says so and
            # the size check above stands alone. One at a time, so a
            # failure is still reported against the right file.
            archive_hash_wait
            ( verify "$HERE/zim/$f" "$BASE/archives/$f.sha256" || true ) &
            AVPID=$!
        fi
    done <<ARCHIVE_MANIFEST
$AMF
ARCHIVE_MANIFEST
    # The last archive's hash is still running at this point. AVPID is
    # this shell's now, not a subshell's, so the trap can reach it too.
    archive_hash_wait
fi

if [ "$WANT_NEWS" -eq 1 ] && [ -f "$DATA/news/news.tbl" ]; then
    echo
    echo "keep the news current -- a daily refresh, which downloads nothing"
    echo "when rampart.dev has nothing newer:"
    echo "  crontab -e, then:"
    echo "  17 4 * * * cd $HERE && ./setup.sh --news >> news-refresh.log 2>&1"
fi
echo
echo "start the server:"
if [ "$DATA" = "$HERE/build" ]; then
    echo "  ./servers.sh start"
else
    echo "  DATA=$DATA ./servers.sh start"
fi
# What this install is now on, for the next run to compare against.
# Written at the end so a failed or interrupted run does not claim a
# version it did not finish installing.
# ONLY on a fresh install. do_upgrade writes this when it actually
# replaces the program files; writing it after a --corpus or --news run
# would claim a release whose files were never fetched, and --upgrade
# would then refuse to fetch them ("already on X"). A tree with no
# version.txt was just unpacked from this BASE, so the published one
# does describe it.
if [ ! -f "$HERE/version.txt" ]; then
    if [ -n "${VER_REMOTE:-}" ] || ver_remote; then
        printf '%s\n' "$VER_REMOTE" > "$HERE/version.txt" 2>/dev/null \
            && say "version" "$(ver_field "$VER_REMOTE" version)"
    fi
fi

# Content terms vary by source and some of them restrict reuse, which a
# download gives no other occasion to mention. The whole line is taken,
# not ver_field's first word, because the value is prose.
LIC_LINE=$(printf '%s\n' "${VER_REMOTE:-}" \
    | awk '$1 == "licenses" { $1 = ""; sub(/^ /, ""); print; exit }')
if [ -n "$LIC_LINE" ]; then
    echo
    echo "content licences: $LIC_LINE"
    echo "  Sources keep their own terms. Every document page shows the"
    echo "  licence for the source it came from, and a citation link leads"
    echo "  to that page. Some sources do not permit commercial use."
fi

echo "then open http://$CITE_HOST:$PORT/  (MCP at /apps/mcp.json)"
[ "$WANT_KIWIX" -eq 1 ] && echo "  kiwix:  bash $HERE/tools/zim-serve.sh start"

exit 0
