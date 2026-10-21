import unittest
import _hermetic  # noqa: F401  (pins the profile to a fixture)
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import language_levels as ll  # noqa: E402

A2_SPEAKER = {"languages": [
    {"language": "Spanish", "read": "native", "write": "native", "speak": "native"},
    {"language": "English", "read": "B2", "write": "B2", "speak": "A2"},
]}
FRIEND = {"languages": [
    {"language": "Inglés", "read": "C1", "write": "C1", "speak": "C1"},
    {"language": "Alemán", "read": "B2", "write": "B2", "speak": "B2"},
]}
GERMAN_ONLY = {"languages": [{"language": "Deutsch", "read": "C2", "write": "C2", "speak": "C2"}]}


class CefrTests(unittest.TestCase):
    def test_order(self):
        order = [ll.level_rank(x) for x in ("A1", "A2", "B1", "B2", "C1", "C2", "native")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(len(set(order)), 7)

    def test_parse_is_forgiving(self):
        self.assertEqual(ll.parse_level(" b2 "), "B2")
        self.assertEqual(ll.parse_level("Native"), "native")
        self.assertEqual(ll.parse_level("nativo"), "native")
        self.assertIsNone(ll.parse_level("fluent"))
        self.assertIsNone(ll.parse_level(None))
        self.assertIsNone(ll.parse_level(3))

    def test_rank_of_missing_is_below_everything(self):
        self.assertLess(ll.level_rank(None), ll.level_rank("A1"))

    def test_at_least(self):
        self.assertTrue(ll.at_least("C1", "B2"))
        self.assertTrue(ll.at_least("B2", "B2"))
        self.assertFalse(ll.at_least("B1", "B2"))
        self.assertFalse(ll.at_least(None, "A1"))


class NameTests(unittest.TestCase):
    def test_names_in_several_languages(self):
        cases = {
            "Alemán": "de", "German": "de", "Deutsch": "de", "aleman": "de",
            "Inglés": "en", "English": "en", "ingles": "en", "Englisch": "en",
            "Portugués": "pt", "Português": "pt", "Portuguese": "pt",
            "Francés": "fr", "Français": "fr", "French": "fr",
            "Italiano": "it", "Italian": "it",
            "Neerlandés": "nl", "Dutch": "nl", "Nederlands": "nl", "Holandés": "nl",
            "Español": "es", "Spanish": "es", "castellano": "es",
            "Japonés": "ja", "Chinese": "zh",
        }
        for name, code in cases.items():
            self.assertEqual(ll.language_code(name), code, name)

    def test_iso_code_passes_through_and_unknown_is_none(self):
        self.assertEqual(ll.language_code("DE"), "de")
        self.assertIsNone(ll.language_code("Klingon"))
        self.assertIsNone(ll.language_code(""))
        self.assertIsNone(ll.language_code(None))

    def test_spanish_display_names(self):
        self.assertEqual(ll.language_name("de"), "alemán")
        self.assertEqual(ll.language_name("en"), "inglés")
        self.assertEqual(ll.language_name("pt"), "portugués")
        self.assertEqual(ll.language_name("xx"), "xx")


class UserLevelsTests(unittest.TestCase):
    def test_levels_by_code(self):
        lv = ll.user_levels(A2_SPEAKER)
        self.assertEqual(lv["en"], {"read": "B2", "write": "B2", "speak": "A2"})
        self.assertEqual(lv["es"]["speak"], "native")

    def test_spanish_assumed_native_when_not_declared(self):
        lv = ll.user_levels(FRIEND)
        self.assertEqual(lv["es"], {"read": "native", "write": "native", "speak": "native"})
        self.assertEqual(lv["de"]["speak"], "B2")

    def test_declared_spanish_wins(self):
        cfg = {"languages": [{"language": "Español", "read": "B2", "write": "B1", "speak": "B1"}]}
        self.assertEqual(ll.user_levels(cfg)["es"]["speak"], "B1")

    def test_legacy_spoken_english_flag(self):
        self.assertEqual(ll.user_levels({"languages": [], "spoken_english": False})["en"]["speak"], "A2")
        self.assertEqual(ll.user_levels({"spoken_english": True})["en"]["speak"], "B2")

    def test_prefers_code_field_over_name(self):
        cfg = {"languages": [{"language": "Whatever", "code": "fr", "read": "B1", "write": None, "speak": None}]}
        self.assertEqual(ll.user_levels(cfg)["fr"]["read"], "B1")

    def test_unknown_language_name_is_skipped(self):
        cfg = {"languages": [{"language": "Klingon", "read": "C1", "write": "C1", "speak": "C1"}]}
        self.assertNotIn("klingon", ll.user_levels(cfg))

    def test_duplicates_keep_best_level(self):
        cfg = {"languages": [{"language": "German", "read": "A2", "write": None, "speak": "A1"},
                             {"language": "Deutsch", "read": "B1", "write": None, "speak": None}]}
        lv = ll.user_levels(cfg)
        self.assertEqual(lv["de"]["read"], "B1")
        self.assertEqual(lv["de"]["speak"], "A1")


class ThresholdTests(unittest.TestCase):
    def test_constants_documented_in_one_place(self):
        self.assertEqual(ll.SPEAK_COMFORTABLE, "B2")
        self.assertEqual(ll.SPEAK_BORDERLINE, "B1")
        self.assertEqual(ll.READ_MIN, "A2")

    def test_speaks_and_reads(self):
        lv = ll.user_levels(A2_SPEAKER)
        self.assertTrue(ll.speaks(lv, "es", "B2"))
        self.assertFalse(ll.speaks(lv, "en", "B1"))
        self.assertTrue(ll.speaks(lv, "en", "A2"))
        self.assertTrue(ll.reads(lv, "en", "B2"))
        self.assertFalse(ll.reads(lv, "de", "A2"))  # missing language = no level

    def test_speak_status(self):
        lv = ll.user_levels(FRIEND)
        self.assertEqual(ll.speak_status(lv, "en"), "comfortable")
        self.assertEqual(ll.speak_status(lv, "de"), "comfortable")
        self.assertEqual(ll.speak_status(ll.user_levels(A2_SPEAKER), "en"), "gap")
        mid = ll.user_levels({"languages": [{"language": "German", "read": "B1", "write": "B1", "speak": "B1"}]})
        self.assertEqual(ll.speak_status(mid, "de"), "borderline")
        self.assertEqual(ll.speak_status(mid, "fr"), "gap")

    def test_readable_languages(self):
        self.assertEqual(ll.readable_codes(ll.user_levels(A2_SPEAKER)), {"es", "en"})
        self.assertEqual(ll.readable_codes(ll.user_levels(FRIEND)), {"es", "en", "de"})


class GateMatrixTests(unittest.TestCase):
    """posting_language -> (gate, note) for candidate profiles."""

    def test_a2_english_keeps_the_old_note(self):
        gate, note = ll.language_gate("en", ll.user_levels(A2_SPEAKER))
        self.assertEqual(gate, "FLAG")
        self.assertEqual(note, "La vacante está escrita en inglés: probablemente se requiere inglés hablado.")

    def test_a2_spanish_and_mixed_pass(self):
        lv = ll.user_levels(A2_SPEAKER)
        self.assertEqual(ll.language_gate("es", lv), ("PASS", None))
        self.assertEqual(ll.language_gate("mixed", lv), ("PASS", None))
        self.assertEqual(ll.language_gate(None, lv), ("PASS", None))

    def test_a2_german_flags_with_level_in_note(self):
        gate, note = ll.language_gate("de", ll.user_levels(A2_SPEAKER))
        self.assertEqual(gate, "FLAG")
        self.assertIn("alemán", note)
        self.assertIn("no tienes alemán", note)

    def test_a2_speaker_note_names_language_and_level(self):
        cfg = {"languages": [{"language": "German", "read": "B1", "write": "A2", "speak": "A2"}]}
        gate, note = ll.language_gate("de", ll.user_levels(cfg))
        self.assertEqual(gate, "FLAG")
        self.assertEqual(note, "La vacante está escrita en alemán: probablemente se requiere alemán hablado y tu nivel hablado es A2.")

    def test_friend_passes_english_and_german(self):
        lv = ll.user_levels(FRIEND)
        self.assertEqual(ll.language_gate("en", lv), ("PASS", None))
        self.assertEqual(ll.language_gate("de", lv), ("PASS", None))
        self.assertEqual(ll.language_gate("es", lv), ("PASS", None))

    def test_friend_french_is_a_gap(self):
        gate, note = ll.language_gate("fr", ll.user_levels(FRIEND))
        self.assertEqual(gate, "FLAG")
        self.assertIn("francés", note)

    def test_german_only_candidate(self):
        lv = ll.user_levels(GERMAN_ONLY)
        self.assertEqual(ll.language_gate("de", lv), ("PASS", None))
        self.assertEqual(ll.language_gate("es", lv), ("PASS", None))
        gate, note = ll.language_gate("en", lv)
        self.assertEqual(gate, "FLAG")
        self.assertIn("inglés", note)

    def test_borderline_is_a_soft_flag(self):
        cfg = {"languages": [{"language": "German", "read": "B2", "write": "B1", "speak": "B1"}]}
        gate, note = ll.language_gate("de", ll.user_levels(cfg))
        self.assertEqual(gate, "FLAG")
        self.assertIn("B1", note)
        self.assertIn("justo", note)

    def test_gap_label_and_markers(self):
        self.assertEqual(ll.gap_label("en"), "Inglés hablado")
        self.assertEqual(ll.gap_label("de"), "Alemán hablado")
        self.assertIn("spoken german", ll.gap_markers("de"))
        self.assertIn("alemán hablado", ll.gap_markers("de"))

    def test_stated_gap_language(self):
        self.assertEqual(ll.stated_gap_language("Inglés hablado: piden fluido"), "en")
        self.assertEqual(ll.stated_gap_language("Spoken English required"), "en")
        self.assertEqual(ll.stated_gap_language("Alemán hablado C1"), "de")
        self.assertEqual(ll.stated_gap_language("Spoken German required"), "de")
        self.assertEqual(ll.stated_gap_language("English interview rounds"), "en")
        self.assertIsNone(ll.stated_gap_language("Exigen SQL avanzado"))


class AdvantageTests(unittest.TestCase):
    def test_german_speaking_is_an_advantage_for_the_friend(self):
        lv = ll.user_levels(FRIEND)
        for text in ("Backend Engineer (German speaking)", "Entwickler Deutsch fließend", "Remote DACH region",
                     "Bilingual English/German support engineer", "fluent German required"):
            self.assertEqual(ll.language_advantage(text, lv, "en"), ["de"], text)

    def test_not_for_a2(self):
        lv = ll.user_levels(A2_SPEAKER)
        self.assertEqual(ll.language_advantage("German speaking Python developer", lv, "en"), [])
        self.assertEqual(ll.language_advantage("English speaking role", lv, "es"), [])

    def test_posting_main_language_is_not_an_advantage(self):
        lv = ll.user_levels(FRIEND)
        self.assertEqual(ll.language_advantage("English speaking team, fluent English", lv, "en"), [])

    def test_native_language_is_not_an_advantage(self):
        lv = ll.user_levels(FRIEND)
        self.assertEqual(ll.language_advantage("Spanish speaking, español nativo", lv, "en"), [])

    def test_english_requirement_in_spanish_posting_is_an_advantage_for_c1(self):
        lv = ll.user_levels(FRIEND)
        self.assertEqual(ll.language_advantage("Inglés avanzado requerido", lv, "es"), ["en"])

    def test_plain_mention_is_not_enough(self):
        lv = ll.user_levels(FRIEND)
        self.assertEqual(ll.language_advantage("German Shepherd breeder", lv, "en"), [])
        self.assertEqual(ll.language_advantage("Berlin based startup", lv, "en"), [])

    def test_note_is_spanish(self):
        self.assertEqual(ll.advantage_note(["de"]), "Ventaja de idioma: piden alemán y tú lo hablas.")
        self.assertEqual(ll.advantage_note(["de", "fr"]), "Ventaja de idioma: piden alemán y francés y tú los hablas.")
        self.assertIsNone(ll.advantage_note([]))


if __name__ == "__main__":
    unittest.main()
