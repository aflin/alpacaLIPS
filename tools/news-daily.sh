#!/bin/bash
# The daily news build, end to end. One command, safe from cron.
#
#   tools/news-daily.sh [--publish] [--no-kiwix] [--no-fetch] [--img-pause MS]
#
#   --publish    also stage the payload for download (make-payloads --news)
#   --no-kiwix   do not touch the kiwix library
#   --no-fetch   skip step 1 and rebuild from the ZIM already in out/.
#                For testing the database half without a network run, and
#                for re-running after a failure in a later step.
#
# WHAT IT DOES
#   1. news-zim.js --update   today's portal, any new or changed event
#                             pages, their images, and a rebuilt zim
#   2. a FRESH news database   zim2jsonl -> kiwix-import -> news-items.js
#   3. swap it into place      build/news replaced whole, not edited
#   4. kiwix                   relink the zim and refresh the library
#   5. --publish               stage table + zim for download
#
# WHY A FRESH DATABASE EACH TIME, rather than importing into the live
# one: kiwix-import is a staging importer that APPENDS, and the zim's
# filename carries the window end date, so every day looks like a new
# archive to it -- importing in place would add 308 more article rows a
# day to the same table. Rebuilding costs seconds and cannot drift.
#
# WHY A SWAP, rather than building in place: the running server reads
# this database. It fingerprints the files behind its handle and reopens
# when they change, so a directory that appears whole is picked up with
# no restart, where a half-written one would be read mid-write.
set -u
# This tree, from where this script sits, so cron needs no paths set.
LIPS=${LIPS:-$(cd "$(dirname "$0")/.." && pwd)}
DB=$LIPS/build/news
NEW=$LIPS/build/news.new
OUT=$LIPS/build/news-src/out
STAGE=${STAGE:-$LIPS/downloads/alpacalips}
PUBLISH=0
WITH_KIWIX=1
WITH_FETCH=1
IMGPAUSE=400

while [ $# -gt 0 ]; do
    case "$1" in
        --publish)    PUBLISH=1; shift ;;
        --no-kiwix)   WITH_KIWIX=0; shift ;;
        --no-fetch)   WITH_FETCH=0; shift ;;
        --img-pause)  IMGPAUSE="$2"; shift 2 ;;
        --stage)      STAGE="$2"; shift 2 ;;
        -h|--help)    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option $1" >&2; exit 1 ;;
    esac
done

say() { printf "  %-26s %s\n" "$1" "$2"; }
die() { echo "news-daily: $*" >&2; exit 1; }
echo "=== news build $(date '+%Y-%m-%d %H:%M:%S')"

# ---- 1. fetch and pack ----------------------------------------------
if [ "$WITH_FETCH" -eq 1 ]; then
    rampart "$LIPS/import/news-zim.js" --update --img-pause "$IMGPAUSE" \
      || die "news-zim.js failed"
else
    say "fetch" "skipped (--no-fetch)"
fi

ZIM=$(ls -1t "$OUT"/wikipedia_en_news_*.zim 2>/dev/null | head -1)
[ -n "$ZIM" ] || die "no zim was produced"
say "zim" "$(basename "$ZIM") ($(du -h "$ZIM" | cut -f1))"

# ---- 2. a fresh database --------------------------------------------
rm -rf "$NEW"; mkdir -p "$NEW" || die "cannot create $NEW"
JSONL=$OUT/news.jsonl
python3r -I "$LIPS/extract/zim2jsonl.py" "$ZIM" "$JSONL" >/dev/null \
  || die "zim2jsonl failed"
rampart "$LIPS/import/kiwix-import.js" --db "$NEW" --src "$JSONL" >/dev/null \
  || die "kiwix-import failed"
# The items, their indexes, and the articles index: news-items.js leaves
# the database complete.
rampart "$LIPS/import/news-items.js" --db "$NEW" || die "news-items.js failed"
[ -f "$NEW/news.tbl" ] && [ -f "$NEW/wikipedia_en_news.tbl" ] \
  || die "the rebuilt database is missing a table"
rm -f "$JSONL" "$JSONL.meta.json"

# ---- 3. swap it in --------------------------------------------------
rm -rf "$DB.old"
[ -d "$DB" ] && mv "$DB" "$DB.old"
mv "$NEW" "$DB" || die "could not move the new database into place"
rm -rf "$DB.old"
say "database" "$(du -sh "$DB" | cut -f1) in $DB"

# ---- 4. kiwix -------------------------------------------------------
# A rebuilt zim is a NEW FILE at the same path, and kiwix holds the old
# one open -- it keeps serving the deleted inode, and touching
# library.xml does not help because --monitorLibrary re-reads book
# definitions, not archive contents. Removing the book and adding it
# back is what makes it reopen.
if [ "$WITH_KIWIX" -eq 1 ] && [ -f "$LIPS/zim/library.xml" ]; then
    KM=""
    [ -x "$LIPS/zim/bin/kiwix-manage" ] && KM="$LIPS/zim/bin/kiwix-manage"
    command -v kiwix-manage >/dev/null 2>&1 && [ -z "$KM" ] && KM=kiwix-manage
    if [ -n "$KM" ]; then
        # A hard link, not a symlink: same tree, so it costs nothing and
        # kiwix opens it as the file it is. The stable name is what
        # library.xml records, and it is the name setup.sh installs the
        # downloaded archive under, so one entry works in both trees.
        ln -f "$ZIM" "$LIPS/zim/wikipedia_en_news.zim" 2>/dev/null \
            || cp -f "$ZIM" "$LIPS/zim/wikipedia_en_news.zim"
        OLDID=$("$KM" "$LIPS/zim/library.xml" show 2>/dev/null |
                awk '/^id:/ { id = $2 } /^path:.*wikipedia_en_news\.zim/ { print id; exit }')
        [ -n "$OLDID" ] && "$KM" "$LIPS/zim/library.xml" remove "$OLDID" >/dev/null 2>&1
        ( cd "$LIPS/zim" && "$KM" library.xml add wikipedia_en_news.zim >/dev/null 2>&1 ) \
          && say "kiwix library" "$(grep -c '<book ' "$LIPS/zim/library.xml") books, news reloaded" \
          || say "kiwix library" "could not add the zim"
    else
        say "kiwix library" "kiwix-manage not found, skipped"
    fi
fi

# ---- 5. publish -----------------------------------------------------
if [ "$PUBLISH" -eq 1 ]; then
    bash "$LIPS/tools/make-payloads.sh" --news --stage "$STAGE" >/dev/null \
      || die "make-payloads --news failed"
    say "published" "$STAGE/news"
fi

# ---- what the result claims to cover ---------------------------------
rampart -gc '
var S = require("rampart-sql"), u = rampart.utils;
var s = new S.init("'"$DB"'");
var m = {};
s.exec("select Prop, Val from news_meta;", { maxRows: 20 },
       function (r) { m[String(r.Prop)] = String(r.Val); });
u.printf("  %-26s %s .. %s (%s items, %s days)\n", "covers",
         m.firstItem, m.lastItem, m.items, m.days);
' 2>/dev/null || true
echo "=== done $(date '+%H:%M:%S')"
