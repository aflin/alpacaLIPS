#!/bin/bash
# Download the kiwix command-line tools into this project, so flavor 2
# needs no system install and the whole project remains removable with a
# single rm -rf.
#
#   tools/setup-kiwix.sh [--accept-license] [--force] [--version X.Y.Z]
#                        [--prefix DIR] [--cache DIR] [--list]
#                        [--keep | --no-keep]
#
# The tarball is downloaded into zim/cache and, after a successful install,
# you are asked whether to keep it. A kept tarball is reused on the next
# run (checksum re-verified) and can be copied to another machine.
#
# WHERE IT COMES FROM: our own mirror first (LIPS_DL_BASE/kiwix/, which
# setup.sh passes), then upstream. The upstream release tree is served
# from France with no US mirror, and is slow enough that it dominates a
# kiwix install; the copy we host is the same file, verified against the
# same upstream md5. --upstream skips the mirror.
#
# Supported: Linux x86_64, Linux aarch64, and macOS on both Apple Silicon
# and Intel. FreeBSD and 32-bit targets are out of scope: upstream has no
# BSD build at all and the armhf build stopped at 3.4.0 (2022).
#
# The musl builds are preferred on Linux: they carry no dependency on the
# host glibc version, so one file works across distributions.

set -u
VERSION="3.8.2"
BASE="https://mirror.download.kiwix.org/release/kiwix-tools"
# Our mirror of the same files. setup.sh passes the download host it is
# already using; empty means the public mirrors and upstream only.
MIRROR="${LIPS_DL_BASE:-}"
USE_MIRROR=1
# The community mirrors carry the same release tree and are the only
# practical source on a machine with no mirror of our own: upstream is
# served from France with no US mirror, measured 7 KB/s from here, and
# rate-limits a fresh clone with HTTP 429. Same list mirror-kiwix.sh
# uses, in the order a timed probe put them.
PUBLIC_MIRRORS="https://wi.mirror.driftle.ss/kiwix/release/kiwix-tools
https://mirrors.dotsrc.org/kiwix/release/kiwix-tools
https://mirror.accum.se/mirror/kiwix.org/release/kiwix-tools
https://ftp.fau.de/kiwix/release/kiwix-tools"
discard_part() {   # remove this run's partial download, if it is one
    case "${TAR:-}" in
        */kiwix-tools_*.tar.gz) [ -f "$TAR.part" ] && rm -f "$TAR.part" ;;
    esac
}

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
PREFIX="$ROOT/zim/bin"
CACHE="$ROOT/zim/cache"
ACCEPT=0
FORCE=0
LIST=0
KEEP=ask

while [ $# -gt 0 ]; do
    case "$1" in
        --accept-license) ACCEPT=1 ;;
        --force)          FORCE=1 ;;
        --list)           LIST=1 ;;
        --keep)           KEEP=yes ;;
        --no-keep)        KEEP=no ;;
        --cache)          shift; CACHE="${1:?--cache needs a value}" ;;
        --mirror)         shift; MIRROR="${1:?--mirror needs a value}" ;;
        --upstream)       USE_MIRROR=0 ;;
        --version)        shift; VERSION="${1:?--version needs a value}" ;;
        --prefix)         shift; PREFIX="${1:?--prefix needs a value}" ;;
        -h|--help)        sed -n '2,15p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

# ---------- platform ----------

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
    Linux/x86_64)            TARGET="linux-x86_64-musl" ;;
    Linux/aarch64|Linux/arm64) TARGET="linux-aarch64-musl" ;;
    Darwin/arm64)            TARGET="macos-arm64" ;;
    Darwin/x86_64)           TARGET="macos-x86_64" ;;
    FreeBSD/*)
        echo "FreeBSD has no upstream kiwix-tools build." >&2
        echo "Either build from source (kiwix-tools-$VERSION.tar.xz, which" >&2
        echo "needs libkiwix and libzim) or run flavor 1, which needs none" >&2
        echo "of this -- citations still link to the stored text." >&2
        exit 3 ;;
    *)
        echo "unsupported platform: $OS $ARCH" >&2
        echo "supported: Linux x86_64, Linux aarch64, macOS arm64, macOS x86_64" >&2
        exit 3 ;;
esac

TARBALL="kiwix-tools_${TARGET}-${VERSION}.tar.gz"
URL="$BASE/$TARBALL"
BINS="kiwix-serve kiwix-manage kiwix-search"

if [ "$LIST" = 1 ]; then
    echo "platform : $OS $ARCH"
    echo "target   : $TARGET"
    echo "version  : $VERSION"
    echo "url      : $URL"
    echo "prefix   : $PREFIX"
    echo "cache    : $CACHE"
    if [ -f "$CACHE/$TARBALL" ]; then
        echo "cached   : yes ($(du -h "$CACHE/$TARBALL" | cut -f1))"
    else
        echo "cached   : no"
    fi
    exit 0
fi

# ---------- already present? ----------

if [ "$FORCE" = 0 ] && [ -x "$PREFIX/kiwix-serve" ]; then
    have="$("$PREFIX/kiwix-serve" --version 2>&1 | head -1)"
    echo "already installed: $have"
    echo "  $PREFIX"
    echo "  pass --force to replace it"
    exit 0
fi

# ---------- licence ----------

cat <<'LIC'
-------------------------------------------------------------------
kiwix-tools is third-party software, not part of this project.

  kiwix-tools (kiwix-serve, kiwix-manage, kiwix-search)
      GPL-3.0-or-later
  libkiwix          (compiled into those binaries)
      GPL-3.0-or-later
  libzim            (ZIM reading)
      GPL-2.0-or-later

  Source: https://github.com/kiwix/kiwix-tools
          https://github.com/openzim/libzim

These run as a SEPARATE PROCESS reached over HTTP. Nothing in this
project links against them, so no code here is affected by those
licences. If you REDISTRIBUTE a bundle containing these binaries,
you are distributing GPL-3 software and must convey the licence and
offer corresponding source -- pointing at the upstream release above
satisfies that for an unmodified binary.
-------------------------------------------------------------------
LIC

if [ "$ACCEPT" != 1 ]; then
    if [ -t 0 ]; then
        printf 'Accept and download? [y/N] '
        read -r reply
        case "$reply" in [yY]|[yY][eE][sS]) ;; *) echo "declined."; exit 1 ;; esac
    else
        echo "Not a terminal and --accept-license not given; refusing to" >&2
        echo "accept a licence on your behalf. Re-run with" >&2
        echo "  --accept-license" >&2
        exit 1
    fi
fi

# ---------- checksum helper ----------

command -v curl >/dev/null || { echo "curl is required" >&2; exit 4; }

md5_of() {      # md5sum on Linux, md5 -q on macOS
    if command -v md5sum >/dev/null; then md5sum "$1" | cut -d' ' -f1
    elif command -v md5 >/dev/null;  then md5 -q "$1"
    else return 1; fi
}

# ---------- cache, then download ----------

mkdir -p "$PREFIX" "$CACHE" || exit 4
TAR="$CACHE/$TARBALL"
TARMD5="$TAR.md5"
DOWNLOADED=0

# A cached tarball is reused only if it still matches its checksum. The
# .md5 is cached beside it, so a machine installing from a copied cache
# (or a shared mount) needs no network at all.
want=""
if [ -f "$TAR" ] && [ -s "$TARMD5" ]; then
    want="$(tr -d '\r' < "$TARMD5" | tr -s ' ' | cut -d' ' -f1 | head -1)"
    got="$(md5_of "$TAR")" || { echo "no md5sum or md5 available" >&2; exit 5; }
    if [ -n "$want" ] && [ "$want" = "$got" ]; then
        echo "using cached $TARBALL"
        echo "  $TAR"
        echo "  md5 verified without downloading: $got"
    else
        echo "cached $TARBALL fails its checksum -- discarding it"
        rm -f "$TAR" "$TARMD5"
        want=""
    fi
fi

# Our mirror first if there is one, then the public mirrors, upstream
# last. Whichever serves the tarball, the checksum is fetched from
# upstream when it can be, so a mirrored copy is verified against the
# publisher rather than against the host that handed it over.
SOURCES=""
if [ "$USE_MIRROR" = 1 ] && [ -n "$MIRROR" ]; then
    SOURCES="${MIRROR%/}/kiwix"
fi
SOURCES="$SOURCES $PUBLIC_MIRRORS $BASE"

if [ ! -f "$TAR" ]; then
    echo "downloading $TARBALL"
    GOT=0
    for src in $SOURCES; do
        echo "  from $src"
        # Into the cache directly, not a temp dir: a failed unpack or a
        # bad checksum should not cost the download a second time.
        if curl -fL --retry 2 -m 1800 --progress-bar -o "$TAR.part" "$src/$TARBALL"; then
            mv "$TAR.part" "$TAR"
            GOT=1
            break
        fi
        echo "  not available there" >&2
        discard_part
    done
    [ "$GOT" = 1 ] || { echo "download failed: $TARBALL" >&2; exit 5; }
    DOWNLOADED=1
    # The checksum always comes from upstream when it can: it is what
    # makes the mirrored copy trustworthy rather than merely convenient.
    curl -fL --retry 3 -m 60 -o "$TARMD5" "$BASE/$TARBALL.md5" \
      || curl -fL --retry 2 -m 60 -o "$TARMD5" "${MIRROR%/}/kiwix/$TARBALL.md5" \
      || {
        echo "could not fetch the checksum; refusing to install unverified" >&2
        echo "  the download is kept at $TAR" >&2
        exit 5; }
    # The .md5 may be "<hash>  <name>" or a bare hash; compare the hash
    # itself rather than trusting md5sum -c to agree about the filename.
    want="$(tr -d '\r' < "$TARMD5" | tr -s ' ' | cut -d' ' -f1 | head -1)"
    got="$(md5_of "$TAR")" || { echo "no md5sum or md5 available" >&2; exit 5; }
    if [ -z "$want" ] || [ "$want" != "$got" ]; then
        echo "CHECKSUM MISMATCH -- not installing" >&2
        echo "  expected $want" >&2
        echo "  got      $got" >&2
        echo "  the suspect file is at $TAR -- delete it before retrying" >&2
        exit 5
    fi
    echo "md5 verified: $got"
fi

# ---------- unpack ----------

# Only the extraction is throwaway; the tarball itself stays in the cache.
UNPACK="$CACHE/.unpack.$$"
rm -rf "$UNPACK"; mkdir -p "$UNPACK" || exit 6
trap 'rm -rf "$UNPACK"' EXIT
TMP="$UNPACK"

tar -xzf "$TAR" -C "$TMP" || { echo "unpack failed" >&2; exit 6; }

installed=""
for b in $BINS; do
    src="$(find "$TMP" -type f -name "$b" -perm -u+x 2>/dev/null | head -1)"
    [ -n "$src" ] || { echo "  $b not in the tarball" >&2; continue; }
    cp "$src" "$PREFIX/$b" && chmod 755 "$PREFIX/$b" && installed="$installed $b"
done
[ -n "$installed" ] || { echo "nothing installed" >&2; exit 6; }

# Keep whatever licence files upstream shipped, so provenance travels with
# the binaries rather than living only in this script.
find "$TMP" -maxdepth 2 -type f \
     \( -iname 'COPYING*' -o -iname 'LICENSE*' -o -iname 'NOTICE*' \) \
     -exec cp {} "$PREFIX/" \; 2>/dev/null

{
    echo "kiwix-tools $VERSION ($TARGET)"
    echo "downloaded $(date -u '+%Y-%m-%dT%H:%M:%SZ') from $URL"
    echo "md5 $got"
    echo "licence accepted by $(id -un)@$(hostname) on $(date -u '+%Y-%m-%d')"
    echo "kiwix-tools and libkiwix: GPL-3.0-or-later; libzim: GPL-2.0-or-later"
    echo "source: https://github.com/kiwix/kiwix-tools"
} > "$PREFIX/PROVENANCE.txt"

echo
echo "installed:$installed"
echo "  into $PREFIX"
"$PREFIX/kiwix-serve" --version 2>&1 | head -2 | sed 's/^/  /'
echo

# ---------- keep the tarball? ----------

# Asked only when it was actually fetched this run. Keeping it makes a
# re-run or a --force instant, survives a failed install, and lets the
# cache be copied to another machine -- which matters because the only
# host carrying these binaries is in France and there is no US mirror of
# the release tree.
if [ "$DOWNLOADED" = 1 ]; then
    sz="$(du -h "$TAR" 2>/dev/null | cut -f1)"
    case "$KEEP" in
        yes) echo "keeping $TARBALL ($sz) in $CACHE" ;;
        no)  rm -f "$TAR" "$TARMD5"; echo "removed the downloaded tarball" ;;
        *)
            if [ -t 0 ]; then
                echo "The downloaded tarball is $sz:"
                echo "  $TAR"
                echo "Keeping it means a re-run needs no download, and the"
                echo "cache can be copied to other machines."
                printf 'Keep it? [Y/n] '
                read -r reply
                case "$reply" in
                    [nN]|[nN][oO]) rm -f "$TAR" "$TARMD5"
                                   echo "  removed." ;;
                    *)             echo "  kept." ;;
                esac
            else
                echo "keeping $TARBALL ($sz) in $CACHE"
                echo "  (--no-keep to discard it, --keep to silence this)"
            fi ;;
    esac
    echo
fi
# build.sh exists in the build tree and not in an installed copy, where
# the archives arrive as a download instead of an import.
echo "next:"
if [ -f "$ROOT/build.sh" ]; then
    echo "  ./build.sh links             put the imported archives in zim/"
    echo "  ./build.sh kiwix             build zim/library.xml from them"
else
    echo "  ./setup.sh --archives       download the archives (530G) into zim/"
fi
echo "  tools/zim-serve.sh start     serve them on 8098"
echo "  tools/zim-serve.sh books     write zim/books.json for source links"
