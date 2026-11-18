#!/usr/bin/env python3
"""Dump ZIM article HTML to JSONL for conversion by rampart.

  python3r zim2jsonl.py <file.zim> <out.jsonl> [--sample N] [--prefix P]

One JSON object per line: {"path":…, "title":…, "html":…}.
With --sample N, draws N random articles (get_random_entry samples the
article list, so redirects and media are not hit).

  WARNING: --sample only sees entries the scraper FLAGGED as articles.
  gutenberg2zim flags its cover and author pages but not its book
  bodies, so --sample 400 on a Gutenberg slice returns 400 navigation
  pages and zero books. Use the full walk there, or sample the entry id
  range (claude-work/gutenberg/gbsample.py).

Without --sample, walks
every entry and emits all text/html ones.  Entry-id order is useless for
sampling -- puzzling.stackexchange has 105k redirects ahead of its
articles -- but fine for a full walk, which skips them cheaply.

Also writes a sidecar <out>.meta.json with the archive's own counts and
its ZIM metadata.  Date becomes the table's Asof and Scraper names the
template family (see import/families.js); both are authoritative, unlike
the filename.
"""
import sys, os, json, argparse
from libzim.reader import Archive

ap = argparse.ArgumentParser()
ap.add_argument("zim"); ap.add_argument("out")
ap.add_argument("--sample", type=int, default=0)
ap.add_argument("--prefix", default="")
o = ap.parse_args()

z = Archive(o.zim)
meta = {"zim": os.path.basename(o.zim),
        "zim_bytes": os.path.getsize(o.zim),
        "all_entry_count": z.all_entry_count,
        "article_count": z.article_count,
        "media_count": z.media_count}

# ZIM metadata.  Keys vary by scraper: iFixit carries no Scraper at all,
# so every lookup is guarded and absent keys are simply left out.
have = set(z.metadata_keys)
for k in ("Date", "Name", "Title", "Scraper", "Creator", "Publisher",
          "Language", "Flavour", "Tags", "Description"):
    if k not in have:
        continue
    try:
        meta["zim" + k] = z.get_metadata(k).decode("utf-8", "replace")
    except Exception as e:
        meta["zim" + k + "_error"] = str(e)

n = html_bytes = 0
seen = set()
with open(o.out, "w", encoding="utf-8") as fh:
    if o.sample:
        tries = 0
        while n < o.sample and tries < o.sample * 40:
            tries += 1
            try:
                e = z.get_random_entry()
                if e.is_redirect or e.path in seen:
                    continue
                if o.prefix and not e.path.startswith(o.prefix):
                    continue
                it = e.get_item()
                if "html" not in it.mimetype:
                    continue
                raw = bytes(it.content)
            except Exception:
                continue
            seen.add(e.path)
            fh.write(json.dumps({"path": e.path, "title": e.title,
                                 "html": raw.decode("utf-8", "replace")}) + "\n")
            n += 1; html_bytes += len(raw)
        meta["tries"] = tries
    else:
        for i in range(z.all_entry_count):
            try:
                e = z.get_entry_by_id(i)
                if e.is_redirect:
                    continue
                if o.prefix and not e.path.startswith(o.prefix):
                    continue
                it = e.get_item()
                if "html" not in it.mimetype:
                    continue
                raw = bytes(it.content)
            except Exception:
                continue
            fh.write(json.dumps({"path": e.path, "title": e.title,
                                 "html": raw.decode("utf-8", "replace")}) + "\n")
            n += 1; html_bytes += len(raw)

meta["docs"] = n
meta["html_bytes"] = html_bytes
with open(o.out + ".meta.json", "w", encoding="utf-8") as fh:
    json.dump(meta, fh)
print("%s: %d docs, %d html bytes -> %s"
      % (meta["zim"], n, html_bytes, o.out))
