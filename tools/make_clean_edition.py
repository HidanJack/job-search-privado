#!/usr/bin/env python3
"""Builds a CLEAN, shareable edition of this repo: no personal data, ready to zip and hand over.

WHITELIST, never a blacklist: only the paths listed in WHITELIST are copied (and,
inside a git checkout, only files git knows about and does not ignore, so state,
node_modules, caches and personal outputs cannot slip in). Every file under
templates/clean_edition/ is then copied over the same relative path: that is how
the personal profile files (CLAUDE.md, the 01-07 profile files, search-queries.md,
the CV and cover-letter examples) become generic placeholders, and where the
edition's README and NOTICE come from.

Before anything is zipped, EVERY file of the output (text, binary read as text,
PDFs through pdftotext, zip members, file names) is scanned against the patterns in
`clean_edition_patterns.txt` (gitignored, never embedded here). Any hit exits
non-zero and no zip is produced. The zip itself is scanned again before it is
moved into place.

Usage:
  python3 tools/make_clean_edition.py [--out DIR] [--patterns FILE]

Pattern file format: one pattern per line; `#` starts a comment; plain text is a
case- and accent-insensitive literal (spaces match any whitespace); `re:` prefixes
a case-insensitive regular expression.
"""
import argparse
import io
import re
import shutil
import subprocess
import sys
import unicodedata
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO.parent / "job-search-edicion-limpia"
PATTERNS_FILE = REPO / "clean_edition_patterns.txt"
TEMPLATES = REPO / "templates" / "clean_edition"
MARKER = ".clean-edition-build"

# Only these paths are ever copied. A trailing "/" is a directory prefix.
WHITELIST = [
    # portal CLIs (node_modules and logs are ignored by git)
    ".agents/skills/",
    # Claude Code commands and generic skills
    ".claude/commands/",
    ".claude/agents/",
    ".claude/settings.json",
    ".claude/skills/job-scraper/SKILL.md",
    ".claude/skills/job-application-assistant/SKILL.md",
    ".claude/skills/job-application-assistant/03-writing-style.md",
    ".claude/skills/job-application-assistant/08-application-forms.md",
    ".claude/skills/job-application-assistant/09-web-research.md",
    ".claude/skills/job-application-assistant/10-ats-and-screening.md",
    ".claude/skills/upskill/SKILL.md",
    # code, tests, dashboard
    "tools/",
    "tests/",
    "ui/",
    "salary_lookup.py",
    # launchers and project files
    "iniciar.sh",
    "detener.sh",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "SETUP.md",
    "CHANGELOG.md",
    ".gitignore",
    ".github/",
    "profile_config.example.json",
    # LaTeX class and fonts for cover letters, mascot used by the README
    "cover_letters/cover.cls",
    "cover_letters/OpenFonts/",
    "assets/mascot/pip_flight_loop.gif",
    # folder skeleton
    "templates/README.md",
    "documents/README.md",
    *[f"documents/{d}/.gitkeep" for d in
      ("applications", "cv", "diplomas", "linkedin", "postings", "projects", "references")],
    "company_research/.gitkeep",
    "job_scraper/.gitkeep",
    "upskill/.gitkeep",
]
# Whitelisted prefixes never shipped, whatever git says.
EXCLUDE_PREFIXES = ("ui/state/", "ui/node_modules/")
EXCLUDE_NAMES = {"__pycache__", "node_modules", ".atl", ".git", "bun.lock"}
EXCLUDE_FILES = {
    ".github/FUNDING.yml",                   # the original author's sponsor links, not ours
    "tools/make_clean_edition.py",           # the generator itself: it needs the private patterns file
    "tests/test_make_clean_edition.py",
}
TRACKER_HEADER = ("date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,"
                  "cv_file,cover_letter_file,source,deadline\n")


class CleanEditionError(Exception):
    pass


# ---- file selection -----------------------------------------------------------
def _git_files(root: Path):
    """Tracked plus untracked-but-not-ignored files, or None outside a git checkout."""
    try:
        out = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=root, capture_output=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return sorted(p for p in out.decode("utf-8").split("\0") if p)


def _walk_files(root: Path):
    out = []
    for p in root.rglob("*"):
        rel = p.relative_to(root)
        if p.is_file() and not (set(rel.parts) & EXCLUDE_NAMES):
            out.append(rel.as_posix())
    return sorted(out)


def whitelisted(rel: str) -> bool:
    if rel in EXCLUDE_FILES or rel.startswith(EXCLUDE_PREFIXES) or rel.endswith("job_scraper/seen_jobs.json"):
        return False
    if set(Path(rel).parts) & EXCLUDE_NAMES or rel.endswith((".pyc", ".pyo")):
        return False
    return any(rel == w or (w.endswith("/") and rel.startswith(w)) for w in WHITELIST)


def select_files(root: Path) -> list[str]:
    files = _git_files(root)
    if files is None:
        files = _walk_files(root)
    return [f for f in files if (root / f).is_file() and whitelisted(f)]


# ---- leak scanner -------------------------------------------------------------
def strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def load_patterns(path: Path):
    """[(label, regex)] from the private patterns file; raises with a clear message when unusable."""
    path = Path(path)
    if not path.is_file():
        raise CleanEditionError(
            f"Leak-scanner pattern file not found: {path}\n"
            "Create it (it is gitignored, one pattern per line, `re:` prefix for regexes) with every "
            "name, email, phone, ID, employer and path that must never ship. The build refuses to run without it."
        )
    patterns = []
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            if line.startswith("re:"):
                patterns.append((line, re.compile(line[3:], re.I)))
            else:
                words = strip_accents(line).split()
                patterns.append((line, re.compile(r"\s+".join(re.escape(w) for w in words), re.I)))
        except re.error as exc:
            raise CleanEditionError(f"{path}:{n}: invalid pattern ({exc})") from exc
    if not patterns:
        raise CleanEditionError(f"{path} has no patterns: refusing to build without a leak check")
    return patterns


def _views(data: bytes) -> list[str]:
    texts = [data.decode("utf-8", errors="ignore"), data.decode("latin-1")]
    if b"\0" in data[:4096]:
        texts.append(data.decode("utf-16le", errors="ignore"))
    return texts + [strip_accents(t) for t in texts]


def _scan_text(label: str, texts, patterns, hits: list) -> None:
    for name, rx in patterns:
        if any(rx.search(t) for t in texts):
            hits.append((label, name))


def _pdf_text(data: bytes) -> str:
    try:
        r = subprocess.run(["pdftotext", "-", "-"], input=data, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.decode("utf-8", errors="ignore")


def scan_bytes(label: str, data: bytes, patterns, hits: list, depth: int = 0) -> None:
    _scan_text(label, _views(data), patterns, hits)
    if data[:5] == b"%PDF-":
        text = _pdf_text(data)
        if text:
            _scan_text(label + " (pdftotext)", [text, strip_accents(text)], patterns, hits)
    if data[:2] == b"PK" and depth < 4:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for info in zf.infolist():
                    _scan_text(f"{label}!{info.filename} (member name)", _views(info.filename.encode()), patterns, hits)
                    if not info.is_dir():
                        scan_bytes(f"{label}!{info.filename}", zf.read(info), patterns, hits, depth + 1)
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError):
            pass


def scan_tree(root: Path, patterns) -> list:
    """Every file under root (and every path name) against the patterns; [(where, pattern)]."""
    hits: list = []
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        _scan_text(f"{rel} (path name)", _views(rel.encode()), patterns, hits)
        if p.is_file() and not p.is_symlink():
            scan_bytes(rel, p.read_bytes(), patterns, hits)
    return hits


def scan_zip(path: Path, patterns) -> list:
    hits: list = []
    scan_bytes(path.name, Path(path).read_bytes(), patterns, hits)
    return hits


# ---- build --------------------------------------------------------------------
def _safe_to_wipe(out: Path) -> None:
    out = out.resolve()
    if out == REPO or REPO.is_relative_to(out) or out.is_relative_to(REPO) or out == Path(out.anchor) or out == Path.home():
        raise CleanEditionError(f"Refusing to use {out} as output: it is the repo, inside it, or contains it.")
    if out.exists() and any(out.iterdir()) and not (out / MARKER).exists():
        raise CleanEditionError(
            f"{out} exists, is not empty and was not created by this script (no {MARKER}). Remove it or pick another --out."
        )


def build_tree(out: Path, root: Path = REPO) -> list[str]:
    """Wipe and recreate `out` with the whitelisted files plus the clean templates. Returns copied paths."""
    out = Path(out)
    _safe_to_wipe(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / MARKER).write_text("Created by tools/make_clean_edition.py; safe to delete.\n", encoding="utf-8")
    copied = []
    for rel in select_files(root):
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / rel, dest)
        copied.append(rel)
    templates = root / "templates" / "clean_edition"
    if not templates.is_dir():
        raise CleanEditionError(f"Missing {templates}: the generic profile templates are required.")
    for src in sorted(templates.rglob("*")):
        if src.is_file():
            rel = src.relative_to(templates).as_posix()
            dest = out / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            if rel not in copied:
                copied.append(rel)
    (out / "job_search_tracker.csv").write_text(TRACKER_HEADER, encoding="utf-8")
    # Upstream-only guards (tests/_upstream.py) must treat this edition as a derivative, not the template.
    (out / ".not-upstream").write_text("Derived edition: upstream-only CI guards do not apply.\n", encoding="utf-8")
    for d in ("cv", "cover_letters", "documents/applications", "reports"):
        (out / d).mkdir(parents=True, exist_ok=True)
    (out / "cv" / ".gitkeep").touch()
    return copied


def make_zip(out: Path, zip_path: Path) -> None:
    out = Path(out)
    tmp = zip_path.with_name(zip_path.name + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(out.rglob("*")):
            if p.name == MARKER:
                continue
            arc = Path(out.name) / p.relative_to(out)
            if p.is_dir():
                zf.write(p, arc.as_posix() + "/")
            else:
                zf.write(p, arc.as_posix())
    tmp.replace(zip_path)


def run(out: Path, patterns_file: Path = PATTERNS_FILE) -> int:
    out = Path(out)
    patterns = load_patterns(patterns_file)
    copied = build_tree(out)
    print(f"Built {out} ({len(copied)} files).")
    hits = scan_tree(out, patterns)
    if hits:
        print(f"\nLEAK SCAN FAILED: {len(hits)} hit(s). No zip produced.", file=sys.stderr)
        for where, pattern in hits:
            print(f"  {where}  <-  {pattern}", file=sys.stderr)
        return 1
    print(f"Leak scan clean ({len(patterns)} patterns, {sum(1 for p in out.rglob('*') if p.is_file())} files).")
    zip_path = out.with_name(out.name + ".zip")
    tmp = zip_path.with_name(zip_path.name + ".tmp")
    zip_path.unlink(missing_ok=True)
    make_zip(out, zip_path)
    zhits = scan_zip(zip_path, patterns)
    if zhits:
        zip_path.unlink(missing_ok=True)
        print("\nZIP LEAK SCAN FAILED. Zip removed.", file=sys.stderr)
        for where, pattern in zhits:
            print(f"  {where}  <-  {pattern}", file=sys.stderr)
        return 1
    tmp.unlink(missing_ok=True)
    print(f"Zip: {zip_path} ({zip_path.stat().st_size / 1e6:.1f} MB), scanned clean.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output directory (default {DEFAULT_OUT})")
    ap.add_argument("--patterns", type=Path, default=PATTERNS_FILE, help="leak-scanner pattern file (gitignored)")
    args = ap.parse_args()
    try:
        return run(args.out, args.patterns)
    except CleanEditionError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
