"""Tests for tools/prefilter.py - the LLM-free gate in front of /rank."""
import json
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import prefilter  # noqa: E402

TODAY = date(2026, 10, 16)
TOOL = REPO / "tools" / "prefilter.py"


def job(title, location="Remote (Mexico)", **over):
    base = {"title": title, "company": "Acme", "location": location, "status": "new",
            "posted_date": "2026-10-15", "fit": "medium", "portal": "himalayas"}
    base.update(over)
    return base


def out(title, **kw):
    return prefilter.evaluate(job(title, **kw), TODAY)


class Exclusions(unittest.TestCase):
    def test_off_target_titles_are_out_with_spanish_reason(self):
        for title in [
            "SAP PM functional consultant - 2670", "Murex S4C Consultant - Remoto 2855",
            "Java Backend Developer - Remoto - 2891", ".NET Developer", "iOS Engineer",
            "Android Developer", "Inside Sales Representative", "Marketing Analyst",
            "Senior Recruiter", "Accounting Specialist", "Staff Software Engineer",
            "Principal Backend Engineer", "Director of Engineering", "Head of Growth",
            "Desarrollador Java Sênior",
        ]:
            with self.subTest(title=title):
                r = out(title)
                self.assertTrue(r["out"], r)
                self.assertTrue(r["reason"])

    def test_target_roles_are_kept(self):
        for title in [
            "Desarrollador Python Senior Remoto 2571", "Data Engineer", "AI Engineer (LLM / Python)",
            "QA Automation Engineer", "Backend Developer", "Analista de datos", "Desarrollador RPA",
            "Marketing Technology Engineer", "React Native Developer", "Python Developer (Java migration)",
            "SAP integration Python developer",
        ]:
            with self.subTest(title=title):
                self.assertFalse(out(title)["out"], title)

    def test_staff_is_matched_as_a_word(self):
        self.assertFalse(out("Backend Engineer - Staffing Platform")["out"])

    def test_location_restricted_to_another_country_is_out(self):
        self.assertTrue(out("Backend Developer", location="Remote (Brazil)")["out"])
        self.assertIn("Brazil", out("Backend Developer", location="Brazil")["reason"])

    def test_location_open_to_mexico_or_unknown_is_kept(self):
        for loc in ["Remote (Brazil, Mexico)", "Remote (worldwide)", "LATAM, Canada, USA", "None", None, "Remote", ""]:
            with self.subTest(loc=loc):
                self.assertFalse(out("Backend Developer", location=loc)["out"])

    def test_title_open_to_region_overrides_single_country_location(self):
        for title in ["Freelance Python Developer (Remote, South / Latin America)",
                      "Python Developer - LATAM", "Backend Developer (Latinoam\u00e9rica)",
                      "Backend Developer, Am\u00e9rica Latina", "Python Dev (Sudam\u00e9rica)",
                      "Python Dev (South America)", "Python Dev (M\u00e9xico)", "Python Dev - Worldwide",
                      "Python Dev, work from anywhere", "Global Python Developer"]:
            with self.subTest(title=title):
                self.assertFalse(out(title, location="Remote (Brazil)")["out"])

    def test_other_text_field_open_to_region_overrides_location(self):
        entry = job("Backend Developer", location="Remote (Brazil)", fit="Open to LATAM")
        self.assertFalse(prefilter.evaluate(entry, TODAY)["out"])

    def test_truncated_location_is_not_trusted(self):
        loc = "Remote (" + ", ".join(["Argentina", "Bahamas", "Barbados", "Belize", "Bolivia", "Brazil", "Canada", "Chile"] * 3)
        self.assertGreaterEqual(len(loc), 190)
        self.assertFalse(out("Backend Developer", location=loc)["out"])


class Scoring(unittest.TestCase):
    def test_xideral_python_senior_beats_generic_roles(self):
        top = out("Desarrollador Python Senior Remoto 2571")["score"]
        for title in ["Software Engineer", "QA Analyst", "Customer Data Analyst"]:
            self.assertGreater(top, out(title, location="Remote (worldwide)")["score"], title)

    def test_python_data_ai_outrank_generic(self):
        self.assertGreater(out("Python Backend Developer")["score"], out("Software Developer")["score"])
        self.assertGreater(out("Data Engineer")["score"], out("Frontend Developer")["score"])

    def test_score_is_clamped_and_recency_matters(self):
        fresh = prefilter.score(job("Backend Developer"), TODAY)
        old = prefilter.score(job("Backend Developer", posted_date="2026-08-01"), TODAY)
        self.assertLessEqual(prefilter.score(job("Python Data AI Backend Developer"), TODAY), 100)
        self.assertGreater(fresh, old)
        self.assertGreaterEqual(prefilter.score(job("Lead Manager Intern", location="x", posted_date="2020-01-01"), TODAY), 0)

    def test_stated_salary_below_current_pay_lowers_score(self):
        low = prefilter.score(job("Backend Developer", salary_mxn_month=15000), TODAY)
        high = prefilter.score(job("Backend Developer", salary_mxn_month=50000), TODAY)
        self.assertGreater(high, low)


class Discrimination(unittest.TestCase):
    """Real tech fits clear the gate; non-tech noise is excluded or capped far below it."""
    GATE = 55

    def score_of(self, title, location=None, fit="medium"):
        return prefilter.score(job(title, location=location, fit=fit), TODAY)

    def test_real_fits_score_above_gate_even_without_location(self):
        for title in ["AI ENGINEER", "Senior AI Engineer", "Spark Data Engineer - Remote work | REF#305832",
                      "Big Data Engineer (Databricks)", "Senior Backend Engineer", "AI Engineer (Copilot)",
                      "Lead Data Engineer", "Ingeniero de datos", "Desarrollador Python Senior"]:
            with self.subTest(title=title):
                self.assertGreaterEqual(self.score_of(title, "Remote (worldwide)"), self.GATE)
                self.assertGreaterEqual(self.score_of(title, None), self.GATE)

    def test_non_tech_titles_are_excluded_or_capped_low(self):
        for title in ["Deal Desk Analyst - Mexico", "Patient Care Communications Specialist",
                      "IC \u2013 Construction Estimator I", "French Bilingual Interpreter",
                      "CEO & Co-founder (Robotics Automation)", "Customer Care Specialist (phone)",
                      "Logistics Coordinator", "Accounts Payable/Accounts Receivable Specialist",
                      "Planner Buyer", "Learning & Development Specialist", "Talent Programs Coordinator",
                      "Mechanical Engineering Expert (MSc. or PhD)", "Electrical Instrumentation Engineer - Data Center"]:
            with self.subTest(title=title):
                entry = job(title, location="Remote (Mexico)")
                verdict = prefilter.evaluate(entry, TODAY)
                self.assertTrue(verdict["out"] or verdict["score"] < 40, verdict)
                if verdict["out"]:
                    self.assertTrue(verdict["reason"])

    def test_non_tech_title_without_tech_signal_is_capped_at_30(self):
        for title in ["Strategy & Operations Associate", "Solutions Strategist", "Join our Talent Community"]:
            with self.subTest(title=title):
                self.assertLessEqual(self.score_of(title, "Remote (Mexico)", fit="high"), 30)

    def test_tech_roles_with_engineer_word_are_not_excluded(self):
        for title in ["Founding Engineer", "Software Engineer (GitHub Contributor)",
                      "Founding Robotic Engineer (Software, Mechatronics, AI)", "Site Reliability Engineer"]:
            with self.subTest(title=title):
                self.assertFalse(out(title)["out"], title)

    def test_stack_match_and_family_spread_scores(self):
        py = self.score_of("Python Backend Engineer (FastAPI, AWS)", "Remote (Mexico)")
        plain = self.score_of("Software Engineer", "Remote (Mexico)")
        noise = self.score_of("Event Coordinator", "Remote (Mexico)")
        self.assertGreaterEqual(py, 80)
        self.assertGreater(py, plain + 10)
        self.assertGreater(plain, noise + 25)

    def test_portuguese_titles_without_engenheiro_are_out(self):
        for title in ["Pessoa Especialista em Desenvolvimento Full-stack", "Pessoa Especialista em Engenharia de Dados"]:
            with self.subTest(title=title):
                self.assertTrue(out(title)["out"], title)

    def test_ai_word_alone_is_not_a_tech_signal(self):
        self.assertLessEqual(self.score_of("Creative Producer (AI-Driven)", "Remote (Mexico)"), 30)
        self.assertGreaterEqual(self.score_of("AI Engineer", "Remote (Mexico)"), 60)

    def test_default_gate_is_sixty(self):
        self.assertEqual(prefilter.DEFAULT_MIN_PREFILTER_SCORE, 60)


class State(unittest.TestCase):
    SETTINGS = {"minSalaryMxn": 35000, "currentSalary": 21000}

    def test_run_marks_out_keeps_rest_and_never_deletes(self):
        seen = {"a": job("SAP consultant"), "b": job("Python Developer"), "c": job("x", status="ranked")}
        counts = prefilter.prefilter_state(seen, TODAY, self.SETTINGS)
        self.assertEqual(counts["prefiltered_out"], 1)
        self.assertEqual(seen["a"]["status"], "prefiltered_out")
        self.assertIn("SAP", seen["a"]["prefilter_reason"])
        self.assertEqual(seen["b"]["status"], "new")
        self.assertIsInstance(seen["b"]["prefilter_score"], int)
        self.assertNotIn("prefilter_score", seen["c"])
        self.assertEqual(len(seen), 3)

    def test_recovered_entries_are_not_filtered_again(self):
        seen = {"a": job("SAP consultant")}
        prefilter.prefilter_state(seen, TODAY, self.SETTINGS)
        self.assertTrue(prefilter.recover_entry(seen["a"]))
        self.assertEqual(seen["a"]["status"], "new")
        self.assertNotIn("prefilter_reason", seen["a"])
        prefilter.prefilter_state(seen, TODAY, self.SETTINGS)
        self.assertEqual(seen["a"]["status"], "new")

    def test_recover_only_works_on_prefiltered_entries(self):
        self.assertFalse(prefilter.recover_entry(job("x", status="ranked")))

    def test_settings_defaults_and_validation(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "s.json"
            self.assertEqual(prefilter.load_search_settings(p)["rankBatch"], 10)
            self.assertEqual(prefilter.load_search_settings(p)["minPrefilterScore"], 60)
            p.write_text(json.dumps({"currentSalary": 21000, "search": {"rankBatch": 40, "minSalaryMxn": "x"}}))
            s = prefilter.load_search_settings(p)
            self.assertEqual((s["rankBatch"], s["minSalaryMxn"]), (40, 35000))

    def test_min_prefilter_score_accepts_zero_and_rejects_out_of_range(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "s.json"
            for raw, expected in ((0, 0), (80, 80), (101, 60), (-1, 60), ("9", 60), (True, 60)):
                p.write_text(json.dumps({"search": {"minPrefilterScore": raw}}))
                self.assertEqual(prefilter.load_search_settings(p)["minPrefilterScore"], expected, raw)


class Cli(unittest.TestCase):
    def test_run_write_and_recover_round_trip(self):
        with TemporaryDirectory() as d:
            state = Path(d) / "seen.json"
            state.write_text(json.dumps({"seen": {"a": job("Java Developer"), "b": job("Python Developer")}}))
            settings = Path(d) / "none.json"
            base = [sys.executable, str(TOOL)]
            args = ["--state", str(state), "--settings", str(settings), "--today", "2026-10-16"]
            r = subprocess.run(base + ["run", "--write"] + args, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(r.stdout)["prefiltered_out"], 1)
            seen = json.loads(state.read_text())["seen"]
            self.assertEqual(seen["a"]["status"], "prefiltered_out")
            subprocess.run(base + ["recover", "a"] + args, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(state.read_text())["seen"]["a"]["status"], "new")

    def test_dry_run_does_not_write(self):
        with TemporaryDirectory() as d:
            state = Path(d) / "seen.json"
            state.write_text(json.dumps({"seen": {"a": job("Java Developer")}}))
            subprocess.run([sys.executable, str(TOOL), "run", "--state", str(state), "--settings", str(Path(d) / "n.json")],
                           capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(state.read_text())["seen"]["a"]["status"], "new")


class RankIntegration(unittest.TestCase):
    """rank_state.py candidates hands /rank only the prefilter-ordered top N."""

    def run_rank(self, d, *extra):
        r = subprocess.run(
            [sys.executable, str(REPO / "tools" / "rank_state.py"), "candidates", "--state", str(Path(d) / "seen.json"),
             "--tracker", str(Path(d) / "t.csv"), "--settings", str(Path(d) / "s.json"), "--today", "2026-10-16", *extra],
            capture_output=True, text=True, check=True)
        return json.loads(r.stdout)

    def seed(self, d, rank_batch=2, min_score=0):
        seen = {
            "sap": job("SAP consultant"), "gen": job("Software Engineer", location="Remote (worldwide)"),
            "py": job("Desarrollador Python"), "data": job("Data Engineer"),
            "out": job("Java Developer", status="prefiltered_out", prefilter_reason="x"),
        }
        (Path(d) / "seen.json").write_text(json.dumps({"seen": seen}))
        (Path(d) / "s.json").write_text(json.dumps({"search": {"rankBatch": rank_batch, "minPrefilterScore": min_score}}))

    def test_cap_uses_rank_batch_setting_and_orders_by_prefilter(self):
        with TemporaryDirectory() as d:
            self.seed(d)
            out = self.run_rank(d)
            self.assertEqual([r["key"] for r in out["selected"]], ["py", "data"])
            self.assertEqual(out["rank_batch"], 2)
            self.assertEqual(out["eligible"], 3)  # the SAP job never counts
            self.assertEqual(out["deferred"], 1)
            self.assertEqual(out["auto_discarded_unsaved"], 1)

    def test_explicit_limit_overrides_and_prefiltered_never_returned_even_with_all(self):
        with TemporaryDirectory() as d:
            self.seed(d)
            out = self.run_rank(d, "--limit", "0", "--all")
            keys = {r["key"] for r in out["selected"]}
            self.assertEqual(keys, {"py", "data", "gen"})

    def test_apply_stores_opportunity_and_risk(self):
        with TemporaryDirectory() as d:
            self.seed(d)
            res = Path(d) / "r.json"
            res.write_text(json.dumps([{"key": "py", "status": "scored", "scores": {"technical": 80, "experience": 70, "behavioral": 70, "career": 80},
                                         "location_verdict": "PASS", "language_gate": "PASS", "posting_language": "es", "modality": "remote",
                                         "gaps": ["Sin GCP"], "fit_reasons": ["a", "b"]}]))
            subprocess.run([sys.executable, str(REPO / "tools" / "rank_state.py"), "apply", "--state", str(Path(d) / "seen.json"),
                            "--settings", str(Path(d) / "s.json"), "--today", "2026-10-16", "--results", str(res)], check=True, capture_output=True)
            e = json.loads((Path(d) / "seen.json").read_text())["seen"]["py"]
            for field in ("opportunity", "risk", "final_priority", "opportunity_driver", "risk_driver"):
                self.assertIn(field, e)


if __name__ == "__main__":
    unittest.main()
