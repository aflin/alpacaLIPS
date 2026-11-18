/* Clean pdftotext output for storage and chunking.
 *
 * pdftotext gives usable prose with blank lines between paragraphs, so
 * chunkembed()'s paragraph split works, but it also carries page
 * furniture that would become index noise:
 *
 *   - form feeds between pages
 *   - a running header and/or footer repeated on most pages
 *   - bare page numbers on their own line
 *   - bullet glyphs orphaned on their own line
 *
 * Running headers are found by POSITION, not frequency: a line that
 * sits at the same page edge on several pages. Frequency alone is
 * wrong -- in "Safe Water School", "Objectives - Knowledge",
 * "Materials - School" and "Appendix" each repeat 9-21 times because
 * every lesson has them, and mid-page they are real structure.
 *
 * The edge test needs a SET, not one string: that document's header
 * changes by section, so "School lessons" leads 50 pages of 121,
 * "School lessons - Background information" 28 and "Appendix" 21, and
 * no single string reaches a majority. A string qualifies when it
 * leads (or ends) at least 3 pages and at least 10% of them.
 */

/* a line carrying no letter or digit is a glyph, not content */
function isGlyphOnly(s) {
    return s.length > 0 && s.length <= 4 && !/[A-Za-z0-9]/.test(s);
}
/* page numbers: digits, or a short roman numeral, alone on the line */
function isPageNumber(s) {
    return /^\d{1,4}$/.test(s) || /^[ivxlcdm]{1,7}$/i.test(s) && s.length <= 7;
}

function clean(raw, opts) {
    opts = opts || {};
    var minPages = opts.minPages || 4;      /* below this, no edge stats */
    var share    = opts.share    || 0.10;   /* fraction of pages to call it */

    var text = String(raw).replace(/\r\n?/g, "\n");
    var pages = text.split("\f");
    var stats = { pages: pages.length, headers: [], footers: [],
                  headerDropped: 0, footerDropped: 0,
                  pageNumbers: 0, glyphs: 0, bulletsMerged: 0,
                  keptAsContent: 0 };

    /* split each page into lines, trimming blank edges */
    var P = pages.map(function (p) {
        var L = p.split("\n").map(function (l) { return l.replace(/\s+$/, ""); });
        while (L.length && !L[0].trim().length) L.shift();
        while (L.length && !L[L.length - 1].trim().length) L.pop();
        return L;
    }).filter(function (L) { return L.length; });

    /* strings that recur at a page edge, as a set */
    function edgeSet(pick) {
        var t = {}, set = {};
        P.forEach(function (L) {
            var s = pick(L);
            if (s === null) return;
            s = s.trim();
            if (!s.length || isPageNumber(s) || isGlyphOnly(s)) return;
            if (s.length > 90) return;
            t[s] = (t[s] || 0) + 1;
        });
        var floor = Math.max(3, P.length * share);
        Object.keys(t).forEach(function (k) {
            if (t[k] >= floor) set[k] = t[k];
        });
        return set;
    }
    /* Would dropping every instance of `cand` erase a word from the
       document? Then it carries content and is not furniture. */
    function wordsSurvive(cand) {
        var words = cand.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
        if (!words.length) return true;            /* nothing to lose */
        var elsewhere = {};
        P.forEach(function (L) {
            L.forEach(function (line) {
                if (line.trim() === cand) return;  /* skip the candidate */
                var m = line.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
                m.forEach(function (w) { elsewhere[w] = 1; });
            });
        });
        for (var i = 0; i < words.length; i++)
            if (!elsewhere[words[i]]) return false;
        return true;
    }

    var headSet = {}, footSet = {};
    if (P.length >= minPages) {
        headSet = edgeSet(function (L) { return L.length ? L[0] : null; });
        footSet = edgeSet(function (L) { return L.length ? L[L.length - 1] : null; });
        /* a string at both edges is ambiguous; treat it as a header */
        Object.keys(footSet).forEach(function (k) {
            if (headSet[k]) delete footSet[k];
        });
        /* back off where dropping would cost content */
        [headSet, footSet].forEach(function (set) {
            Object.keys(set).forEach(function (k) {
                if (!wordsSurvive(k)) {
                    delete set[k];
                    stats.keptAsContent++;
                }
            });
        });
        stats.headers = Object.keys(headSet).sort(function (a, b) {
            return headSet[b] - headSet[a]; });
        stats.footers = Object.keys(footSet).sort(function (a, b) {
            return footSet[b] - footSet[a]; });
    }

    var out = [];
    P.forEach(function (L) {
        /* drop the running header/footer from this page */
        if (L.length && headSet[L[0].trim()]) {
            L = L.slice(1); stats.headerDropped++;
        }
        if (L.length && footSet[L[L.length - 1].trim()]) {
            L = L.slice(0, -1); stats.footerDropped++;
        }

        var keep = [];
        for (var i = 0; i < L.length; i++) {
            var s = L[i].trim();

            /* page number alone, only at a page edge: a "3." mid-page
               could be a list item, so position is what makes it safe */
            if (isPageNumber(s) &&
                (keep.length === 0 || i >= L.length - 2)) {
                stats.pageNumbers++; continue;
            }
            /* orphaned bullet: fold it into the line it belongs to */
            if (isGlyphOnly(s)) {
                var j = i + 1;
                if (j < L.length && L[j].trim().length) {
                    keep.push("* " + L[j].trim());
                    stats.bulletsMerged++;
                    i = j; continue;
                }
                stats.glyphs++; continue;
            }
            keep.push(L[i]);
        }
        if (keep.length) out.push(keep.join("\n"));
    });

    /* a page boundary is a paragraph boundary */
    var joined = out.join("\n\n")
                 .replace(/[ \t]+\n/g, "\n")
                 .replace(/\n{3,}/g, "\n\n")
                 .replace(/^\s+/, "").replace(/\s+$/, "");
    stats.chars = joined.length;
    return { text: joined, stats: stats };
}

module.exports = { clean: clean };
