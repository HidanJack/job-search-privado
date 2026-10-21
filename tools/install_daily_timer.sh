#!/usr/bin/env bash
# Installs the systemd USER timer behind the dashboard's "daily search" switch.
# It renders job-search-daily.{service,timer} for THIS checkout and runs
# `bun run ui/daily.ts` (portal sweep, Indeed via Claude, /rank) once a day.
#   tools/install_daily_timer.sh [--time HH:MM] [--print]
# --print only shows the units; nothing is written or enabled. The switch in the
# dashboard (or `systemctl --user enable --now job-search-daily.timer`) turns it on.
set -euo pipefail

TIME="09:00"
PRINT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --time) TIME="${2:-}"; shift 2 ;;
    --print) PRINT=1; shift ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
if ! [[ "$TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
  echo "--time must be HH:MM (24h), got '$TIME'" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="${BUN_BIN:-$HOME/.bun/bin/bun}"

SERVICE="[Unit]
Description=Daily job search and ranking

[Service]
Type=oneshot
WorkingDirectory=$ROOT
Environment=PATH=$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$BUN run ui/daily.ts
TimeoutStartSec=3h"

TIMER="[Unit]
Description=Run the daily job search at $TIME

[Timer]
OnCalendar=*-*-* $TIME:00
Persistent=true

[Install]
WantedBy=timers.target"

if [ "$PRINT" = "1" ]; then
  printf '# job-search-daily.service\n%s\n\n# job-search-daily.timer\n%s\n' "$SERVICE" "$TIMER"
  exit 0
fi

DEST="$HOME/.config/systemd/user"
mkdir -p "$DEST"
printf '%s\n' "$SERVICE" > "$DEST/job-search-daily.service"
printf '%s\n' "$TIMER" > "$DEST/job-search-daily.timer"
systemctl --user daemon-reload
echo "Installed in $DEST (not enabled yet)."
echo "Turn it on from the dashboard, or: systemctl --user enable --now job-search-daily.timer"
