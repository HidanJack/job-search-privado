#!/usr/bin/env bash
# Arranca el panel de búsqueda de empleo (o solo abre el navegador si ya corre).
# NO_BROWSER=1 evita abrir el navegador. JOB_UI_PORT cambia el puerto (def. 8787).
set -euo pipefail

export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUERTO="${JOB_UI_PORT:-8787}"
URL="http://127.0.0.1:${PUERTO}"
ESTADO="$RAIZ/ui/state"
LOG="$ESTADO/server.log"
PIDFILE="$ESTADO/server.pid"

responde() { curl -s -m 2 -o /dev/null "$URL"; }
abrir() {
  if [ "${NO_BROWSER:-}" = "1" ]; then return 0; fi
  xdg-open "$URL" >/dev/null 2>&1 || echo "No pude abrir el navegador. Abre $URL"
}

if responde; then
  echo "El panel ya está corriendo en $URL"
  abrir
  exit 0
fi

command -v bun >/dev/null || { echo "No encuentro bun en ~/.bun/bin" >&2; exit 1; }
mkdir -p "$ESTADO"
cd "$RAIZ"
echo "Iniciando el panel..."
JOB_UI_PORT="$PUERTO" setsid nohup bun run ui/server.ts >"$LOG" 2>&1 </dev/null &
echo $! >"$PIDFILE"

for _ in $(seq 1 30); do
  if responde; then
    echo "Listo: $URL"
    abrir
    exit 0
  fi
  sleep 0.5
done

echo "El panel no arrancó. Últimas líneas del log:" >&2
tail -n 15 "$LOG" >&2 || true
exit 1
