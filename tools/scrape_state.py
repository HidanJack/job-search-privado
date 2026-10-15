#!/usr/bin/env python3
"""Store /scrape results in seen_jobs.json - Step 4's dedup-and-store in code.

Step 4 used to be prose: derive each key with job_key.py, then hand-edit the
state file. Doing that for twenty postings is tedious enough that a headless
run (the dashboard's "Buscar ahora") improvised a throwaway script in /tmp to
do it - a command no allowlist can pre-approve, so the write was denied and the
whole run's results were lost. This is the one sanctioned way to store results.

  add   merge a JSON list of postings into seen_jobs.json

Input is a JSON array of objects with `title, company, url, posted_date,
deadline, fit, status, portal, source`, read from `--file` (which must live
inside job_scraper/ and is removed after a successful merge) or from stdin.

Dedup follows Step 4 exactly: a posting is skipped when its URL matches any
stored entry under any key, or when its company+title (or canonical key)
already exists. Existing entries are never rewritten, so a `ranked` or
`expired` status set by /rank always survives a later scrape. `first_seen` is
set to today. The write is atomic (temp file + rename in the same directory).

Usage:
  python3 tools/scrape_state.py add --file job_scraper/incoming.json
  python3 tools/scrape_state.py add < postings.json

Prints {"added", "skipped", "total"} as JSON. Exit 0 on success, 1 on invalid
input or a path outside job_scraper/.
"""

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from job_key import make_key  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "job_scraper"
STATE_NAME = "seen_jobs.json"

FIELDS = ("title", "company", "url", "posted_date", "deadline", "fit", "status", "portal", "source")
FITS = {"high", "medium", "low"}
STATUSES = {"new", "skipped", "ranked", "expired"}
SOURCES = {"cli", "websearch"}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_URL = 2048


class InputError(ValueError):
    pass


def inside(path: Path, base: Path) -> Path:
    """Resolve `path` and refuse anything outside `base` (symlinks included)."""
    resolved = path.resolve()
    base_resolved = base.resolve()
    if resolved != base_resolved and base_resolved not in resolved.parents:
        raise InputError(f"{path} is outside {base}")
    return resolved


def _norm_url(url: str) -> str:
    return url.strip().rstrip("/")


def _pair(company: str, title: str) -> tuple[str, str]:
    return (" ".join(company.split()).casefold(), " ".join(title.split()).casefold())


def validate(raw) -> list[dict]:
    if not isinstance(raw, list):
        raise InputError("input must be a JSON array of postings")
    clean = []
    for i, item in enumerate(raw):
        where = f"posting #{i}"
        if not isinstance(item, dict):
            raise InputError(f"{where}: expected an object")
        unknown = set(item) - set(FIELDS)
        if unknown:
            raise InputError(f"{where}: unknown fields {sorted(unknown)}")
        for field in ("title", "company", "url", "portal"):
            if not isinstance(item.get(field), str) or not item[field].strip():
                raise InputError(f"{where}: '{field}' must be a non-empty string")
        url = item["url"].strip()
        if len(url) > MAX_URL or not re.match(r"^https?://[^\s/]+", url):
            raise InputError(f"{where}: url must be an http(s) URL")
        for field in ("posted_date", "deadline"):
            value = item.get(field)
            if value is not None and (not isinstance(value, str) or not ISO.match(value)):
                raise InputError(f"{where}: '{field}' must be YYYY-MM-DD or null")
        if item.get("fit") not in FITS:
            raise InputError(f"{where}: 'fit' must be one of {sorted(FITS)}")
        status = item.get("status", "new")
        if status not in STATUSES:
            raise InputError(f"{where}: 'status' must be one of {sorted(STATUSES)}")
        if item.get("source") not in SOURCES:
            raise InputError(f"{where}: 'source' must be one of {sorted(SOURCES)}")
        clean.append({
            "title": item["title"].strip(),
            "company": item["company"].strip(),
            "url": url,
            "posted_date": item.get("posted_date"),
            "deadline": item.get("deadline"),
            "fit": item["fit"],
            "status": status,
            "portal": item["portal"].strip(),
            "source": item["source"],
        })
    return clean


def load(path: Path) -> tuple[dict, dict]:
    if not path.is_file():
        doc = {"seen": {}}
        return doc, doc["seen"]
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise InputError(f"{path} is not valid JSON: {exc}") from exc
    seen = doc.get("seen") if isinstance(doc, dict) and "seen" in doc else doc
    if not isinstance(seen, dict):
        raise InputError(f"{path}: expected an object of job entries")
    return doc, seen


def save(path: Path, doc: dict) -> None:
    """Atomic replace: a half-written seen_jobs.json loses the scrape history."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".seen_jobs.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def add(state: Path, postings: list[dict], today: str) -> dict:
    doc, seen = load(state)
    urls = {_norm_url(e.get("url") or "") for e in seen.values() if isinstance(e, dict)}
    urls.discard("")
    pairs = {_pair(e.get("company") or "", e.get("title") or "") for e in seen.values() if isinstance(e, dict)}
    added = skipped = 0
    for post in postings:
        key = make_key(post["company"], post["title"], post["url"])
        url = _norm_url(post["url"])
        pair = _pair(post["company"], post["title"])
        if url in urls or key in seen or pair in pairs:
            skipped += 1
            continue
        seen[key] = {
            "title": post["title"],
            "company": post["company"],
            "url": post["url"],
            "first_seen": today,
            "posted_date": post["posted_date"],
            "deadline": post["deadline"],
            "fit": post["fit"],
            "status": post["status"],
            "portal": post["portal"],
            "source": post["source"],
        }
        urls.add(url)
        pairs.add(pair)
        added += 1
    if added:
        save(state, doc)
    return {"added": added, "skipped": skipped, "total": len(seen)}


def _force_utf8_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)  # absent on a StringIO under test
        if reconfigure:
            reconfigure(encoding="utf-8")


def main(argv=None, base: Path = BASE, stdin=None) -> int:
    _force_utf8_output()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_add = sub.add_parser("add", help="merge postings into seen_jobs.json")
    p_add.add_argument("--file", type=Path, help="JSON array inside job_scraper/ (removed on success)")
    p_add.add_argument("--state", type=Path, default=None, help="state file inside job_scraper/ (default seen_jobs.json)")
    p_add.add_argument("--today", default=None, help="override today's date (YYYY-MM-DD)")
    args = ap.parse_args(argv)

    try:
        state = inside(args.state, base) if args.state else (base / STATE_NAME)
        today = args.today or date.today().isoformat()
        if not ISO.match(today):
            raise InputError("--today must be YYYY-MM-DD")
        if args.file:
            source = inside(args.file, base)
            if not source.is_file():
                raise InputError(f"{args.file} not found")
            text = source.read_text(encoding="utf-8")
        else:
            source = None
            text = (stdin or sys.stdin).read()
        try:
            raw = json.loads(text)
        except json.JSONDecodeError as exc:
            raise InputError(f"input is not valid JSON: {exc}") from exc
        result = add(state, validate(raw), today)
    except InputError as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    if source is not None:
        source.unlink(missing_ok=True)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
