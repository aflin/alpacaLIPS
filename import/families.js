/* Per-template-family extraction config.
 *
 * The 183 archives come from four generators, not 183 templates, so the
 * config is keyed by family. Selectors are rampart-html primitives, not
 * CSS: there is no selector engine.
 *
 *   by "class" -> findClass(value)
 *   by "tag"   -> findTag(value)
 *   by "attr"  -> findAttr(value)   ONE string, "name=value" syntax,
 *                 globs allowed at one end ("id=post-*").
 *                 Passing two arguments silently matches every element
 *                 that merely HAS the attribute.
 *
 * Content containers were found by text share and then verified by
 * diffing the dropped text -- a length ratio cannot validate a selector
 * (the 84-98% figures looked fine while the page <h1> was being lost).
 */

var FAMILIES = {
    /* All wiki projects: Wikipedia, Wiktionary, Wikisource, Wikibooks,
       Wikiversity, Wikivoyage, Wikiquote, WikiMed. 97-98% of page text.
       Scoping also removes the "This page is issued from ..." licence
       line that appears on every single page. */
    mwoffliner: {
        include: [ { by: "class", value: "mw-parser-output" } ],
        exclude: [ { by: "class", value: "mw-editsection" },
                   { by: "class", value: "mw-jump-link" } ],
        /* NOTE: navbox is NOT excluded. Wiktionary's NavFrame elements are
           conjugation and declension tables -- real content. Exclusions
           must be verified against the term-frequency audit, not guessed
           from class names. */

        /* Auto-generated listings of other pages' titles. Measured on a
           2000-page Wikibooks sample: 101 such rows, 5.1% of rows but
           only 0.7% of bytes, averaging 935 bytes. The byte saving is
           not the point -- a keyword hit on a list of member titles
           tells a researching model nothing the member articles do not,
           so they are retrieval noise.

           DO NOT generalise this to a namespace blocklist. On Wikibooks
           a "Prefix:" is usually a book title containing a colon, not a
           MediaWiki namespace: Cookbook:, Wikijunior:, Shelf:,
           The_Legend_of_Zelda:, Mario_Kart:,
           How_to_Think_Like_a_Computer_Scientist: are all real content
           and together are 9% of pages. Wiktionary likewise has
           Appendix:, Thesaurus: and Reconstruction:. Only these two
           patterns are safe. */
        pathExclude: [ /^Category:/, /^_categories_partials_/ ],
        docHint: 16384
    },

    /* Stack Exchange (sotoki). #mainbar is question + answers + comments
       in document order, 95-98% of page text. Drops the nav
       ("Questions / Tags / Users / About") and post metadata. */
    sotoki: {
        include: [ { by: "attr", value: "id=mainbar" } ],
        exclude: [],
        pathPrefix: "questions/",   /* skip users/, tags/, about index pages */
        /* questions/tagged/<slug> are tag LISTING pages: a heading, the
           tag description, then titles and excerpts of questions that
           are each stored in their own row. Keeping them would
           duplicate that text and add "Questions Tags Users About"
           furniture to the index. They carry #mainbar-full rather than
           #mainbar, so they are already missed by the selector -- this
           drops them by decision instead, because a later sotoki giving
           them #mainbar would otherwise flood the table silently.
           Measured on 3dprinting: 1278 of 7309 questions/ pages. */
        pathExclude: [ /^questions\/tagged\// ],
        docHint: 4096
    },

    /* iFixit repair guides. 253,845 HTML pages, of which User/ is
       150,359 profile pages; Guide/ 56,536, Device/ 44,856,
       Teardown/ 1,856 and Info/ 225 are content, totalling 103,473 and
       matching the archive's own article_count of 103,480.

       div#main is the container on every page type: 90-99% of page
       text kept across Guide, Teardown and Device samples, with the
       only dropped lines being the identical 9-line site footer
       ("Free manuals / Solutions / Devices / Repairs / (c) iFixit").

       NOT div#content, which scores the same as #main on Guide pages
       but sits inside it on Device pages and there drops the device
       description -- "Repair guides and support for the Expedition, a
       full-size SUV based on Ford's F-150 pickup truck" -- which is the
       most valuable sentence on the page for keyword search. On one
       sample it kept only 32%. The text-share ranking alone did not
       show this; the dropped-line diff did (import/t-dropped.js).

       Device pages run from empty stubs to rich family pages: the
       smallest carry 109 characters of which 101 are the footer, so
       they extract to nothing and are skipped as empty. That is
       correct -- a device with no guides tells a researching model
       nothing beyond its title.

       The archive carries no Scraper key, so the family is recognised
       by filename. Text yield is small: guides are mostly photographs
       with short step captions (98,827 bytes of HTML for 5,932
       characters of text), so 103k articles come to roughly 0.3 GB.
       The 575,002 images are the real value and need §17.1. */
    ifixit: {
        include: [ { by: "attr", value: "id=main" } ],
        exclude: [],
        pathExclude: [ /^User\// ],
        docHint: 2048
    },

    /* Project Gutenberg (gutenberg2zim). The book body IS the <body>:
       the scraper stores each book's original HTML unwrapped, and strips
       the Project Gutenberg licence header and footer -- head and tail
       were read on several books to confirm, since that boilerplate
       repeated across ~85,000 rows would dominate the index.

       THE BOOK BODIES ARE NOT FLAGGED AS ARTICLES. Only the cover,
       author and shelf pages are, so article_count reports 14 for a
       slice holding 6 books, and any article-list walk misses every
       book: zim2jsonl.py --sample 400 on the literature slice returned
       400 chrome pages and zero books. Import must use the full entry
       walk.

       PATH GRAMMAR CANNOT SELECT THE BOOKS. A book is <Title>.<id> and
       an author page is <Author>.<id> -- the same shape -- and size does
       not separate them either: one measured book (85,744 B) is smaller
       than every author page (~95,600 B), because the chrome's bulk is
       JavaScript rather than text.

       What does separate them is the scraper's own template skin class,
       which every cover, author, shelf and Home page carries and no
       book body has. Measured over 529 pages from five slices (literature,
       science, technology, fine arts, Germanic languages): chrome never
       exceeded 538 characters of text and the smallest book was 4,282,
       so one class test classifies every page with no threshold.

       docHint is the measured mean of 347,117 bytes over 229 book
       bodies (p50 286,183, max 1,668,337); text is 0.814 of HTML. */
    gutenberg2zim: {
        include: [ { by: "tag", value: "body" } ],
        exclude: [],
        rejectClass: "pure-skin-gutenberg",
        docHint: 262144
    }

    /* Not yet written, and deliberately out of the first import:
         nautiluszim  5 zimgit-* archives
       These are not scraped sites: nautiluszim packages a collection of
       FILES, so each archive is a landing page, a bundled PDF.js/
       video.js viewer, and the real content as files/*.pdf (7 PDFs in
       water, 12 in medicine, 108 in post-disaster). There are only 2
       HTML entries per archive, so an HTML selector gets nothing.
       Their text needs rampart-totext, which extracts PDFs via poppler
       -- verified: 670,134 characters out of a 7.6 MB
       "Emergency War Surgery" PDF. That is a separate code path from
       this one, not a selector. */
};

/* Families whose content is FILES, not HTML.
 *
 * nautiluszim packages a collection: a landing page, a bundled
 * PDF.js/video.js viewer, and the content as files/*.pdf. Only two HTML
 * entries exist, so no selector can reach the text; it comes out of the
 * PDFs through rampart-totext (poppler), handled by
 * import/pdf-import.js.
 *
 * Deliberately NOT in FAMILIES, so the HTML worklist keeps skipping
 * these archives rather than importing two landing pages each.
 */
var PDF_FAMILIES = {
    nautiluszim: {
        table: "zimgit",
        collection: "zimgit",
        /* whole books in one row: the largest seen is ~1 MB of text */
        docHint: 65536
    }
};

/* Which PDF family, table and site an archive belongs to. The site is
   the collection topic -- water, knots, medicine, food-preparation,
   post-disaster -- taken from the filename, as with the wikis. */
function classifyPdf(zimName, scraper) {
    var n = String(zimName).replace(/\.zim$/, "");
    var f = familyFromScraper(scraper) ||
            (/^zimgit-/.test(n) ? "nautiluszim" : null);
    if (!f || !PDF_FAMILIES[f]) return null;
    var m = /^zimgit-([a-z0-9-]+?)_[a-z]{2,3}(_|$)/.exec(n);
    /* Per collection rather than one zimgit table, for the same reason as
       stackexchange: five archives sharing a table cannot be replaced one
       at a time. PDF_FAMILIES[f].table remains the fallback when the name
       carries no collection to key on. */
    return { family: f, collection: PDF_FAMILIES[f].collection,
             table: (m && m[1])
                    ? PDF_FAMILIES[f].table + "_" +
                      String(m[1]).replace(/[^A-Za-z0-9]+/g, "_")
                    : PDF_FAMILIES[f].table,
             site: m ? m[1] : n.replace(/[^a-z0-9-]/g, "") };
}

/* Family from the ZIM's own Scraper metadata, which is authoritative.
   Measured across all 183 archives: sotoki 162, mwoffliner 15,
   nautiluszim 5, and iFixit with no Scraper key at all. */
function familyFromScraper(scraper) {
    var s = String(scraper || "").trim().toLowerCase();
    if (!s) return null;
    /* "sotoki v3.1.1", "mwoffliner 2.1.1" -> first word. A name with no
       FAMILIES entry passes through so pickArchives reports it by name
       rather than silently dropping the archive.
       gutenberg2zim hyphenates its version instead of spacing it
       ("gutenberg2zim-3.0.1"), so a trailing -<version> comes off too. */
    return s.split(/[\s\/]+/)[0].replace(/-[0-9][0-9a-z.]*$/, "");
}

/* Family from the filename, for callers that have not opened the ZIM.
   Only a fallback: prefer the Scraper key. */
function familyFromName(n) {
    if (/^ifixit_/.test(n)) return "ifixit";
    if (/stackexchange\.com_|^stackoverflow\.com_|^(askubuntu|superuser|serverfault)\.com_/.test(n))
        return "sotoki";
    if (/^(wikipedia|wiktionary|wikisource|wikibooks|wikiversity|wikivoyage|wikiquote|wikimed)_/.test(n))
        return "mwoffliner";
    if (/^zimgit-/.test(n)) return "nautiluszim";
    if (/^gutenberg_/.test(n)) return "gutenberg2zim";
    return null;
}

/* Which family, collection and table an archive belongs to.
   `scraper` is the sidecar's zimScraper when available; the table and
   site names come from the filename, which is where the site identity
   actually lives (Scraper says only "sotoki"). */
function classify(zimName, scraper) {
    var n = String(zimName).replace(/\.zim$/, "");
    var fam = familyFromScraper(scraper) || familyFromName(n);

    if (/^stackoverflow\.com_/.test(n))
        return { family: fam, collection: "stackoverflow",
                 table: "stackoverflow", site: null };

    var se = /^(.+?)\.stackexchange\.com_|^(askubuntu|superuser|serverfault)\.com_/.exec(n);
    if (se) {
        /* A table per site, like gutenberg's per-slice tables: a re-dumped
           site is then replaced by dropping one table rather than by
           deleting rows out of a shared one. Collection, and so Source,
           is unchanged. */
        var st = String(se[1] || se[2]);
        return { family: fam, collection: "stackexchange",
                 table: "stackexchange_" + st.replace(/[^A-Za-z0-9]+/g, "_"),
                 site: st };
    }

    if (/^ifixit_/.test(n))
        return { family: fam, collection: "ifixit", table: "ifixit",
                 site: null };

    /* gutenberg_en_lcc-pd_2026-03 -> table gutenberg_en_pd, site lcc-pd.
       One table per LCC slice while staging, as the import plan asks;
       the slice is ALSO on Site so the 39 tables can later merge into a
       single gutenberg table the way stackexchange holds 161 archives in
       one, without re-extracting. Slices are dated per letter, not per
       dump, so the date is not part of the table name. */
    var gb = /^gutenberg_([a-z]{2,3})_lcc-([a-z]+)_/.exec(n);
    if (gb)
        return { family: fam, collection: "gutenberg",
                 table: "gutenberg_" + gb[1] + "_" + gb[2],
                 site: "lcc-" + gb[2] };

    var wiki = /^(wikipedia|wiktionary|wikisource|wikibooks|wikiversity|wikivoyage|wikiquote)_/.exec(n);
    if (wiki) {
        var m = /^([a-z]+)_([a-z-]+)_([a-z0-9]+)/.exec(n);
        var tbl = m ? (m[1] + "_" + m[2] + (m[3] && m[3] !== "all" ? "_" + m[3] : "")) : wiki[1];
        tbl = tbl.replace(/[^a-z0-9_]/g, "_");
        /* A ZIM we packed ourselves (import/news-zim.js) reports Scraper
           "zimwriterfs", because that is what wrote the container. The
           markup inside is Wikipedia's own, so the mwoffliner selectors
           are the correct ones -- the scraper names the packer here, not
           the source. Gated on the wiki name: a zimwriterfs archive of
           anything else still has no selectors. */
        var wfam = (fam === "zimwriterfs") ? "mwoffliner" : fam;
        return { family: wfam, collection: wiki[1], table: tbl, site: null };
    }

    return null;   /* iFixit, zimgit: no selectors written yet */
}

/* Archives that are not corpus content. top1m is a popularity signal
   only (DESIGN.md §8, §18): importing it would duplicate Wikipedia. */
var NOT_CORPUS = [ /^wikipedia_en_top1m_/, /^wikipedia_en_top_/ ];

/* Flavour preference. maxi carries the images that §17.1 serves, so it
   wins; a wiki present as both maxi and nopic must import only once or
   every article is duplicated. */
var FLAVOUR_RANK = { maxi: 3, nopic: 2, mini: 1 };
function flavourOf(n) {
    var m = /_(maxi|nopic|mini)_/.exec(n);
    return m ? m[1] : "";
}

/* The dump date the filename carries, as YYYY-MM or YYYY-MM-DD, which
   sorts lexically. "" when there is none (zimgit-*, ifixit at some
   dates), which compares below every real date -- a dated dump should
   win over an undated one. */
function dateOf(n) {
    var m = /_(\d{4}-\d{2}(?:-\d{2})?)\.zim$/.exec(String(n));
    return m ? m[1] : "";
}

/* Better means: a better flavour, or the same flavour from a newer
   dump. Without the second half, two dumps of one archive tie on rank
   and whichever was listed first wins, which is the older one. */
function better(a, b) {               /* is a better than b? */
    if (a.rank !== b.rank) return a.rank > b.rank;
    return dateOf(a.zim) > dateOf(b.zim);
}

/* Why the loser lost, in the terms that actually decided it: the old
   message said "lower flavour than nopic" when both were nopic and only
   the date differed, and printed an empty flavour for the sotoki
   archives, which have none. */
function whyLost(lost, won) {
    if (lost.rank !== won.rank)
        return "superseded by the " + (flavourOf(won.zim) || "other") +
               " flavour";
    var d = dateOf(won.zim);
    return d ? "superseded by the " + d + " dump" : "duplicate of " + won.zim;
}

/* Given every archive filename, choose which to import: one per table,
   best flavour, newest dump of it, excluding non-corpus archives. */
function pickArchives(names) {
    var best = {}, skipped = [];
    names.forEach(function (n) {
        if (!/\.zim$/.test(n)) return;
        if (NOT_CORPUS.some(function (re) { return re.test(n); })) {
            skipped.push({ zim: n, why: "not corpus (signal only)" });
            return;
        }
        var c = classify(n);
        if (!c) { skipped.push({ zim: n, why: "no family/selectors" }); return; }
        if (!FAMILIES[c.family]) {
            skipped.push({ zim: n, why: "no selectors for family " + c.family });
            return;
        }
        var cand = { zim: n, rank: FLAVOUR_RANK[flavourOf(n)] || 0, info: c };
        var key = c.table + "|" + (c.site || "");
        var cur = best[key];
        if (!cur || better(cand, cur)) {
            if (cur) skipped.push({ zim: cur.zim, why: whyLost(cur, cand) });
            best[key] = cand;
        } else {
            skipped.push({ zim: n, why: whyLost(cand, cur) });
        }
    });
    return { pick: Object.keys(best).map(function (k) { return best[k]; }),
             skipped: skipped };
}

module.exports = { FAMILIES: FAMILIES, classify: classify,
                   PDF_FAMILIES: PDF_FAMILIES, classifyPdf: classifyPdf,
                   familyFromScraper: familyFromScraper,
                   familyFromName: familyFromName,
                   pickArchives: pickArchives, flavourOf: flavourOf };
