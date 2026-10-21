#!/usr/bin/env python3
"""Learned job scorer: free (no LLM, no API) and it improves as your data grows.

The handcrafted prefilter (`prefilter.score`) is a title-only keyword heuristic.
This module learns, from the jobs /rank already judged, which words predict a
good fit, and blends that with the heuristic.

  Labels   ranked jobs with a rank_score ("good" = rank_score >= 65), jobs he
           skipped (negative) and jobs in job_search_tracker.csv with a
           drafted/applied/... status (positive; matched by URL or company+title).
  Features word + bigram tokens of title, tags and snippet, location tokens
           (company names are deliberately NOT used: no memorising employers)
           and the handcrafted score of the title+location as one numeric input.
  Model    L2-regularised logistic regression in pure Python (scikit-learn is not
           installed); saved to ui/state/learned_model.json (gitignored).
  Blend    final = 0.5 * handcrafted + 0.5 * learned (the learned probability is
           quantile-matched to the handcrafted score distribution of the `new`
           pool so the gate keeps its meaning) when the model has >= 60 labels,
           handcrafted only below that.

Caveat: ranked jobs were pre-selected by the old gate (label bias), so the model
is trained mostly on plausible jobs; the 50/50 blend keeps the heuristic as a
guard rail for kinds of jobs the model has never seen.

Usage:
  python3 tools/learned_score.py train [--state P] [--tracker P] [--model P]
  python3 tools/learned_score.py score --title T [--location L] [--tags a,b] [--snippet S]
  python3 tools/learned_score.py score --key JOBKEY
"""
import argparse
import bisect
import csv
import json
import math
import random
import re
import sys
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prefilter  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "job_scraper" / "seen_jobs.json"
TRACKER = ROOT / "job_search_tracker.csv"
MODEL = ROOT / "ui" / "state" / "learned_model.json"

GOOD_SCORE = 65            # rank_score at or above this is a "good" job
MIN_LABELS = 60            # below this the model is stored but inactive (handcrafted only)
BLEND_WEIGHT = 0.5         # final = (1 - w) * handcrafted + w * learned
FEEDBACK_WEIGHT = 2.0      # his own skip / draft decisions count double
POSITIVE_TRACKER = {"drafted", "applied", "interview", "interviewing", "offer", "accepted"}
L2 = 2.0                   # regularisation strength (chosen by repeated CV: 0.08 overfit, 2-8 plateau)
EPOCHS = 400
LEARNING_RATE = 0.05
MIN_DF = 3                 # a token must appear in at least this many training jobs
POP_MIN = 30               # smallest `new` pool usable for calibration
EXPLAIN_MIN_WEIGHT = 0.12
EXPLAIN_COMMON_DF = 0.4    # tokens in at least this share of training jobs say nothing about one job
GENERIC_LOCATION = frozenset("remote remoto worldwide anywhere global mexico latam latin america americas".split())
MULTI_LOCATION = 150       # longer location strings collapse to one "multi" token
MODEL_VERSION = 1

STOPWORDS = frozenset("""
a an and are as at be by for from in is it of on or the to we with you your our their this that will can
de del la las el los y o en para por con un una unos unas al se su sus que es lo
""".split())
WORD = re.compile(r"[a-z0-9][a-z0-9+#]*")


def fold(text) -> str:
    text = unicodedata.normalize("NFKD", str(text or "").lower())
    return "".join(c for c in text if not unicodedata.combining(c))


def words(text) -> list[str]:
    return [w for w in WORD.findall(fold(text).replace(".net", " net ")) if w not in STOPWORDS and len(w) > 1]


def tokenize(entry: dict) -> list[str]:
    """Unique feature tokens of a job. Company names are never used."""
    toks: dict[str, None] = {}
    title = words(entry.get("title"))
    for w in title:
        toks[f"w={w}"] = None
    for a, b in zip(title, title[1:]):
        toks[f"b={a} {b}"] = None
    tags = entry.get("tags") if isinstance(entry.get("tags"), list) else []
    for tag in tags:
        if not isinstance(tag, str):
            continue
        folded = " ".join(words(tag))
        if folded:
            toks[f"tag={folded}"] = None
        for w in words(tag):
            toks[f"w={w}"] = None
    snippet = entry.get("snippet")
    if isinstance(snippet, str):
        for w in words(snippet[:400]):
            toks[f"w={w}"] = None
    loc = fold(entry.get("location")).strip()
    if loc:
        if len(loc) > MULTI_LOCATION:
            toks["loc=multi"] = None
        else:
            for w in words(loc):
                if len(w) > 2 and w != "none":
                    toks[f"loc={w}"] = None
    return list(toks)


# ---- labels -------------------------------------------------------------------
def _norm_url(url) -> str:
    return str(url or "").strip().rstrip("/").lower()


def _pair(company, title) -> tuple[str, str]:
    return (" ".join(fold(company).split()), " ".join(fold(title).split()))


def _tracker_positives(path) -> tuple[set, set]:
    urls, pairs = set(), set()
    if not path:
        return urls, pairs
    try:
        with Path(path).open(newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                if (row.get("status") or "").strip().lower() not in POSITIVE_TRACKER:
                    continue
                if row.get("source"):
                    urls.add(_norm_url(row["source"]))
                pairs.add(_pair(row.get("company"), row.get("role")))
    except OSError:
        pass
    urls.discard("")
    return urls, pairs


def build_labels(seen: dict, tracker_path=None) -> list[dict]:
    """[{key, good, score, feedback}]: `score` is the LLM rank_score (None for feedback-only labels)."""
    urls, pairs = _tracker_positives(tracker_path)
    out = []
    for key, e in seen.items():
        if not isinstance(e, dict):
            continue
        score = e.get("rank_score") if isinstance(e.get("rank_score"), (int, float)) and not isinstance(e.get("rank_score"), bool) else None
        status = e.get("status")
        drafted = _norm_url(e.get("url")) in urls or _pair(e.get("company"), e.get("title")) in pairs
        if drafted and status in ("ranked", "new", "skipped", "expired"):
            out.append({"key": key, "good": True, "score": score if status == "ranked" else None, "feedback": True})
        elif status == "skipped":
            out.append({"key": key, "good": False, "score": None, "feedback": True})
        elif status == "ranked" and score is not None:
            out.append({"key": key, "good": score >= GOOD_SCORE, "score": score, "feedback": False})
    return out


# ---- metrics ------------------------------------------------------------------
def _ranks(v) -> list[float]:
    order = sorted(range(len(v)), key=lambda i: v[i])
    ranks = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2
        i = j + 1
    return ranks


def spearman(a, b) -> float:
    ra, rb = _ranks(list(a)), _ranks(list(b))
    n = len(ra)
    if n < 2:
        return 0.0
    ma, mb = sum(ra) / n, sum(rb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    den = math.sqrt(sum((x - ma) ** 2 for x in ra) * sum((y - mb) ** 2 for y in rb))
    return cov / den if den else 0.0


def auc(scores, good) -> float:
    ranks = _ranks(list(scores))
    pos = [r for r, g in zip(ranks, good) if g]
    n_pos, n_neg = len(pos), len(ranks) - len(pos)
    if not n_pos or not n_neg:
        return 0.5
    return (sum(pos) + n_pos - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


def precision_at(scores, good, k: int) -> float:
    """Share of 'good' among the top k by score; a tie straddling the cut counts proportionally."""
    k = min(k, len(scores))
    if k <= 0:
        return 0.0
    order = sorted(range(len(scores)), key=lambda i: -scores[i])
    cutoff = scores[order[k - 1]]
    above = [i for i in order if scores[i] > cutoff]
    tied = [i for i in order if scores[i] == cutoff]
    hits = sum(1 for i in above if good[i]) + (k - len(above)) * (sum(1 for i in tied if good[i]) / len(tied))
    return hits / k


def _metrics(scores, rank_scores, good) -> dict:
    return {
        "spearman": round(spearman(scores, rank_scores), 3), "auc": round(auc(scores, good), 3),
        "p10": round(precision_at(scores, good, 10), 3), "p25": round(precision_at(scores, good, 25), 3),
    }


# ---- model --------------------------------------------------------------------
def static_hand(entry: dict, today: date) -> int:
    """Handcrafted score of what is known about any job at discovery: title and location only.

    `fit`, salary and posting date are left out: /rank rewrites them for ranked jobs, so using
    them as features would leak the label.
    """
    return prefilter.score({"title": entry.get("title"), "location": entry.get("location")}, today)


def _hand_x(hand) -> float:
    return (hand - 50.0) / 25.0


def _sigmoid(z: float) -> float:
    return 1.0 / (1.0 + math.exp(-z)) if z >= 0 else math.exp(z) / (1.0 + math.exp(z))


def _fit_logistic(rows: list[list[int]], xs: list[float], ys: list[int], sw: list[float], dim: int) -> tuple[list[float], float, float]:
    """Adam on the weighted, L2-penalised logistic loss. Intercept and hand weight are barely penalised."""
    w = [0.0] * dim
    wh = b = 0.0
    m = [0.0] * dim
    v = [0.0] * dim
    mh = vh = mb = vb = 0.0
    total = sum(sw) or 1.0
    b1, b2, eps = 0.9, 0.999, 1e-8
    for t in range(1, EPOCHS + 1):
        g = [0.0] * dim
        gh = gb = 0.0
        for idx, x, y, s in zip(rows, xs, ys, sw):
            z = b + wh * x + sum(w[j] for j in idx)
            err = (_sigmoid(z) - y) * s / total
            for j in idx:
                g[j] += err
            gh += err * x
            gb += err
        c1, c2 = 1 - b1 ** t, 1 - b2 ** t
        for j in range(dim):
            gj = g[j] + L2 * w[j] / len(rows) * 4
            m[j] = b1 * m[j] + (1 - b1) * gj
            v[j] = b2 * v[j] + (1 - b2) * gj * gj
            w[j] -= LEARNING_RATE * (m[j] / c1) / (math.sqrt(v[j] / c2) + eps)
        gh += 0.01 * wh
        mh = b1 * mh + (1 - b1) * gh
        vh = b2 * vh + (1 - b2) * gh * gh
        wh -= LEARNING_RATE * (mh / c1) / (math.sqrt(vh / c2) + eps)
        mb = b1 * mb + (1 - b1) * gb
        vb = b2 * vb + (1 - b2) * gb * gb
        b -= LEARNING_RATE * (mb / c1) / (math.sqrt(vb / c2) + eps)
    return w, wh, b


def _quantiles(values: list[float]) -> list[float]:
    vs = sorted(values)
    n = len(vs)
    return [vs[min(n - 1, int(round(q / 100 * (n - 1))))] for q in range(101)]


def _interp(x: float, xs: list[float], ys: list[float]) -> float:
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    i = bisect.bisect_right(xs, x)
    x0, x1 = xs[i - 1], xs[i]
    return ys[i - 1] if x1 == x0 else ys[i - 1] + (ys[i] - ys[i - 1]) * (x - x0) / (x1 - x0)


def predict_p(model: dict, entry: dict, hand: float) -> float:
    weights = model["weights"]
    z = model["bias"] + model["hand_weight"] * _hand_x(hand) + sum(weights.get(t, 0.0) for t in tokenize(entry))
    return _sigmoid(z)


def _calibration(model: dict, seen: dict, today: date) -> None:
    """Quantile maps so a learned probability lands on the handcrafted scale of the `new` pool."""
    pool = [e for e in seen.values() if isinstance(e, dict) and e.get("status") == "new"]
    if len(pool) >= POP_MIN:
        hands = [prefilter.score(e, today) for e in pool]
    else:  # tiny pool: any job that was not hard-excluded, judged on what is known at discovery
        pool = [e for e in seen.values() if isinstance(e, dict) and e.get("status") in ("new", "ranked", "skipped")]
        hands = [static_hand(e, today) for e in pool]
    if len(pool) < 2:
        model["calibration"] = None
        return
    ps = [predict_p(model, e, static_hand(e, today)) for e in pool]
    model["calibration"] = {"p": _quantiles(ps), "hand": _quantiles(hands), "n": len(pool)}


def train_model(seen: dict, labels: list[dict], today: date) -> dict:
    """Fit on `labels` (see build_labels); `seen` supplies the job text and the calibration pool."""
    examples = [(seen[x["key"]], x) for x in labels if x["key"] in seen]
    docs = [tokenize(e) for e, _ in examples]
    df: dict[str, int] = {}
    for toks in docs:
        for t in toks:
            df[t] = df.get(t, 0) + 1
    vocab = sorted(t for t, c in df.items() if c >= MIN_DF)
    index = {t: i for i, t in enumerate(vocab)}
    rows = [[index[t] for t in toks if t in index] for toks in docs]
    xs = [_hand_x(static_hand(e, today)) for e, _ in examples]
    ys = [1 if x["good"] else 0 for _, x in examples]
    sw = [FEEDBACK_WEIGHT if x.get("feedback") else 1.0 for _, x in examples]
    # Balance the classes so a 20% base rate does not squash every probability toward 0.
    pos = sum(s for s, y in zip(sw, ys) if y) or 1.0
    neg = sum(s for s, y in zip(sw, ys) if not y) or 1.0
    sw = [s * (0.5 / pos if y else 0.5 / neg) * len(ys) for s, y in zip(sw, ys)]
    if examples and 0 < sum(ys) < len(ys):
        w, wh, b = _fit_logistic(rows, xs, ys, sw, len(vocab))
    else:
        w, wh, b = [0.0] * len(vocab), 0.0, 0.0
    model = {
        "version": MODEL_VERSION,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "labels": len(examples), "good": sum(ys), "active": len(examples) >= MIN_LABELS,
        "blend_weight": BLEND_WEIGHT, "good_score": GOOD_SCORE,
        "bias": round(b, 6), "hand_weight": round(wh, 6),
        "common": sorted(t for t, c in df.items() if examples and c / len(examples) >= EXPLAIN_COMMON_DF),
        "weights": {t: round(w[i], 5) for i, t in enumerate(vocab) if abs(w[i]) > 1e-4},
    }
    _calibration(model, seen, today)
    return model


def learned_score(model: dict, entry: dict, today: date) -> float | None:
    """0-100 learned score on the handcrafted scale; None when the model has no calibration."""
    cal = model.get("calibration")
    if not cal:
        return None
    p = predict_p(model, entry, static_hand(entry, today))
    pct = _interp(p, cal["p"], list(range(101)))
    return _interp(pct, list(range(101)), cal["hand"])


def blended_score(model: dict | None, entry: dict, today: date, static: bool = False, hand: int | None = None) -> tuple[int, dict]:
    """(final 0-100, parts). Handcrafted only unless the model is active; `static` hides fit/salary/date."""
    if hand is None:
        hand = static_hand(entry, today) if static else prefilter.score(entry, today)
    parts = {"hand": hand}
    if not model or not model.get("active"):
        return hand, parts
    learned = learned_score(model, entry, today)
    if learned is None:
        return hand, parts
    learned = round(learned)
    parts["learned"] = learned
    parts["p"] = round(predict_p(model, entry, static_hand(entry, today)), 4)
    return max(0, min(100, round((1 - BLEND_WEIGHT) * hand + BLEND_WEIGHT * learned))), parts


def _show(token: str) -> str:
    return token.split("=", 1)[1]


def explain(model: dict, entry: dict, top: int = 3) -> list[str]:
    """Spanish one-liners: the tokens that push this job up / down ("Sube: python, fastapi").

    Ubiquitous tokens (in >= 40% of training jobs) and generic place words are left out:
    they carry no information about this particular job.
    """
    weights = model["weights"]
    common = set(model.get("common", ()))
    present = []
    for t in tokenize(entry):
        w = weights.get(t)
        if w is None or abs(w) < EXPLAIN_MIN_WEIGHT or t in common:
            continue
        if t.startswith("loc=") and _show(t) in GENERIC_LOCATION:
            continue
        present.append((w, t))
    out = []
    for label, sign in (("Sube", 1), ("Baja", -1)):
        shown: list[str] = []
        for _, tok in sorted((x for x in present if x[0] * sign > 0), key=lambda x: -abs(x[0])):
            text = _show(tok)
            if text in shown or any(" " in s and text in s.split() for s in shown):
                continue  # already shown, or a word of a bigram already shown
            if " " in text:  # a bigram replaces the single words it contains
                shown = [s for s in shown if s not in text.split()]
            shown.append(text)
            if len(shown) == top:
                break
        if shown:
            out.append(f"{label}: {', '.join(shown)}")
    return out


def save_model(model: dict, path: Path = MODEL) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(f"{path}.tmp")
    tmp.write_text(json.dumps(model, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)


def load_model(path: Path = MODEL) -> dict | None:
    try:
        model = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    ok = isinstance(model, dict) and isinstance(model.get("weights"), dict) and "bias" in model and "hand_weight" in model
    return model if ok else None


# ---- cross-validation ---------------------------------------------------------
def cross_validate(seen: dict, labels: list[dict], today: date, folds: int = 5, repeats: int = 3, seed: int = 7) -> dict:
    """Repeated k-fold over the jobs with a rank_score; feedback-only labels always train.

    Compares the handcrafted score (full entry and title+location view), the learned
    probability alone and the 50/50 blend, all on the same held-out predictions.
    """
    evalset = [x for x in labels if x["score"] is not None and x["key"] in seen]
    always = [x for x in labels if x["score"] is None and x["key"] in seen]
    names = ("hand_full", "hand_static", "learned", "blend")
    acc: dict[str, list[dict]] = {n: [] for n in names}
    for r in range(repeats):
        order = list(range(len(evalset)))
        random.Random(seed + r).shuffle(order)
        pred = {n: [0.0] * len(evalset) for n in names}
        for f in range(folds):
            test = set(order[f::folds])
            train = [evalset[i] for i in range(len(evalset)) if i not in test] + always
            model = train_model(seen, train, today)
            for i in test:
                e = seen[evalset[i]["key"]]
                hand_static = static_hand(e, today)
                pred["hand_full"][i] = prefilter.score(e, today)
                pred["hand_static"][i] = hand_static
                learned = learned_score(model, e, today)
                pred["learned"][i] = learned if learned is not None else hand_static
                pred["blend"][i] = (1 - BLEND_WEIGHT) * hand_static + BLEND_WEIGHT * pred["learned"][i]
        rs = [x["score"] for x in evalset]
        good = [x["score"] >= GOOD_SCORE for x in evalset]
        for n in names:
            acc[n].append(_metrics(pred[n], rs, good))
    result = {n: {k: round(sum(m[k] for m in ms) / len(ms), 3) for k in ms[0]} for n, ms in acc.items()} if evalset else {}
    result.update({"n": len(evalset), "good": sum(1 for x in evalset if x["score"] >= GOOD_SCORE), "folds": folds, "repeats": repeats})
    return result


# ---- CLI ----------------------------------------------------------------------
def _load_seen(path: Path) -> tuple[dict, dict]:
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        sys.exit(f"cannot read {path}: {exc}")
    seen = doc.get("seen") if isinstance(doc, dict) else None
    if not isinstance(seen, dict):
        sys.exit(f"{path} has no 'seen' object")
    return doc, seen


def cmd_train(args) -> int:
    _, seen = _load_seen(args.state)
    labels = build_labels(seen, args.tracker)
    cv = cross_validate(seen, labels, args.today, folds=args.folds, repeats=args.repeats) if labels else {}
    model = train_model(seen, labels, args.today)
    model["cv"] = cv
    save_model(model, args.model)
    top = sorted(model["weights"].items(), key=lambda kv: kv[1])
    summary = {
        "labels": model["labels"], "good": model["good"], "active": model["active"], "cv": cv,
        "top_positive": [t for t, _ in top[::-1][:12]], "top_negative": [t for t, _ in top[:12]], "model": str(args.model),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


def cmd_score(args) -> int:
    model = load_model(args.model)
    if args.key:
        _, seen = _load_seen(args.state)
        entry = seen.get(args.key)
        if entry is None:
            sys.exit(f"{args.key}: not in {args.state}")
    else:
        entry = {"title": args.title, "location": args.location,
                 "tags": [t.strip() for t in args.tags.split(",") if t.strip()], "snippet": args.snippet}
    final, parts = blended_score(model, entry, args.today)
    print(json.dumps({"final": final, **parts, "why": explain(model, entry) if model else []}, ensure_ascii=False))
    return 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--state", type=Path, default=STATE)
    common.add_argument("--model", type=Path, default=MODEL)
    common.add_argument("--today", type=date.fromisoformat, default=date.today())
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    tr = sub.add_parser("train", parents=[common])
    tr.add_argument("--tracker", type=Path, default=TRACKER)
    tr.add_argument("--folds", type=int, default=5)
    tr.add_argument("--repeats", type=int, default=3)
    tr.set_defaults(func=cmd_train)
    sc = sub.add_parser("score", parents=[common])
    sc.add_argument("--key")
    sc.add_argument("--title", default="")
    sc.add_argument("--location", default="")
    sc.add_argument("--tags", default="")
    sc.add_argument("--snippet", default="")
    sc.set_defaults(func=cmd_score)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
