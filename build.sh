#!/bin/bash
# Build the alpacaLIPS corpus from nothing, one stage at a time.
#
#   ./build.sh check                  what is here, what is missing
#   ./build.sh <stage> [<stage> ...]  run those stages, in this order
#   ./build.sh all                    every stage below, in order
#
# STAGES
#   check    prerequisites, free space, and how far the build has got
#   fetch    download the archives: ~570 GB, days on a home line
#   meta     read each archive's own metadata -> notes/zim-meta.json
#   import   extract and import, one archive at a time: the 210 HTML
#            archives through JSONL, then the 5 PDF collections (~2 days)
#   merge    copy the per-collection tables into `corpus` (~3 h)
#   index    build corpus_cx, corpus_src, corpus_ttl (~12 h)
#   links    put the imported archives in zim/, for kiwix to serve
#   kiwix    kiwix-tools into zim/bin, and library.xml built from zim/
#   news     the rolling news window: pages, ZIM, table (~2 h first
#            run, a minute after that)
#
#   urls     NOT in `all`: move the archive list on to the current dumps.
#            Kiwix keeps only the last dump or two, so a list written in
#            October 404s by December. Refreshing it makes the build want
#            NEWER archives than the ones already downloaded, so run it
#            deliberately -- on a fresh machine before `fetch`, or when
#            rebuilding the corpus from current material.
#
# OPTIONS
#   --data DIR   archives, staging and job lists         (default $DATA)
#   --db DIR     the build database                      (default build/corpus)
#   --jobs N     parallel downloads                      (default 4)
#   --mem PCT    indexMem for the index stage            (default 70)
#   --yes        do not ask before a stage that costs hours, and accept
#                the kiwix-tools GPL-3 licence notice the kiwix stage
#                would otherwise show and wait on
#   --dry-run    print the commands a stage would run, and stop
#
# RE-RUNNING IS SAFE, AND IS HOW A FAILED STAGE IS RESUMED. Nothing
# repeats work: a download skips a file already the right size, the
# importer skips an archive already in lips_sources, the merge skips a
# table already in corpus_merged, the index stage skips an index already
# in SYSINDEX, and the news stage re-uses its page cache.
#
# Each stage also writes notes/build-<stage>.log, so a stage left running
# over a weekend can be read afterwards.
set -u

# The top of the tree: this script sits in it, beside config.sh.
LIPS=$(cd "$(dirname "$0")" && pwd)
. "$LIPS/config.sh"

JOBS=4
MEM=70
YES=0
DRY=0

usage() { sed -n '2,44p' "$0" | sed 's/^# \{0,1\}//'; }

STAGES=""
while [ $# -gt 0 ]; do
    case "$1" in
        --data)    DATA="$2"; META=$DATA/meta; KIWIX=$DATA/kiwix
                   STAGE=$DATA/staging; shift 2 ;;
        --db)      DB="$2"; shift 2 ;;
        --jobs)    JOBS="$2"; shift 2 ;;
        --mem)     MEM="$2"; shift 2 ;;
        --yes|-y)  YES=1; shift ;;
        --dry-run|-n) DRY=1; shift ;;
        -h|--help) usage; exit 0 ;;
        -*)        echo "build.sh: unknown option $1" >&2; exit 1 ;;
        all)       STAGES="$STAGES fetch meta import merge index links kiwix news"; shift ;;
        check|urls|fetch|meta|import|merge|index|links|kiwix|news)
                   STAGES="$STAGES $1"; shift ;;
        *)         echo "build.sh: unknown stage $1" >&2; usage >&2; exit 1 ;;
    esac
done
[ -n "$STAGES" ] || { usage; exit 1; }

export LIPS DATA META KIWIX STAGE DB

NOTES=$LIPS/notes
mkdir -p "$NOTES" || exit 1

say()  { printf '  %-22s %s\n' "$1" "$2"; }
head_() { printf '\n=== %s  %s\n' "$1" "$(date '+%F %T')"; }
die()  { echo "build.sh: $*" >&2; exit 1; }

# Everything a stage runs goes through here: echoed, timed, and tee'd to
# the stage log. --dry-run stops at the echo.
LOG=/dev/null
run() {
    printf '+ %s\n' "$*"
    [ "$DRY" -eq 1 ] && return 0
    "$@" 2>&1 | tee -a "$LOG"
    return "${PIPESTATUS[0]}"
}

# Asked once per long stage, and only with a terminal to answer on.
confirm() {
    [ "$YES" -eq 1 ] && return 0
    [ "$DRY" -eq 1 ] && return 0
    [ -t 0 ] || die "$1 needs a terminal to confirm on, or --yes"
    printf '%s  Continue? [y/N] ' "$1"
    read -r a
    case "$a" in y|Y|yes|YES) return 0 ;; *) echo "skipped"; return 1 ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ check
stage_check() {
    head_ "check"
    say "tree"      "$LIPS"
    say "archives"  "$KIWIX"
    say "staging"   "$STAGE"
    say "database"  "$DB"
    echo
    echo "  prerequisites"
    if have rampart; then
        say "  rampart" "$(rampart -v 2>&1 | head -1)"
    else
        say "  rampart" "MISSING -- curl -fsSL https://get.rampart.dev/ | sh"
    fi
    for m in rampart-sql rampart-curl rampart-html; do
        if rampart -gc "require(\"$m\");" >/dev/null 2>&1
        then say "  $m" "ok"; else say "  $m" "MISSING"; fi
    done
    if have python3r; then
        if python3r -I -c 'import libzim' >/dev/null 2>&1
        then say "  python3r libzim" "ok"
        else say "  python3r libzim" "MISSING -- pip3r install libzim"; fi
    else
        say "  python3r" "MISSING (rampart's python)"
    fi
    for c in curl zimwriterfs kiwix-manage; do
        if have "$c"; then
            say "  $c" "$(command -v "$c")"
        elif [ -x "$LIPS/zim/bin/$c" ]; then
            say "  $c" "$LIPS/zim/bin/$c (tools/setup-kiwix.sh put it there)"
        elif [ "$c" = curl ]; then
            say "  curl" "MISSING -- every download needs it"
        else
            say "  $c" "missing -- ./build.sh kiwix installs it in zim/bin"
        fi
    done

    echo
    echo "  space"
    df -h "$LIPS" "$DATA" 2>/dev/null | grep -v '^Filesystem' |
        while read -r fs size used avail pct mount; do
            say "  $mount" "$avail free of $size"
        done
    echo "  the full build needs ~570 GB of archives, up to ~1.7 TB of"
    echo "  staging, and ~800 GB of database. Staging can be dropped as it"
    echo "  goes (tools/run-import.sh --delete-staging) if that is tight."

    echo
    echo "  progress"
    if [ -d "$KIWIX" ]; then
        n=$(ls -1 "$KIWIX"/*.zim 2>/dev/null | wc -l)
        say "  pool" "$n archive(s), $(du -sh "$KIWIX" 2>/dev/null | cut -f1)"
    else
        say "  pool" "not downloaded yet"
    fi
    [ -f "$NOTES/zim-meta.json" ] \
        && say "  zim-meta.json" "$(date -r "$NOTES/zim-meta.json" '+%F')" \
        || say "  zim-meta.json" "not built yet"
    if [ -f "$DB/lips_sources.tbl" ]; then
        rampart "$LIPS/tools/src-status.js" --db "$DB" 2>/dev/null |
            tail -1 | sed 's/^ */  /'
    else
        say "  import" "nothing imported yet"
    fi
    if [ -f "$DB/corpus_merged.tbl" ]; then
        rampart "$LIPS/tools/merge-status.js" --db "$DB" 2>/dev/null |
            grep -e '^corpus now' -e '^merged tables' | sed 's/^/  /'
    fi
    if [ -f "$DB/corpus.tbl" ]; then
        rampart "$LIPS/tools/corpus-index.js" --db "$DB" --list 2>/dev/null |
            sed 's/^/  /'
    fi
    if [ -f "$LIPS/build/news/news.tbl" ]; then
        say "  news" "$(du -sh "$LIPS/build/news" | cut -f1) in build/news"
    else
        say "  news" "not built yet"
    fi
    echo
}

# ------------------------------------------------------------------- urls
stage_urls() {
    head_ "urls"
    LOG=$NOTES/build-urls.log
    confirm "Moving the list on means the build wants newer archives than the pool holds." \
        || return 0
    run bash "$LIPS/tools/download/refresh-urls.sh"
}

# ------------------------------------------------------------------ fetch
stage_fetch() {
    head_ "fetch"
    LOG=$NOTES/build-fetch.log
    [ "$DRY" -eq 1 ] || mkdir -p "$META" "$KIWIX" \
        || die "cannot create $META / $KIWIX"
    confirm "fetch downloads ~570 GB and takes days on a home line." || return 0

    # Three pools, because the material comes from three places: the
    # kiwix catalogue's Metalinks (hash-verified), the maxi flavours
    # fetched from a fast mirror, and gutenberg, which only
    # download.kiwix.org carries.
    run rampart "$LIPS/tools/download/mkjobs.js" --kiwix || die "mkjobs failed"
    run bash "$LIPS/tools/download/fetch.sh" kiwix /kiwix/ "$JOBS"
    run rampart "$LIPS/tools/download/maxijobs.js" || die "maxijobs failed"
    run bash "$LIPS/tools/download/fetch-maxi.sh"
    export POOL=$KIWIX
    run bash "$LIPS/tools/get-gutenberg.sh"

    echo
    echo "  anything missing or the wrong size:"
    run rampart "$LIPS/tools/download/incomplete.js"
    echo "  a 404 here means the dump has rotated upstream:"
    echo "  ./build.sh urls moves the list on to the current one."
}

# ------------------------------------------------------------------- meta
stage_meta() {
    head_ "meta"
    LOG=$NOTES/build-meta.log
    [ -d "$KIWIX" ] || die "no archive pool at $KIWIX -- run the fetch stage"
    # Every pool directory present, so a second pool (a fast-mirror copy,
    # say) is indexed too. The importer and families.js both read this.
    dirs=$KIWIX
    for d in "$DATA"/kiwix-*; do [ -d "$d" ] && dirs="$dirs $d"; done
    run python3r -I "$LIPS/extract/zim-meta.py" "$NOTES/zim-meta.json" $dirs
}

# ----------------------------------------------------------------- import
stage_import() {
    head_ "import"
    LOG=$NOTES/build-import.log
    [ -f "$NOTES/zim-meta.json" ] || die "no notes/zim-meta.json -- run the meta stage"

    # The work list is derived, not kept: it is whatever families.js
    # picks minus whatever lips_sources already has, smallest first, with
    # Stack Overflow last because it is 107 GB on its own.
    WL=$NOTES/worklist.txt
    [ "$DRY" -eq 1 ] && WL=$NOTES/worklist.dry.txt
    rampart "$LIPS/import/worklist.js" --db "$DB" > "$WL.new" \
        || die "worklist.js failed"
    mv -f "$WL.new" "$WL"
    grep -e '^#' "$WL" | sed 's/^/  /'
    n=$(grep -c -v '^#' "$WL")
    [ "$n" -gt 0 ] || { echo "  nothing left to import"; return 0; }
    confirm "import runs $n archive(s) and takes about two days." || return 0

    # --no-index: mkindex would fulltext-index every staging table, for
    # indexes the merge then discards. The corpus gets its own.
    run bash "$LIPS/tools/run-import.sh" --db "$DB" --no-index \
        $(grep -v '^#' "$WL") || die "run-import.sh failed"

    pdf_pass || die "the PDF import failed"
}

# The nautiluszim archives: file collections whose content is PDFs, not
# HTML, so families.js leaves them out of the work list above and they
# come in through extract/zim2pdf.py and import/pdf-import.js. Five
# archives, 155 PDFs, 107 distinct documents.
pdf_pass() {
    local z b out first="" last=""
    for z in "$KIWIX"/zimgit-*.zim; do
        [ -e "$z" ] || continue
        # post-disaster re-ships copies from the other four. Duplicates
        # are skipped by content hash and the first import of a book
        # keeps the better title and Site, so the specific collections
        # go in before the catch-all bundle.
        case "${z##*/}" in
            *post-disaster*) last="$last $z" ;;
            *)               first="$first $z" ;;
        esac
    done
    if [ -z "$first$last" ]; then
        say "pdf archives" "none in the pool"
        return 0
    fi
    for z in $first $last; do
        b=${z##*/}; b=${b%.zim}
        out=$STAGE/$b-pdf
        if [ -s "$out/manifest.json" ]; then
            say "staged already" "$b"
        else
            run python3r -I "$LIPS/extract/zim2pdf.py" "$z" "$out" \
                || return 1
        fi
        run rampart "$LIPS/import/pdf-import.js" --db "$DB" --dir "$out" \
            || return 1
    done
}

# ------------------------------------------------------------------ merge
stage_merge() {
    head_ "merge"
    LOG=$NOTES/build-merge.log
    [ -f "$DB/lips_sources.tbl" ] || die "nothing imported yet"
    run rampart "$LIPS/tools/merge-into-corpus.js" --db "$DB" --list
    confirm "merge copies every outstanding table into corpus (~3 h)." || return 0
    run rampart "$LIPS/tools/merge-into-corpus.js" --db "$DB" --go

    # The MCP server opens its instructions with a description of the
    # corpus. Written here, from lips_sources, because this is where that
    # table becomes final -- and because a server should not count its own
    # catalogue to describe itself. A stale sentence is not cosmetic: the
    # hardcoded one claimed 171 archives and never mentioned Gutenberg or
    # Wikibooks, so two collections were invisible to every model.
    run rampart "$LIPS/tools/make-instructions.js" --db "$DB" \
        || say "note" "could not write web/lib/corpus-inventory.js"
}

# ------------------------------------------------------------------ index
stage_index() {
    head_ "index"
    LOG=$NOTES/build-index.log
    [ -f "$DB/corpus.tbl" ] || die "no corpus table -- run the merge stage"
    run rampart "$LIPS/tools/corpus-index.js" --db "$DB" --list
    confirm "index builds the fulltext index over ~50M documents (~12 h)." || return 0
    # An index already in SYSINDEX is skipped, so this resumes: it is the
    # one that was interrupted which needs --rebuild to fold in the rest.
    run rampart "$LIPS/tools/corpus-index.js" --db "$DB" "$MEM"
}

# ------------------------------------------------------------------ links
stage_links() {
    head_ "links"
    LOG=$NOTES/build-links.log
    [ -f "$DB/lips_sources.tbl" ] \
        || die "nothing imported yet -- there is no manifest to link from"
    # zim/ holding links rather than copies is what makes flavor 2 cost
    # nothing: the archives stay in the pool and kiwix serves them there.
    run rampart "$LIPS/tools/zim-link.js"
}

# ------------------------------------------------------------------ kiwix
stage_kiwix() {
    head_ "kiwix"
    LOG=$NOTES/build-kiwix.log
    # The archives are served by kiwix-serve, and library.xml -- which the
    # news stage adds its own ZIM to -- is maintained with kiwix-manage.
    # Both go in zim/bin: nothing is installed outside the tree.
    if have kiwix-manage || [ -x "$LIPS/zim/bin/kiwix-manage" ]; then
        say "kiwix-tools" "already here"
    elif [ "$YES" -eq 1 ]; then
        run bash "$LIPS/tools/setup-kiwix.sh" --accept-license --no-keep \
            || die "kiwix-tools install failed"
    else
        # Without --yes it shows the GPL-3 notice and asks.
        run bash "$LIPS/tools/setup-kiwix.sh" \
            || die "kiwix-tools install failed"
    fi
    # Fatal: `all` runs links before this, so an empty zim/ here means
    # something earlier went wrong, and carrying on would build the news
    # window with no library to add its ZIM to.
    run bash "$LIPS/tools/zim-serve.sh" library \
        || die "library.xml was not built"
    echo "  to serve the archives:  tools/zim-serve.sh start"
}

# ------------------------------------------------------------------- news
stage_news() {
    head_ "news"
    LOG=$NOTES/build-news.log
    [ -f "$DB/corpus.tbl" ] || die "no corpus -- the news window is measured from it"
    have zimwriterfs || die "zimwriterfs not found (zim-tools); the news ZIM needs it"
    STATE=$LIPS/build/news-src/cache/state.json
    if [ ! -f "$STATE" ]; then
        # First run walks the whole window with an empty cache: a few
        # thousand polite requests, so a couple of hours.
        confirm "the first news build fetches the whole window (~2 h, one request at a time)." \
            || return 0
        run rampart "$LIPS/import/news-zim.js" --init || die "news --init failed"
    fi
    run bash "$LIPS/tools/news-daily.sh"
    echo "  for a daily refresh, cron this one line:"
    echo "    0 5 * * *  $LIPS/tools/news-daily.sh --publish >> $NOTES/news-daily.log 2>&1"
}

for s in $STAGES; do
    case "$s" in
        check)  stage_check ;;
        urls)   stage_urls ;;
        fetch)  stage_fetch ;;
        meta)   stage_meta ;;
        import) stage_import ;;
        merge)  stage_merge ;;
        index)  stage_index ;;
        links)  stage_links ;;
        kiwix)  stage_kiwix ;;
        news)   stage_news ;;
    esac
done
printf '\n=== build.sh done  %s\n' "$(date '+%F %T')"
