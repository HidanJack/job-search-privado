#!/usr/bin/env python3
"""Opportunity / Risk scoring for ranked jobs (deterministic, no LLM).

Computed after /rank from fields already stored on a ranked entry and written
back as `opportunity`, `risk`, `final_priority` plus a one-line Spanish driver
for each (`opportunity_driver`, `risk_driver`). The UI sorts cards by
`final_priority`.

FORMULAS (all weights live in OPPORTUNITY_WEIGHTS / RISK_POINTS below)

  Oportunidad (0-100) = weighted mean of six 0-100 components:
    fit        rank_score (the /rank fit score)
    salary     0 at/below your current pay (21k), 50 at your floor (35k),
               100 at 1.6x the floor; unknown salary = 40 (neutral-low)
    freshness  100 -> 80 over the first 4 days, then decays to 20 at 14 days
               and 0 at 30 (applying early matters); unknown age = 50
    language   Spanish posting 100, mixed 70, English 20, unknown 50
    modality   remote 100, hybrid 70, onsite 40, unknown 60
    source     portal quality; averaged with an applicants score when the
               entry stores `applicants` (fewer = better)

  Riesgo (0-100) = sum of additive points, capped at 100:
    spoken English  English posting (assumed spoken English) or a stated
                    spoken-English gap; more when C1/C2/fluent is asked
    gaps            years required above your verifiable 4 plus a 2-year
                    tolerance (you have programmed ~15 years, so asks up to 6
                    cost nothing), each non-language gap from the fit
                    analysis, "senior" in the title. A degree/licenciatura gap
                    is never a real risk (your licenciatura is unfinished but
                    you pass those screens): it adds a token 2 points, once
    friction        location FLAG/FAIL (US/EU hours do not add risk: the
                    candidate works night shifts; CST is his own timezone)
    ghost job       very old, reposted, no salary and vague analysis
    salary          unknown salary, or pay at/below your current 21k, or
                    unpaid/commission-only wording

  Final priority = round(Oportunidad * (1 - RISK_DISCOUNT * Riesgo / 100)):
  maximum risk removes RISK_DISCOUNT (50%) of the opportunity.
"""
import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prefilter  # noqa: E402  (settings loader and paths shared with the prefilter)

CANDIDATE_YEARS = 4          # verifiable professional years (CVs state these)
YEARS_TOLERANCE = 2          # ~15 years of hands-on programming: asks up to 6 are realistic

OPPORTUNITY_WEIGHTS = {
    "fit": 0.40, "salary": 0.20, "freshness": 0.15, "language": 0.10, "modality": 0.08, "source": 0.07,
}
RISK_DISCOUNT = 0.5
RISK_POINTS = {
    "english_posting": 40,       # English posting => spoken English assumed
    "english_stated": 25,        # Spanish/mixed posting that still states a spoken-English gap
    "english_advanced": 15,      # C1/C2/fluent/native asked on top of the above
    "years_each": 7,             # per year above CANDIDATE_YEARS + YEARS_TOLERANCE (max years_max)
    "years_max": 25,
    "gap_each": 7,               # per non-language gap (max gap_max)
    "gap_max": 21,
    "degree_gap": 2,             # token points for a degree/licenciatura gap (never a knockout)
    "senior_title": 6,
    "location_flag": 15,
    "location_fail": 40,
    "age_stale": 10,             # > 14 days
    "age_ghost": 25,             # > 45 days
    "reposted": 15,
    "vague_no_salary": 8,
    "salary_unknown": 8,
    "salary_low": 25,            # at or below current pay
    "salary_unpaid": 40,
}
SOURCE_QUALITY = {
    "getonbrd": 90, "linkedin": 80, "indeed": 75, "himalayas": 70, "jobicy": 60,
    "remoteok": 55, "hn-hiring": 60, "freehire": 55,
}
DEFAULT_SOURCE_QUALITY = 50

ENGLISH_ADVANCED = re.compile(r"\b(c1|c2|fluent|fluido|nativo|native|advanced|avanzado)\b", re.I)
ENGLISH_GAP = re.compile(r"ingl[eé]s hablado|spoken english|ingl[eé]s (fluido|conversacional)|english[^.]{0,40}(interview|conversation|calls?)", re.I)
DEGREE = re.compile(r"t[ií]tulo|titulad|licenciatura|ingenier[ií]a|degree|bachelor|c[eé]dula", re.I)
YEARS = re.compile(r"(\d{1,2})\s*\+?\s*(?:a[nñ]os|years|yrs)", re.I)
UNPAID = re.compile(r"\b(unpaid|no remunerad|sin sueldo|voluntari|solo comisi|commission[- ]only|a comisi)", re.I)
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}")


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _age(entry: dict, today: date):
    m = ISO.match(str(entry.get("posted_date") or ""))
    if not m:
        return None
    try:
        return max(0, (today - date.fromisoformat(m.group(0))).days)
    except ValueError:
        return None


def _texts(entry: dict) -> list[str]:
    out = []
    for field in ("gaps", "fit_reasons", "strengths"):
        value = entry.get(field)
        if isinstance(value, list):
            out.extend(str(v) for v in value)
    note = entry.get("language_note")
    if note:
        out.append(str(note))
    return out


def _lerp(x, x0, x1, y0, y1):
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0)


def salary_component(salary, floor: int, current: int) -> float:
    if salary is None:
        return 40.0
    if salary <= current:
        return 0.0
    if salary < floor:
        return _lerp(salary, current, floor, 0, 50)
    return min(100.0, _lerp(salary, floor, floor * 1.6, 50, 100))


def freshness_component(age) -> float:
    if age is None:
        return 50.0
    if age <= 4:
        return _lerp(age, 0, 4, 100, 80)
    if age <= 14:
        return _lerp(age, 4, 14, 80, 20)
    if age <= 30:
        return _lerp(age, 14, 30, 20, 0)
    return 0.0


def source_component(entry: dict) -> float:
    portal = str(entry.get("portal") or "").lower()
    base = next((q for name, q in SOURCE_QUALITY.items() if portal.startswith(name)), DEFAULT_SOURCE_QUALITY)
    applicants = _num(entry.get("applicants"))
    if applicants is None:
        return float(base)
    few = 100 if applicants < 10 else 80 if applicants < 25 else 50 if applicants < 75 else 20 if applicants < 200 else 0
    return (base + few) / 2


def opportunity_components(entry: dict, today: date, floor: int, current: int) -> dict:
    lang = {"es": 100, "mixed": 70, "en": 20}.get(entry.get("posting_language"), 50)
    modality = {"remote": 100, "hybrid": 70, "onsite": 40}.get(entry.get("modality"), 60)
    return {
        "fit": float(_num(entry.get("rank_score")) or 0),
        "salary": salary_component(_num(entry.get("salary_mxn_month")), floor, current),
        "freshness": freshness_component(_age(entry, today)),
        "language": float(lang),
        "modality": float(modality),
        "source": source_component(entry),
    }


def _mxn(value) -> str:
    return "$" + f"{int(round(value)):,}"


def opportunity_driver(entry: dict, comps: dict, today: date, floor: int) -> str:
    """The component contributing the most weighted points, in Spanish."""
    known = [k for k in comps if not (k == "salary" and _num(entry.get("salary_mxn_month")) is None)
             and not (k == "freshness" and _age(entry, today) is None)]
    key = max(known, key=lambda k: comps[k] * OPPORTUNITY_WEIGHTS[k])
    if key == "fit":
        return f"Encaje de {int(comps['fit'])} de 100 con tu perfil"
    if key == "salary":
        salary = _num(entry.get("salary_mxn_month"))
        return f"Sueldo de {_mxn(salary)} al mes" + (", sobre tu mínimo" if salary and salary >= floor else "")
    if key == "freshness":
        age = _age(entry, today)
        return "Publicada hoy: postula ya" if age == 0 else f"Publicada hace {age} {'día' if age == 1 else 'días'}: postula pronto"
    if key == "language":
        return "Anuncio en español"
    if key == "modality":
        return {"remote": "Trabajo remoto", "hybrid": "Modalidad híbrida"}.get(entry.get("modality"), "Modalidad compatible")
    return "Portal confiable"


def risk_items(entry: dict, today: date, current: int) -> list[tuple[int, str]]:
    """(points, Spanish explanation) for every risk that applies."""
    p = RISK_POINTS
    items: list[tuple[int, str]] = []
    texts = _texts(entry)
    blob = " ".join(texts)
    gaps = [str(g) for g in entry.get("gaps") or []] if isinstance(entry.get("gaps"), list) else []

    english_gap = entry.get("posting_language") == "en" or any(ENGLISH_GAP.search(g) for g in gaps)
    if english_gap:
        advanced = ENGLISH_ADVANCED.search(" ".join(g for g in gaps if ENGLISH_GAP.search(g)) + " " + str(entry.get("language_note") or ""))
        pts = p["english_posting"] if entry.get("posting_language") == "en" else p["english_stated"]
        if advanced:
            pts += p["english_advanced"]
            level = advanced.group(0).upper() if advanced.group(0).lower() in ("c1", "c2") else advanced.group(0).lower()
            label = f"piden inglés hablado {level}" if level in ("C1", "C2") else f"piden inglés hablado ({level})"
        elif entry.get("posting_language") == "en":
            label = "anuncio en inglés: se asume inglés hablado"
        else:
            label = "piden inglés hablado"
        items.append((pts, label))

    years = [int(m.group(1)) for g in gaps + [str(r) for r in entry.get("fit_reasons") or []] for m in YEARS.finditer(g)]
    top = max(years, default=0)
    limit = CANDIDATE_YEARS + YEARS_TOLERANCE
    years_risk = top > limit
    if years_risk:
        items.append((min(p["years_max"], int(round((top - limit) * p["years_each"]))), f"piden {top}+ años y tienes ~4 verificables"))
    degree_gaps = [g for g in gaps if DEGREE.search(g) and not ENGLISH_GAP.search(g)]
    if degree_gaps:
        items.append((p["degree_gap"], "piden título o licenciatura"))
    other_gaps = [g for g in gaps if not ENGLISH_GAP.search(g) and g not in degree_gaps and not YEARS.search(g)]
    if other_gaps:
        items.append((min(p["gap_max"], p["gap_each"] * len(other_gaps)), f"{len(other_gaps)} {'requisito' if len(other_gaps) == 1 else 'requisitos'} que no cubres"))
    if re.search(r"\b(senior|sr|lead|principal)\b", str(entry.get("title") or ""), re.I) and not years_risk:
        items.append((p["senior_title"], "puesto senior"))

    verdict = entry.get("location_verdict")
    if verdict == "FAIL":
        items.append((p["location_fail"], "ubicación incompatible"))
    elif verdict == "FLAG":
        items.append((p["location_flag"], "ubicación con condiciones"))

    age = _age(entry, today)
    if age is not None and age > 45:
        items.append((p["age_ghost"], f"publicada hace {age} días: posible vacante fantasma"))
    elif age is not None and age > 14:
        items.append((p["age_stale"], f"publicada hace {age} días"))
    if entry.get("reposted") is True:
        items.append((p["reposted"], "vacante republicada"))

    salary = _num(entry.get("salary_mxn_month"))
    if UNPAID.search(blob) or UNPAID.search(str(entry.get("title") or "")):
        items.append((p["salary_unpaid"], "posiblemente no remunerada"))
    elif salary is None:
        items.append((p["salary_unknown"], "sueldo no publicado"))
        reasons = entry.get("fit_reasons")
        if (not isinstance(reasons, list) or len(reasons) < 2) and age is not None and age > 7:
            items.append((p["vague_no_salary"], "anuncio vago y sin sueldo"))
    elif salary <= current:
        items.append((p["salary_low"], f"sueldo de {_mxn(salary)}, no supera tu pago actual"))
    return items


def compute(entry: dict, today: date, floor: int = prefilter.DEFAULT_MIN_SALARY, current: int = prefilter.CURRENT_SALARY) -> dict:
    comps = opportunity_components(entry, today, floor, current)
    opportunity = int(round(sum(comps[k] * w for k, w in OPPORTUNITY_WEIGHTS.items())))
    items = risk_items(entry, today, current)
    risk = min(100, sum(pts for pts, _ in items))
    final = int(round(opportunity * (1 - RISK_DISCOUNT * risk / 100)))
    biggest = max(items, key=lambda i: i[0])[1] if items else "sin alertas importantes"
    return {
        "opportunity": opportunity,
        "risk": risk,
        "final_priority": final,
        "opportunity_driver": opportunity_driver(entry, comps, today, floor),
        "risk_driver": biggest[0].upper() + biggest[1:],
    }


def settings_args(path: Path) -> tuple[int, int]:
    s = prefilter.load_search_settings(path)
    return s["minSalaryMxn"], s["currentSalary"]


def apply_scores(entry: dict, today: date, floor: int, current: int) -> None:
    entry.update(compute(entry, today, floor, current))
    entry["score_date"] = today.isoformat()


def recompute_state(seen: dict, today: date, floor: int, current: int) -> int:
    n = 0
    for entry in seen.values():
        if entry.get("status") == "ranked" and _num(entry.get("rank_score")) is not None:
            apply_scores(entry, today, floor, current)
            n += 1
    return n


def cmd_recompute(args) -> int:
    doc, seen = prefilter._load(args.state)
    floor, current = settings_args(args.settings)
    n = recompute_state(seen, args.today, floor, current)
    if args.write:
        prefilter._save(args.state, doc)
    print(json.dumps({"recomputed": n, "written": bool(args.write)}))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    rec = sub.add_parser("recompute", help="refresh opportunity/risk on every ranked entry (freshness decays daily)")
    rec.add_argument("--state", type=Path, default=prefilter.STATE)
    rec.add_argument("--settings", type=Path, default=prefilter.SETTINGS)
    rec.add_argument("--today", type=date.fromisoformat, default=date.today())
    rec.add_argument("--write", action="store_true")
    rec.set_defaults(func=cmd_recompute)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
