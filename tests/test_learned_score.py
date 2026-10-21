"""Tests for tools/learned_score.py - the free, self-improving scorer behind the prefilter."""
import csv
import json
import random
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
import _hermetic  # noqa: F401,E402  (pins profile_config to the test fixture)
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import learned_score as ls  # noqa: E402
import prefilter  # noqa: E402

TODAY = date(2026, 10, 20)
TOOL = REPO / "tools" / "learned_score.py"

GOOD_TITLES = ["Python Backend Engineer", "Senior Python Developer FastAPI", "AI Engineer LLM Python",
               "Data Engineer Python Spark", "Backend Developer Python Django", "Full Stack Python Developer"]
BAD_TITLES = ["NET Developer Azure", "Java Backend Engineer Spring", "PHP Laravel Developer", "Frontend Angular Developer",
              "QA Manual Tester Senior", "Support Engineer Tier 2"]


def synth(n=120, seed=1):
    """Ranked jobs where python-ish titles score high and the rest low."""
    rnd = random.Random(seed)
    seen = {}
    for i in range(n):
        good = rnd.random() < 0.4
        title = rnd.choice(GOOD_TITLES if good else BAD_TITLES)
        seen[f"k{i}"] = {
            "title": title, "company": f"Co{i}", "location": rnd.choice(["Remote (Mexico)", "Remote (Worldwide)", "Brazil"]),
            "status": "ranked", "rank_score": rnd.randint(70, 90) if good else rnd.randint(20, 55),
            "portal": "himalayas", "first_seen": "2026-10-10", "posted_date": "2026-10-10", "fit": "medium",
        }
    return seen


class Tokens(unittest.TestCase):
    def test_accent_folded_lowercase_and_no_company_names(self):
        toks = ls.tokenize({"title": "Ingeniero de Inteligencia Artificial Sênior", "company": "Santander México",
                            "location": "Ciudad de México", "tags": ["Python Development"], "snippet": "Construye APIs con FastAPI"})
        self.assertIn("w=inteligencia", toks)
        self.assertIn("b=inteligencia artificial", toks)
        self.assertIn("loc=mexico", toks)
        self.assertIn("tag=python development", toks)
        self.assertIn("w=fastapi", toks)
        self.assertFalse([t for t in toks if "santander" in t])

    def test_long_multi_country_location_collapses_to_one_token(self):
        toks = ls.tokenize({"title": "Dev", "location": "Remote (" + ", ".join(f"Country{i}" for i in range(40)) + ")"})
        self.assertIn("loc=multi", toks)
        self.assertFalse([t for t in toks if t.startswith("loc=country")])

    def test_missing_fields_are_fine(self):
        self.assertTrue(ls.tokenize({"title": "Python Developer"}))
        self.assertEqual(ls.tokenize({}), [])

    def test_dotnet_keeps_a_token(self):
        self.assertIn("w=net", ls.tokenize({"title": "Senior .NET Developer"}))


class Labels(unittest.TestCase):
    def tracker(self, d, rows):
        p = Path(d) / "t.csv"
        with p.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=["company", "role", "status", "source"])
            w.writeheader()
            w.writerows(rows)
        return p

    def test_ranked_threshold_skipped_negative_and_tracker_positive(self):
        seen = {
            "a": {"title": "Python Dev", "company": "A", "status": "ranked", "rank_score": 70},
            "b": {"title": "Java Dev", "company": "B", "status": "ranked", "rank_score": 64},
            "c": {"title": "iOS Dev", "company": "C", "status": "skipped"},
            "d": {"title": "Data Engineer", "company": "D", "url": "https://x.test/d", "status": "new"},
            "e": {"title": "Backend Engineer", "company": "Acme", "status": "ranked", "rank_score": 40},
            "f": {"title": "Nothing", "company": "F", "status": "new"},
        }
        with TemporaryDirectory() as d:
            tracker = self.tracker(d, [
                {"company": "Acme", "role": "backend  engineer", "status": "drafted", "source": ""},
                {"company": "Zed", "role": "Other", "status": "applied", "source": "https://x.test/d/"},
                {"company": "Q", "role": "Python Dev", "status": "rejected", "source": ""},
            ])
            labels = {x["key"]: x for x in ls.build_labels(seen, tracker)}
        self.assertTrue(labels["a"]["good"] and not labels["b"]["good"])
        self.assertFalse(labels["c"]["good"])
        self.assertEqual(labels["a"]["score"], 70)
        self.assertTrue(labels["d"]["good"])          # tracker match by URL
        self.assertTrue(labels["e"]["good"])           # tracker match by company+title, overrides rank_score 40
        self.assertEqual(labels["e"]["score"], 40)     # evaluation keeps the LLM score
        self.assertNotIn("f", labels)

    def test_missing_tracker_is_ok(self):
        self.assertEqual(ls.build_labels({}, Path("/nonexistent/t.csv")), [])


class Metrics(unittest.TestCase):
    def test_spearman_auc_precision(self):
        self.assertAlmostEqual(ls.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertAlmostEqual(ls.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1.0)
        self.assertAlmostEqual(ls.auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]), 1.0)
        self.assertAlmostEqual(ls.auc([0.5, 0.5], [1, 0]), 0.5)
        self.assertAlmostEqual(ls.precision_at([0.9, 0.8, 0.7, 0.1], [1, 0, 1, 0], 2), 0.5)

    def test_precision_at_splits_ties_fairly(self):
        self.assertAlmostEqual(ls.precision_at([1, 1, 1, 1], [1, 0, 0, 0], 2), 0.25)


class Training(unittest.TestCase):
    def test_model_separates_synthetic_classes_and_cv_beats_chance(self):
        seen = synth()
        labels = ls.build_labels(seen, None)
        model = ls.train_model(seen, labels, TODAY)
        good = ls.predict_p(model, {"title": "Python Backend Developer FastAPI", "location": "Remote (Mexico)"}, 70)
        bad = ls.predict_p(model, {"title": "NET Developer Azure", "location": "Remote (Mexico)"}, 70)
        self.assertGreater(good, bad + 0.2)
        self.assertGreater(good, 0.55)
        self.assertLess(bad, 0.45)
        cv = ls.cross_validate(seen, labels, TODAY, folds=5, repeats=1)
        self.assertGreater(cv["learned"]["auc"], 0.9)

    def test_explain_lists_rising_and_falling_tokens_in_spanish(self):
        seen = synth()
        model = ls.train_model(seen, ls.build_labels(seen, None), TODAY)
        why = ls.explain(model, {"title": "Python Developer .NET Azure", "location": "Remote (Mexico)"})
        self.assertTrue(any(w.startswith("Sube: ") and "python" in w for w in why), why)
        self.assertTrue(any(w.startswith("Baja: ") and "net" in w for w in why), why)

    def test_save_load_round_trip(self):
        seen = synth(80)
        model = ls.train_model(seen, ls.build_labels(seen, None), TODAY)
        with TemporaryDirectory() as d:
            p = Path(d) / "m.json"
            ls.save_model(model, p)
            again = ls.load_model(p)
        e = {"title": "Python Developer", "location": "Remote (Mexico)"}
        self.assertAlmostEqual(ls.predict_p(model, e, 60), ls.predict_p(again, e, 60))

    def test_load_model_missing_or_corrupt_is_none(self):
        with TemporaryDirectory() as d:
            self.assertIsNone(ls.load_model(Path(d) / "none.json"))
            bad = Path(d) / "bad.json"
            bad.write_text("{nope")
            self.assertIsNone(ls.load_model(bad))


class Blend(unittest.TestCase):
    def test_blend_weight_is_a_constant_half_and_min_labels_sixty(self):
        self.assertEqual(ls.BLEND_WEIGHT, 0.5)
        self.assertEqual(ls.MIN_LABELS, 60)

    def test_below_min_labels_final_is_handcrafted_only(self):
        seen = synth(40)
        model = ls.train_model(seen, ls.build_labels(seen, None), TODAY)
        self.assertFalse(model["active"])
        entry = {"title": "Python Developer", "location": "Remote (Mexico)", "posted_date": "2026-10-19", "fit": "medium"}
        final, parts = ls.blended_score(model, entry, TODAY)
        self.assertEqual(final, prefilter.score(entry, TODAY))
        self.assertNotIn("learned", parts)

    def test_active_model_blends_half_and_half_and_is_monotone(self):
        seen = synth(120)
        pool = {f"n{i}": {"title": t, "location": "Remote (Mexico)", "status": "new", "posted_date": "2026-10-19", "fit": "medium"}
                for i, t in enumerate(GOOD_TITLES + BAD_TITLES)}
        model = ls.train_model({**seen, **pool}, ls.build_labels(seen, None), TODAY)
        self.assertTrue(model["active"])
        good = {"title": "Python Backend Developer", "location": "Remote (Mexico)", "posted_date": "2026-10-19", "fit": "medium"}
        bad = {"title": "NET Developer Azure", "location": "Remote (Mexico)", "posted_date": "2026-10-19", "fit": "medium"}
        fg, pg = ls.blended_score(model, good, TODAY)
        fb, pb = ls.blended_score(model, bad, TODAY)
        self.assertGreater(pg["learned"], pb["learned"])
        self.assertEqual(fg, round(0.5 * pg["hand"] + 0.5 * pg["learned"]))
        self.assertTrue(0 <= fb <= fg <= 100)


class PrefilterIntegration(unittest.TestCase):
    def test_prefilter_state_uses_model_and_stores_why(self):
        seen = synth(120)
        pool = {f"n{i}": {"title": t, "location": "Remote (Mexico)", "status": "new", "posted_date": "2026-10-19", "fit": "medium"}
                for i, t in enumerate(GOOD_TITLES + BAD_TITLES)}
        model = ls.train_model({**seen, **pool}, ls.build_labels(seen, None), TODAY)
        state = {k: dict(v) for k, v in pool.items()}
        prefilter.prefilter_state(state, TODAY, {"minSalaryMxn": 30000, "currentSalary": 20000}, model=model)
        kept = [e for e in state.values() if e["status"] == "new"]
        self.assertTrue(kept)
        for e in kept:
            self.assertIn("prefilter_hand_score", e)
            self.assertIn("prefilter_learned_score", e)
            self.assertIsInstance(e.get("prefilter_why", []), list)
        py = next(e for e in kept if e["title"] == "Python Backend Engineer")
        self.assertTrue(py["prefilter_why"])

    def test_prefilter_state_without_model_is_unchanged(self):
        state = {"a": {"title": "Python Developer", "location": "Remote (Mexico)", "status": "new"}}
        prefilter.prefilter_state(state, TODAY, {"minSalaryMxn": 30000, "currentSalary": 20000}, model=None)
        self.assertNotIn("prefilter_why", state["a"])
        self.assertNotIn("prefilter_hand_score", state["a"])


class Cli(unittest.TestCase):
    def test_train_then_score_via_cli(self):
        with TemporaryDirectory() as d:
            state = Path(d) / "seen.json"
            state.write_text(json.dumps({"seen": synth(100)}))
            model = Path(d) / "m.json"
            common = ["--state", str(state), "--model", str(model), "--today", "2026-10-20"]
            r = subprocess.run([sys.executable, str(TOOL), "train", "--tracker", str(Path(d) / "t.csv"), "--folds", "3", "--repeats", "1", *common],
                               capture_output=True, text=True, check=True)
            out = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertTrue(model.is_file())
            self.assertEqual(out["labels"], 100)
            self.assertIn("cv", out)
            r = subprocess.run([sys.executable, str(TOOL), "score", "--title", "Python Backend Developer", "--location", "Remote (Mexico)", *common],
                               capture_output=True, text=True, check=True)
            res = json.loads(r.stdout)
            self.assertIn("final", res)
            self.assertIn("why", res)


if __name__ == "__main__":
    unittest.main()
