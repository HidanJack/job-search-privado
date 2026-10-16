"""Tests for tools/opportunity.py - Oportunidad / Riesgo / final priority."""
import json
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import opportunity as opp  # noqa: E402

TODAY = date(2026, 10, 16)


def ranked(**over):
    base = {
        "title": "Python Developer", "status": "ranked", "rank_score": 70, "posted_date": "2026-10-15",
        "posting_language": "es", "modality": "remote", "salary_mxn_month": 45000, "portal": "getonbrd",
        "gaps": [], "fit_reasons": ["a", "b"], "location_verdict": "PASS",
    }
    base.update(over)
    return base


def calc(**over):
    return opp.compute(ranked(**over), TODAY)


class Opportunity(unittest.TestCase):
    def test_weights_sum_to_one(self):
        self.assertAlmostEqual(sum(opp.OPPORTUNITY_WEIGHTS.values()), 1.0)

    def test_better_fit_salary_freshness_language_raise_opportunity(self):
        base = calc()["opportunity"]
        self.assertLess(calc(rank_score=40)["opportunity"], base)
        self.assertLess(calc(salary_mxn_month=20000)["opportunity"], base)
        self.assertLess(calc(posted_date="2026-09-20")["opportunity"], base)
        self.assertLess(calc(posting_language="en")["opportunity"], base)
        self.assertLess(calc(modality="onsite")["opportunity"], base)

    def test_salary_component_anchors(self):
        self.assertEqual(opp.salary_component(21000, 35000, 21000), 0)
        self.assertEqual(opp.salary_component(35000, 35000, 21000), 50)
        self.assertEqual(opp.salary_component(56000, 35000, 21000), 100)
        self.assertEqual(opp.salary_component(None, 35000, 21000), 40)

    def test_freshness_decays_after_four_days(self):
        f = opp.freshness_component
        self.assertEqual(f(0), 100)
        self.assertEqual(f(4), 80)
        self.assertGreater(f(4), f(10))
        self.assertEqual(f(60), 0)

    def test_few_applicants_raise_source_quality(self):
        self.assertGreater(opp.source_component({"portal": "x", "applicants": 3}), opp.source_component({"portal": "x", "applicants": 300}))

    def test_values_are_bounded(self):
        for entry in [ranked(rank_score=100), ranked(rank_score=0, salary_mxn_month=None, posted_date=None)]:
            r = opp.compute(entry, TODAY)
            self.assertTrue(0 <= r["opportunity"] <= 100 and 0 <= r["risk"] <= 100 and 0 <= r["final_priority"] <= 100)

    def test_driver_is_spanish_and_skips_unknown_salary(self):
        self.assertTrue(calc()["opportunity_driver"])
        self.assertNotIn("Sueldo", calc(rank_score=0, salary_mxn_month=None, posted_date=None, posting_language=None, modality=None)["opportunity_driver"])


class Risk(unittest.TestCase):
    def test_english_posting_assumes_spoken_english(self):
        r = calc(posting_language="en")
        self.assertGreaterEqual(r["risk"], opp.RISK_POINTS["english_posting"])
        self.assertIn("inglés", r["risk_driver"])

    def test_c1_requirement_is_named_in_driver(self):
        r = calc(gaps=["Inglés hablado: piden C1 y tu nivel es ~A2"])
        self.assertIn("C1", r["risk_driver"])
        self.assertGreaterEqual(r["risk"], opp.RISK_POINTS["english_stated"] + opp.RISK_POINTS["english_advanced"])

    def test_years_required_above_candidate(self):
        r = calc(gaps=["Piden 8+ años de experiencia y tienes ~3.5"])
        self.assertIn("8+ años", r["risk_driver"])
        self.assertGreater(r["risk"], calc()["risk"])
        self.assertEqual(calc(gaps=["Piden 3 años"])["risk"], calc(gaps=["Otro requisito"])["risk"])

    def test_missing_skills_add_risk(self):
        self.assertGreater(calc(gaps=["No tienes GCP", "Sin BigQuery"])["risk"], calc()["risk"])

    def test_timezone_and_hours_add_no_risk(self):
        base = calc()["risk"]
        for g in ["Horario EST obligatorio", "Horario CST (hora de México)", "European hours", "US hours", "Zona horaria CET"]:
            self.assertEqual(calc(fit_reasons=["a", g])["risk"], base, g)
        self.assertNotIn("zona horaria", calc(fit_reasons=["a", "Horario EST"])["risk_driver"].lower())
        self.assertNotIn("timezone", opp.RISK_POINTS)

    def test_ghost_signals(self):
        self.assertGreater(calc(posted_date="2026-08-01")["risk"], calc(posted_date="2026-10-01")["risk"])
        self.assertGreater(calc(reposted=True)["risk"], calc()["risk"])
        self.assertIn("fantasma", calc(posted_date="2026-08-01")["risk_driver"])

    def test_unclear_or_unpaid_salary(self):
        self.assertGreater(calc(salary_mxn_month=None)["risk"], calc()["risk"])
        self.assertGreater(calc(salary_mxn_month=18000)["risk"], calc()["risk"])
        self.assertIn("no remunerada", calc(title="Pasante (unpaid internship)", salary_mxn_month=None)["risk_driver"])

    def test_clean_job_has_low_risk_and_neutral_driver(self):
        r = calc()
        self.assertEqual(r["risk"], 0)
        self.assertIn("sin alertas", r["risk_driver"].lower())

    def test_risk_is_capped(self):
        r = calc(posting_language="en", gaps=["10+ años", "a", "b", "Inglés hablado C1"], posted_date="2026-01-01", salary_mxn_month=None, location_verdict="FAIL")
        self.assertEqual(r["risk"], 100)


class Final(unittest.TestCase):
    def test_risk_discounts_opportunity(self):
        low, high = calc(), calc(posting_language="en", gaps=["10+ años de experiencia"])
        self.assertLess(high["final_priority"], high["opportunity"])
        self.assertEqual(low["final_priority"], low["opportunity"])

    def test_max_risk_halves_opportunity(self):
        self.assertEqual(round(80 * (1 - opp.RISK_DISCOUNT)), 40)

    def test_riskier_ranks_below_equal_opportunity(self):
        a = calc(posting_language="en")
        b = calc()
        self.assertGreater(b["final_priority"], a["final_priority"])


class Recompute(unittest.TestCase):
    def test_recompute_updates_only_ranked_and_cli_writes(self):
        with TemporaryDirectory() as d:
            state = Path(d) / "seen.json"
            state.write_text(json.dumps({"seen": {"a": ranked(), "b": {"status": "new", "title": "x"}}}))
            subprocess.run([sys.executable, str(REPO / "tools" / "opportunity.py"), "recompute", "--write", "--state", str(state),
                            "--settings", str(Path(d) / "n.json"), "--today", "2026-10-16"], check=True, capture_output=True)
            seen = json.loads(state.read_text())["seen"]
            self.assertIn("final_priority", seen["a"])
            self.assertNotIn("final_priority", seen["b"])


if __name__ == "__main__":
    unittest.main()
