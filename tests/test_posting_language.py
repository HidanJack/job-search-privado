"""Tests for tools/posting_language.py - language detection and the backfill."""
import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
import _hermetic  # noqa: F401,E402  (pins profile_config to the test fixture)
from tempfile import TemporaryDirectory
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
spec = importlib.util.spec_from_file_location("posting_language", REPO / "tools" / "posting_language.py")
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)

ES = "Buscamos un ingeniero con experiencia en el desarrollo de APIs para nuestro equipo, y con conocimientos de bases de datos."
EN = "We are looking for an engineer with strong experience in the team to work on our APIs and join the company."


def ranked(**over):
    base = {
        "status": "ranked",
        "portal": "himalayas-search",
        "url": "https://example.com/job",
        "title": "Data Engineer",
        "rank_score": 70,
        "language_gate": "PASS",
        "gaps": ["Kafka"],
        "strengths": ["Python"],
    }
    base.update(over)
    return base


class Detect(unittest.TestCase):
    def test_spanish(self):
        self.assertEqual(pl.detect_language(ES), "es")

    def test_english(self):
        self.assertEqual(pl.detect_language(EN), "en")

    def test_mixed(self):
        self.assertEqual(pl.detect_language(ES + " " + EN), "mixed")

    def test_too_short_is_none(self):
        self.assertIsNone(pl.detect_language("Data Engineer"))
        self.assertIsNone(pl.detect_language(""))
        self.assertIsNone(pl.detect_language(None))

    def test_html_is_stripped(self):
        self.assertEqual(pl.detect_language(f"<p class='the and of'>{EN}</p>"), "en")

    def test_title_needs_clear_signal(self):
        self.assertEqual(pl.detect_title("Engineer for the team and the data"), "en")
        self.assertIsNone(pl.detect_title("Back-end Software Engineer"))


class Backfill(unittest.TestCase):
    def setUp(self):
        d = TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir = Path(d.name)
        self.state = self.dir / "seen_jobs.json"

    def write(self, seen):
        self.state.write_text(json.dumps({"version": 1, "seen": seen}), encoding="utf-8")

    def read(self):
        return json.loads(self.state.read_text(encoding="utf-8"))["seen"]

    def test_fills_language_and_applies_english_rule_only(self):
        seen = {
            "en": ranked(),
            "es": ranked(),
            "done": ranked(posting_language="es"),
            "skipped": {"status": "skipped"},
        }
        self.write(seen)
        before = copy.deepcopy(seen)
        order = iter([EN, ES])
        summary = pl.backfill(self.state, fetch=lambda e: {"description": next(order)})
        after = self.read()
        self.assertEqual(summary["en"], ["en"])
        self.assertEqual(summary["es"], ["es"])
        self.assertEqual(after["en"]["posting_language"], "en")
        self.assertEqual(after["en"]["language_gate"], "FLAG")
        self.assertEqual(after["en"]["language_note"], pl.rank_state.ENGLISH_POSTING_NOTE)
        self.assertEqual(after["en"]["gaps"], [pl.rank_state.SPOKEN_ENGLISH_GAP, "Kafka"])
        # Spanish: only posting_language is added.
        self.assertEqual(after["es"], {**before["es"], "posting_language": "es"})
        # Untouched entries are identical.
        self.assertEqual(after["done"], before["done"])
        self.assertEqual(after["skipped"], before["skipped"])
        self.assertEqual(after["en"]["strengths"], ["Python"])
        self.assertEqual(after["en"]["rank_score"], 70)

    def test_failed_detail_leaves_entry_unchanged_and_reports(self):
        seen = {"a": ranked(), "b": ranked()}
        self.write(seen)

        def fetch(entry):
            if entry is not None and fetch.calls == 0:
                fetch.calls += 1
                raise RuntimeError("boom")
            return {"description": EN}

        fetch.calls = 0
        summary = pl.backfill(self.state, fetch=fetch)
        after = self.read()
        self.assertEqual([f["key"] for f in summary["failed"]], ["a"])
        self.assertEqual(after["a"], seen["a"])
        self.assertEqual(after["b"]["posting_language"], "en")

    def test_title_fallback_and_none(self):
        seen = {"t": ranked(title="Engineer for the team and the data"), "n": ranked(title="Data Engineer")}
        self.write(seen)
        summary = pl.backfill(self.state, fetch=lambda e: {"description": "", "title": e["title"]})
        self.assertEqual(summary["en"], ["t"])
        self.assertEqual(summary["none"], ["n"])
        self.assertNotIn("posting_language", self.read()["n"])

    def test_indeed_entries_are_skipped_without_fetching(self):
        self.write({"i": ranked(portal="indeed", title="Desarrollador Python"), "b": ranked()})
        calls = []

        def fetch(entry):
            calls.append(entry["portal"])
            return {"description": EN}

        summary = pl.backfill(self.state, fetch=fetch)
        self.assertEqual(calls, ["himalayas-search"])
        self.assertEqual(summary["none"], ["i"])
        self.assertNotIn("posting_language", self.read()["i"])

    def test_dry_run_writes_nothing(self):
        self.write({"a": ranked()})
        raw = self.state.read_bytes()
        summary = pl.backfill(self.state, dry_run=True, fetch=lambda e: {"description": EN})
        self.assertEqual(summary["en"], ["a"])
        self.assertEqual(self.state.read_bytes(), raw)

    def test_atomic_write_keeps_original_when_replace_fails(self):
        self.write({"a": ranked()})
        raw = self.state.read_bytes()
        with mock.patch("os.replace", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                pl.backfill(self.state, fetch=lambda e: {"description": EN})
        self.assertEqual(self.state.read_bytes(), raw)
        self.assertEqual([p.name for p in self.dir.iterdir()], ["seen_jobs.json"])

    def test_fetch_uses_no_shell_and_own_timeout(self):
        run = mock.Mock(return_value=mock.Mock(returncode=0, stdout='{"description": "x"}', stderr=""))
        pl.fetch_detail({"portal": "himalayas-search", "url": "u"}, run=run)
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "bun")
        self.assertFalse(run.call_args.kwargs["shell"])
        self.assertEqual(run.call_args.kwargs["timeout"], pl.FETCH_TIMEOUT)


if __name__ == "__main__":
    unittest.main()


DE = ("Wir suchen einen erfahrenen Entwickler für unser Team in Berlin. Sie haben mehrjährige Erfahrung mit Python "
      "und arbeiten gerne mit anderen zusammen. Wir bieten Ihnen ein spannendes Umfeld und flexible Arbeitszeiten, "
      "und Sie sind Teil von einem Unternehmen, das nicht nur wächst, sondern auch Verantwortung übernimmt.")
PT = ("Estamos à procura de um desenvolvedor com experiência em Python para a nossa equipe. Você vai trabalhar com "
      "dados e também com outras áreas da empresa, e não precisa de muita experiência. Oferecemos uma vaga com "
      "benefícios, e os nossos colaboradores são muito bem tratados pela empresa.")
FR = ("Nous recherchons un ingénieur logiciel pour rejoindre notre équipe à Paris. Vous avez de l'expérience avec "
      "Python et vous aimez travailler dans une équipe. Nous offrons un poste avec des avantages, et vous serez "
      "responsable de la qualité du code pour nos clients.")
IT = ("Cerchiamo uno sviluppatore con esperienza in Python per il nostro team a Milano. Il candidato ideale è "
      "una persona che lavora bene in gruppo e che ha già lavorato con le API. Offriamo un ambiente dinamico e "
      "siamo alla ricerca di colleghi che condividano i nostri valori, anche da remoto.")
NL = ("Wij zoeken een ervaren ontwikkelaar voor ons team in Amsterdam. Je hebt ervaring met Python en je werkt graag "
      "samen met collega's. Wij bieden een uitdagende functie bij een bedrijf dat niet stilstaat, en je krijgt "
      "veel vrijheid voor je eigen ideeën. Deze vacature is voor iemand die het verschil wil maken.")


class DetectMoreLanguages(unittest.TestCase):
    def test_body_paragraphs(self):
        for text, code in ((ES, "es"), (EN, "en"), (DE, "de"), (PT, "pt"), (FR, "fr"), (IT, "it"), (NL, "nl")):
            self.assertEqual(pl.detect_language(text), code, code)

    def test_titles(self):
        cases = {
            "Softwareentwickler (m/w/d) Python": "de",
            "Backend Entwickler für unser Team": "de",
            "Desenvolvedor Python para a equipe de dados": "pt",
            "Ingénieur logiciel pour notre équipe": "fr",
            "Sviluppatore backend per il nostro team": "it",
            "Ontwikkelaar voor ons team": "nl",
            "Desarrollador de software para el equipo": "es",
            "Engineer for the team and the data": "en",
        }
        for title, code in cases.items():
            self.assertEqual(pl.detect_title(title), code, title)

    def test_titles_too_short_or_neutral_are_none(self):
        for title in ("Software Engineer", "Python", "Data Engineer (Remote)", "Backend Engineer - Berlin", "São Paulo", ""):
            self.assertIsNone(pl.detect_title(title), title)

    def test_mixed_when_two_languages_are_substantial(self):
        self.assertEqual(pl.detect_language(DE + " " + EN), "mixed")
        self.assertEqual(pl.detect_language(FR + " " + ES), "mixed")

    def test_too_short_is_none_and_detect_says_unknown(self):
        self.assertIsNone(pl.detect_language("Wir suchen"))
        self.assertEqual(pl.detect("Wir suchen"), "unknown")
        self.assertEqual(pl.detect(DE), "de")
        self.assertEqual(pl.detect("Entwickler (m/w/d)", kind="title"), "de")

    def test_english_and_spanish_are_not_pulled_away(self):
        # an English posting with common words that exist in other languages stays English
        text = EN + " We pay per hour, do your best, and the OS is Linux. Die casting is not our business."
        self.assertEqual(pl.detect_language(text), "en")
        self.assertEqual(pl.detect_language(ES + " Trabajamos a veces en Berlín con Deutsche Bank."), "es")

    def test_exclusive_sets_never_contain_common_english_words(self):
        common = {"do", "per", "so", "me", "he", "an", "no", "to", "was", "in", "is", "as", "on", "at", "up", "if",
                  "os", "met", "plus", "van", "see", "all", "one", "man", "name", "are", "for", "but", "not"}
        for code, words in pl.EXCLUSIVE.items():
            bad = (common - {"van"}) & set(words)
            self.assertFalse(bad, (code, bad))

    def test_cli_detect_title_flag(self):
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            pl.cmd_detect(type("A", (), {"file": None, "text": "Entwickler (m/w/d)", "title": True})())
        self.assertEqual(buf.getvalue().strip(), "de")
