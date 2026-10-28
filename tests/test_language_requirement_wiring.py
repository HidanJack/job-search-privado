"""language_requirements wired into /rank (rank_state apply) and into opportunity/risk."""
import json
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _hermetic  # noqa: F401,E402

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import language_requirement as lr  # noqa: E402
import opportunity as opp  # noqa: E402

TODAY = date(2026, 10, 16)
TOOL = REPO / "tools" / "rank_state.py"
SCORES = {"technical": 70, "experience": 70, "behavioral": 70, "career": 70}


def ranked(**over):
    base = {
        "title": "Python Developer", "status": "ranked", "rank_score": 70, "posted_date": "2026-10-15",
        "posting_language": "en", "modality": "remote", "salary_mxn_month": 45000, "portal": "getonbrd",
        "gaps": [], "fit_reasons": ["a", "b"], "location_verdict": "PASS", "language_gate": "FLAG",
    }
    base.update(over)
    return base


def req(kind, skill="any", level=None, evidence=None, optional=False):
    r = {"lang": "en", "skill": skill, "level": level, "kind": kind, "evidence": evidence, "source": "regex"}
    if optional:
        r["optional"] = True
    return r


class RiskTests(unittest.TestCase):
    def risk(self, **over):
        return opp.compute(ranked(**over), TODAY)["risk"]

    def test_legacy_english_posting_keeps_todays_points(self):
        legacy = self.risk()
        self.assertGreaterEqual(legacy, 40)

    def test_spoken_requirement_keeps_the_points(self):
        self.assertEqual(self.risk(language_requirements=[req("conversational", "speak")]), self.risk())

    def test_unspecified_is_half(self):
        full = self.risk()
        half = self.risk(language_requirements=[req("unspecified")])
        self.assertLess(half, full)
        self.assertAlmostEqual(full - half, 20, delta=1)

    def test_read_write_and_optional_add_no_language_risk(self):
        base = self.risk(posting_language="es")
        for r in (req("technical_read_write", "read_write"), req("basic", optional=True), req("intermediate")):
            self.assertEqual(self.risk(language_requirements=[r]), base)

    def test_language_component_for_read_write_is_like_bilingual(self):
        a = opp.language_component(ranked(language_requirements=[req("technical_read_write", "read_write")]))
        self.assertEqual(a, opp.LANGUAGE_MIXED)
        self.assertLess(opp.language_component(ranked()), a)


class RankStateApplyTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.state = self.tmp / "seen.json"
        self.settings = self.tmp / "settings.json"
        self.settings.write_text("{}")

    def apply(self, result, **entry_over):
        entry = {"title": "Dev", "company": "Acme", "url": "https://example.com/1", "status": "new", "portal": "x",
                 "posted_date": "2026-10-15", **entry_over}
        self.state.write_text(json.dumps({"seen": {"k": entry}}))
        res = {"key": "k", "scores": SCORES, "posting_language": "en", "language_gate": "PASS", **result}
        path = self.tmp / "r.json"
        path.write_text(json.dumps([res]))
        proc = subprocess.run([sys.executable, str(TOOL), "apply", "--results", str(path), "--state", str(self.state),
                               "--today", "2026-10-16", "--settings", str(self.settings)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(self.state.read_text())["seen"]["k"]

    def test_agent_requirements_are_stored_cleaned(self):
        e = self.apply({"language_requirements": [
            {"lang": "en", "skill": "speak", "kind": "conversational", "level": None, "evidence": "Conversational​ English", "source": "llm"}]})
        self.assertEqual(e["language_requirements"][0]["evidence"], "Conversational English")
        self.assertEqual(e["language_gate"], "FLAG")
        self.assertIn("Piden inglés conversacional", e["language_note"])
        self.assertIn("Inglés hablado", e["gaps"] if "gaps" in e else [])

    def test_read_write_requirement_keeps_the_gate_open(self):
        e = self.apply({"language_requirements": [req("technical_read_write", "read_write", evidence="read and write technical English")]})
        self.assertEqual(e["language_gate"], "PASS")
        self.assertEqual(e["language_note"], "Piden inglés de lectura/escritura (B2): lo cubres.")
        self.assertFalse(any("hablado" in g.lower() for g in e.get("gaps", [])))

    def test_missing_requirements_run_the_extractor_on_the_posting_text(self):
        e = self.apply({"posting_text": "We need conversational English for client calls."})
        self.assertEqual(e["language_requirements"][0]["source"], "regex")
        self.assertEqual(e["language_gate"], "FLAG")

    def test_extractor_finding_nothing_marks_unspecified(self):
        e = self.apply({"posting_text": "Build data pipelines in Python."})
        self.assertEqual(e["language_requirements"][0]["kind"], "unspecified")
        self.assertEqual(e["language_gate"], "FLAG")
        self.assertIn("No especifica el nivel", e["language_note"])

    def test_no_text_and_no_requirements_keeps_the_legacy_rule(self):
        e = self.apply({})
        self.assertNotIn("language_requirements", e)
        self.assertEqual(e["language_gate"], "FLAG")  # strict legacy rule: English posting, A2 speaker

    def test_invented_evidence_is_dropped_when_the_text_is_known(self):
        e = self.apply({"posting_text": "Python backend role.", "language_requirements": [
            {"lang": "en", "skill": "speak", "kind": "fluent", "evidence": "must be fluent in English", "source": "llm"}]})
        self.assertIsNone(e["language_requirements"][0]["evidence"])

    def test_an_agent_note_is_never_overwritten(self):
        e = self.apply({"language_gate": "FLAG", "language_note": "Nota del agente.", "language_requirements": [req("technical_read_write", "read_write")]})
        self.assertEqual(e["language_note"], "Nota del agente.")


class ExpiryReasonTests(RankStateApplyTests):
    def test_expired_result_stores_the_reason_and_keeps_the_entry(self):
        entry = {"title": "Dev", "company": "Acme", "url": "https://example.com/1", "status": "ranked", "portal": "x", "rank_score": 70}
        self.state.write_text(json.dumps({"seen": {"k": entry}}))
        path = self.tmp / "r.json"
        path.write_text(json.dumps([{"key": "k", "status": "expired", "reason": "La vacante ya no existe en el portal"}]))
        proc = subprocess.run([sys.executable, str(TOOL), "apply", "--results", str(path), "--state", str(self.state),
                               "--today", "2026-10-16", "--settings", str(self.settings)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        e = json.loads(self.state.read_text())["seen"]["k"]
        self.assertEqual((e["status"], e["expired_reason"], e["title"]), ("expired", "La vacante ya no existe en el portal", "Dev"))


class HelperTests(unittest.TestCase):
    def test_apply_rewrites_auto_notes_only_and_strips_the_auto_gap(self):
        e = {"posting_language": "en", "language_gate": "FLAG", "language_note": "La vacante está escrita en inglés: probablemente se requiere inglés hablado y tu nivel hablado es A2.",
             "gaps": ["Inglés hablado", "Otra brecha"], "language_requirements": [req("technical_read_write", "read_write")]}
        lr.apply(e, opp.LEVELS)
        self.assertEqual(e["language_gate"], "PASS")
        self.assertEqual(e["gaps"], ["Otra brecha"])

    def test_fail_gate_is_never_softened(self):
        e = {"posting_language": "en", "language_gate": "FAIL", "language_note": "x", "language_requirements": [req("basic")]}
        lr.apply(e, opp.LEVELS)
        self.assertEqual(e["language_gate"], "FAIL")


if __name__ == "__main__":
    unittest.main()
