#!/bin/bash
# Mirror the upstream kiwix-tools builds into the staging tree, so
# installs pull them from our host instead of kiwix.org, whose own
# server measured 7 KB/s from here -- three hours for four 20 MB files.
#
#   tools/mirror-kiwix.sh [--version V] [--stage DIR] [--upstream-only]
#
# Sources are tried fastest-first. The community mirrors carry the same
# release tree and were 150-300x quicker in a timed 4 MB probe:
#
#   wi.mirror.driftle.ss   2.1 MB/s      mirrors.dotsrc.org   1.9 MB/s
#   mirror.accum.se        1.6 MB/s      ftp.fau.de           1.2 MB/s
#   mirror.download.kiwix.org             7 KB/s   (last resort)
#
# Whichever serves the file, the md5 is taken from kiwix.org itself, so
# a mirrored copy is verified against the publisher and not against the
# host that happened to hand it over.
#
# Polite by construction: one request at a time with a gap between, and
# nothing is re-downloaded if it is already here and its md5 matches.
set -u
VERSION=3.8.2
STAGE=${STAGE:-/usr/local/src/alpacalips-staging}
UPSTREAM=https://mirror.download.kiwix.org/release/kiwix-tools
MIRRORS="https://wi.mirror.driftle.ss/kiwix/release/kiwix-tools
https://mirrors.dotsrc.org/kiwix/release/kiwix-tools
https://mirror.accum.se/mirror/kiwix.org/release/kiwix-tools
https://ftp.fau.de/kiwix/release/kiwix-tools"
GAP=3
while [ $# -gt 0 ]; do
    case "$1" in
        --version)       VERSION="${2:?--version needs a value}"; shift 2 ;;
        --stage)         STAGE="${2:?--stage needs a value}";     shift 2 ;;
        --upstream-only) MIRRORS=""; shift ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done

# The platforms setup-kiwix.sh can install. armhf is not published
# upstream at this version, so 32-bit ARM still has no kiwix.
TARGETS="linux-x86_64-musl linux-aarch64-musl macos-arm64 macos-x86_64"
D=$STAGE/kiwix
[ -n "$STAGE" ] && [ -n "$VERSION" ] || { echo "empty stage or version" >&2; exit 1; }
mkdir -p "$D" || exit 1
say() { printf "  %-44s %s\n" "$1" "$2"; }

# Delete one file this script wrote, never a path built from an empty
# variable: the name has to look like what it creates.
discard() {
    case "${1:-}" in
        */kiwix-tools_*.tar.gz|*/kiwix-tools_*.tar.gz.part|*/kiwix-tools_*.tar.gz.md5)
            [ -f "$1" ] && rm -f "$1" ;;
        *)  [ -n "${1:-}" ] && echo "refusing to remove: $1" >&2 ;;
    esac
}

ok=0 failed=0
for t in $TARGETS; do
    f=kiwix-tools_${t}-${VERSION}.tar.gz
    tgz=$D/$f
    part=$D/$f.part
    md5=$D/$f.md5

    if [ -f "$tgz" ] && [ -f "$md5" ] \
       && ( cd "$D" && md5sum -c "$f.md5" >/dev/null 2>&1 ); then
        say "$f" "have"; ok=$((ok+1)); continue
    fi

    got=0 from=""
    for src in $MIRRORS $UPSTREAM; do
        if curl -fsSL -m 1800 -o "$part" "$src/$f"; then
            got=1; from=$(echo "$src" | cut -d/ -f3); break
        fi
        discard "$part"
        sleep $GAP
    done
    if [ "$got" != 1 ]; then
        say "$f" "DOWNLOAD FAILED everywhere"
        failed=$((failed+1)); sleep $GAP; continue
    fi
    mv -f "$part" "$tgz"
    sleep $GAP

    # The checksum comes from the publisher even when the bytes did not.
    if ! curl -fsSL -m 120 -o "$md5" "$UPSTREAM/$f.md5"; then
        say "$f.md5" "no checksum published"
        discard "$md5"
    fi
    if [ -f "$md5" ] && ! ( cd "$D" && md5sum -c "$f.md5" >/dev/null 2>&1 ); then
        say "$f" "MD5 MISMATCH -- discarded"
        discard "$tgz"
        discard "$md5"
        failed=$((failed+1)); sleep $GAP; continue
    fi
    say "$f" "$(du -h "$tgz" | cut -f1) from $from, md5 ok"
    ok=$((ok+1))
    sleep $GAP
done

# Same MANIFEST shape as the corpus and archives: "<name> <bytes>".
( cd "$D" && for f in kiwix-tools_*.tar.gz; do
      [ -f "$f" ] || continue
      printf "%s %s\n" "$f" "$(stat -c %s "$f")"
  done > MANIFEST.tmp && mv MANIFEST.tmp MANIFEST )
echo
say "mirrored" "$ok build(s), $failed failed"
say "manifest" "$D/MANIFEST"
