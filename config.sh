# Shared locations. Source this from any shell tool in the tree.
#
# Everything lives inside the clone by default: fetched material under
# downloads/, built tables and indexes under build/. Both are excluded
# by .gitignore, so a clone can be built in place and stays clean.
#
#   LIPS    this tree, worked out from where this file lives
#   DATA   everything downloaded -- the archives, the job lists, and the
#          extracted staging. This is the one that grows to terabytes,
#          so it is the one to move if the clone is on a small disk.
#
# To move it, write config.local.sh beside this file. It is read first,
# it is not in the repo, and the paths below follow whatever it sets:
#
#   DATA=${DATA:-/mnt/big/alpacalips}
#
# Keeping the ${VAR:-...} form there leaves an exported value winning
# over both, which is how ./build.sh --data passes one choice down
# to every step.

LIPS=${LIPS:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}
[ -r "$LIPS/config.local.sh" ] && . "$LIPS/config.local.sh"

DATA=${DATA:-$LIPS/downloads}    # everything fetched, and the payloads built from it
META=${META:-$DATA/meta}        # job lists, metalink cache, progress logs
# THE ARCHIVES' ONE LOCATION. They are published for download, so they
# live in the web server's download directory and nowhere else: fetch
# writes them there, meta and import read them there, and the kiwix
# library is built from there. No pool, no second name, no copies.
# Falls back inside DATA when no download directory is configured, which
# is the case on a fresh tree before --download-dir is given.
KIWIX=${KIWIX:-${DOWNLOAD_DIR:-$DATA}/archives}
STAGE=${STAGE:-$DATA/staging}   # extracted JSONL, kept (DESIGN.md §19)
DB=${DB:-$LIPS/build/corpus}       # the tables and their indexes
