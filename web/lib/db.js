/* Database handles that notice when their files are replaced.
 *
 * A texis database here is REPLACED, not edited: the news table daily, the
 * corpus whenever a new build lands. An open handle does not notice, and
 * neither does a new one opened beside it. Measured, all three cases:
 *
 *   handle on a replaced directory       -> serves the old rows, for ever
 *   new handle while the old is open      -> serves the old rows as well;
 *                                            the cache for that path is
 *                                            pinned by the open handle
 *   close the old, THEN open a new one    -> serves the new rows
 *
 * So closing first is the whole trick, and a handle has to carry the
 * fingerprint of the files it was opened against. The fingerprint uses
 * the inode as well as mtime and size, because a replacement gets a new
 * inode even when its timestamp looks plausible.
 *
 * Cost is one stat() per watched file per request. A search takes
 * milliseconds; answering it from the wrong day costs rather more.
 *
 * Callers that cache anything derived from the data -- collection lists,
 * row counts, the zim map -- pass onReopen and clear it there: those
 * caches go stale with exactly the same event.
 */
var Sql = require("rampart-sql");
var open_ = {};                 /* dir -> { sql, tag } */

function tagOf(dir, files) {
    var out = "", any = false;
    for (var i = 0; i < files.length; i++) {
        var st = rampart.utils.stat(dir + "/" + files[i]);
        if (st) { any = true; out += st.ino + "/" + st.mtime + "/" + st.size + "|"; }
        else out += "-|";
    }
    return any ? out : "";       /* none of them present: nothing to open */
}

/* open(dir, [files], [onReopen]) -> handle, or null when the files are
   not there. `files` are the ones whose replacement matters; the first
   is also the existence test. */
function open(dir, files, onReopen) {
    files = (files && files.length) ? files : ["corpus.tbl"];
    var tag = tagOf(dir, files);
    var e = open_[dir];
    if (!tag) {                              /* gone */
        if (e) { try { e.sql.close(); } catch (x) {} delete open_[dir]; }
        return null;
    }
    if (e && e.tag === tag) return e.sql;
    if (e) { try { e.sql.close(); } catch (x) {} delete open_[dir]; }
    var s;
    try { s = new Sql.init(dir); }
    catch (x) {
        rampart.utils.printf("db.open: cannot open %s: %s\n", dir, x.message);
        return null;
    }
    open_[dir] = { sql: s, tag: tag };
    if (onReopen) { try { onReopen(s); } catch (x) {} }
    return s;
}

module.exports = { open: open };
