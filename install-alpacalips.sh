#!/bin/sh
# install-alpacalips.sh -- fetch, unpack and set up alpacaLIPS.
#
#   curl -fsSL https://rampart.dev/install-alpacalips.sh | sh
#
# Run with --help for the options. The help text lives in usage() below
# rather than in this header: piped to sh, this script has no file of
# its own to read a comment block out of.
#
# It downloads about 1 MB -- the program files -- and leaves the large
# payloads to setup.sh, which reports each one's size and checks free
# space first. Re-running is safe: the program files are replaced and
# your settings, database and archives are left where they are.

set -eu

BASE=${BASE:-https://rampart.dev/downloads/alpacalips}
DIR=${DIR:-./alpacalips}
TARBALL=alpacalips-run.tar.gz
RUN_SETUP=1
VERIFY=1
FORCE=0
WANTS=0          # a payload was named, so setup.sh needs no questions
ARGS=            # passed through to setup.sh

say()  { printf '  %-18s %s\n' "$1" "$2"; }
note() { printf '%s\n' "$*"; }
die()  { printf 'install-alpacalips: %s\n' "$*" >&2; exit 1; }

usage() {
    # Printed from here, not read out of the file: piped to sh there is
    # no file to read, and a silent --help is worse than a long function.
    cat <<'EOF'
install-alpacalips.sh -- fetch, unpack and set up alpacaLIPS.

  curl -fsSL https://rampart.dev/install-alpacalips.sh | sh

To pass options through a pipe, add `-s --`:

  curl -fsSL https://rampart.dev/install-alpacalips.sh | sh -s -- --dir /opt/alpacalips

Where it unpacks:
  -d, --dir DIR     the install directory      (default ./alpacalips)
      --base URL    where to download from
      --force       use DIR even if it holds unrelated files

What this script does:
      --no-setup    unpack only; run nothing
      --no-verify   skip the checksum check    (not recommended)
  -h, --help        this text

Everything else is handed to setup.sh, which does the real work:
      --check       report what is published and what is here; download nothing
      --corpus      the corpus: full-text search and the stored page text
      --archives    the original ZIM archives, for reading the pages themselves
      --kiwix       the local viewer those archives are read with
      --news        refresh the rolling news window
      --port N, --bind ADDR, --base-url URL, --accept-license

At a terminal, setup.sh asks what to install. Through a pipe with
nothing chosen it reports instead, because the corpus is a 112 GB
download and nothing that large should begin unasked.
EOF
    exit 0
}

while [ $# -gt 0 ]; do
    case $1 in
        -d|--dir)    [ $# -ge 2 ] || die "--dir needs a directory"
                     DIR=$2; shift 2 ;;
        --base)      [ $# -ge 2 ] || die "--base needs a URL"
                     BASE=$2; shift 2 ;;
        --no-setup)  RUN_SETUP=0; shift ;;
        --no-verify) VERIFY=0; shift ;;
        --force)     FORCE=1; shift ;;
        -h|--help)   usage ;;
        --corpus|--archives|--kiwix|--news|--check)
                     WANTS=1; ARGS="$ARGS $1"; shift ;;
        *)           ARGS="$ARGS $1"; shift ;;
    esac
done

# ---- tools ---------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q -O "$2" "$1"; }
else
    die "need curl or wget to download anything"
fi
command -v tar >/dev/null 2>&1 || die "need tar to unpack the runtime"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$1" | sed 's/.*= *//'
    else
        return 1
    fi
}

note "alpacaLIPS"
say "source" "$BASE"
say "install to" "$DIR"

# ---- download and check --------------------------------------------
TMP=$(mktemp -d "${TMPDIR:-/tmp}/alpacalips.XXXXXX") || die "cannot make a temp directory"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

fetch "$BASE/$TARBALL" "$TMP/$TARBALL" \
    || die "cannot download $BASE/$TARBALL"
say "downloaded" "$TARBALL"

if [ "$VERIFY" -eq 1 ]; then
    if fetch "$BASE/$TARBALL.sha256" "$TMP/$TARBALL.sha256" 2>/dev/null; then
        want=$(cut -d' ' -f1 "$TMP/$TARBALL.sha256")
        got=$(sha256_of "$TMP/$TARBALL") \
            || die "no sha256 tool here; install one or pass --no-verify"
        [ "$want" = "$got" ] || die "checksum mismatch -- not unpacking
  published $want
  got       $got"
        say "checksum" "verified"
    else
        say "checksum" "not published at this source -- continuing unverified"
    fi
fi

mkdir -p "$TMP/x"
tar xzf "$TMP/$TARBALL" -C "$TMP/x" || die "cannot unpack $TARBALL"
SRC=$TMP/x/alpacalips
[ -d "$SRC" ] || SRC=$TMP/x          # a flat tarball, should it ever be one
[ -f "$SRC/setup.sh" ] || die "no setup.sh inside $TARBALL"

# ---- place it ------------------------------------------------------
if [ -e "$DIR" ] && [ ! -d "$DIR" ]; then
    die "$DIR exists and is not a directory"
fi
if [ -d "$DIR" ] && [ -f "$DIR/setup.sh" ]; then
    say "found" "an install here already -- updating the program files"
elif [ -d "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null || true)" ] \
     && [ "$FORCE" -eq 0 ]; then
    die "$DIR is not empty and holds no alpacaLIPS install.
  Pick another with --dir, or pass --force to use this one anyway."
fi
mkdir -p "$DIR" || die "cannot create $DIR"
# Only the program files are shipped, so an update leaves web/server_conf.js,
# the database under build/ and the archives under zim/ untouched.
cp -R "$SRC/." "$DIR/" || die "cannot copy into $DIR"
chmod +x "$DIR/setup.sh" "$DIR/servers.sh" 2>/dev/null || true
say "unpacked" "$(cd "$DIR" && pwd)"

HOME_DIR=$(cd "$DIR" && pwd)
next() {
    note ""
    note "next:"
    note "  cd $HOME_DIR"
    note "  ./setup.sh --check          what is published, and what is here"
    note "  ./setup.sh --corpus         install the corpus (112G download)"
    note "  ./servers.sh start          start the server once something is installed"
}

[ "$RUN_SETUP" -eq 1 ] || { next; exit 0; }

cd "$DIR"
note ""
# shellcheck disable=SC2086  # ARGS is a list of plain flags
if [ -t 0 ]; then
    sh ./setup.sh $ARGS
elif [ -c /dev/tty ] && ( : < /dev/tty ) 2>/dev/null; then
    # Piped from curl, but there is a terminal: let setup.sh ask.
    sh ./setup.sh $ARGS < /dev/tty
elif [ "$WANTS" -eq 1 ]; then
    sh ./setup.sh $ARGS < /dev/null
else
    note "No terminal to ask with and no payload named, so nothing will be"
    note "downloaded. Here is what is available:"
    note ""
    sh ./setup.sh --check < /dev/null || true
    next
fi
