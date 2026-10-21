"""tools/install_daily_timer.sh renders the systemd user units for the UI's daily-search button."""
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "tools" / "install_daily_timer.sh"


def render(*args):
    return subprocess.run(["bash", str(SCRIPT), "--print", *args], capture_output=True, text=True)


class DailyTimerUnits(unittest.TestCase):
    def test_print_renders_service_and_timer_for_this_checkout(self):
        r = render()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"WorkingDirectory={REPO}", r.stdout)
        self.assertIn("ExecStart=", r.stdout)
        self.assertIn("ui/daily.ts", r.stdout)
        self.assertIn("OnCalendar=*-*-* 09:00:00", r.stdout)
        self.assertIn("job-search-daily.service", r.stdout)
        self.assertIn("job-search-daily.timer", r.stdout)

    def test_time_option_changes_the_schedule(self):
        self.assertIn("OnCalendar=*-*-* 07:30:00", render("--time", "07:30").stdout)

    def test_invalid_time_is_rejected(self):
        r = render("--time", "25:99")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("HH:MM", r.stderr)

    def test_print_writes_nothing_and_never_calls_systemctl(self):
        self.assertNotIn("systemctl", render().stdout.split("[Unit]")[0])


if __name__ == "__main__":
    unittest.main()
