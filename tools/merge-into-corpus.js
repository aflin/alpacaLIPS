#!/usr/bin/env rampart
/* Merge staged per-collection tables into `corpus`.
 *
 *   rampart merge-into-corpus.js --list        # plan only, no writes
 *   rampart merge-into-corpus.js --go
 *   rampart merge-into-corpus.js --go --table gutenberg_en_pd
 *
 * WHY A REGISTRY. The first merge left no record of which tables it had
 * copied, so working out what was still outstanding meant comparing
 * corpus.tbl's mtime against lips_sources.Imported and reasoning about
 * row-count shortfalls. This writes corpus_merged, so the next pass can
 * just read it. A table (or a stackexchange Site) already recorded there
 * is skipped: re-running must never double rows.
 *
 * THE FULLTEXT INDEX IS NOT TOUCHED. corpus_cx is a compound index on
 * (Doc, Source) and inserts do not maintain it -- the new rows are
 * reachable only by linear scan until `alter index corpus_cx optimize`
 * is run, which is long and belongs in its own deliberate step.
 * corpus_src and corpus_ttl DO update per insert.
 *
 * COLUMN ORDER IS POSITIONAL AND MUST COME FROM ORDINAL_POSITION.
 * `select NAME from SYSCOLUMNS` returns columns in NAME order, which for
 * corpus looks plausible and is wrong -- it puts Nbytes 2nd when it is
 * 7th, so the insert hands an int to Source and fails with "Types for
 * field Source are not compatible varchar != int". True order is
 *   corpus  Id, Source, Site, SrcPath, Title, Doc, Nbytes, Sha
 * Source is supplied as a constant and Sha as '' -- empty is what every
 * existing corpus row carries; the original merge never computed it.
 *
 * A NAMED COLUMN LIST DOES NOT WORK. `insert into corpus (Id, Source,
 * ...) select ...` is accepted, returns rowCount 0, raises no error and
 * inserts nothing. Only the positional form writes rows, so the column
 * order above is load-bearing and silent if wrong.
 */
rampart.globalize(rampart.utils);
var Sql = require("rampart-sql");

function arg(n, d) { var i = process.argv.indexOf("--" + n);
                     return i > 0 ? process.argv[i + 1] : d; }
function flag(n) { return process.argv.indexOf("--" + n) > 0; }

/* The tree this file sits in, so a clone anywhere works. */
var LIPS  = process.env.LIPS || rampart.utils.realPath(process.scriptPath + "/..");
var DB   = String(arg("db", LIPS + "/build/corpus"));
var GO   = flag("go");
/* Per-row locking costs about 0.057 ms a row here, which over 51 million
   rows is the better part of an hour. The merge owns the corpus while it
   runs -- it has just dropped it -- so there is nothing for the locks to
   protect against. --locking restores it for a run where something else
   has the database open. */
var LOCKING = flag("locking");
var REBUILD = flag("rebuild");
var ONE  = arg("table", null);
var sql  = new Sql.init(DB, true);
if (!LOCKING) {
    /* 0.7.6: noLocking applies to this connection only, so this does
       not reach anything else that has the database open. */
    sql.set({ noLocking: true });
}

/* The 39 LCC slices become ONE Source, 'gutenberg', with the slice on
   Site -- the same shape stackexchange uses for 161 archives. Mapping a
   table to its corpus Source lives here rather than being inferred, so
   a wrong guess cannot silently create 36 new collections. */
function sourceFor(t) {
    if (/^gutenberg_en_/.test(t)) return "gutenberg";
    return t;                      /* wikipedia_en, wikibooks_en, ... */
}

/* Partly-merged tables are discovered, not listed: stackexchange is the
   only one today (157 archives in, 4 out), and its new Sites are read
   from lips_sources rather than hardcoded, so a later top-up of any
   collection is handled without editing this file. */

function tableExists(n) {
    var f = false;
    sql.exec("select NAME from SYSTABLES where NAME=?;", [n], { maxRows: 1 },
             function () { f = true; });
    return f;
}

if (!tableExists("corpus_merged")) {
    sql.exec("create table corpus_merged (TableName varchar(64), " +
             "Site varchar(64), Source varchar(32), Rows int, " +
             "Merged varchar(24));");
    printf("created corpus_merged\n");
}

/* What is already recorded as merged. */
var done = {};
sql.exec("select TableName, Site from corpus_merged;", { maxRows: 5000 },
         function (r) { done[String(r.TableName) + "|" + String(r.Site || "")] = 1; });

/* THE CUTOFF IS THE CORPUS BUILD TIME, not the registry alone.
   corpus_merged starts empty on a tree whose first merge predates it, so
   gating only on that registry marks ALREADY-MERGED tables as new -- a
   dry run planned 43.5M rows, including stackoverflow, wiktionary_en and
   wikipedia_en, which would have doubled most of the corpus. An archive
   imported after corpus.tbl was last written is new; anything earlier is
   already in. Both timestamps are ISO UTC, so they compare lexically. */
/* COMPARE INSTANTS, NOT STRINGS. stat().mtime stringifies as local time
   with an offset ("2026-11-05 16:28:07.169-08:00") while Imported is UTC
   with a T ("2026-11-05T12:37:01.678Z"). Lexically those differ first at
   position 10, where 'T' > ' ', so every same-date archive sorted after
   the cutoff: stackoverflow's 24,145,596 already-merged rows were planned
   for re-insertion on exactly that one-character difference. */
/* THE CUTOFF MUST BE STORED, NOT RE-DERIVED. Taking it from corpus.tbl's
   mtime is self-destroying: this tool's own first insert moves that mtime
   forward, so the next run sees every pending archive as older than the
   cutoff and plans nothing. A 6-row canary was enough to hide 1.9M rows.
   It is therefore read once, persisted, and reused. */
if (!tableExists("corpus_merge_meta"))
    sql.exec("create table corpus_merge_meta (Asof varchar(40), " +
             "Noted varchar(24));");
var stored = null;
sql.exec("select Asof from corpus_merge_meta;", { maxRows: 1 },
         function (r) { stored = String(r.Asof); });

/* A virgin database has no corpus.tbl to date from, and nothing in it is
   already merged, so the cutoff is the epoch: every imported table is
   newer than it and gets planned. Tested as isNaN, not as falsy -- the
   epoch is 0, and  rejected it. */
var st0 = stat(DB + "/corpus.tbl");
var ASOF_S = String(arg("asof", stored
                        || (st0 ? st0.mtime : "1970-01-01T00:00:00Z")));
var ASOF = new Date(ASOF_S).getTime();
if (isNaN(ASOF)) { printf("cannot parse cutoff %s\n", ASOF_S); process.exit(1); }
if (!stored) {
    sql.exec("insert into corpus_merge_meta (Asof, Noted) values (?,?);",
             [ASOF_S, dateFmt("%Y-%m-%dT%H:%M:%S", new Date())]);
    printf("recorded merge cutoff: %s\n", ASOF_S);
} else if (stored !== ASOF_S) {
    printf("NOTE: overriding stored cutoff %s with %s\n", stored, ASOF_S);
}
printf("merge cutoff: %s (%d)%s\n", ASOF_S, ASOF,
       stored ? "  [stored]" : "  [new]");
printf("archives imported after that instant are treated as new.\n");

/* IS THE CORPUS STILL MADE OF THESE TABLES? Two ways it stops being:
   a table it was built from is gone, or one has been re-imported since.
   Appending to a corpus in that state duplicates whatever changed, so
   this is checked before anything is planned. */
var staleGone = [], staleNew = [];

/* Merged is stored UTC without a zone and Imported with one, so they
   are only comparable once both say which zone they are in. */
function instant(v) {
    var t = String(v || "");
    if (!t.length) return NaN;
    if (!/[Zz]$|[+-]\d\d:?\d\d$/.test(t)) t += "Z";
    return new Date(t).getTime();
}

var mergedAt = {};
sql.exec("select TableName, Merged from corpus_merged;", { maxRows: 5000 },
         function (r) { mergedAt[String(r.TableName)] = instant(r.Merged); });
Object.keys(mergedAt).forEach(function (t) {
    if (!tableExists(t)) staleGone.push(t);
});
sql.exec("select TableName, Zim, Imported from lips_sources;",
         { maxRows: 5000 }, function (r) {
    var t = String(r.TableName);
    if (!(t in mergedAt)) return;          /* never merged: just pending */
    var when = mergedAt[t], imp = instant(r.Imported);
    if (isNaN(when) || isNaN(imp)) return; /* unreadable: not evidence */
    if (imp > when) staleNew.push(t + " (" + String(r.Zim) + ")");
});
var STALE = staleGone.length + staleNew.length;
if (STALE) {
    printf("\nCORPUS IS BEHIND ITS TABLES\n");
    staleGone.forEach(function (t) {
        printf("  gone        %s -- merged, and the table no longer exists\n", t);
    });
    staleNew.slice(0, 8).forEach(function (t) {
        printf("  re-imported %s\n", t);
    });
    if (staleNew.length > 8)
        printf("  re-imported ... and %d more\n", staleNew.length - 8);
    printf("\n%d table(s) affected. corpus holds rows these no longer"
           + " account for.\n", staleGone.length + staleNew.length);
    if (!REBUILD) {
        printf("\nRefusing to append to it: that would duplicate whatever"
               + " changed.\n  --rebuild drops corpus, forgets the registry"
               + " and merges every table\n  again in order (the insertion"
               + " order is what decides tie ranking).\n");
        process.exit(2);
    }
}

if (REBUILD) {
    if (!GO) {
        printf("\n--rebuild given without --go: nothing dropped.\n");
        process.exit(0);
    }
    printf("\nrebuilding from the tables:\n");
    if (tableExists("corpus")) {
        /* The indexes go with it: they describe rows that are about to
           stop existing, and the index stage rebuilds them from the new
           corpus. */
        ["corpus_cx", "corpus_src", "corpus_ttl"].forEach(function (ix) {
            try { sql.exec("drop index " + ix + ";");
                  printf("  dropped index %s\n", ix); } catch (e) {}
        });
        sql.exec("drop table corpus;");
        printf("  dropped table corpus\n");
    }
    ["corpus_merged", "corpus_merge_meta"].forEach(function (t) {
        if (tableExists(t)) { sql.exec("drop table " + t + ";");
                              printf("  dropped %s\n", t); }
    });
    printf("  re-run this tool to merge every table from nothing\n");
    process.exit(0);
}

/* Per table, split its archives either side of the cutoff. */
var tbls = {};
sql.exec("select TableName, Site, Imported from lips_sources;",
         { maxRows: 5000 }, function (r) {
    var t = String(r.TableName);
    if (!tbls[t]) tbls[t] = { old: 0, nw: 0, sites: {}, blind: 0 };
    if (new Date(String(r.Imported)).getTime() > ASOF) {
        tbls[t].nw++;
        var s = String(r.Site || "");
        if (s.length) tbls[t].sites[s] = 1; else tbls[t].blind++;
    } else tbls[t].old++;
});

/* INSERTION ORDER IS A RANKING POLICY, NOT BOOKKEEPING. Broad queries
   tie heavily -- 7 of 13 rank groups inside a measured top 40, one of
   them ten documents deep -- and insertion order fully determines the
   order within a tie (built twice with two collections swapped: same
   ranks, every tied group reversed). What it does not decide is
   membership, which content decides. DESIGN.md §2 has the measurement.

   Quality descending, decided 2026-11-05 and extended 2026-11-14 for
   Gutenberg and Wikibooks: encyclopedia and book text first, forums
   after, specialists last. Wiktionary is held back to 9th because 9.1M
   short dictionary entries would otherwise win every single-word tie,
   and single-word lookups are a separate tool call. iFixit and the
   survival guides go last because a question that wants them is better
   served by restricting to the collection -- which is what the
   compound index on (Doc, Source) is for.

   Keyed on SOURCE, not table name: gutenberg is 39 LCC slices and
   stackexchange 161 sites, each of which is one Source. */
var ORDER = ["wikipedia_en", "wikipedia_en_medicine", "wikisource_en",
             "gutenberg", "wikibooks_en", "wikiversity_en",
             "wikiquote_en", "wikivoyage_en", "wiktionary_en",
             "stackexchange", "stackoverflow", "ifixit", "zimgit"];

function orderOf(t) {
    var i = ORDER.indexOf(sourceFor(t));
    return i < 0 ? ORDER.length : i;     /* unknown Source: last */
}

/* Explicit secondary key rather than relying on a stable sort, so the
   39 gutenberg slices land in the same order on every run. */
function byPolicy(a, b) {
    var d = orderOf(a) - orderOf(b);
    if (d !== 0) return d;
    return a < b ? -1 : a > b ? 1 : 0;
}

var unordered = Object.keys(tbls).filter(function (t) {
    return ORDER.indexOf(sourceFor(t)) < 0;
}).sort();
if (unordered.length) {
    printf("\nNOT IN THE ORDER POLICY -- merged last, in this order:\n");
    unordered.forEach(function (t) {
        printf("  %-22s source %s\n", t, sourceFor(t));
    });
    printf("Decide where they belong (DESIGN.md §2) rather than leaving\n" +
           "them to fall off the end.\n");
}

/* Units of work: a whole table, or one Site of a partly-merged table. */
var work = [], refused = [];
Object.keys(tbls).sort(byPolicy).forEach(function (t) {
    if (ONE && t !== String(ONE)) return;
    var x = tbls[t];
    if (!x.nw) return;                      /* nothing new in this table */
    if (!tableExists(t)) return;
    if (!x.old) {                           /* wholly new -> whole table */
        if (!done[t + "|"]) work.push({ t: t, site: null });
        return;
    }
    /* Partly merged: only Site can separate new rows from old ones. A
       new archive with no Site is unselectable, so refuse rather than
       guess -- inserting the whole table would duplicate the old rows. */
    if (x.blind) {
        refused.push(t + " (" + x.blind + " new archive(s) with no Site; " +
                     "cannot separate from " + x.old + " already merged)");
        return;
    }
    Object.keys(x.sites).sort().forEach(function (s) {
        if (!done[t + "|" + s]) work.push({ t: t, site: s });
    });
});
if (refused.length)
    printf("\nREFUSED (need a discriminator):\n  %s\n", refused.join("\n  "));

/* Count what each unit will contribute, and skip anything already in. */
printf("\n%-22s %-18s %-12s %10s\n", "table", "site filter", "source", "rows");
var total = 0, plan = [], siteCounts = {};
/* One grouped pass per partly-merged table instead of a count per Site:
   four `where Site = ?` counts meant four scans of an 8.2M-row table. */
work.forEach(function (w) {
    if (!w.site || siteCounts[w.t]) return;
    siteCounts[w.t] = {};
    sql.exec("select Site, count(*) c from " + w.t + " group by Site;",
             { maxRows: 5000 },
             function (r) { siteCounts[w.t][String(r.Site)] = Number(r.c); });
});
work.forEach(function (w) {
    var n = 0;
    if (w.site) n = siteCounts[w.t][w.site] || 0;
    else
        sql.exec("select count(*) c from " + w.t + ";", { maxRows: 1 },
                 function (r) { n = Number(r.c); });
    if (!n) return;
    plan.push({ t: w.t, site: w.site, src: sourceFor(w.t), n: n });
    total += n;
    printf("%-22s %-18s %-12s %10d\n", w.t, w.site || "(whole table)",
           sourceFor(w.t), n);
});

/* The destination, on a tree that has never been built. COLUMN ORDER IS
   LOAD-BEARING: the insert below is positional (a named column list is
   accepted, inserts nothing and reports no error), so this is the order
   every later insert depends on. varchar(4096) on Doc is the size hint
   the importer uses, not a limit. */
if (!tableExists("corpus")) {
    sql.exec("create table corpus (" +
             "Id counter, Source varchar(32), Site varchar(64), " +
             "SrcPath varchar(512), Title varchar(256), " +
             "Doc varchar(4096), Nbytes int, Sha varchar(64));");
    printf("created table corpus\n");
}

var before = 0;
sql.exec("select count(*) c from corpus;", { maxRows: 1 },
         function (r) { before = Number(r.c); });
printf("\ninsertion order: quality descending (DESIGN.md §2)\n");
printf("corpus before: %d rows\n", before);
printf("to insert:     %d rows in %d units\n", total, plan.length);
printf("corpus after:  %d rows\n", before + total);

if (!GO) {
    printf("\n--list only; nothing written. Re-run with --go to insert.\n");
    process.exit(0);
}

/* ---- insert ---------------------------------------------------------- */
printf("\ninserting...\n");
var t0 = Date.now(), ins = 0;
plan.forEach(function (p) {
    var p0 = Date.now();
    /* LITERALS, not parameters, inside convert(): a bound ? is typed int
       and the insert fails with "Types for field Source are not
       compatible varchar != int". merge3.js, the working precedent for
       this statement, used a literal too. Interpolation is safe only
       because every value is checked against a strict whitelist first --
       these are table-derived collection names, not input. */
    if (!/^[A-Za-z0-9_-]+$/.test(p.src)) {
        printf("  REFUSED %-22s unsafe Source %j\n", p.t, p.src);
        return;
    }
    if (p.site !== null && !/^[A-Za-z0-9_.-]+$/.test(p.site)) {
        printf("  REFUSED %-22s unsafe Site %j\n", p.t, p.site);
        return;
    }
    var sel = "insert into corpus select counter, " +
              "convert('" + p.src + "','varchar'), Site, SrcPath, Title, " +
              "Doc, Nbytes, convert('','varchar') from " + p.t;
    if (p.site) sel += " where Site = '" + p.site + "'";
    try {
        sql.exec(sel + ";");
    } catch (e) {
        printf("  FAILED %-22s %s\n", p.t, e.message.split("\n")[0]);
        return;
    }
    sql.exec("insert into corpus_merged (TableName, Site, Source, Rows, " +
             "Merged) values (?,?,?,?,?);",
             [p.t, p.site || "", p.src, p.n,
              dateFmt("%Y-%m-%dT%H:%M:%S", new Date())]);
    ins += p.n;
    printf("  %-22s %-18s %8d rows  %.1f s\n", p.t, p.site || "", p.n,
           (Date.now() - p0) / 1000);
    fflush(stdout);
});

var after = 0;
sql.exec("select count(*) c from corpus;", { maxRows: 1 },
         function (r) { after = Number(r.c); });
printf("\ncorpus: %d -> %d rows (+%d, expected +%d) in %.1f min\n",
       before, after, after - before, ins, (Date.now() - t0) / 60000);
if (after - before !== ins)
    printf("MISMATCH: inserted count differs from plan -- investigate "
           + "before running the index optimize.\n");
printf("\nfulltext index NOT updated. New rows are found by linear scan "
       + "until:\n  alter index corpus_cx optimize;\n");
