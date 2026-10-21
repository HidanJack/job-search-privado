#!/usr/bin/env python3
"""Deterministically turn a confirmed onboarding proposal into the user's profile files.

Reads ui/state/onboarding/proposal.json (written by /onboard, edited and confirmed
by the user), validates it with tools/onboarding_proposal.py and writes, atomically:

  profile_config.json                                        numbers, languages, search families, prefilter keywords
  CLAUDE.md                                                  title/role lines + the "## Candidate Profile" section
  .claude/skills/job-application-assistant/01-candidate-profile.md

Rules: only facts present in the proposal are written (a null field is omitted, never
replaced by a guess); inferred skills/languages get a trailing `<!-- inferred -->`
comment; existing files are copied to ui/state/backups/onboarding-<timestamp>/ first;
re-running with the same proposal changes nothing (no rewrite, no new backup); an
invalid proposal, or one with a field that looks like an instruction to an AI,
changes nothing. In the author's PRIVATE checkout (tools/make_clean_edition.py is
there) it refuses to run unless --force-private is passed, so his real profile is
never overwritten by accident.

Usage: python3 tools/onboarding_apply.py [--root DIR] [--proposal FILE]
           [--current-salary MXN] [--force-private]
Prints {"ok": true, "written": [...], "backups": [...], "unchanged": [...]} or, with
exit code 2, {"ok": false, "error": code, "message": "...", "details": [...]}.
"""
import argparse
import json
import math
import os
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import onboarding_proposal  # noqa: E402
import profile_config  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PROPOSAL_REL = "ui/state/onboarding/proposal.json"
PROFILE_REL = ".claude/skills/job-application-assistant/01-candidate-profile.md"
STRONG_POINTS, SECONDARY_POINTS, STACK_CAP = 10, 5, 28
MAX_TERMS = 12
LEVEL_ORDER = {"A1": 1, "A2": 2, "B1": 3, "B2": 4, "C1": 5, "C2": 6, "native": 6}
CONFIDENTIALITY = (
    "> **CONFIDENTIALITY RULE (hard):** never name your employer's or clients' end customers in any CV, cover letter,\n"
    "> form answer or message when your contract or common sense forbids it. Describe them generically (\"a\n"
    "> manufacturing client\", \"a media-sector client\"). Client names may appear in internal analysis documents\n"
    "> only; they must never reach a generated application document."
)


class ApplyError(Exception):
    def __init__(self, code: str, message: str, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or []


# ---- helpers ----------------------------------------------------------------
def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).lower()


def _cell(s) -> str:
    return str(s or "").replace("|", "/").strip()


def _word(term: str) -> str:
    """A profile_config prefilter word: lowercase, accent-free, regex-escaped."""
    return re.escape(_fold(term).strip())


def _uniq(items):
    seen, out = set(), []
    for x in items:
        key = _fold(x)
        if key and key not in seen:
            seen.add(key)
            out.append(x)
    return out


def _level_text(l: dict) -> str:
    parts = [f"{k} {l[k]}" for k in ("read", "write", "speak") if l.get(k)]
    return ", ".join(parts) if parts else "level not stated"


def _mark(inferred) -> str:
    return " <!-- inferred -->" if inferred else ""


def _period(start, end) -> str:
    if start and end:
        return f"{start} - {end}"
    return start or end or ""


# ---- rendering --------------------------------------------------------------
def _links(identity: dict):
    li, gh, other = None, None, []
    for u in identity.get("links") or []:
        host = re.sub(r"^https?://", "", u, flags=re.I).split("/")[0].lower()
        if host.endswith("linkedin.com") and not li:
            li = u
        elif host.endswith("github.com") and not gh:
            gh = u
        else:
            other.append(u)
    return li, gh, other


def _skill_line(s: dict) -> str:
    extra = " - ".join(x for x in (s.get("level"), s.get("evidence")) if x)
    return f"- **{s['name']}**" + (f" ({extra})" if extra else "") + _mark(s["inferred"])


def _work_mode(p: dict) -> str:
    t = p["targets"]
    mode = {"remote": "remote", "hybrid": "hybrid", "onsite": "on-site", "any": "any work mode"}.get(t.get("remote") or "", "")
    return ", ".join(x for x in (f"prefers {mode}" if mode else "", t.get("location") and f"target location: {t['location']}") if x)


def render_claude_section(p: dict, floor) -> str:
    ident, t = p["identity"], p["targets"]
    lines = ["## Candidate Profile", "", "### Identity", f"- **Name:** {ident.get('name') or ''}".rstrip()]
    loc = " ".join(x for x in (ident.get("location"), f"({_work_mode(p)})" if _work_mode(p) else "") if x)
    if loc:
        lines.append(f"- **Location:** {loc}")
    if p["languages"]:
        lines += ["- **Languages:**", "  | Language | Level |", "  |----------|-------|"]
        for l in p["languages"]:
            lines.append(f"  | {_cell(l['language'])} | {_cell(_level_text(l))}{_mark(l['inferred'])} |")
    lines += [
        "- **CV language:** match posting",
        "- **Freshness window:** 4 days",
        "- **FX to MXN:** USD=18.5",
        f"- **Salary floor:** {floor if floor else '(not set)'} MXN/month",
        "- **Never in documents:** photo, age, marital status, ID numbers, expected salary.",
        "",
    ]
    if p["summary"]:
        lines += ["### Profile summary", p["summary"], ""]
    if p["education"]:
        lines.append("### Education")
        for e in p["education"]:
            head = " - ".join(x for x in (e.get("degree"), e.get("institution")) if x)
            tail = ", ".join(x for x in (e.get("status"), _period(e.get("start"), e.get("end"))) if x)
            lines.append(f"- **{head}**" + (f" ({tail})" if tail else ""))
        lines.append("")
    if p["experience"]:
        lines.append("### Professional Experience")
        for e in p["experience"]:
            head = " - ".join(x for x in (f"**{e['title']}**" if e.get("title") else "", f"**{e['company']}**" if e.get("company") else "") if x)
            per = _period(e.get("start"), e.get("end"))
            lines.append(f"- {head}" + (f" ({per})" if per else ""))
            lines += [f"  - {h}" for h in e["highlights"]]
        lines.append("")
    strong, second = p["stack"]["strong"], p["stack"]["secondary"]
    named = {_fold(x) for x in strong + second}
    other = [s for s in p["skills"] if _fold(s["name"]) not in named]
    if p["skills"] or strong or second:
        lines.append("### Technical Skills")
        if strong:
            lines.append(f"- **Primary:** {', '.join(strong)}")
        if second:
            lines.append(f"- **Secondary:** {', '.join(second)}")
        if other:
            lines.append("- **Other:** " + ", ".join(f"{s['name']}{_mark(s['inferred'])}" for s in other))
        lines.append("")
    if t["roles"]:
        lines += ["### Target Roles", f"- **Primary families:** {', '.join(t['roles'])}", ""]
    if floor:
        lines += ["### Deal-breakers", f"- Salary below {floor} MXN/month", ""]
    return "\n".join(lines).rstrip() + "\n\n"


def render_profile_md(p: dict, frontmatter: str) -> str:
    ident = p["identity"]
    li, gh, other = _links(ident)
    L = []
    if frontmatter:
        L += [frontmatter.rstrip("\n"), ""]
    L += ["# Candidate Profile", "", CONFIDENTIALITY, "", "## Identity", f"- **Name:** {ident.get('name') or ''}".rstrip()]
    for label, val in (("Location", ident.get("location")), ("Phone", ident.get("phone")), ("Email", ident.get("email")),
                       ("LinkedIn", li), ("GitHub", gh), ("Other links", ", ".join(other)), ("Constraints", _work_mode(p))):
        if val:
            L.append(f"- **{label}:** {val}")
    L.append("- **Never include:** photo, age, marital status, ID numbers, expected salary (salary goes only in form fields)")
    if p["summary"]:
        L.append(f"- **Profile summary:** {p['summary']}")
    ye = p["years_experience"]
    if ye.get("value") is not None:
        L.append(f"- **Years of experience:** {ye['value']}" + (f" - {ye['basis']}" if ye.get("basis") else ""))
    L.append("")
    if p["languages"]:
        L += ["### Languages", "", "| Language | Level | Notes |", "|----------|-------|-------|"]
        for l in p["languages"]:
            L.append(f"| {_cell(l['language'])} | {_cell(_level_text(l))} | {'inferred, not stated' if l['inferred'] else ''} |".replace("|  |", "| |"))
        L.append("")
    if p["education"]:
        L += ["## Education", "", "| Degree | Period | Institution | Status |", "|--------|--------|-------------|--------|"]
        for e in p["education"]:
            period = _period(e.get("start"), e.get("end"))
            L.append(f"| {_cell(e.get('degree'))} | {_cell(period)} | {_cell(e.get('institution'))} | {_cell(e.get('status'))} |")
        L.append("")
    if p["experience"]:
        L.append("## Professional Experience")
        for e in p["experience"]:
            head = " - ".join(x for x in (e.get("title"), e.get("company")) if x)
            per = _period(e.get("start"), e.get("end"))
            L += ["", f"### {head}" + (f" ({per})" if per else "")]
            L += [f"- {h}" for h in e["highlights"]]
        L.append("")
    if p["skills"]:
        L += ["## Technical Skills", ""]
        L += [_skill_line(s) for s in p["skills"]]
        L.append("")
    return "\n".join(L).rstrip() + "\n"


# ---- profile_config.json ----------------------------------------------------
def _catalog(root: Path):
    """[(id, {lowercase label/id/query names})] from the market catalog in ui/lib/skills.ts, if present."""
    path = root / "ui" / "lib" / "skills.ts"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    out = []
    for m in re.finditer(r'\{ id: "([a-z_]+)", label: "([^"]+)", queries: \[([^\]]*)\]', text):
        names = {m.group(1).replace("_", " "), _fold(m.group(2)), *(_fold(q) for q in re.findall(r'"([^"]+)"', m.group(3)))}
        out.append((m.group(1), names))
    return out


def derive_config(p: dict, root: Path, existing: dict, current_salary):
    cfg = dict(existing)
    cfg["name"] = p["identity"].get("name") or existing.get("name", "")
    val = p["years_experience"].get("value")
    if val is not None:
        cfg["candidate_years"] = min(60, int(math.floor(val)))
    if p["targets"].get("salary_floor_mxn"):
        cfg["salary_floor_mxn"] = p["targets"]["salary_floor_mxn"]
    if current_salary:
        cfg["current_salary_mxn"] = current_salary

    langs = {_fold(l["language"]): l for l in p["languages"]}
    en = langs.get("english") or langs.get("ingles")
    cfg["spoken_english"] = bool(en and LEVEL_ORDER.get(en.get("speak") or "", 0) >= LEVEL_ORDER["B2"])
    cfg["languages"] = [{"language": l["language"], "read": l["read"], "write": l["write"], "speak": l["speak"]}
                        for l in p["languages"]]
    cfg["search"] = {**(existing.get("search") if isinstance(existing.get("search"), dict) else {}),
                     "families": [{"name": f["name"], "queries": f["queries"]} for f in p["search_families"] if f["queries"]]}
    if not cfg["search"]["families"]:
        del cfg["search"]["families"]  # nothing usable: the neutral default families apply

    strong = _uniq(p["stack"]["strong"])[:MAX_TERMS]
    second = [s for s in _uniq(p["stack"]["secondary"]) if _fold(s) not in {_fold(x) for x in strong}][:MAX_TERMS]
    avoid = _uniq(p["stack"]["avoid"])[:MAX_TERMS]
    skill_names = [s["name"] for s in p["skills"]]
    pre = dict(existing.get("prefilter") if isinstance(existing.get("prefilter"), dict) else {})
    if strong or second:
        pre["stack_points"] = ([{"words": [_word(t)], "points": STRONG_POINTS} for t in strong]
                               + [{"words": [_word(t)], "points": SECONDARY_POINTS} for t in second])
        pre["stack_cap"] = STACK_CAP
    keep = _uniq(strong + second + skill_names)
    keep = [_word(k) for k in keep if 0 < len(k) <= 25][:40]
    if keep:
        pre["skill_keep"] = keep
    mine = {_fold(x) for x in strong + second + skill_names}
    pre["stack_only"] = [e for e in profile_config.DEFAULTS["prefilter"]["stack_only"]
                         if not any(_fold(w) in mine or _fold(e["label"]) in mine for w in e["words"])]
    if avoid:
        pre["off_stack"] = {"words": [_word(a) for a in avoid], "points": -8}
    spanish = langs.get("spanish") or langs.get("espanol")
    pre["spanish_title_bonus"] = 6 if spanish and max(LEVEL_ORDER.get(spanish.get(k) or "", 0) for k in ("read", "write")) >= LEVEL_ORDER["B2"] else 0
    cfg["prefilter"] = pre

    catalog = _catalog(root)
    if catalog:
        ordered = _uniq(strong + skill_names + second)
        ids = []
        for term in ordered:
            for cid, names in catalog:
                if _fold(term) in names and cid not in ids:
                    ids.append(cid)
        if ids:
            skills = dict(existing.get("skills") if isinstance(existing.get("skills"), dict) else {})
            skills["selected"] = ids[:12]
            skills["primary"] = ids[0]
            cfg["skills"] = skills
    return cfg


# ---- file plumbing ----------------------------------------------------------
def _claude_md(old: str, p: dict, floor) -> str:
    start = old.find("## Candidate Profile")
    end = old.find("\n## Repo Structure")
    if start < 0 or end < 0 or end < start:
        raise ApplyError("template_unrecognised",
                         "CLAUDE.md no tiene las secciones «Candidate Profile» y «Repo Structure»; no se tocó nada.")
    name = p["identity"].get("name") or ""
    head = old[:start]
    head = re.sub(r"^# Job Application Assistant for .*$", f"# Job Application Assistant for {name}", head, count=1, flags=re.M)
    head = re.sub(r"(application assistant for )[^,\n]+(, helping with)", lambda m: f"{m.group(1)}{name}{m.group(2)}", head, count=1)
    return head + render_claude_section(p, floor) + old[end + 1:]


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def apply(proposal, root=ROOT, *, current_salary_mxn=None, force_private=False, now=None) -> dict:
    root = Path(root)
    res = onboarding_proposal.validate(proposal)
    if not res.ok:
        raise ApplyError("invalid_proposal", "La propuesta no es válida; no se escribió nada.", res.errors)
    if res.flagged:
        raise ApplyError("flagged", "Hay campos que parecen instrucciones para una IA: edítalos o bórralos y vuelve a confirmar.",
                         [{"path": f, "message": "parece una instrucción"} for f in res.flagged])
    if (root / "tools" / "make_clean_edition.py").exists() and not force_private:
        raise ApplyError("private_repo", "Este es el repositorio privado del autor: se niega a sobrescribir su perfil "
                         "(usa --force-private si de verdad quieres hacerlo).")
    if current_salary_mxn is not None and (isinstance(current_salary_mxn, bool) or not isinstance(current_salary_mxn, int)
                                           or not 1 <= current_salary_mxn <= 1_000_000):
        raise ApplyError("invalid_proposal", "El sueldo actual debe ser un entero entre 1 y 1,000,000.")
    p = res.proposal

    cfg_path = root / "profile_config.json"
    try:
        existing = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
        existing = existing if isinstance(existing, dict) else {}
    except (OSError, ValueError):
        existing = {}
    claude_path, prof_path = root / "CLAUDE.md", root / PROFILE_REL
    if not claude_path.exists():
        raise ApplyError("template_unrecognised", "No se encontró CLAUDE.md; no se escribió nada.")
    cfg = derive_config(p, root, existing, current_salary_mxn)
    floor = cfg.get("salary_floor_mxn") if (p["targets"].get("salary_floor_mxn") or "salary_floor_mxn" in existing) else None
    old_prof = prof_path.read_text(encoding="utf-8") if prof_path.exists() else ""
    fm = re.match(r"^---\n.*?\n---\n", old_prof, re.S)
    outputs = {
        "profile_config.json": json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
        "CLAUDE.md": _claude_md(claude_path.read_text(encoding="utf-8"), p, floor),
        PROFILE_REL: render_profile_md(p, fm.group(0) if fm else ""),
    }

    changed = {}
    for rel, text in outputs.items():
        path = root / rel
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            changed[rel] = text
    backups, written = [], []
    if changed:
        stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
        bdir = root / "ui" / "state" / "backups" / f"onboarding-{stamp}"
        n = 1
        while bdir.exists():
            n += 1
            bdir = root / "ui" / "state" / "backups" / f"onboarding-{stamp}-{n}"
        for rel in changed:
            src = root / rel
            if src.exists():
                dest = bdir / Path(rel).name
                _atomic_write(dest, src.read_text(encoding="utf-8"))
                backups.append(dest.relative_to(root).as_posix())
        for rel, text in changed.items():
            _atomic_write(root / rel, text)
            written.append({"path": rel, "bytes": len(text.encode("utf-8"))})
    return {"ok": True, "written": written, "backups": backups,
            "unchanged": [rel for rel in outputs if rel not in changed]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, default=ROOT)
    ap.add_argument("--proposal", type=Path, default=None, help=f"default: <root>/{PROPOSAL_REL}")
    ap.add_argument("--current-salary", type=int, default=None, help="monthly MXN; only written when given")
    ap.add_argument("--force-private", action="store_true")
    args = ap.parse_args(argv)
    path = args.proposal or args.root / PROPOSAL_REL
    for stream in (sys.stdout,):
        if getattr(stream, "reconfigure", None):
            stream.reconfigure(encoding="utf-8")
    try:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise ApplyError("invalid_proposal", "No hay una propuesta válida que aplicar.")
        out = apply(raw, args.root, current_salary_mxn=args.current_salary, force_private=args.force_private)
    except ApplyError as exc:
        print(json.dumps({"ok": False, "error": exc.code, "message": str(exc), "details": exc.details}, ensure_ascii=False))
        return 2
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
