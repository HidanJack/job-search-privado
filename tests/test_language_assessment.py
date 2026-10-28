"""The language gate reads the REAL requirement (language_levels.requirement_assessment)."""
import unittest
import _hermetic  # noqa: F401
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import language_levels as ll  # noqa: E402

LEVELS = ll.user_levels({"languages": [
    {"language": "Spanish", "read": "native", "write": "native", "speak": "native"},
    {"language": "English", "read": "B2", "write": "B2", "speak": "A2"},
]})


def req(kind, skill="any", level=None, evidence=None, optional=False, lang="en"):
    r = {"lang": lang, "skill": skill, "level": level, "kind": kind, "evidence": evidence, "source": "regex"}
    if optional:
        r["optional"] = True
    return r


def assess(reqs, posting="en", levels=LEVELS):
    return ll.requirement_assessment(posting, reqs, levels)


class AssessmentTests(unittest.TestCase):
    def test_conversational_is_a_spoken_flag_with_quote(self):
        a = assess([req("conversational", "speak", evidence="Conversational English is required")])
        self.assertEqual((a["need"], a["verdict"], a["risk_factor"]), ("spoken", "FLAG", 1.0))
        self.assertEqual(a["note"], "Piden inglés conversacional: «Conversational English is required». Tu nivel hablado es A2.")
        self.assertEqual(a["evidence"], "Conversational English is required")

    def test_fluent_and_advanced_flag(self):
        self.assertEqual(assess([req("fluent", "speak")])["need"], "spoken")
        self.assertEqual(assess([req("advanced", "any", "C1")])["need"], "spoken")

    def test_read_write_within_level_passes(self):
        a = assess([req("technical_read_write", "read_write", evidence="read and write technical English")])
        self.assertEqual((a["need"], a["verdict"], a["risk_factor"]), ("read_write", "PASS", 0.0))
        self.assertEqual(a["note"], "Piden inglés de lectura/escritura (B2): lo cubres.")

    def test_intermediate_and_b2_pass_but_c1_read_write_does_not(self):
        self.assertEqual(assess([req("intermediate")])["need"], "read_write")
        self.assertEqual(assess([req("intermediate", "any", "B2")])["verdict"], "PASS")
        self.assertEqual(assess([req("advanced", "read_write", "C1")])["need"], "spoken")

    def test_spoken_intermediate_above_a2_flags(self):
        self.assertEqual(assess([req("intermediate", "speak", "B1")])["need"], "spoken")

    def test_optional_passes(self):
        a = assess([req("fluent", "speak", optional=True)])
        self.assertEqual((a["need"], a["verdict"], a["risk_factor"]), ("optional", "PASS", 0.0))

    def test_unspecified_in_an_english_posting_is_a_soft_flag_with_half_risk(self):
        a = assess([req("unspecified")])
        self.assertEqual((a["need"], a["verdict"], a["risk_factor"]), ("unspecified", "FLAG", 0.5))
        self.assertEqual(a["note"], "No especifica el nivel; probablemente hay reuniones en inglés.")

    def test_a_spoken_requirement_beats_a_read_write_one(self):
        a = assess([req("technical_read_write", "read_write"), req("conversational", "speak")])
        self.assertEqual(a["need"], "spoken")

    def test_comfortable_speaker_has_no_need(self):
        lv = ll.user_levels({"languages": [{"language": "English", "read": "C1", "write": "C1", "speak": "C1"}]})
        a = assess([req("fluent", "speak")], levels=lv)
        self.assertEqual((a["need"], a["verdict"]), ("none", "PASS"))

    def test_spanish_and_mixed_are_unchanged(self):
        for posting in ("es", "mixed", "unknown", None):
            a = assess([req("fluent", "speak")], posting=posting)
            self.assertEqual((a["need"], a["verdict"], a["note"]), ("none", "PASS", None))

    def test_requirements_of_other_languages_are_ignored(self):
        a = assess([req("fluent", "speak", lang="de")])
        self.assertEqual(a["need"], "unspecified")

    def test_missing_requirements_keep_the_legacy_rule(self):
        a = assess(None)
        self.assertTrue(a["legacy"])
        self.assertEqual((a["verdict"], a["risk_factor"], a["note"]), ("FLAG", 1.0, ll.ENGLISH_POSTING_NOTE))

    def test_empty_list_means_checked_and_nothing_found(self):
        self.assertEqual(assess([])["need"], "unspecified")

    def test_undeclared_spoken_level_note(self):
        lv = ll.user_levels({"languages": [{"language": "German", "read": "B2", "write": "B2", "speak": "B2"}]})
        a = ll.requirement_assessment("fr", [req("fluent", "speak", lang="fr")], lv)
        self.assertIn("No tienes francés hablado declarado", a["note"])


if __name__ == "__main__":
    unittest.main()
