#!/usr/bin/env python3
"""Index every downloaded ZIM's own metadata into notes/zim-meta.json.

  python3r zim-meta.py <out.json> <dir> [<dir> ...]

Keyed by filename: {scraper, date, name, title, flavour, articles,
entries, media, bytes}.  The import registry (DESIGN.md §19) takes Asof
from `date`, and families.js takes the template family from `scraper`;
both come from the archive itself rather than from its filename.
"""
import sys, os, json, glob
from libzim.reader import Archive

out, dirs = sys.argv[1], sys.argv[2:]

# The output path comes FIRST, which makes `zim-meta.py archive.zim dir`
# an easy slip -- and it truncates the archive before anything else
# happens. Refuse to write over anything that is not plausibly a JSON
# file this script produced.
if os.path.exists(out):
    if not out.endswith(".json"):
        sys.exit("refusing to write over %s: the output path comes first "
                 "and that name is not .json\n"
                 "  usage: zim-meta.py <out.json> <dir> [<dir> ...]" % out)
    if os.path.getsize(out) > 64 * 1024 * 1024:
        sys.exit("refusing to write over %s: %.1f MB is too large to be "
                 "metadata this script wrote"
                 % (out, os.path.getsize(out) / 1048576.0))
res = {}
for d in dirs:
    for f in sorted(glob.glob(os.path.join(d, "*.zim"))):
        base = os.path.basename(f)
        rec = {"dir": d, "bytes": os.path.getsize(f)}
        try:
            z = Archive(f)
            have = set(z.metadata_keys)
            def g(k):
                if k not in have:
                    return None
                try:
                    return z.get_metadata(k).decode("utf-8", "replace")
                except Exception:
                    return None
            rec.update(scraper=g("Scraper"), date=g("Date"), name=g("Name"),
                       title=g("Title"), flavour=g("Flavour"),
                       language=g("Language"), tags=g("Tags"),
                       articles=z.article_count, entries=z.all_entry_count,
                       media=z.media_count)
        except Exception as e:
            rec["error"] = str(e)
        res[base] = rec
        print("%-62s %-18s %-10s %9d articles"
              % (base[:62], (rec.get("scraper") or "-")[:18],
                 rec.get("date") or "-", rec.get("articles") or 0))

with open(out, "w", encoding="utf-8") as fh:
    json.dump(res, fh, indent=1, sort_keys=True)
print("\n%d archives -> %s" % (len(res), out))
