#!/usr/bin/env python3
"""Deterministic (LLM-free) prefilter for unranked jobs.

The sweep can add hundreds of postings at once and `/rank` is slow and costs
LLM usage per job. This scores every `new` job from the fields the scraper
already stored (title, company, location, portal, posted_date, fit, salary
when present) against Luis's skills and role families, and:

  * marks clearly off-target jobs `prefiltered_out` with a short Spanish
    reason (SAP/Murex/Java-only/.NET-only/mobile-only/sales/marketing/HR/
    accounting titles, Staff/Principal/Director/Head seniority, Portuguese
    postings, postings restricted to another country). They are never deleted
    and never sent to /rank; `recover` puts one back in the pending pool.
  * stores `prefilter_score` (0-100) on the rest, which `rank_state.py
    candidates` uses to hand /rank the best N first.

Rules are intentionally conservative: when in doubt a job is kept and merely
scores low, because a false negative (a good job discarded) costs more than
one extra LLM call. Tech-stack exclusions are overridden by a positive skill
keyword in the title (`SAP` + `Python` stays).

Usage:
  python3 tools/prefilter.py run [--write] [--state PATH]
  python3 tools/prefilter.py recover KEY [--state PATH]
  python3 tools/prefilter.py evaluate --title T [--company C] [--location L]
"""
import argparse
import json
import re
import sys
import unicodedata
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "job_scraper" / "seen_jobs.json"
SETTINGS = ROOT / "ui" / "state" / "settings.json"

OUT_STATUS = "prefiltered_out"
DEFAULT_RANK_BATCH = 25
DEFAULT_MIN_SALARY = 35000
DEFAULT_MAX_DAYS = 7
CURRENT_SALARY = 21000


def load_search_settings(path: Path = SETTINGS) -> dict:
    """ui/state/settings.json["search"] merged over the same defaults the UI uses."""
    out = {
        "rankBatch": DEFAULT_RANK_BATCH,
        "minSalaryMxn": DEFAULT_MIN_SALARY,
        "maxDays": DEFAULT_MAX_DAYS,
        "currentSalary": CURRENT_SALARY,
    }
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return out
    if not isinstance(doc, dict):
        return out
    search = doc.get("search") if isinstance(doc.get("search"), dict) else {}
    for key in ("rankBatch", "minSalaryMxn", "maxDays"):
        value = search.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            out[key] = value
    current = doc.get("currentSalary")
    if isinstance(current, int) and not isinstance(current, bool) and current > 0:
        out["currentSalary"] = current
    return out


def fold(text) -> str:
    """Lowercase and strip accents so "diseñador"/"inglés" match plain rules."""
    text = unicodedata.normalize("NFKD", str(text or "").lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def rx(*words: str) -> "re.Pattern":
    return re.compile(r"(?<![a-z0-9])(?:" + "|".join(words) + r")(?![a-z0-9])")


# ---- exclusion rules (title based) -----------------------------------------
# A positive skill keyword in the title overrides STACK_ONLY / MOBILE rules.
SKILL_KEEP = rx(
    "python", "data", "datos", "ai", "ia", "ml", "llm", "etl", "machine learning",
    "typescript", "react", "node", "nodejs", "rust", "fastapi", "django", "flask",
    "automation", "automatizacion", "rpa",
)
# Engineering-role words: keep a "Marketing Technology Engineer" out of the
# function-based exclusions.
ENGINEER_WORDS = rx(
    "engineer", "engineering", "developer", "programmer", "ingeniero", "ingeniera",
    "desarrollador", "desarrolladora", "programador", "data scientist", "devops", "sre",
)
SENIORITY_OUT = rx("staff", "principal", "director", "head", "vp", "vice president", "chief", "cto", "distinguished")
SENIORITY_LABEL = {
    "staff": "Staff", "principal": "Principal", "director": "Director", "head": "Head",
    "vp": "VP", "vice president": "VP", "chief": "Chief", "cto": "CTO", "distinguished": "Distinguished",
}
# (pattern, label) - roles on a stack Luis does not work on.
STACK_ONLY = [
    (rx("sap", "abap"), "SAP"),
    (rx("murex"), "Murex"),
    (rx("salesforce"), "Salesforce"),
    (rx("servicenow"), "ServiceNow"),
    (rx("workday"), "Workday"),
    (rx("netsuite"), "NetSuite"),
    (rx("concur"), "Concur"),
    (rx("peoplesoft", "oracle ebs", "oracle fusion"), "Oracle ERP"),
    (rx("dynamics 365", "dynamics crm"), "Dynamics"),
    (rx("mainframe", "cobol"), "Mainframe/COBOL"),
    (rx("java"), "Java"),
    (rx("net", "dotnet", "c#", "asp net", "csharp"), ".NET"),
    (rx("php", "laravel"), "PHP"),
    (rx("ruby", "rails"), "Ruby"),
    (rx("c\\+\\+", "embedded", "firmware"), "C++/embebido"),
]
MOBILE = (rx("ios", "android", "swift", "kotlin", "mobile", "movil"), "móvil")
MOBILE_KEEP = rx("react native", "flutter")
# (pattern, Spanish label) - business functions that are not engineering.
FUNCTION_OUT = [
    (rx("sales", "ventas", "vendedor", "vendedora", "account executive", "account manager", "business development", "sdr", "bdr"), "ventas"),
    (rx("marketing", "growth", "seo", "sem", "brand", "publicidad"), "marketing"),
    (rx("recruiter", "recruiting", "talent acquisition", "hr", "human resources", "recursos humanos", "people partner", "reclutador", "reclutadora", "compensation"), "recursos humanos"),
    (rx("accountant", "accounting", "bookkeeper", "contador", "contadora", "contable", "payroll", "nomina", "billing", "cobranza", "tax"), "contabilidad"),
    (rx("customer success", "customer support", "customer service", "call center", "contact center", "agente", "agent", "appointment setter", "atencion a clientes"), "atención a clientes"),
    (rx("project manager", "program manager", "product manager", "scrum master", "producto manager"), "gestión de proyectos/producto"),
    (rx("designer", "disenador", "disenadora", "vfx", "animator", "illustrator", "video editor", "compositor", "cad"), "diseño"),
    (rx("community manager", "content writer", "copywriter", "content creator", "content designer", "translator", "traductor"), "contenido"),
    (rx("legal", "attorney", "lawyer", "abogado", "counsel", "paralegal"), "legal"),
    (rx("teacher", "tutor", "profesor", "education", "instructor", "nurse", "enfermera", "healthcare"), "educación/salud"),
    (rx("assistant", "asistente", "secretary", "receptionist"), "asistencia administrativa"),
]
PORTUGUESE = rx(
    "engenheiro", "engenheira", "desenvolvedor", "desenvolvedora", "vaga", "estagio",
    "qualidade", "pessoa engenheira", "analista de qualidade", "cientista",
)
# Countries/regions that exclude a Mexico-based candidate when they are the
# only place named. Anything unrecognised is kept.
FOREIGN_PLACES = [
    "brazil", "brasil", "argentina", "venezuela", "colombia", "chile", "peru", "uruguay",
    "ecuador", "bolivia", "paraguay", "costa rica", "panama", "guatemala", "dominican",
    "india", "pakistan", "philippines", "indonesia", "vietnam", "china", "japan", "singapore",
    "australia", "new zealand", "europe", "emea", "uk", "united kingdom", "ireland", "germany",
    "france", "spain", "portugal", "italy", "poland", "romania", "netherlands", "nigeria",
    "kenya", "south africa", "egypt", "turkey", "ukraine", "canada", "usa", "united states",
    "us only", "u.s.",
]
TRUNCATED_LOCATION = 190
LOCATION_OK = ("mexico", "worldwide", "anywhere", "latam", "latin america", "americas", "global", "north america", "international")


def location_restriction(location) -> str | None:
    """Foreign place name when the posting is limited to it, else None."""
    loc = fold(location)
    # The sweep stores at most 200 characters: a cut-off list may hide Mexico.
    if len(loc) >= TRUNCATED_LOCATION or not loc or loc == "none" or any(t in loc for t in LOCATION_OK):
        return None
    for place in FOREIGN_PLACES:
        if re.search(r"(?<![a-z])" + re.escape(place) + r"(?![a-z])", loc):
            return place.title() if len(place) > 3 else place.upper()
    return None


def exclusion(entry: dict) -> str | None:
    """Spanish reason the job is clearly off-target, or None to keep it."""
    title = fold(entry.get("title"))
    keep_skill = bool(SKILL_KEEP.search(title))
    is_engineer = bool(ENGINEER_WORDS.search(title))

    m = SENIORITY_OUT.search(title)
    if m:
        label = SENIORITY_LABEL.get(m.group(0), m.group(0).title())
        return f"Nivel {label}: muy por encima de tus ~3.5 años"
    if PORTUGUESE.search(title):
        return "Anuncio en portugués"
    for pattern, label in STACK_ONLY:
        if pattern.search(title) and not keep_skill:
            return f"Puesto centrado en {label}, fuera de tu stack"
    pattern, label = MOBILE
    if pattern.search(title) and not MOBILE_KEEP.search(title) and not keep_skill:
        return "Puesto solo de desarrollo móvil (iOS/Android)"
    for pattern, label in FUNCTION_OUT:
        if pattern.search(title) and not is_engineer and not keep_skill:
            return f"Puesto de {label}, no es desarrollo ni datos"
    place = location_restriction(entry.get("location"))
    if place:
        return f"Solo para residentes de {place}"
    return None


# ---- scoring (kept jobs) -----------------------------------------------------
BASE_SCORE = 30
# (pattern, points): role families and skills named in the title. First hit of
# each group counts once, so "Python Data Engineer" is not triple-counted.
SKILL_POINTS = [
    (rx("python"), 25),
    (rx("data engineer", "ingeniero de datos", "ingeniera de datos", "etl", "data pipeline", "dwh", "big data"), 18),
    (rx("ai", "ia", "ml", "llm", "machine learning", "inteligencia artificial", "genai", "nlp"), 15),
    (rx("backend", "back end", "back-end", "api"), 12),
    (rx("fastapi", "django", "flask", "pandas", "polars", "ocr"), 8),
    (rx("software engineer", "software developer", "developer", "desarrollador", "desarrolladora", "ingeniero de software", "programador"), 8),
    (rx("rpa", "automation", "automatizacion", "automate"), 8),
    (rx("data analyst", "analista de datos", "bi analyst", "business intelligence", "data scientist"), 8),
    (rx("typescript", "react", "node", "nodejs", "full stack", "fullstack", "rust"), 5),
    (rx("devops", "sre", "cloud", "kubernetes", "aws", "azure", "platform"), 5),
    (rx("qa", "tester", "quality"), 4),
]
SPANISH_TITLE_WORDS = rx(
    "desarrollador", "desarrolladora", "ingeniero", "ingeniera", "analista", "datos",
    "remoto", "sr", "ssr", "especialista", "arquitecto", "programador", "inteligencia",
)
PENALTIES = [
    (rx("lead", "lider", "manager", "gerente", "jefe"), -10),
    (rx("architect", "arquitecto", "arquitecta"), -8),
    (rx("senior", "sr"), -3),
    (rx("intern", "internship", "trainee", "practicante", "becario"), -15),
]
JUNIOR = rx("junior", "jr", "entry level", "associate")
LOCATION_POINTS = (("mexico", 15), ("latam", 8), ("latin america", 8), ("worldwide", 8), ("anywhere", 8), ("americas", 6), ("global", 4))
FIT_POINTS = {"high": 10, "medium": 0, "low": -10}


def parse_date(value) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def score(entry: dict, today: date, floor: int = DEFAULT_MIN_SALARY, current: int = CURRENT_SALARY) -> int:
    """0-100 relevance of a kept job; higher = send to /rank sooner."""
    title = fold(entry.get("title"))
    points = BASE_SCORE
    for pattern, value in SKILL_POINTS:
        if pattern.search(title):
            points += value
    for pattern, value in PENALTIES:
        if pattern.search(title):
            points += value
    if JUNIOR.search(title):
        points += 3
    # Imported here: posting_language -> rank_state -> prefilter would be a cycle.
    import posting_language

    if SPANISH_TITLE_WORDS.search(title) or posting_language.detect_title(entry.get("title") or "") == "es":
        points += 10
    loc = fold(entry.get("location"))
    if loc:
        points += max((v for token, v in LOCATION_POINTS if token in loc), default=0)
        if loc.startswith("remote") or "remoto" in loc:
            points += 3
    points += FIT_POINTS.get(entry.get("fit"), 0)
    posted = parse_date(entry.get("posted_date"))
    if posted:
        age = max(0, (today - posted).days)
        points += 6 if age <= 2 else 4 if age <= 4 else 2 if age <= 7 else -5 if age > 30 else -2 if age > 14 else 0
    salary = entry.get("salary_mxn_month")
    if isinstance(salary, (int, float)) and not isinstance(salary, bool):
        points += 5 if salary >= floor else -10 if salary < current else 0
    return max(0, min(100, int(points)))


def evaluate(entry: dict, today: date, floor: int = DEFAULT_MIN_SALARY, current: int = CURRENT_SALARY) -> dict:
    reason = exclusion(entry)
    return {"score": score(entry, today, floor, current), "out": reason is not None, "reason": reason}


# ---- state -------------------------------------------------------------------
def prefilter_state(seen: dict, today: date, settings: dict) -> dict:
    """Update `new` entries in place; returns counts. Recovered entries are kept."""
    kept = out = recovered = 0
    for entry in seen.values():
        if entry.get("status") != "new":
            continue
        if entry.get("prefilter_recovered"):
            entry["prefilter_score"] = score(entry, today, settings["minSalaryMxn"], settings["currentSalary"])
            recovered += 1
            continue
        verdict = evaluate(entry, today, settings["minSalaryMxn"], settings["currentSalary"])
        entry["prefilter_score"] = verdict["score"]
        if verdict["out"]:
            entry["status"] = OUT_STATUS
            entry["prefilter_reason"] = verdict["reason"]
            entry["prefilter_date"] = today.isoformat()
            out += 1
        else:
            kept += 1
    return {"kept": kept, "prefiltered_out": out, "recovered_kept": recovered}


def recover_entry(entry: dict) -> bool:
    if entry.get("status") != OUT_STATUS:
        return False
    entry["status"] = "new"
    entry["prefilter_recovered"] = True
    entry.pop("prefilter_reason", None)
    return True


def _load(path: Path) -> tuple[dict, dict]:
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        sys.exit(f"cannot read {path}: {exc}")
    seen = doc.get("seen") if isinstance(doc, dict) else None
    if not isinstance(seen, dict):
        sys.exit(f"{path} has no 'seen' object")
    return doc, seen


def _save(path: Path, doc: dict) -> None:
    tmp = Path(f"{path}.prefilter.tmp")
    tmp.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def cmd_run(args) -> int:
    doc, seen = _load(args.state)
    counts = prefilter_state(seen, args.today, load_search_settings(args.settings))
    if args.write:
        _save(args.state, doc)
    print(json.dumps({**counts, "written": bool(args.write)}, ensure_ascii=False))
    return 0


def cmd_recover(args) -> int:
    doc, seen = _load(args.state)
    entry = seen.get(args.key)
    if entry is None or not recover_entry(entry):
        sys.exit(f"{args.key}: not a prefiltered_out entry")
    entry["prefilter_score"] = score(entry, args.today)
    _save(args.state, doc)
    print(json.dumps({"recovered": args.key}))
    return 0


def cmd_evaluate(args) -> int:
    entry = {"title": args.title, "company": args.company, "location": args.location}
    print(json.dumps(evaluate(entry, args.today), ensure_ascii=False))
    return 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--state", type=Path, default=STATE)
    common.add_argument("--settings", type=Path, default=SETTINGS)
    common.add_argument("--today", type=date.fromisoformat, default=date.today())
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", parents=[common])
    run.add_argument("--write", action="store_true")
    run.set_defaults(func=cmd_run)
    rec = sub.add_parser("recover", parents=[common])
    rec.add_argument("key")
    rec.set_defaults(func=cmd_recover)
    ev = sub.add_parser("evaluate", parents=[common])
    ev.add_argument("--title", required=True)
    ev.add_argument("--company", default="")
    ev.add_argument("--location", default="")
    ev.set_defaults(func=cmd_evaluate)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
