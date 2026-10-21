"""Tests for tools/opportunity.py - Oportunidad / Riesgo / final priority."""
import json
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _hermetic  # noqa: F401,E402  (pins profile_config to the test fixture)

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
        self.assertEqual(opp.salary_component(20000, 30000, 20000), 0)
        self.assertEqual(opp.salary_component(30000, 30000, 20000), 50)
        self.assertEqual(opp.salary_component(48000, 30000, 20000), 100)
        self.assertEqual(opp.salary_component(None, 30000, 20000), 40)

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
        self.assertEqual(calc(gaps=["Piden 3 años"])["risk"], calc()["risk"])

    def test_years_within_tolerance_add_no_risk(self):
        base = calc()["risk"]
        self.assertEqual(calc(gaps=["Piden 6 años de experiencia"])["risk"], base)
        self.assertEqual(calc(gaps=["Piden 5+ años de experiencia"])["risk"], base)
        self.assertGreater(calc(gaps=["Piden 7 años de experiencia"])["risk"], base)
        self.assertEqual(opp.CANDIDATE_YEARS, 4)

    def test_degree_gap_adds_no_meaningful_risk(self):
        base = calc()["risk"]
        for gap in ["Piden título profesional/licenciatura", "Requieren licenciatura en ingeniería",
                    "Bachelor's degree required", "Degree in Computer Science", "Título en Ingeniería en Sistemas"]:
            self.assertLessEqual(calc(gaps=[gap])["risk"] - base, 2, gap)
        self.assertEqual(calc(gaps=["Piden licenciatura", "No tienes GCP"])["risk"] - base,
                         calc(gaps=["No tienes GCP"])["risk"] - base + 2)

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


class ProfileDriven(unittest.TestCase):
    def test_years_ask_is_judged_against_the_configured_experience(self):
        from unittest import mock

        asks = ranked(gaps=["Piden 8 años de experiencia"])
        with mock.patch.object(opp, "CANDIDATE_YEARS", 4):
            strict = opp.compute(asks, TODAY)["risk"]
        with mock.patch.object(opp, "CANDIDATE_YEARS", 10):
            senior = opp.compute(asks, TODAY)["risk"]
        self.assertGreater(strict, senior)
        self.assertEqual(senior, 0)

    def test_years_message_uses_configured_years(self):
        from unittest import mock

        with mock.patch.object(opp, "CANDIDATE_YEARS", 5):
            items = opp.risk_items(ranked(gaps=["Piden 12 años"]), TODAY, 20000)
        self.assertTrue(any("tienes ~5 verificables" in label for _, label in items))

    def test_spoken_english_ok_removes_english_penalty(self):
        from unittest import mock

        eng = ranked(posting_language="en")
        base = opp.compute(eng, TODAY)
        with mock.patch.object(opp, "LEVELS", opp.language_levels.user_levels({"spoken_english": True})):
            free = opp.compute(eng, TODAY)
        self.assertLess(free["risk"], base["risk"])
        self.assertGreater(free["opportunity"], base["opportunity"])

    def test_defaults_come_from_profile_config(self):
        self.assertEqual(opp.CANDIDATE_YEARS, opp.profile_config.load()["candidate_years"])


A2_SPEAKER = {"languages": [{"language": "Spanish", "read": "native", "write": "native", "speak": "native"},
                      {"language": "English", "read": "B2", "write": "B2", "speak": "A2"}]}
FRIEND = {"languages": [{"language": "English", "read": "C1", "write": "C1", "speak": "C1"},
                        {"language": "German", "read": "B2", "write": "B2", "speak": "B2"}]}


def lang_component(levels_cfg, **over):
    from unittest import mock
    with mock.patch.object(opp, "LEVELS", opp.language_levels.user_levels(levels_cfg)):
        return opp.opportunity_components(ranked(**over), TODAY, 30000, 20000)["language"]


def risk_with(levels_cfg, **over):
    from unittest import mock
    with mock.patch.object(opp, "LEVELS", opp.language_levels.user_levels(levels_cfg)):
        return opp.compute(ranked(**over), TODAY)


class LanguageGeneralization(unittest.TestCase):
    def test_a2_numbers_are_unchanged(self):
        self.assertEqual(lang_component(A2_SPEAKER, posting_language="es"), 100)
        self.assertEqual(lang_component(A2_SPEAKER, posting_language="mixed"), 70)
        self.assertEqual(lang_component(A2_SPEAKER, posting_language="en"), 20)
        self.assertEqual(lang_component(A2_SPEAKER, posting_language=None), 50)
        # the same with no languages declared at all (fixture profile: spoken_english false)
        self.assertEqual(opp.opportunity_components(ranked(posting_language="en"), TODAY, 30000, 20000)["language"], 20)

    def test_score_table_by_spoken_level(self):
        def cfg(level):
            return {"languages": [{"language": "German", "read": level, "write": level, "speak": level}]}
        want = {"native": 100, "C2": 90, "C1": 90, "B2": 70, "B1": 45, "A2": 20}
        for level, score in want.items():
            self.assertEqual(lang_component(cfg(level), posting_language="de"), score, level)
        self.assertEqual(lang_component({"languages": []}, posting_language="de"), 10)

    def test_friend_components(self):
        self.assertEqual(lang_component(FRIEND, posting_language="en"), 90)
        self.assertEqual(lang_component(FRIEND, posting_language="de"), 70)
        self.assertEqual(lang_component(FRIEND, posting_language="es"), 100)
        self.assertEqual(lang_component(FRIEND, posting_language="fr"), 10)

    def test_risk_scales_with_the_gap(self):
        def cfg(level):
            return {"languages": [{"language": "German", "read": "B2", "write": "B2", "speak": level}]}
        pts = {lvl: risk_with(cfg(lvl), posting_language="de", salary_mxn_month=45000)["risk"] for lvl in ("A2", "B1", "B2")}
        self.assertEqual(pts["A2"], opp.RISK_POINTS["english_posting"])
        self.assertEqual(pts["B1"], round(opp.RISK_POINTS["english_posting"] * opp.GAP_SCALE["B1"]))
        self.assertEqual(pts["B2"], 0)
        self.assertGreater(risk_with({"languages": []}, posting_language="de")["risk"], pts["A2"])

    def test_german_posting_label_names_the_language(self):
        from unittest import mock
        with mock.patch.object(opp, "LEVELS", opp.language_levels.user_levels(A2_SPEAKER)):
            items = opp.risk_items(ranked(posting_language="de"), TODAY, 20000)
        self.assertTrue(any("alemán" in label for _, label in items), items)

    def test_friend_has_no_language_risk_in_english_or_german(self):
        for lang in ("en", "de"):
            self.assertEqual(risk_with(FRIEND, posting_language=lang, salary_mxn_month=45000)["risk"], 0, lang)

    def test_stated_german_gap_for_a2_vs_friend(self):
        gap = ["Alemán hablado C1"]
        a2 = risk_with(A2_SPEAKER, gaps=gap, salary_mxn_month=45000)["risk"]
        friend = risk_with(FRIEND, gaps=gap, salary_mxn_month=45000)["risk"]
        self.assertEqual(a2, round(opp.RISK_POINTS["english_stated"] * opp.GAP_SCALE["none"]) + opp.RISK_POINTS["english_advanced"])
        self.assertEqual(friend, opp.RISK_POINTS["english_advanced"])  # B2 speaker, C1 asked

    def test_language_advantage_bonus_and_note(self):
        plain = risk_with(FRIEND, posting_language="en", title="Backend Engineer")
        adv = risk_with(FRIEND, posting_language="en", title="Backend Engineer (German speaking)")
        self.assertEqual(adv["language_advantage"], "Ventaja de idioma: piden alemán y tú lo hablas.")
        self.assertNotIn("language_advantage", plain)
        self.assertGreater(adv["opportunity"], plain["opportunity"])
        from unittest import mock
        with mock.patch.object(opp, "LEVELS", opp.language_levels.user_levels(FRIEND)):
            a = opp.opportunity_components(ranked(posting_language="en", title="German speaking Engineer"), TODAY, 30000, 20000)["language"]
        self.assertEqual(a, 100)  # 90 for English C1 + 10 bonus, capped at 100

    def test_advantage_reads_tags_snippet_and_description(self):
        for field, value in (("tags", ["python", "DACH"]), ("snippet", "Fluent German a plus"), ("description", "bilingual English/German")):
            r = risk_with(FRIEND, posting_language="en", **{field: value})
            self.assertIn("language_advantage", r, field)

    def test_a2_gets_no_advantage(self):
        r = risk_with(A2_SPEAKER, posting_language="en", title="Backend Engineer (German speaking)")
        self.assertNotIn("language_advantage", r)

    def test_apply_scores_drops_a_stale_advantage_note(self):
        from unittest import mock
        entry = ranked(posting_language="en", language_advantage="vieja")
        with mock.patch.object(opp, "LEVELS", opp.language_levels.user_levels(A2_SPEAKER)):
            opp.apply_scores(entry, TODAY, 30000, 20000)
        self.assertNotIn("language_advantage", entry)


if __name__ == "__main__":
    unittest.main()
