import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tools.check_cover_letter import check, find_banned_phrases, letter_body, word_count

REPO = Path(__file__).resolve().parent.parent
TOOL = REPO / "tools" / "check_cover_letter.py"

LETTER = r"""
\begin{document}
\lettercontent{Dear Ana Torres,}
\lettercontent{Your data platform team is moving ingestion to Airflow, and I built %s.}
\lettercontent{At Intelitax I rewrote a matching engine in Rust.}
{\begin{itemize}
    \item \textbf{OCR:} 95\%% accuracy on bank statements
\end{itemize}\par}
\lettercontent{I look forward to hearing from you.}
\end{document}
"""


class BodyExtractionTests(unittest.TestCase):
    def test_salutation_and_sign_off_are_excluded(self):
        body = letter_body(LETTER % "exactly that")
        self.assertNotIn("Dear", body)
        self.assertNotIn("look forward", body)
        self.assertIn("Airflow", body)
        self.assertIn("Rust", body)

    def test_items_are_part_of_the_body(self):
        self.assertIn("95", letter_body(LETTER % "x"))

    def test_latex_commands_are_stripped(self):
        body = letter_body(LETTER % "x")
        self.assertNotIn("textbf", body)
        self.assertNotIn("\\", body)


class BannedPhraseTests(unittest.TestCase):
    def test_english_and_spanish_stock_phrases_are_found(self):
        text = "I am excited to apply. Me apasiona el código en un entorno dinámico."
        self.assertEqual(
            set(find_banned_phrases(text)),
            {"i am excited to apply", "me apasiona", "entorno dinámico"},
        )

    def test_whole_words_only(self):
        # "leverage" must not fire inside an unrelated word.
        self.assertEqual(find_banned_phrases("deleveraged balance sheets"), [])

    def test_specific_letter_is_clean(self):
        self.assertEqual(find_banned_phrases("I cut reconciliation from 82 to 2 open items."), [])


class LengthTests(unittest.TestCase):
    def test_word_count(self):
        # A slash separates two words; a decimal stays one token.
        self.assertEqual(word_count("Built a Rust/PyO3 engine, 1.2M rows."), 7)

    def test_short_body_is_a_problem(self):
        _, problems = check("Too short.")
        self.assertTrue(any("words" in p for p in problems))

    def test_in_range_clean_body_passes(self):
        _, problems = check(" ".join(["word"] * 200))
        self.assertEqual(problems, [])


class CliTests(unittest.TestCase):
    def run_tool(self, text, *flags):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "letter.tex"
            path.write_text(text, encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(TOOL), str(path), *flags], capture_output=True, text=True
            )

    def test_exit_1_lists_each_problem(self):
        proc = self.run_tool(LETTER % "something I am passionate about")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("passionate about", proc.stderr)
        self.assertIn("words", proc.stderr)

    def test_exit_0_on_clean_plain_text(self):
        proc = self.run_tool(" ".join(["specific"] * 180), "--plain")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("180 body words", proc.stdout)


if __name__ == "__main__":
    unittest.main()
