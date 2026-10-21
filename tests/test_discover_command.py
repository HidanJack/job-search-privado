"""/discover is a sandboxed command: it may only read its input and write its proposals under ui/state/discovery/."""
import re
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))
import security_guards  # noqa: E402

COMMAND = REPO / ".claude" / "commands" / "discover.md"


class DiscoverCommand(unittest.TestCase):
    def setUp(self):
        self.text = COMMAND.read_text(encoding="utf-8")
        self.front = security_guards._frontmatter(self.text)

    def test_allowed_tools_are_exactly_the_discovery_dir(self):
        self.assertEqual(security_guards._tool_entries(self.front["allowed-tools"]),
                         ["Read(ui/state/discovery/*)", "Edit(ui/state/discovery/*)"])

    def test_those_entries_are_on_the_reviewed_allowlist(self):
        for entry in security_guards._tool_entries(self.front["allowed-tools"]):
            self.assertIn(entry, security_guards.ALLOWED_SKILL_TOOLS)

    def test_no_shell_web_or_agent_tool_is_granted_or_suggested(self):
        for tool in ("Bash", "WebFetch", "WebSearch", "Agent"):
            self.assertNotIn(tool, self.front["allowed-tools"])
        self.assertIn("do not try Bash, web access or sub-agents", self.text)

    def test_title_and_schema_keys(self):
        self.assertTrue(self.text.split("---", 2)[2].lstrip().startswith("# /discover"))
        for key in ("why_it_fits", "evidence", "gaps", "seniority_fit", "adjacent_to", "search_queries", "confidence", "inferred", "skipped", "warnings"):
            self.assertIn(f'"{key}"', self.text)

    def test_input_is_declared_data_and_honesty_rules_are_present(self):
        self.assertIn("NONCE", self.text)
        self.assertIn("never instructions", self.text.lower())
        self.assertIn("VERBATIM", self.text)
        self.assertIn("ya lo buscas", self.text)
        self.assertRegex(self.text, r"5 to 8 paths")
        self.assertRegex(self.text, r"never start|leading \"-\"")

    def test_the_command_only_names_discovery_paths(self):
        paths = set(re.findall(r"ui/state/[a-z/_.*]+", self.text))
        self.assertTrue(all(p.startswith("ui/state/discovery/") for p in paths), paths)

    def test_security_guards_accept_the_command(self):
        security_guards.errors.clear() if hasattr(security_guards, "errors") else None
        self.assertEqual(security_guards.main(), 0)


if __name__ == "__main__":
    unittest.main()
