#!/usr/bin/env rampart
/* Build lips_licenses: the terms for every corpus Source.
 *
 *   rampart tools/make-licenses.js --db DIR [--list]
 *
 * Keyed on Source, which is what a corpus row carries, so the server
 * looks terms up with the value it already has in hand.
 *
 * WHERE THESE COME FROM. The ZIM metadata declares a licence for only
 * 163 of 223 archives (all of them Stack Exchange); the other 60 declare
 * nothing. The rest was read out of the archives' own pages -- iFixit
 * states "© iFixit — Creative Commons" on every page, ArchWiki states
 * GFDL 1.3, Gentoo and ProofWiki state CC BY-SA -- or is marked
 * unverified here rather than guessed. A one-word claim on a tracker is
 * not evidence: the MedlinePlus ZIM was requested as "Public domain"
 * while two thirds of it is licensed to NLM by third parties.
 *
 * An unclassified Source is an error, not a blank row. A new archive has
 * to have its terms established before it can be served, and this is
 * where that gets recorded.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");

function arg(n, d) {
    var i = process.argv.indexOf("--" + n);
    return i > 0 ? process.argv[i + 1] : d;
}
function flag(n) { return process.argv.indexOf("--" + n) > 0; }

var LIPS = process.env.LIPS || realPath(process.scriptPath + "/..");
var DB = String(arg("db", LIPS + "/build/corpus"));
var sql = new Sql.init(DB, true);

var CC_BY_SA_4 = "https://creativecommons.org/licenses/by-sa/4.0/";
var CC_BY_SA_3 = "https://creativecommons.org/licenses/by-sa/3.0/";

/* Wikimedia projects: same terms, different contributor body. */
var WM = {
    wikipedia_en:          "Wikipedia contributors",
    wikipedia_en_medicine: "Wikipedia contributors",
    wikisource_en:         "Wikisource contributors",
    wikibooks_en:          "Wikibooks contributors",
    wikiversity_en:        "Wikiversity contributors",
    wikiquote_en:          "Wikiquote contributors",
    wikivoyage_en:         "Wikivoyage contributors",
    wiktionary_en:         "Wiktionary contributors"
};

var SE = {
    license: "CC BY-SA", holder: "Stack Exchange contributors",
    url: "https://stackoverflow.com/help/licensing", commercial: "yes",
    notes: "Version is 2.5, 3.0 or 4.0 depending on post date. Author " +
           "bylines are part of the stored text and the path links back " +
           "to the original post."
};

function termsFor(src) {
    if (/^stackexchange_/.test(src) || src === "stackoverflow") return SE;
    if (src in WM)
        return { license: "CC BY-SA 4.0", holder: WM[src], url: CC_BY_SA_4,
                 commercial: "yes",
                 notes: "Attribution is to the contributor body; the path " +
                        "links back to the article." };
    switch (src) {
    case "gutenberg":
        return { license: "Public domain (United States)",
                 holder: "Project Gutenberg",
                 url: "https://www.gutenberg.org/policy/permission.html",
                 commercial: "yes",
                 notes: "Public domain in the US; copyright elsewhere is " +
                        "the reader's to check. A few Project Gutenberg " +
                        "works are copyrighted and carried with permission." };
    case "ifixit":
        return { license: "CC BY-NC-SA 3.0", holder: "iFixit",
                 url: "https://creativecommons.org/licenses/by-nc-sa/3.0/",
                 commercial: "no",
                 notes: "NON-COMMERCIAL. Guides name their own authors in " +
                        "the stored text." };
    case "appropedia_en":
        return { license: "CC BY-SA 3.0 or 4.0 (per page)",
                 holder: "Appropedia contributors", url: CC_BY_SA_4,
                 commercial: "yes",
                 notes: "The version is stated per page; both appear." };
    case "archlinux":
        return { license: "GFDL 1.3", holder: "ArchWiki contributors",
                 url: "https://www.gnu.org/licenses/fdl-1.3.html",
                 commercial: "yes",
                 notes: "The GNU Free Documentation License requires the " +
                        "licence text to accompany redistribution -- the " +
                        "only GFDL source in the corpus." };
    case "gentoo":
        return { license: "CC BY-SA 4.0", holder: "Gentoo Authors",
                 url: CC_BY_SA_4, commercial: "yes",
                 notes: "Stated in every page footer, \"unless otherwise " +
                        "noted\"." };
    case "proofwiki":
        return { license: "CC BY-SA 4.0", holder: "ProofWiki contributors",
                 url: CC_BY_SA_4, commercial: "yes", notes: "" };
    case "gardenology":
        return { license: "Creative Commons (version unstated)",
                 holder: "Gardenology.org", url: "", commercial: "unknown",
                 notes: "Pages say \"Creative Commons\" without naming a " +
                        "version. Establish before relying on it." };
    case "energypedia":
    case "librepathology":
        return { license: "UNVERIFIED", holder: "", url: "",
                 commercial: "unknown",
                 notes: "No licence stated in the ZIM metadata or in the " +
                        "sampled pages. Upstream terms not yet established." };
    case "cdc_travel":
        return { license: "Public domain (US government)",
                 holder: "Centers for Disease Control and Prevention",
                 url: "https://www.cdc.gov/other/agencymaterials.html",
                 commercial: "yes",
                 notes: "A US government work. The Yellow Book's printed "
                        + "edition is published by Oxford University Press; "
                        + "the online text is CDC's. Pages the crawl "
                        + "captured off-site, including six Medscape pages "
                        + "under a WebMD copyright, are excluded at import." };
    case "nhs_medicines":
        return { license: "Open Government Licence v3.0",
                 holder: "Crown copyright, NHS England",
                 url: "https://www.nationalarchives.gov.uk/doc/"
                      + "open-government-licence/version/3/",
                 commercial: "yes",
                 notes: "Reuse is permitted with attribution. The NHS "
                        + "website's own terms also require that a copy not "
                        + "be presented as the NHS website." };
    case "mankier":
        return { license: "Mixed: one licence per man page",
                 holder: "the documenting projects",
                 url: "", commercial: "unknown",
                 notes: "Each man page carries its own project's terms -- "
                        + "GPL, BSD and MIT all appear, and so does "
                        + "all-rights-reserved. Most pages state nothing. "
                        + "Each page's Copyright section is part of the "
                        + "stored text, so the terms travel with it." };
    case "cd3wd":
        return { license: "Mixed / unverified",
                 holder: "various publishers (VITA, FAO, GTZ and others)",
                 url: "", commercial: "unknown",
                 notes: "A compilation of development manuals from many "
                        + "publishers. Most were published for free "
                        + "reproduction in development work, but the terms "
                        + "are not stated in the archive and have to be "
                        + "checked per document." };
    }
    if (/^zimgit_/.test(src))
        return { license: "Mixed / unverified", holder: "various publishers",
                 url: "", commercial: "unknown",
                 notes: "A collection of PDFs from several publishers with " +
                        "no terms stated in the archive. Rights must be " +
                        "checked per document." };
    return null;
}

/* Every Source actually present, so the table matches the corpus. */
var sources = {};
sql.exec("select Source from corpus_merged;", { maxRows: 5000 },
         function (r) { sources[String(r.Source)] = 1; });
var all = Object.keys(sources).sort();
if (!all.length) { printf("no Sources in corpus_merged -- nothing to do\n"); process.exit(1); }

var rows = [], missing = [];
all.forEach(function (s) {
    var t = termsFor(s);
    if (!t) { missing.push(s); return; }
    rows.push([s, t.license, t.holder, t.url, t.commercial, t.notes]);
});

if (missing.length) {
    printf("\nNO TERMS RECORDED for %d Source(s):\n  %s\n",
           missing.length, missing.join("\n  "));
    printf("\nAdd them to termsFor() before serving them. Refusing to write "
           + "a partial table.\n");
    process.exit(2);
}

/* One line for the installer and version.txt, read from the table so it
   cannot drift from what the pages actually say. */
if (flag("summary")) {
    var tot = 0, nc2 = 0, unk2 = 0;
    sql.exec("select Commercial from lips_licenses;", { maxRows: 5000 },
             function (r) {
        tot++;
        if (String(r.Commercial) === "no") nc2++;
        if (String(r.Commercial) === "unknown") unk2++;
    });
    if (!tot) { printf("no licence table yet\n"); process.exit(1); }
    /* Shaped for version.txt, where a reader takes the first field:
       "licenses 189 recorded, ..." leaves $2 meaningful on its own. */
    printf("%d recorded, %d non-commercial, %d unverified\n",
           tot, nc2, unk2);
    process.exit(0);
}

if (flag("list")) {
    printf("%-30s %-34s %-6s %s\n", "Source", "License", "comm.", "holder");
    rows.forEach(function (r) {
        printf("%-30s %-34s %-6s %s\n", r[0], r[1], r[4], r[2]);
    });
    printf("\n%d Source(s). --list only; nothing written.\n", rows.length);
    process.exit(0);
}

sql.exec("create table if not exists lips_licenses ("
         + "Source varchar(64), License varchar(64), Holder varchar(128), "
         + "Url varchar(200), Commercial varchar(8), Notes varchar(400));");
/* Rebuilt rather than updated: the rules above are the definition, so a
   run should leave exactly what they say and nothing stale. */
sql.exec("delete from lips_licenses;");
rows.forEach(function (r) {
    sql.exec("insert into lips_licenses (Source, License, Holder, Url, "
             + "Commercial, Notes) values (?,?,?,?,?,?);", r);
});

var n = 0;
sql.exec("select count(*) c from lips_licenses;", { maxRows: 1 },
         function (r) { n = Number(r.c); });
printf("lips_licenses: %d row(s) written for %d Source(s)\n", n, all.length);

var nc = 0, unk = 0;
sql.exec("select Commercial from lips_licenses;", { maxRows: 5000 },
         function (r) {
    var c = String(r.Commercial);
    if (c === "no") nc++;
    if (c === "unknown") unk++;
});
printf("  commercial use not permitted: %d source(s)\n", nc);
printf("  terms unverified:             %d source(s)\n", unk);
