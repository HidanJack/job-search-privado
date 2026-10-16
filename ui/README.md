# Local dashboard

A small web panel over the job-search workspace: the postings `/scrape` and `/rank` found (with *why you fit*, salary in MXN and modality), one-click `/apply`, document review, and application tracking. Visible text is in Spanish.

## Start

```bash
bun run ui/server.ts          # from the repo root
# or: cd ui && bun run start
```

Open <http://127.0.0.1:8787>. Set `JOB_UI_PORT` to change the port and `CLAUDE_BIN` if `claude` is not on `PATH`.

**Before the first run:** open `claude` interactively once in the repo root and accept the workspace trust dialog. Until then, headless runs ignore `.claude/settings.json` ("this workspace has not been trusted"), so `/rank` cannot even call `tools/rank_state.py` and `/job-scraper` cannot call the portal CLIs. Run `/setup` in that same session so scoring and drafting have a real profile.

## What it does

| Button | Runs | Result |
|---|---|---|
| **Buscar ahora** | `claude -p "/job-scraper"` (the `/scrape` skill registers under its directory name), then `claude -p "/rank"` | New postings scored and saved to `job_scraper/seen_jobs.json` |
| **Postular** | `claude -p "/apply [ui-mode] <url>"` | Tailored CV + cover letter, knockouts, keyword coverage, form answers |
| **Aprobar y postular** | — | Opens the posting in a new tab and moves the tracker row from `drafted` to `applied` |
| **Pedir cambios** | `/apply [ui-mode] [knockouts-acknowledged] <url> [feedback] <text>` | Redraft with your notes |
| **Descartar** | — | Marks the posting `skipped` in `seen_jobs.json` |

Submission is never automatic: portals do not offer a sanctioned way to submit on your behalf, and browser automation on LinkedIn/Indeed breaks their terms. The panel opens the posting with everything ready to upload.

`/apply`'s non-interactive contract (markers and the `ui-result` block) is documented in `.claude/commands/apply.md`, "Non-interactive mode".

## Filters

Defaults come from `CLAUDE.md`: `Freshness window:` (max days since posted, default 4) and `Salary floor:` (default 30000 MXN/month). Changes are saved in the browser (`localStorage`). Postings without a published salary or date are included by default and can be excluded.

## Security model

- Listens on `127.0.0.1` only; every request must carry `Host: 127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard).
- Every `POST` must come from the panel's own `Origin` with `Content-Type: application/json` (CSRF guard).
- `claude` is launched with `Bun.spawn([...argv])`, never through a shell. The posting URL is validated (http/https, no credentials, no whitespace, ≤2048 chars) and user feedback is flattened to one line; both travel inside the prompt string, which always starts with `/`, so neither can become a flag.
- Permissions: the repo's `.claude/settings.json` plus `--permission-mode acceptEdits` and an explicit `--allowedTools` list (`ui/lib/runner.ts`): `Read`, `Glob`, `Grep`, `Write`, `Edit`, `WebFetch`, `WebSearch`, `Agent`, `Skill`, and for `/apply` only `lualatex`, `xelatex`, `check_cover_letter.py` and `rm -f cv/main_*` (build-artifact cleanup). Print mode cannot prompt, so these are what `/apply` needs to fetch, compile and verify. Not allowed: `curl` (posting text is untrusted and could steer an outbound request) and unrestricted `Bash`. `--dangerously-skip-permissions` is never used.
- PDFs are served only from `cv/` and `cover_letters/`, form answers only from `documents/applications/**/*.txt`, with path normalisation and symlink checks.
- No external CDN: everything is served locally. Posting-derived text is rendered with `textContent`, never as HTML.
- `ui/state/` (last `/apply` result per posting) is git-ignored and pinned in `tools/security_guards.py`.

## Tests

```bash
cd ui && bun install && bun test && bun run typecheck
```

Tests use fixtures and an injected fake spawner: no network, no real `claude`.

## Arranque con un clic

- `./iniciar.sh` (raíz del repo): levanta el panel en segundo plano (log en `ui/state/server.log`, PID en `ui/state/server.pid`) y abre el navegador. Si ya está corriendo, solo abre el navegador.
- `./detener.sh`: detiene el panel, solo si el PID guardado es `bun` ejecutando `ui/server.ts`.
- Menú de aplicaciones: "Mi búsqueda de empleo" (`~/.local/share/applications/mi-busqueda.desktop`).
- Variables: `NO_BROWSER=1` no abre el navegador; `JOB_UI_PORT` cambia el puerto (por defecto 8787).
