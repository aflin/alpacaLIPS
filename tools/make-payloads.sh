#!/bin/bash
# Build the downloadable payloads into a staging directory, ready to be
# copied to rampart.dev.
#
#   tools/make-payloads.sh --corpus          corpus* + SYS*.tbl  (~276 GB in)
#   tools/make-payloads.sh --news            the news table and its zim
#   tools/make-payloads.sh --runtime         the runtime tarball (~180 KB)
#   tools/make-payloads.sh --kiwix           kiwix-serve + library (~68 MB)
#   tools/make-payloads.sh --archives        the .zim files (hard linked)
#   tools/make-payloads.sh --all
#
#   --zstd            use zstd instead of gzip: smaller and much faster to
#                     pack and unpack, but absent from a stock macOS and
#                     a minimal Linux, and no tar can substitute for it
#   --gzip            the default, named for symmetry
#   --part SIZE       split size, default 5G
#   --stage DIR       default downloads/alpacalips, inside the tree
#   --db DIR          the database to package, default $LIPS/build/corpus.
#                     Used to stage a small test payload from a mini
#                     corpus so setup.sh can be exercised end to end.
#   --copy            copy the archives instead of hard linking them.
#                     Only needed when the staging tree is on another
#                     filesystem from zim/, where a hard link is
#                     impossible; it costs ~530 GB.
#   --dry-run         show what would be built and how big
#   --sha             compute a .sha256 for any archive the POOL has no
#                     recorded hash for. The pool's own sidecars, written
#                     when each archive was verified, are published
#                     either way and cost a link. Off by default:
#                     hashing what is left can double the run,
#                     and MANIFEST already carries each file's size, which
#                     is enough for setup.sh to catch a truncated copy.
#
# WHY GZIP BY DEFAULT: the payload has to be readable on a machine with
# nothing installed. Measured on both platforms this targets, GNU tar and
# Apple's bsdtar both run the zstd binary rather than decoding zstd
# themselves, so a stock macOS or minimal Linux cannot open a .tar.zst at
# all -- while /usr/bin/gzip and a zlib-linked bsdtar are always there.
# The price, measured on 2 GiB of corpus.tbl: ratio 3.39x against 3.81x,
# and decode at 75 MiB/s of input against 304 MiB/s, so an install is
# ~27 min rather than ~18 on fast hardware and ~75 rather than ~33 on an
# old x86. Packing is single-threaded here (no pigz), so a full corpus
# republish is ~1.8 h against ~25 min. --zstd restores the old behaviour
# for a mirror that knows its audience has it.
#
# SPLIT, not one file: a 100 GB object is awkward to host and awkward to
# resume. Parts are listed in MANIFEST in order and streamed back through
# the decompressor with `cat`, so no reassembled copy is ever written.
#
# ARCHIVES ARE NOT TARRED. A .zim is already compressed -- zstd inside
# the container -- so a tar.gz of 530 GB of them buys nothing and costs
# one unresumable object. They are published individually with a
# MANIFEST, which also lets a user take only the collections they want.
#
# HARD LINKED BY DEFAULT. Everything is in one tree now, so staging an
# archive costs no disk and no time, and the result behaves like real
# files: tar packs them, rsync sends them, a web server serves them,
# nothing has to dereference anything. --copy is for the one case a
# hard link cannot cover, a staging tree on another filesystem, and
# then the run is restartable: a file already staged at the same size
# is skipped.
set -u
LIPS=${LIPS:-$(cd "$(dirname "$0")/.." && pwd)}
DB=$LIPS/build/corpus
# The archives, where they live and are served from. Not a zim/ farm of
# links into a pool: there is no pool and there are no links.
ZIMDIR=${KIWIX:-$LIPS/zim}
PART=5G
# gzip, because a stock macOS and a minimal Linux can both unpack it with
# nothing installed, and neither can unpack zstd: both tars shell out to
# the zstd binary. --zstd is there for a mirror whose audience has it.
COMP=gzip
DO_CORPUS=0 DO_KIWIX=0 DO_ARCHIVES=0 DO_RUNTIME=0 DO_NEWS=0 DRY=0 SHA=0 COPY=0
NEWSDB=$LIPS/build/news
NEWSZIM=$LIPS/build/news-src/out
NAME=alpacalips
# Inside the tree, beside what the build fetched, and the directory the
# server publishes from. --stage moves it. Set after NAME, which it uses.
STAGE=${STAGE:-$LIPS/downloads/$NAME}

while [ $# -gt 0 ]; do
    case "$1" in
        --corpus)   DO_CORPUS=1; shift ;;
        --kiwix)    DO_KIWIX=1; shift ;;
        --runtime)  DO_RUNTIME=1; shift ;;
        --news)     DO_NEWS=1; shift ;;
        --archives) DO_ARCHIVES=1; shift ;;
        --all)      DO_CORPUS=1; DO_KIWIX=1; DO_ARCHIVES=1; DO_RUNTIME=1;
                    DO_NEWS=1; shift ;;
        --gzip)     COMP=gzip; shift ;;
        --zstd)     COMP=zstd; shift ;;
        --part)     PART="$2"; shift 2 ;;
        --stage)    STAGE="$2"; shift 2 ;;
        --db)       DB="$2"; shift 2 ;;
        --dry-run)  DRY=1; shift ;;
        --sha)      SHA=1; shift ;;
        --copy)     COPY=1; shift ;;
        -h|--help)  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done
[ $((DO_CORPUS+DO_KIWIX+DO_ARCHIVES+DO_RUNTIME+DO_NEWS)) -gt 0 ] || {
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

say() { printf "  %-32s %s\n" "$1" "$2"; }
human() { numfmt --to=iec "$1" 2>/dev/null || echo "$1"; }

if [ "$COMP" = zstd ]; then
    command -v zstd >/dev/null 2>&1 || { echo "zstd not found; use --gzip" >&2; exit 1; }
    CFILT="zstd -3 -T0 -c"; EXT=tar.zst
else
    CFILT="gzip -6 -c"; EXT=tar.gz
fi
# pv gives a bar and an ETA when the total is known; cat is the no-op.
if command -v pv >/dev/null 2>&1; then PVBIN=pv; else PVBIN=""; fi
progress() { if [ -n "$PVBIN" ]; then pv -s "$1" -N "$2"; else cat; fi; }

mkdir -p "$STAGE/corpus" "$STAGE/kiwix" "$STAGE/archives"
echo "staging : $STAGE"
echo "compress: $COMP (.$EXT), parts of $PART"
[ -n "$PVBIN" ] || echo "note    : pv not found, no progress bar"
echo

# ------------------------------------------------------------ runtime
# Rebuilt from source every time, not tarred from whatever happens to be
# in dist/: publishing a stale runtime beside a fresh corpus is the one
# packaging mistake nothing downstream can detect.
if [ "$DO_RUNTIME" -eq 1 ]; then
    echo "=== runtime: $NAME-run.tar.gz"
    if [ "$DRY" -eq 1 ]; then
        say "would run" "tools/make-dist.sh --name $NAME, then tar dist/$NAME"
    else
        bash "$LIPS/tools/make-dist.sh" --name "$NAME" >/dev/null \
          || { echo "make-dist.sh failed" >&2; exit 1; }
        T=$STAGE/$NAME-run.tar.gz
        tar -czf "$T.tmp" -C "$LIPS/dist" "$NAME" \
          && mv -f "$T.tmp" "$T" \
          || { rm -f "$T.tmp"; echo "tar failed" >&2; exit 1; }
        ( cd "$STAGE" && sha256sum "$NAME-run.tar.gz" > "$NAME-run.tar.gz.sha256" )
        # What the corpus holds, and what the MCP server tells a client:
        # readable before committing to the download, and generated from
        # the corpus rather than written by hand.
        rampart "$LIPS/tools/publish-inventory.js" --db "$DB" --out "$STAGE" \
            || say "note" "could not publish the inventory"
        say "built" "$(basename "$T"), $(du -h "$T" | cut -f1)"
        say "setup.sh" "$(grep -c . "$LIPS/dist/$NAME/setup.sh") lines, from this tree"
    fi
    echo
fi

# --------------------------------------------------------------- news
# Two separate files on purpose: the table is what every install needs
# and is small enough to re-fetch daily, while the zim is only useful to
# an install that already has archives and a kiwix to serve them. A
# corpus-only user should not download 60 MB of pictures to get the news.
#
# The table ships as a tar of the database DIRECTORY, because replacing
# it wholesale is how a refresh is meant to happen -- the server notices
# the new files and reopens.
if [ "$DO_NEWS" -eq 1 ]; then
    echo "=== news: the table, and the zim for installs with archives"
    mkdir -p "$STAGE/news"
    if [ ! -d "$NEWSDB" ]; then
        say "skipped" "no news database at $NEWSDB"
    elif [ "$DRY" -eq 1 ]; then
        say "would pack" "$(du -sh "$NEWSDB" | cut -f1) from $NEWSDB"
    else
        NT=$STAGE/news/news.$EXT
        ( cd "$(dirname "$NEWSDB")" && tar -cf - "$(basename "$NEWSDB")" ) \
          | $CFILT > "$NT.tmp" && mv -f "$NT.tmp" "$NT"
        ( cd "$STAGE/news" && sha256sum "news.$EXT" | awk '{print $1}' > "news.$EXT.sha256" )
        # A different compressor means a different name, so drop the
        # payload the last format left: the MANIFEST would not list it and
        # nothing would ever delete it.
        ( cd "$STAGE/news" && for o in news.tar.*; do
              case "$o" in *.sha256) continue ;; esac
              [ "$o" = "news.$EXT" ] && continue
              rm -f "$o" "$o.sha256"
              say "removed" "$o (previous format)"
          done )
        say "table" "$(du -h "$NT" | cut -f1)"
        # The newest built zim, by name: the window is in the filename.
        NZ=$(ls -1 "$NEWSZIM"/wikipedia_en_news_*.zim 2>/dev/null | sort | tail -1)
        if [ -n "$NZ" ]; then
            cp -f "$NZ" "$STAGE/news/$(basename "$NZ").tmp"
            mv -f "$STAGE/news/$(basename "$NZ").tmp" "$STAGE/news/$(basename "$NZ")"
            ( cd "$STAGE/news" && sha256sum "$(basename "$NZ")" | awk '{print $1}' \
                > "$(basename "$NZ").sha256" )
            # One window on the server, not a growing archive of them:
            # the filename changes with the window, so without this the
            # directory keeps every day's zim and the MANIFEST lists
            # them all.
            ( cd "$STAGE/news" && for o in wikipedia_en_news_*.zim; do
                  [ -f "$o" ] || continue
                  [ "$o" = "$(basename "$NZ")" ] && continue
                  rm -f "$o" "$o.sha256"
                  say "removed" "$o (superseded window)"
              done )
            say "zim" "$(basename "$NZ") $(du -h "$NZ" | cut -f1)"
        else
            say "zim" "none built yet"
        fi
        # Same "<name> <bytes>" MANIFEST as everything else, written
        # whole so a half-written one cannot be read.
        ( cd "$STAGE/news" && for f in news.tar.* wikipedia_en_news_*.zim; do
              case "$f" in *.sha256) continue ;; esac
              [ -f "$f" ] || continue
              printf '%s %s\n' "$f" "$(stat -c %s "$f")"
          done > MANIFEST.tmp && mv MANIFEST.tmp MANIFEST )
        # The window, so a client can say what it is about to install
        # without unpacking it first.
        if [ -f "$NZ.meta.json" ]; then cp -f "$NZ.meta.json" "$STAGE/news/window.json"; fi
        say "manifest" "$(wc -l < "$STAGE/news/MANIFEST") files"
    fi
    echo
fi

# ------------------------------------------------------------- corpus
if [ "$DO_CORPUS" -eq 1 ]; then
    echo "=== corpus: corpus* + SYS*.tbl"
    cd "$DB" || { echo "no $DB" >&2; exit 1; }
    # SYS*.tbl is the catalog: without it the table files are unreadable,
    # which is the gap the earlier backup/ had.
    # corpus_cx* not corpus_cx.*: the delta tiers are corpus_cx_D.btr,
    # corpus_cx_T.btr and corpus_cx_P.tbl -- underscore, not dot, so a
    # dot glob silently drops them.
    # lips_sources and corpus_merged are NOT optional: the app reads them
    # for the collection list, the tiers and every citation URL, and
    # without them a search dies with "No such table: lips_sources".
    FILES=$(ls -1 corpus.tbl corpus_cx* corpus_src.btr corpus_ttl.btr \
                  lips_sources* corpus_merged* SYS*.tbl 2>/dev/null)
    [ -n "$FILES" ] || { echo "no corpus files in $DB" >&2; exit 1; }
    TOT=$(du -cb $FILES | tail -1 | cut -f1)
    say "files" "$(echo "$FILES" | wc -l)"
    say "raw size" "$(human "$TOT")"
    say "parts" "$(basename "$STAGE")/corpus/corpus.$EXT.part-*"
    if [ "$DRY" -eq 1 ]; then
        echo "$FILES" | sed 's/^/      /'
    else
        rm -f "$STAGE/corpus/corpus.$EXT.part-"* "$STAGE/corpus/MANIFEST"
        tar -cf - $FILES \
          | progress "$TOT" "corpus" \
          | $CFILT \
          | split -b "$PART" -d -a 3 --additional-suffix="" \
                  - "$STAGE/corpus/corpus.$EXT.part-"
        # MANIFEST is "<name> <bytes>", matching the archives one, so a
        # client can sum it and check free space BEFORE starting a 112 GB
        # download. Written to a temp file and renamed: hashing 112 GB
        # takes minutes, and a half-written MANIFEST read by setup.sh
        # would silently fetch a partial corpus.
        ( cd "$STAGE/corpus" && for f in corpus.$EXT.part-*; do
              case "$f" in *.sha256) continue ;; esac
              sha256sum "$f" | awk '{print $1}' > "$f.sha256"
              printf '%s %s\n' "$f" "$(stat -c %s "$f")"
          done > MANIFEST.tmp && mv MANIFEST.tmp MANIFEST )
        # An identity for this corpus, so an install can tell whether the
        # one it holds is the one being served. The MANIFEST's sha covers
        # every part name and size, so any repack changes it; the figures
        # beside it are what makes a difference worth acting on legible.
        ( cd "$STAGE/corpus" && {
              printf 'manifest_sha256 %s\n' \
                  "$(sha256sum MANIFEST | awk '{print $1}')"
              printf 'packed %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
              rampart -gc 'var u = rampart.utils;
                  try {
                      var i = require("'"$LIPS"'/web/lib/corpus-inventory.js");
                      u.printf("documents %d\narchives %d\nsnapshots %s\n",
                               i.docs, i.archives, i.asof);
                  } catch (e) {}' 2>/dev/null
          } > VERSION.tmp && mv -f VERSION.tmp VERSION )
        say "version" "$(awk '/^manifest_sha256/{print substr($2,1,16)}' \
                         "$STAGE/corpus/VERSION")"
        # The uncompressed total, so the client can also check that the
        # EXTRACTED corpus will fit, not just the download.
        echo "$TOT" > "$STAGE/corpus/EXTRACTED"
        # Count MANIFEST lines, not the glob: corpus.*.part-* also matches
        # the .sha256 files written beside each part and doubles the count.
        say "built" "$(wc -l < "$STAGE/corpus/MANIFEST") parts, $(du -sh "$STAGE/corpus" | cut -f1)"
    fi
    echo
fi

# -------------------------------------------------------------- kiwix
# The kiwix-tools builds, mirrored from upstream. This used to tar up
# THIS host's zim/bin, which no installer ever fetched -- a payload that
# only looked useful. What setup-kiwix.sh actually wants is the upstream
# tarball for its own platform, and upstream is slow.
if [ "$DO_KIWIX" -eq 1 ]; then
    echo "=== kiwix: upstream kiwix-tools builds"
    if [ "$DRY" -eq 1 ]; then
        say "would run" "tools/mirror-kiwix.sh --stage $STAGE"
    else
        bash "$LIPS/tools/mirror-kiwix.sh" --stage "$STAGE" \
          || { echo "mirror-kiwix.sh failed" >&2; exit 1; }
        if [ -f "$STAGE/kiwix/MANIFEST" ]; then
            say "built" "$(wc -l < "$STAGE/kiwix/MANIFEST") builds, $(du -sh "$STAGE/kiwix" | cut -f1)"
        fi
    fi
    echo
fi

# ----------------------------------------------------------- archives
if [ "$DO_ARCHIVES" -eq 1 ]; then
    if [ "$COPY" -eq 1 ]; then
        echo "=== archives: materialised copies, published individually"
    else
        echo "=== archives: hard linked from zim/, no disk used"
    fi
    n=0; tot=0; copied=0; skipped=0; cbytes=0
    : > "$STAGE/archives/MANIFEST.tmp"
    if [ "$COPY" -eq 1 ]; then
        free=$(df -B1 --output=avail "$STAGE" | tail -1)
        need=$(du -cbL "$ZIMDIR"/*.zim 2>/dev/null | tail -1 | cut -f1)
        say "need / free" "$(human "${need:-0}") / $(human "$free")"
        if [ "$DRY" -eq 0 ] && [ "${need:-0}" -gt "$free" ]; then
            echo "  NOT ENOUGH SPACE in $STAGE -- refusing" >&2; exit 1
        fi
    fi
    for z in "$ZIMDIR"/*.zim; do
        [ -e "$z" ] || continue
        b=$(basename "$z")
        # The news window is published under news/ by its dated name,
        # and zim/ carries it under a stable one for kiwix. Including it
        # here would ship it twice and churn this MANIFEST daily.
        [ "$b" = "wikipedia_en_news.zim" ] && continue
        sz=$(stat -Lc %s "$z" 2>/dev/null || echo 0)
        n=$((n+1)); tot=$((tot+sz))
        echo "$b $sz" >> "$STAGE/archives/MANIFEST.tmp"
        [ "$DRY" -eq 1 ] && continue
        if [ "$COPY" -eq 0 ]; then
            # NOTHING TO DO: the archive is already in the directory it
            # is served from, because that is where it was fetched. This
            # used to link it out of a pool, and fall back to copying the
            # whole 530 GB when the staging tree turned out to be on
            # another filesystem. There is no pool now, and no copy.
            :
            # The pool keeps each archive's verified hash beside it, so
            # publishing it costs a link instead of re-reading 530 GB.
            # Only where the pool has none does --sha compute one, and
            # that one is kept beside the source so it is computed once
            # ever rather than once per staging run.
            if [ -f "$src.sha256" ]; then
                ln -f "$src.sha256" "$STAGE/archives/$b.sha256" 2>/dev/null \
                    || cp -f "$src.sha256" "$STAGE/archives/$b.sha256"
            elif [ "$SHA" -eq 1 ]; then
                if sha256sum "$src" 2>/dev/null | awk '{print $1}' \
                       > "$src.sha256.tmp"; then
                    mv -f "$src.sha256.tmp" "$src.sha256"
                    ln -f "$src.sha256" "$STAGE/archives/$b.sha256" 2>/dev/null \
                        || cp -f "$src.sha256" "$STAGE/archives/$b.sha256"
                else
                    rm -f "$src.sha256.tmp"
                    sha256sum "$STAGE/archives/$b" | awk '{print $1}' \
                        > "$STAGE/archives/$b.sha256"
                fi
            fi
            copied=$((copied+1)); continue
        fi
        have=$(stat -c %s "$STAGE/archives/$b" 2>/dev/null || echo -1)
        if [ "$have" = "$sz" ]; then skipped=$((skipped+1)); continue; fi
        # Copy through pv for a per-file bar; .part then rename, so an
        # interrupted copy is never mistaken for a complete archive.
        rm -f "$STAGE/archives/$b.part"
        if [ -n "$PVBIN" ]; then
            pv -s "$sz" -N "$b" < "$z" > "$STAGE/archives/$b.part"
        else
            cp -L "$z" "$STAGE/archives/$b.part"
        fi
        mv -f "$STAGE/archives/$b.part" "$STAGE/archives/$b"
        if [ -f "$z.sha256" ]; then
            cp -f "$z.sha256" "$STAGE/archives/$b.sha256"
        elif [ "$SHA" -eq 1 ]; then
            sha256sum "$STAGE/archives/$b" | awk '{print $1}' \
                > "$STAGE/archives/$b.sha256"
        fi
        copied=$((copied+1)); cbytes=$((cbytes+sz))
    done
    mv "$STAGE/archives/MANIFEST.tmp" "$STAGE/archives/MANIFEST"
    say "archives" "$n files, $(human "$tot") total"
    if [ "$DRY" -eq 0 ]; then
        if [ "$COPY" -eq 1 ]; then
            say "this run" "$copied copied ($(human "$cbytes")), $skipped already staged"
        else
            # Count links rather than claim them: a staged entry with one
            # link is a copy, which means ln fell back and the stage is
            # not on the pool's filesystem after all.
            linked=$(find "$STAGE/archives" -maxdepth 1 -name '*.zim' \
                     -links +1 2>/dev/null | wc -l)
            say "this run" "$copied staged, $linked of $n are hard links"
            [ "$linked" -eq "$n" ] || say "note" \
                "$((n - linked)) are real copies: $STAGE is not on the pool's filesystem"
        fi
    fi
    echo
fi

echo "staged in $STAGE:"
du -sh "$STAGE"/* 2>/dev/null | sed 's/^/  /'
echo
echo "copy to the host with, e.g.:"
echo "  rsync -a --partial --progress $STAGE/ rampart.dev:/var/www/downloads/alpacalips/"
echo
echo "Every staged file is a real file or a hard link to one, so there is"
echo "nothing to dereference and no -L to remember."
