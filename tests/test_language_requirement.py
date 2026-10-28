"""Tests for tools/language_requirement.py: the deterministic reader of the REAL language requirement."""
import unittest
import _hermetic  # noqa: F401  (pins the profile to a fixture)
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import language_requirement as lr  # noqa: E402


def one(text, lang="en", posting="en"):
    found = [r for r in lr.extract(text, posting) if r["lang"] == lang]
    assert found, f"nothing found in {text!r}"
    return found[0]


class ExtractTests(unittest.TestCase):
    def test_fluent(self):
        r = one("We need someone with fluent English to talk to our clients.")
        self.assertEqual((r["kind"], r["skill"], r["source"]), ("fluent", "speak", "regex"))
        self.assertIn("fluent English", r["evidence"])

    def test_conversational(self):
        r = one("Conversational English is required.")
        self.assertEqual((r["kind"], r["skill"]), ("conversational", "speak"))

    def test_excellent_communication_skills(self):
        r = one("Excellent communication skills in English, both written and verbal.")
        self.assertEqual(r["skill"], "speak")
        self.assertIn(r["kind"], ("advanced", "fluent"))

    def test_cefr_level(self):
        r = one("Requirements: English B2 or higher.")
        self.assertEqual((r["level"], r["kind"], r["skill"]), ("B2", "intermediate", "any"))
        r = one("C1 level of English")
        self.assertEqual((r["level"], r["kind"]), ("C1", "advanced"))
        self.assertEqual(one("English A2")["kind"], "basic")

    def test_intermediate_and_advanced_words(self):
        self.assertEqual(one("Intermediate English")["kind"], "intermediate")
        r = one("Upper-intermediate English")
        self.assertEqual((r["kind"], r["level"]), ("intermediate", "B2"))
        self.assertEqual(one("Advanced English skills")["kind"], "advanced")
        self.assertEqual(one("Basic English")["kind"], "basic")

    def test_spanish_patterns(self):
        self.assertEqual(one("Inglés avanzado indispensable", posting="es")["kind"], "advanced")
        self.assertEqual(one("Inglés intermedio", posting="es")["kind"], "intermediate")
        r = one("Inglés conversacional", posting="es")
        self.assertEqual((r["kind"], r["skill"]), ("conversational", "speak"))
        self.assertEqual(one("Nivel B2 de inglés", posting="es")["level"], "B2")

    def test_technical_read_write(self):
        r = one("Able to read and write technical English.")
        self.assertEqual((r["kind"], r["skill"]), ("technical_read_write", "read_write"))
        self.assertEqual(one("Written English is a must for documentation.")["skill"], "read_write")
        self.assertEqual(one("Lectura y escritura de inglés técnico", posting="es")["kind"], "technical_read_write")

    def test_spoken_contexts(self):
        self.assertEqual(one("All interviews will be in English.")["skill"], "speak")
        self.assertEqual(one("Daily stand-ups in English with the team.")["skill"], "speak")
        r = one("You will work with US clients every day.")
        self.assertEqual((r["lang"], r["skill"]), ("en", "speak"))

    def test_optional(self):
        r = one("English is a plus.")
        self.assertTrue(r.get("optional"))
        self.assertEqual(r["kind"], "basic")
        self.assertTrue(one("Nice to have: fluent English")["optional"])
        self.assertTrue(one("Se valora inglés avanzado", posting="es").get("optional"))

    def test_nothing_found_is_unspecified_for_the_posting_language(self):
        out = lr.extract("We build data pipelines in Python. Remote role.", "en")
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["lang"], out[0]["kind"], out[0]["evidence"]), ("en", "unspecified", None))

    def test_nothing_found_in_a_spanish_posting_returns_nothing(self):
        self.assertEqual(lr.extract("Buscamos ingeniero Python.", "es"), [])

    def test_other_languages(self):
        r = one("Fluent German is required, English is a plus.", lang="de", posting="de")
        self.assertEqual(r["kind"], "fluent")
        self.assertEqual(one("Verhandlungssicheres Deutsch", lang="de", posting="de")["lang"], "de")

    def test_multiple_languages_in_one_phrase(self):
        out = lr.extract("Fluent in English and German", "en")
        self.assertEqual({r["lang"] for r in out}, {"en", "de"})

    def test_evidence_is_verbatim_and_capped(self):
        long = "Intro " * 100 + "We require fluent English for daily calls. " + "Outro " * 100
        r = one(long)
        self.assertLessEqual(len(r["evidence"]), 160)
        self.assertIn("fluent English", r["evidence"])
        self.assertIn(r["evidence"].strip("… "), long)

    def test_accented_text_keeps_verbatim_evidence(self):
        r = one("Se requiere inglés conversacional para reuniones.", posting="es")
        self.assertIn("inglés conversacional", r["evidence"])

    def test_ignores_unrelated_mentions(self):
        out = lr.extract("Our engineers contribute to the English Premier League data platform.", "en")
        self.assertEqual([r for r in out if r["kind"] != "unspecified"], [])


class ValidateTests(unittest.TestCase):
    def test_drops_bad_items_and_caps(self):
        raw = [
            {"lang": "en", "skill": "speak", "level": "C1", "kind": "fluent", "evidence": "x" * 500, "source": "llm"},
            {"lang": "xx", "skill": "speak"},
            "junk",
            {"lang": "en", "skill": "bogus", "level": "Z9", "kind": "nope", "evidence": 5, "source": "alien"},
        ] + [{"lang": "de", "skill": "any", "kind": "basic"}] * 20
        out = lr.validate(raw)
        self.assertLessEqual(len(out), lr.MAX_ITEMS)
        self.assertLessEqual(len(out[0]["evidence"]), lr.MAX_EVIDENCE)
        self.assertEqual(out[1], {"lang": "en", "skill": "any", "level": None, "kind": "unspecified", "evidence": None, "source": "llm"})
        self.assertTrue(all(r["lang"] in ("en", "de") for r in out))

    def test_not_a_list_is_none(self):
        self.assertIsNone(lr.validate(None))
        self.assertIsNone(lr.validate("fluent"))

    def test_evidence_goes_through_the_posting_guard(self):
        out = lr.validate([{"lang": "en", "skill": "speak", "kind": "fluent", "evidence": "fluent​ Eng​lish"}])
        self.assertEqual(out[0]["evidence"], "fluent English")


if __name__ == "__main__":
    unittest.main()


class MoreExtractTests(unittest.TestCase):
    def test_proficiency_without_level_is_unspecified_but_keeps_the_quote(self):
        r = one("Good command of English")
        self.assertEqual(r["kind"], "unspecified")
        self.assertIn("command of English", r["evidence"])

    def test_cefr_after_proficiency_word(self):
        self.assertEqual(one("English proficiency (B2+) is required")["level"], "B2")

    def test_communicate_in_english(self):
        self.assertEqual(one("Must be able to communicate in English with the US team")["skill"], "speak")

    def test_plus_only_applies_to_its_own_clause(self):
        out = {r["lang"]: r for r in lr.extract("Spanish is a plus, English required", "en")}
        self.assertTrue(out["es"].get("optional"))
        self.assertFalse(out["en"].get("optional"))

    def test_fluent_in_two_languages(self):
        langs = {r["lang"] for r in lr.extract("Fluent in English and Spanish required.", "en") if r["kind"] == "fluent"}
        self.assertEqual(langs, {"en", "es"})


def _ok(text):
    return (("ok", text) if text is not None else ("error", None))


class BackfillTests(unittest.TestCase):
    LEVELS = lr.language_levels.user_levels({})

    def seen(self):
        base = {"status": "ranked", "posting_language": "en", "language_gate": "FLAG",
                "language_note": "La vacante está escrita en inglés: probablemente se requiere inglés hablado y tu nivel hablado es A2.",
                "gaps": ["Inglés hablado"], "url": "https://example.com/x"}
        return {
            "rw": {**base, "portal": "himalayas"}, "fl": {**base, "portal": "jobicy"}, "ind": {**base, "portal": "indeed"},
            "bad": {**base, "portal": "linkedin-search"}, "done": {**base, "portal": "himalayas", "language_requirements": []},
            "new": {**base, "status": "new", "portal": "himalayas"},
        }

    def test_backfill(self):
        texts = {"rw": "You can read and write technical English.", "fl": "Fluent English is a must for daily calls.", "bad": None}
        seen = self.seen()
        fetched = []
        summary = lr.backfill_state(seen, self.LEVELS, lambda e: (fetched.append(e) or _ok(texts[next(k for k, v in seen.items() if v is e)])), delay=0)
        self.assertEqual(summary["candidates"], 4)
        self.assertEqual((summary["fetched"], summary["failed"], summary["no_cli"]), (2, 1, 1))
        self.assertEqual(seen["rw"]["language_gate"], "PASS")
        self.assertEqual(seen["rw"]["gaps"], [])
        self.assertEqual(seen["fl"]["language_gate"], "FLAG")
        self.assertEqual(seen["fl"]["language_requirements"][0]["kind"], "fluent")
        self.assertEqual(seen["ind"]["language_requirements"][0]["source"], "none")
        self.assertNotIn("language_requirements", seen["bad"])   # failed fetch: retried by the next run
        self.assertEqual(seen["done"]["language_requirements"], [])   # never re-fetched
        self.assertNotIn("language_requirements", seen["new"])      # only ranked entries
        self.assertEqual(summary["kinds"]["en"]["fluent"], 1)

    def test_earlier_llm_spoken_judgement_is_kept_when_the_text_says_nothing(self):
        seen = {"k": {"status": "ranked", "posting_language": "en", "portal": "himalayas", "url": "https://example.com/x",
                      "language_gate": "FLAG", "language_note": "El anuncio exige inglés fluido para llamadas diarias.",
                      "gaps": ["Inglés hablado: piden inglés fluido en llamadas con el CEO"]}}
        summary = lr.backfill_state(seen, self.LEVELS, lambda e: ("ok", "Python backend role."), delay=0)
        self.assertEqual(summary["kept_from_llm"], 1)
        r = seen["k"]["language_requirements"][0]
        self.assertEqual((r["kind"], r["source"], r["skill"]), ("fluent", "llm", "speak"))
        self.assertEqual(seen["k"]["language_note"], "El anuncio exige inglés fluido para llamadas diarias.")


OLD_NOTE = "La vacante está escrita en inglés: probablemente se requiere inglés hablado y tu nivel hablado es A2."


def llm_entry(**over):
    base = {"status": "ranked", "posting_language": "en", "portal": "himalayas", "url": "https://example.com/x",
            "language_gate": "FLAG", "language_note": OLD_NOTE, "gaps": ["Inglés hablado", "Otra brecha"]}
    base.update(over)
    return base


class LlmHintTests(unittest.TestCase):
    LEVELS = lr.language_levels.user_levels({})

    def test_old_assumption_template_is_not_evidence(self):
        h = lr.llm_hint(llm_entry())
        self.assertEqual((h["kind"], h["source"]), ("unspecified", "llm_assumption"))

    def test_gap_that_only_says_the_posting_is_in_english_is_an_assumption(self):
        e = llm_entry(language_note=None, gaps=["Inglés hablado: la vacante está escrita en inglés, se asume que lo necesitas"])
        self.assertEqual(lr.llm_hint(e)["source"], "llm_assumption")

    def test_concrete_evidence_keeps_it_spoken(self):
        cases = {
            "Inglés hablado: piden inglés fluido": "fluent",
            "Piden inglés conversacional para las llamadas": "conversational",
            "Inglés hablado C1 requerido": "fluent",
            "Entrevistas en inglés con el equipo de EE. UU.": "conversational",
            "Reuniones diarias en inglés": "conversational",
            "Excellent communication skills in English": "conversational",
            "Trabajas con clientes en inglés": "conversational",
            "Inglés avanzado hablado": "fluent",
        }
        for text, kind in cases.items():
            h = lr.llm_hint(llm_entry(language_note=None, gaps=[text]))
            self.assertEqual((h["source"], h["kind"], h["skill"]), ("llm", kind, "speak"), text)

    def test_other_uses_of_advanced_do_not_count(self):
        h = lr.llm_hint(llm_entry(language_note=None, gaps=["Inglés hablado: piden Python avanzado y la vacante está en inglés"]))
        self.assertEqual(h["source"], "llm_assumption")

    def test_no_stated_spoken_requirement_at_all_has_no_hint(self):
        self.assertIsNone(lr.llm_hint(llm_entry(language_note=None, gaps=["Otra brecha"], language_gate="PASS")))

    def test_assumption_makes_the_job_visible_with_a_soft_flag(self):
        seen = {"k": llm_entry()}
        lr.backfill_state(seen, self.LEVELS, lambda e: ("ok", "Python backend role."), delay=0)
        e = seen["k"]
        self.assertEqual(e["language_requirements"][0]["source"], "llm_assumption")
        self.assertEqual(e["language_note"], "No especifica el nivel; probablemente hay reuniones en inglés.")
        self.assertEqual(e["gaps"], ["Otra brecha"])   # the assumed "Inglés hablado" gap is gone

    def test_assumption_beats_an_agent_written_note_that_is_only_the_template(self):
        e = llm_entry(language_note="El anuncio está escrito en inglés, así que probablemente se pide inglés hablado.", gaps=[])
        seen = {"k": e}
        lr.backfill_state(seen, self.LEVELS, lambda x: ("ok", "Python backend role."), delay=0)
        self.assertEqual(seen["k"]["language_requirements"][0]["source"], "llm_assumption")
        self.assertIn("No especifica el nivel", seen["k"]["language_note"])

    def test_redo_repairs_earlier_hint_records_without_fetching(self):
        old = llm_entry(language_requirements=[{"lang": "en", "skill": "speak", "level": None, "kind": "conversational", "evidence": None, "source": "llm"}])
        keep = llm_entry(language_note=None, gaps=["Inglés hablado: piden inglés fluido en llamadas diarias"],
                         language_requirements=[{"lang": "en", "skill": "speak", "level": None, "kind": "fluent", "evidence": None, "source": "llm"}])
        quoted = llm_entry(language_requirements=[{"lang": "en", "skill": "speak", "level": None, "kind": "fluent", "evidence": "Fluent English", "source": "regex"}])
        seen = {"old": old, "keep": keep, "quoted": quoted}
        n = lr.redo_llm_hints(seen, self.LEVELS)
        self.assertEqual(n, {"checked": 2, "downgraded": 1, "kept": 1})
        self.assertEqual(seen["old"]["language_requirements"][0]["source"], "llm_assumption")
        self.assertEqual(seen["keep"]["language_requirements"][0]["source"], "llm")
        self.assertEqual(seen["quoted"]["language_requirements"][0]["evidence"], "Fluent English")


class HedgeAndOriginalTests(unittest.TestCase):
    LEVELS = lr.language_levels.user_levels({})

    def test_a_guess_about_calls_is_not_evidence(self):
        e = llm_entry(language_note=None, gaps=["Inglés hablado: la vacante está en inglés y probablemente haya llamadas con el equipo"])
        self.assertEqual(lr.llm_hint(e)["source"], "llm_assumption")

    def test_firm_clause_next_to_a_hedged_one_still_counts(self):
        e = llm_entry(language_note="El anuncio pide inglés avanzado y está escrito en inglés: probablemente se requiere inglés hablado.", gaps=[])
        self.assertEqual((lr.llm_hint(e)["source"], lr.llm_hint(e)["kind"]), ("llm", "fluent"))

    def test_a_note_written_by_this_tool_is_not_evidence(self):
        e = llm_entry(language_note="Piden inglés conversacional. Tu nivel hablado es A2.", gaps=["Inglés hablado"])
        self.assertEqual(lr.llm_hint(e)["source"], "llm_assumption")

    def test_redo_judges_the_original_wording_not_the_rewritten_one(self):
        rewritten = llm_entry(language_note="Piden inglés conversacional. Tu nivel hablado es A2.", gaps=["Inglés hablado"],
                              language_requirements=[{"lang": "en", "skill": "speak", "level": None, "kind": "conversational", "evidence": None, "source": "llm"}])
        original = {"k": llm_entry(language_note=OLD_NOTE, gaps=["Inglés hablado: la vacante está escrita en inglés y tu nivel hablado es ~A2."])}
        seen = {"k": rewritten}
        out = lr.redo_llm_hints(seen, self.LEVELS, original)
        self.assertEqual(out, {"checked": 1, "downgraded": 1, "kept": 0})
        self.assertEqual(seen["k"]["language_requirements"][0]["source"], "llm_assumption")
        self.assertIn("No especifica el nivel", seen["k"]["language_note"])
        self.assertEqual(seen["k"]["gaps"], [])

    def test_redo_keeps_and_rebuilds_a_concrete_original(self):
        rewritten = llm_entry(language_note="Piden inglés conversacional. Tu nivel hablado es A2.", gaps=["Inglés hablado"],
                              language_requirements=[{"lang": "en", "skill": "speak", "level": None, "kind": "conversational", "evidence": None, "source": "llm"}])
        original = {"k": llm_entry(language_note=OLD_NOTE, gaps=["Inglés hablado: piden inglés avanzado y tu nivel hablado es A2."])}
        seen = {"k": rewritten}
        out = lr.redo_llm_hints(seen, self.LEVELS, original)
        self.assertEqual(out, {"checked": 1, "downgraded": 0, "kept": 1})
        self.assertEqual((seen["k"]["language_requirements"][0]["kind"], seen["k"]["language_requirements"][0]["source"]), ("fluent", "llm"))
        self.assertEqual(seen["k"]["gaps"], ["Inglés hablado: piden inglés avanzado y tu nivel hablado es A2."])


class GoneTests(unittest.TestCase):
    LEVELS = lr.language_levels.user_levels({})

    def test_not_found_is_reported_apart_and_the_entry_is_untouched(self):
        seen = {"gone": llm_entry(), "err": llm_entry(), "ok": llm_entry()}
        out = {"gone": ("gone", None), "err": ("error", None), "ok": ("ok", "Conversational English.")}
        summary = lr.backfill_state(seen, self.LEVELS, lambda e: out[next(k for k, v in seen.items() if v is e)], delay=0)
        self.assertEqual((summary["gone"], summary["failed"]), (["gone"], 1))
        self.assertEqual(summary["failed_keys"], ["err"])
        self.assertNotIn("language_requirements", seen["gone"])
        self.assertNotIn("language_requirements", seen["err"])

    def test_classify_cli_failure(self):
        self.assertEqual(lr.classify_cli_error(1, '{"error":"job not found (x)","code":"NOT_FOUND"}'), "gone")
        for stdout in ('{"error":"timeout","code":"NETWORK"}', "", "not json", '{"error":"HTTP 503","code":"HTTP_ERROR"}'):
            self.assertEqual(lr.classify_cli_error(1, stdout), "error")

    def test_expire_results_use_the_rank_state_expiry_shape(self):
        res = lr.expire_results(["a", "b"])
        self.assertEqual(res[0], {"key": "a", "status": "expired", "reason": lr.GONE_REASON})
        self.assertEqual(lr.GONE_REASON, "La vacante ya no existe en el portal")
