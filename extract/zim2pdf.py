#!/usr/bin/env python3
"""Extract the PDF entries of a ZIM to files, for rampart-totext.

  python3r zim2pdf.py <file.zim> <outdir>

Writes each application/pdf entry to <outdir>/NNNN.pdf and a manifest
<outdir>/manifest.json listing {path, title, size, file} per PDF plus
the archive's own metadata, so the importer can set Site and Asof
without reopening the ZIM.

nautiluszim archives are file collections, not scraped sites: a landing
page, a bundled PDF.js/video.js viewer, and the content as files/*.pdf.
There are only two HTML entries, so the HTML path gets nothing and the
text has to come out of the PDFs.
The ZIM entry title is only the filename ("files/Water (1).pdf") and
the PDF's own metadata title is often junk ("22\\wq22.PDF"), so real
titles come from the archive's own database.js, which nautiluszim
writes as a list of {ti, dsc, aut, fp} records keyed by filename.
"""
import sys, os, json, re, ast
from libzim.reader import Archive

if len(sys.argv) < 3:
    sys.exit(__doc__)
zim, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)

z = Archive(zim)
have = set(z.metadata_keys)


def meta(k):
    if k not in have:
        return None
    try:
        return z.get_metadata(k).decode("utf-8", "replace")
    except Exception:
        return None


man = {"zim": os.path.basename(zim),
       "zim_bytes": os.path.getsize(zim),
       "zimDate": meta("Date"), "zimName": meta("Name"),
       "zimTitle": meta("Title"), "zimScraper": meta("Scraper"),
       "zimTags": meta("Tags"), "zimDescription": meta("Description"),
       "pdfs": []}

# nautiluszim's own catalogue: titles, descriptions and authors.
# It is a JS literal in Python-dict style (single quotes), so it parses
# with ast.literal_eval once the "var DATABASE =" wrapper is stripped.
cat = {}
try:
    e = z.get_entry_by_path("database.js")
    src = bytes(e.get_item().content).decode("utf-8", "replace")
    m = re.search(r"\[\s*(\{.*\})\s*,?\s*\]", src, re.S)
    if m:
        for rec in ast.literal_eval("[" + m.group(1) + "]"):
            for fp in (rec.get("fp") or []):
                cat[os.path.basename(str(fp))] = {
                    "title": rec.get("ti"), "desc": rec.get("dsc"),
                    "author": rec.get("aut")}
    man["catalogue"] = len(cat)
except Exception as ex:
    print("  no database.js catalogue: %s" % ex, file=sys.stderr)
    man["catalogue"] = 0

n = total = 0
for i in range(z.all_entry_count):
    try:
        e = z.get_entry_by_id(i)
        if e.is_redirect:
            continue
        it = e.get_item()
        if not it.mimetype.startswith("application/pdf"):
            continue
        blob = bytes(it.content)
    except Exception as ex:
        print("  skip entry %d: %s" % (i, ex), file=sys.stderr)
        continue
    fn = "%04d.pdf" % n
    with open(os.path.join(outdir, fn), "wb") as fh:
        fh.write(blob)
    c = cat.get(os.path.basename(e.path), {})
    man["pdfs"].append({"path": e.path, "title": c.get("title") or e.title,
                        "desc": c.get("desc"), "author": c.get("author"),
                        "fromCatalogue": bool(c),
                        "size": len(blob), "file": fn})
    n += 1
    total += len(blob)

with open(os.path.join(outdir, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(man, fh, indent=1)
print("%s: %d PDFs, %d bytes -> %s" % (man["zim"], n, total, outdir))
