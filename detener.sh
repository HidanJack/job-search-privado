#!/usr/bin/env bash
# Detiene el panel iniciado con iniciar.sh (solo si el PID es bun ejecutando ui/server.ts).
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$RAIZ/ui/state/server.pid"

[ -f "$PIDFILE" ] || { echo "No hay panel registrado (sin server.pid)."; exit 0; }
PID="$(cat "$PIDFILE")"

if [[ "$PID" =~ ^[0-9]+$ ]] && [ -r "/proc/$PID/cmdline" ]; then
  CMD="$(tr '\0' ' ' <"/proc/$PID/cmdline")"
  if [[ "$CMD" == *bun* && "$CMD" == *ui/server.ts* ]]; then
    kill "$PID"
    for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
    rm -f "$PIDFILE"
    echo "Panel detenido."
    exit 0
  fi
fi

rm -f "$PIDFILE"
echo "El PID guardado no es el panel; no maté nada y limpié el registro."
