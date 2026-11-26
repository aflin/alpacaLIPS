#!/bin/bash
# Build the alpacaLIPS corpus from nothing, one stage at a time.
#
#   ./build.sh check                  what is here, what is missing
#   ./build.sh <stage> [<stage> ...]  run those stages, in this order
#   ./build.sh all                    urls through news, in order
#                                     (package and copy are not in it)
#
# STAGES
#   check    prerequisites, free space, and how far the build has got
#   urls     move the archive list on to the current dumps. Kiwix keeps
#            only the last dump or two, so a list written in October 404s
#            by December. FIRST IN `all`, and worth knowing why: it makes
#            the build want NEWER archives than the ones already
#            downloaded, which is the point of a refresh and a surprise
#            otherwise. Skip it (name the stages instead of `all`) to
#            rebuild from the material already on disk.
#   fetch    download the archives: ~570 GB, days on a home line
#   meta     read each archive's own metadata -> notes/zim-meta.json
#   import   extract and import, one archive at a time: the 210 HTML
#            archives through JSONL, then the 5 PDF collections (~2 days)
#   merge    copy the per-collection tables into `corpus` (~35 min;
#            it runs with noLocking, which needs rampart 0.7.6)
#   index    build corpus_Doc_Source_ftx, corpus_SrcPath_x, corpus_Title_x.
#            4h 49m at 51.7M rows on a 504 GiB machine: the fulltext index
#            4h 29m (3205 rows/s) and the two btrees 10 min each, so the
#            fulltext is nearly all of it.
#            THE TIME DEPENDS ON MEMORY, not on the row count alone. That
#            run held ~102 GiB resident -- about 2 GiB per million rows --
#            and built in a single pass with no intermediate merge. Below
#            roughly 100 GiB of indexMem this corpus spills and merges in
#            cycles instead, and merge I/O rather than tokenising sets the
#            pace; expect substantially longer. Check the memory before
#            trusting any duration.
#   links    put the imported archives in zim/, for kiwix to serve
#   kiwix    kiwix-tools into zim/bin, and library.xml built from zim/
#   news     the rolling news window: pages, ZIM, table (~2 h first
#            run, a minute after that)
#
#   corpus   NOT in `all`: build the corpus download payload -- 277 GB
#            read, ~115 GiB written, hours. Built in a dated directory,
#            the live one and swapped in with renames, keeping the
#            corpus-YYYY-MM-DD/, named in corpus-current.txt when it is
#            complete. Earlier payloads stay published for a week.
#   package  NOT in `all`: build the download payloads into
#            downloads/alpacalips -- the corpus in gzip parts with a
#            MANIFEST and checksums, the news, the runtime tarball, the
#            archive links, INVENTORY.txt and INSTRUCTIONS.txt
#   copy     NOT in `all`: publish what `package` built to the download
#            directory (--download-dir)
#
# OPTIONS
#   --data DIR   archives, staging and job lists
#   --db DIR     the build database
#   --download-dir DIR   where `copy` publishes the payloads
#
#                These three are remembered: each defaults to what
#                config.local.sh says, or to a directory in this tree if
#                it says nothing, and giving one writes it back to
#                config.local.sh for later runs. `./build.sh check`
#                prints all three.
#   --jobs N     parallel downloads                      (default 4)
#   --mem PCT    indexMem for the index stage            (default 70)
#   --yes        do not ask before a stage that costs hours, and accept
#                the kiwix-tools GPL-3 licence notice the kiwix stage
#                would otherwise show and wait on
#   --dry-run    print the commands a stage would run, and stop
#   --only LIST  for `package`: which payloads to build, comma
#                separated -- runtime, news, corpus, kiwix, archives.
#                All of them by default, and the corpus alone is hours
#                of compression, so publishing a new setup.sh wants
#                `package --only runtime`.
#
#   --version X.Y.Z   set the release number in VERSION at the repo root
#   --bump [part]     increment it: patch (the default), minor or major
#
#                Both write VERSION and exit without running a stage.
#                That file is plain text and meant to be edited by hand
#                too; `package` copies whatever it says into the
#                published version.txt, which is what an install
#                compares when it offers an upgrade.
#
# RE-RUNNING IS SAFE, AND IS HOW A FAILED STAGE IS RESUMED. Nothing
# repeats work: a download skips a file already the right size, the
# importer skips an archive already in lips_sources, the merge skips a
# table already in corpus_merged, the index stage skips an index already
# in SYSINDEX, and the news stage re-uses its page cache.
#
# FOR ONE LOG OF A WHOLE REBUILD, redirect the invocation:
#   ./build.sh -y import merge index links kiwix > notes/rebuild.log 2>&1
# Every stage's output goes to that file in order, and each stage also
# keeps its own notes/build-<stage>.log.
#
# Each stage also writes notes/build-<stage>.log, so a stage left running
# over a weekend can be read afterwards.
set -u

# The top of the tree: this script sits in it, beside config.sh.
LIPS=$(cd "$(dirname "$0")" && pwd)
. "$LIPS/config.sh"

# ver_ge, rampart_version and MIN_RAMPART, so the version floor here is
# the same comparison setup.sh gates on rather than a second one. It
# wants HERE set by the caller -- setup.sh and servers.sh both do -- and
# under `set -u` it exits without it.
HERE=$LIPS
[ -r "$LIPS/tools/rampart-find.sh" ] && . "$LIPS/tools/rampart-find.sh"
# 0.7.6, not 0.7.5: the merge sets noLocking on its connection and the
# index sets optimize "indexbatchbuild", and 0.7.5's sql.set() knows
# neither -- it raises, deep inside a stage. The RUNTIME floor is lower
# and lives in tools/rampart-find.sh: an install needs neither feature,
# and a 0.7.6 build writes byte-identical index files.
MIN_RAMPART=${MIN_RAMPART:-0.7.6}
# Which payloads `package` builds; --only sets it in the loop below, so
# this has to be above the loop. It was below it, which meant --only was
# parsed and then cleared, and `package --only runtime` quietly built
# everything.
PKG_ONLY=""

JOBS=4
MEM=70
YES=0
DRY=0

# The header, however long it gets: from the second line to the first
# line that is not a comment. A fixed line range -- which this was --
# silently truncates the moment anything above it grows, and it had:
# --jobs, --mem, --yes and --dry-run were all off the end.
usage() {
    awk 'NR == 1 { next }
         /^#/    { sub(/^# ?/, ""); print; next }
                 { exit }' "$0"
}

# config.local.sh holds what this machine chose: it is read by config.sh
# before any default is applied, so writing a setting there is what makes
# it stick. Comments and unrelated lines are preserved.
LOCAL=$LIPS/config.local.sh
conf_put() {   # conf_put NAME VALUE
    local n=$1 v=$2 tmp
    tmp=$(mktemp) || return 1
    if [ -f "$LOCAL" ]; then
        grep -v -e "^$n=" -e "^# $n is set by build.sh" "$LOCAL" > "$tmp"
    else
        printf '# Written by build.sh. Read by config.sh before its own\n' > "$tmp"
        printf '# defaults, so what is here wins.\n' >> "$tmp"
    fi
    printf '# %s is set by build.sh\n%s=${%s:-%s}\n' "$n" "$n" "$n" "$v" >> "$tmp"
    mv -f "$tmp" "$LOCAL"
}
PUT_DATA="" PUT_DB="" PUT_DL=""

STAGES=""
while [ $# -gt 0 ]; do
    case "$1" in
        # KIWIX is NOT re-derived from DATA: the archives live in the
        # download directory, and setting it here undid that for anyone
        # who passed --data. config.sh owns that rule; this only moves
        # DATA and the things that really are inside it.
        --data)    DATA="$2"; META=$DATA/meta
                   STAGE=$DATA/staging; PUT_DATA=$DATA; shift 2 ;;
        --db)      DB="$2"; PUT_DB=$DB; shift 2 ;;
        --download-dir) DOWNLOAD_DIR="$2"; PUT_DL=$DOWNLOAD_DIR; shift 2 ;;
        --jobs)    JOBS="$2"; shift 2 ;;
        # The release number lives in VERSION at the repo root, so it can
        # be edited by hand; these two just save the arithmetic.
        --version) printf '%s\n' "$2" > "$LIPS/VERSION"
                   echo "version set to $2"; exit 0 ;;
        --bump)    case "${2:-patch}" in
                       major|minor|patch) BUMP=${2:-patch} ;;
                       *) echo "--bump takes major, minor or patch" >&2
                          exit 1 ;;
                   esac
                   OLDV=$(head -1 "$LIPS/VERSION" 2>/dev/null | tr -d ' \t')
                   [ -n "$OLDV" ] || OLDV=0.0.0
                   NEWV=$(awk -v v="$OLDV" -v w="$BUMP" 'BEGIN {
                       n = split(v, a, ".")
                       for (i = n + 1; i <= 3; i++) a[i] = 0
                       if (w == "major") { a[1]++; a[2] = 0; a[3] = 0 }
                       else if (w == "minor") { a[2]++; a[3] = 0 }
                       else a[3]++
                       printf "%s.%s.%s", a[1], a[2], a[3] }')
                   printf '%s\n' "$NEWV" > "$LIPS/VERSION"
                   echo "version $OLDV -> $NEWV"; exit 0 ;;
        --mem)     MEM="$2"; shift 2 ;;
        --yes|-y)  YES=1; shift ;;
        --dry-run|-n) DRY=1; shift ;;
        # Which payloads `package` builds. Without it, every one --
        # which means re-gzipping the whole database to publish a new
        # 84 KB runtime tarball.
        --only)    PKG_ONLY="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        -*)        echo "build.sh: unknown option $1" >&2; exit 1 ;;
        # urls leads: it moves the archive list on to the current dumps,
        # and without it fetch works from the list on disk, so a newer
        # dump is never found and every stage after it is a no-op.
        # package and copy stay out -- publishing is its own decision.
        all)       STAGES="$STAGES urls fetch meta import merge index links kiwix news"; shift ;;
        check|urls|fetch|meta|import|merge|index|links|kiwix|news|package|copy|corpus)
                   STAGES="$STAGES $1"; shift ;;
        *)         echo "build.sh: unknown stage $1" >&2; usage >&2; exit 1 ;;
    esac
done
# A setting given on the command line is remembered, so it need not be
# repeated -- and is reported, because a silent write to config.local.sh
# would be worse than the flag it replaces.
for _p in DATA:"$PUT_DATA" DB:"$PUT_DB" DOWNLOAD_DIR:"$PUT_DL"; do
    _n=${_p%%:*}; _v=${_p#*:}
    [ -n "$_v" ] || continue
    conf_put "$_n" "$_v" \
        && printf '  %-22s %s (written to config.local.sh)\n' "$_n" "$_v"
done

# Settings alone are a complete command: `./build.sh --download-dir DIR`
# records it and stops, which is how you look at or change where things
# live without starting hours of work.
if [ -z "$STAGES" ]; then
    if [ -n "$PUT_DATA$PUT_DB$PUT_DL" ]; then exit 0; fi
    usage; exit 1
fi

# Where `copy` publishes. config.local.sh may have set it; otherwise the
# payloads stay in the tree and `copy` has nothing to do but say so.
DOWNLOAD_DIR=${DOWNLOAD_DIR:-}
# Built where they are served. The corpus parts are 115 GiB: staging
# them on the local disk and copying them to the share afterwards wrote
# 230 GiB to produce 115. With no download directory configured there is
# nowhere to serve from, so it falls back to the tree.
PAYLOADS=${DOWNLOAD_DIR:-$LIPS/downloads/alpacalips}

export LIPS DATA META KIWIX STAGE DB DOWNLOAD_DIR

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
    say "  version" "$(head -1 "$LIPS/VERSION" 2>/dev/null || echo "not set")"
    echo "  prerequisites"
    PREREQ=0
    # ENFORCED, not just printed. The floor is real: 0.7.3 runs every
    # stage and fails somewhere deeper, where the cause is no longer
    # obvious. Checked on the `rampart` that is on PATH, because that is
    # the one every stage below invokes.
    if have rampart; then
        rv=$(rampart_version "$(command -v rampart)" 2>/dev/null)
        if [ -z "$rv" ]; then
            say "  rampart" "found, but it reports no version"; PREREQ=1
        elif ver_ge "$rv" "$MIN_RAMPART"; then
            say "  rampart" "$rv"
        else
            say "  rampart" "$rv -- TOO OLD, needs $MIN_RAMPART or newer"
            PREREQ=1
        fi
    else
        say "  rampart" "MISSING -- curl -fsSL https://get.rampart.dev/ | sh"
        PREREQ=1
    fi
    for m in rampart-sql rampart-curl rampart-html; do
        if rampart -gc "require(\"$m\");" >/dev/null 2>&1
        then say "  $m" "ok"; else say "  $m" "MISSING"; PREREQ=1; fi
    done
    if have python3r; then
        if python3r -I -c 'import libzim' >/dev/null 2>&1
        then say "  python3r libzim" "ok"
        else say "  python3r libzim" "MISSING -- pip3r install libzim"
             PREREQ=1; fi
    else
        say "  python3r" "MISSING (rampart's python)"; PREREQ=1
    fi
    for c in curl zimwriterfs kiwix-manage; do
        if have "$c"; then
            say "  $c" "$(command -v "$c")"
        elif [ -x "$LIPS/zim/bin/$c" ]; then
            say "  $c" "$LIPS/zim/bin/$c (tools/setup-kiwix.sh put it there)"
        elif [ "$c" = curl ]; then
            say "  curl" "MISSING -- every download needs it"; PREREQ=1
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
    # Where this build keeps things, and who decided: a flag that is
    # remembered is only safe if it can be read back.
    printf '\n  directories\n'
    for _d in "DATA:$DATA" "DB:$DB" "DOWNLOAD_DIR:${DOWNLOAD_DIR:-}"; do
        _n=${_d%%:*}; _v=${_d#*:}
        if [ -z "$_v" ]; then
            say "  $_n" "not set -- payloads stay in $PAYLOADS"
        elif [ -f "$LOCAL" ] && grep -q "^$_n=" "$LOCAL"; then
            say "  $_n" "$_v (config.local.sh)"
        else
            say "  $_n" "$_v (default in this tree)"
        fi
    done

    if [ "$PREREQ" -ne 0 ]; then
        echo "  SOMETHING ABOVE IS MISSING OR TOO OLD. The build will fail on"
        echo "  the first stage that needs it, so fix it before starting."
        echo
        return 1
    fi
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
    # Measured order first: mkjobs.js reads what this writes, and the
    # mirrors differ by more than an order of magnitude. Advisory -- with
    # no ranking file mkjobs rotates mirrors as it always did.
    run sh "$LIPS/tools/download/rank-mirrors.sh" "$META" || true
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

    # The staging tables are not indexed: the merge scans each one once
    # and the index that matters is the one on corpus.
    run bash "$LIPS/tools/run-import.sh" --db "$DB" \
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
    # Exit 2 means the corpus is behind its tables: a table it was built
    # from is gone, or one has been re-imported since. Appending then
    # would duplicate whatever changed, so the tool refuses and this
    # decides. The merge is re-run after the drop, which is why the drop
    # is its own invocation: the log shows which step failed.
    MRC=0
    run rampart "$LIPS/tools/merge-into-corpus.js" --db "$DB" --go || MRC=$?
    if [ "$MRC" -eq 2 ]; then
        confirm "corpus is behind its tables: drop it and merge all of them again (~3 h)." \
            || return 0
        run rampart "$LIPS/tools/merge-into-corpus.js" --db "$DB" \
            --rebuild --go || die "could not drop the corpus"
        run rampart "$LIPS/tools/merge-into-corpus.js" --db "$DB" --go \
            || die "the re-merge failed"
    elif [ "$MRC" -ne 0 ]; then
        die "merge-into-corpus.js failed ($MRC)"
    fi

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
    run rampart "$LIPS/tools/corpus-index.js" --db "$DB" "$MEM" \
        || die "the index build failed -- do not package this database"

    # VERIFY, do not trust the exit status. A fulltext build killed part
    # way through leaves the index registered in SYSINDEX with an empty
    # .dat: every query then matches nothing and raises no error. Check
    # that all three exist AND that a term that must match does.
    local have miss hits
    have=$(rampart "$LIPS/tools/corpus-index.js" --db "$DB" --list 2>/dev/null)
    miss=""
    for ix in corpus_Doc_Source_ftx corpus_SrcPath_x corpus_Title_x; do
        printf '%s' "$have" | grep -q "$ix" || miss="$miss $ix"
    done
    [ -z "$miss" ] || die "missing after the build:$miss"
    hits=$(rampart -gc 'var S=require("rampart-sql"), u=rampart.utils;
        var s = new S.init("'"$DB"'"); var n = 0;
        s.exec("select Title from corpus where Doc likep ?;",
               ["photosynthesis"], { maxRows: 5 }, function () { n++; });
        u.printf("%d", n);' 2>/dev/null)
    [ "${hits:-0}" -gt 0 ] \
        || die "the index answers nothing for a term that must match -- it is empty"
    say "verified" "three indexes present, and they answer"
}

# ------------------------------------------------------------------ links
stage_links() {
    head_ "links"
    LOG=$NOTES/build-links.log
    [ -f "$DB/lips_sources.tbl" ] \
        || die "nothing imported yet -- there is no manifest to link from"
    # No links: the archives are already in the directory they are
    # served from. What is left worth doing is confirming that every
    # archive the corpus was built from is there, and the right size,
    # before kiwix is told to serve them.
    run rampart "$LIPS/tools/zim-verify.js"
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
stage_package() {
    head_ "package"
    LOG=$NOTES/build-package.log
    [ -f "$DB/corpus.tbl" ] || die "no corpus at $DB -- nothing to package"
    # Everything a download needs, into the tree. --sha hashes what has no
    # published checksum yet; the archives cost links rather than copies
    # when the payload directory and the pool share a filesystem.
    # --only maps onto make-payloads' section flags; nothing given
    # means --all, as before.
    # Everything except the corpus, which has its own stage: this one is
    # meant to be cheap enough to run whenever setup.sh changes.
    PKGFLAGS="--runtime --news --kiwix --archives"
    if [ -n "$PKG_ONLY" ]; then
        PKGFLAGS=""
        for sec in $(echo "$PKG_ONLY" | tr ',' ' '); do
            case "$sec" in
                runtime|news|corpus|kiwix|archives)
                    PKGFLAGS="$PKGFLAGS --$sec" ;;
                *) die "--only: unknown payload $sec (runtime, news, corpus, kiwix, archives)" ;;
            esac
        done
        say "only" "$PKG_ONLY"
    fi
    run bash "$LIPS/tools/make-payloads.sh" $PKGFLAGS --sha --stage "$PAYLOADS" \
        || die "make-payloads.sh failed"
    say "packaged" "$PAYLOADS"
    [ -n "$DOWNLOAD_DIR" ] \
        && say "next" "./build.sh copy  -> $DOWNLOAD_DIR" \
        || say "next" "./build.sh copy --download-dir DIR"
}

# The corpus payload: 277 GB read, ~115 GiB written, hours. Separate
# from `package` because it is the only expensive one, and because it
# replaces what the server is publishing -- which make-payloads does by
# writing a dated directory and naming it in corpus-current.txt when it
# is finished -- never by renaming or deleting what is being served.
stage_corpus() {
    head_ "corpus"
    LOG=$NOTES/build-corpus.log
    [ -f "$DB/corpus.tbl" ] || die "no corpus table -- run the merge stage"
    [ -n "$PAYLOADS" ] || die "no payload directory"
    confirm "packaging the corpus reads 277 GB and writes ~115 GiB (hours)." \
        || return 0
    run bash "$LIPS/tools/make-payloads.sh" --corpus --sha --stage "$PAYLOADS"
}

stage_copy() {
    head_ "copy"
    LOG=$NOTES/build-copy.log
    [ -n "$DOWNLOAD_DIR" ] \
        || die "no download directory: pass --download-dir DIR once and it is remembered"
    [ -d "$PAYLOADS" ] && [ -n "$(ls -A "$PAYLOADS" 2>/dev/null)" ] \
        || die "nothing packaged yet: run ./build.sh package first"
    mkdir -p "$DOWNLOAD_DIR" || die "cannot create $DOWNLOAD_DIR"
    # Payloads are built where they are served, so these are usually the
    # same directory and there is nothing to copy. rsync of a directory
    # onto itself with --delete is not something to find out by running.
    if [ "$(cd "$PAYLOADS" 2>/dev/null && pwd -P)" = \
         "$(cd "$DOWNLOAD_DIR" 2>/dev/null && pwd -P)" ]; then
        say "nothing to copy" "payloads are written in $DOWNLOAD_DIR already"
        return 0
    fi
    say "from" "$PAYLOADS"
    say "to" "$DOWNLOAD_DIR"
    say "size" "$(du -sh "$PAYLOADS" 2>/dev/null | cut -f1)"
    confirm "copy publishes the payloads, replacing what is served now." || return 0
    if command -v rsync >/dev/null 2>&1; then
        # --partial so an interrupted copy resumes; --delete so a payload
        # the build no longer produces stops being served.
        run rsync -a --partial --delete "$PAYLOADS/" "$DOWNLOAD_DIR/" \
            || die "rsync failed"
    else
        run cp -R "$PAYLOADS/." "$DOWNLOAD_DIR/" || die "cp failed"
    fi
    say "published" "$(du -sh "$DOWNLOAD_DIR" 2>/dev/null | cut -f1) in $DOWNLOAD_DIR"
}

stage_news() {
    head_ "news"
    LOG=$NOTES/build-news.log
    [ -f "$DB/corpus.tbl" ] || die "no corpus -- the news window is measured from it"
    # news-zim.js asks the corpus, once per candidate article, whether it
    # already holds that page. Through the SrcPath btree those are
    # lookups; without it each one scans 200 GB, and a cold window asks
    # 7,000 times. Refuse rather than crawl.
    [ -f "$DB/corpus_SrcPath_x.btr" ] \
        || die "the news stage needs the SrcPath index: run ./build.sh index first"
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

# Only check returns a status worth propagating -- every other stage
# calls die() on failure. A non-zero exit lets check gate a script.
# The floor, before anything runs. stage_check does its own reporting
# and must keep working on an old rampart in order to say so, but every
# other stage would otherwise fail somewhere deeper: on 0.7.5 the merge
# raises on sql.set({noLocking}) and the index on optimize.
for s in $STAGES; do
    [ "$s" = "check" ] && continue
    if have rampart; then
        rv=$(rampart_version "$(command -v rampart)" 2>/dev/null)
        if [ -n "$rv" ] && ! ver_ge "$rv" "$MIN_RAMPART"; then
            echo "rampart $rv is too old for the build: $MIN_RAMPART or" \
                 "newer is needed." >&2
            echo "  the merge needs sql.set({noLocking}) and the index" \
                 "needs optimize 'indexbatchbuild'." >&2
            echo "  ./build.sh check reports what it finds; the runtime" \
                 "still installs on 0.7.5." >&2
            exit 1
        fi
    fi
    break
done

RC=0
for s in $STAGES; do
    case "$s" in
        check)  stage_check || RC=1 ;;
        urls)   stage_urls ;;
        fetch)  stage_fetch ;;
        meta)   stage_meta ;;
        import) stage_import ;;
        merge)  stage_merge ;;
        index)  stage_index ;;
        links)  stage_links ;;
        kiwix)  stage_kiwix ;;
        news)   stage_news ;;
        package) stage_package ;;
        corpus) stage_corpus ;;
        copy)   stage_copy ;;
    esac
done
printf '\n=== build.sh done  %s\n' "$(date '+%F %T')"
exit $RC
