<p align="center">
  <img src="assets/mascot/pip_flight_loop.gif" alt="Pip, la mascota del proyecto" width="160"/>
</p>

# Búsqueda de empleo con Claude Code (edición limpia)

Panel local + comandos de Claude Code para buscar vacantes, calificarlas contra **tu** perfil, y preparar CV y carta a la medida. Todo corre en tu máquina. Es un derivado modificado de [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search) (MIT); ver `LICENSE` y `NOTICE`.

Esta edición viene **sin ningún dato personal**: el perfil, las consultas de búsqueda y los CV de ejemplo son plantillas (el candidato de ejemplo es ficticio: «Alex Example»). Tú pones tus propios datos.

## Requisitos

- Linux (probado en Ubuntu/Debian; el temporizador diario usa `systemd --user`).
- [Claude Code](https://claude.com/claude-code) instalado y con sesión iniciada con **tu** suscripción.
- [Bun](https://bun.sh) (panel y CLIs de los portales).
- Python 3.
- LaTeX con `lualatex` y `xelatex` (en Debian/Ubuntu: `texlive-luatex texlive-xetex texlive-latex-extra texlive-fonts-extra`; `moderncv` viene en `texlive-latex-extra`).
- `poppler-utils` (`pdftotext`, para verificar los PDF).

## Primera ejecución

1. Descomprime y entra a la carpeta.
2. Abre `claude` **una vez** en esta carpeta y acepta «confiar en el espacio de trabajo» (sin eso, las ejecuciones sin pantalla del panel no respetan `.claude/settings.json`). Puedes salir después.
3. `cd ui && bun install && cd ..`
4. `./iniciar.sh` abre el panel en <http://127.0.0.1:8787> (puerto distinto: `JOB_UI_PORT=8799 ./iniciar.sh`; `./detener.sh` lo apaga). Mientras tu perfil siga vacío, el panel abre la **configuración inicial** (ver abajo); no tienes que editar ningún archivo.

### Configuración inicial (primer uso)

1. Sube tu CV (PDF, DOCX, TXT o MD; máximo 2 MB) y/o escribe con tus palabras qué sabes y qué buscas, y responde unas preguntas cortas (sueldo mínimo, ciudad, remoto/híbrido, idiomas).
2. Claude (con **tu** suscripción, `claude -p /onboard`) redacta una propuesta: tu perfil, tus idiomas con nivel, tu stack y las **familias de búsqueda** (en inglés y en cada idioma que lees o escribes bien, más búsquedas de «ventaja de idioma» como «German speaking», «Deutsch» o «DACH» si hablas otro idioma). Solo usa lo que hay en tu texto: lo deducido va marcado como tal y lo que falta se te pregunta.
3. Tú la revisas y editas. Al confirmar, código determinista (sin IA) escribe `profile_config.json`, `CLAUDE.md` y `01-candidate-profile.md` (antes guarda una copia de lo que hubiera en `ui/state/backups/`).
4. El archivo que subiste se borra al terminar el análisis; el texto extraído se borra al confirmar o cancelar. Todo vive solo en `ui/state/onboarding/` (ignorado por git). El texto del CV se trata siempre como **datos**, nunca como instrucciones.

Si prefieres hacerlo a mano: `cp profile_config.example.json profile_config.json` y edítalo (ver «Configuración» abajo), y llena `CLAUDE.md`, `.claude/skills/job-application-assistant/01…07-*.md` y `cv/main_example.tex` (todo lo que dice `[YOUR_…]`), o usa el comando **`/setup`** dentro de `claude`.

Para leer PDF hace falta `pdftotext` (paquete `poppler-utils`, ya listado en los requisitos); si no lo tienes, sube tu CV como DOCX, TXT o MD.

## Qué hace cada botón

- **Buscar ahora**: consulta los portales (GetOnBoard, Himalayas, Jobicy, RemoteOK, HN Hiring, LinkedIn…) con sus CLIs, y usa Claude para Indeed si tienes el conector; luego descarta lo claramente fuera de perfil (prefiltro sin LLM) y califica las vacantes pendientes.
- **Calificar pendientes**: llama a `/rank` sobre las mejores N vacantes sin calificar (orden por puntaje del prefiltro).
- **Postular**: ejecuta `/apply` para esa vacante: evalúa el encaje, revisa preguntas eliminatorias, genera CV y carta en LaTeX y las respuestas del formulario. **Nunca envía nada por ti**: abre la vacante con todo listo para que la subas tú.
- **Pedir cambios**: rehace los documentos con tus notas. **Descartar**: marca la vacante como descartada.
- **Búsqueda diaria automática**: interruptor del temporizador (ver abajo).
- Pestañas **Seguimiento** (tu tabla de postulaciones) y **Mercado** (cuánto pagan tus habilidades; «Actualizar datos de mercado» consulta los portales y no usa Claude).

Otros comandos de `claude`: `/setup`, `/rank`, `/apply <url>`, `/interview`, `/outcome`, `/referral`, `/expand`, `/html-report`, `/add-portal`, `/add-template`, `/reset`.

## Búsqueda diaria

Un temporizador de `systemd --user` ejecuta la misma secuencia que «Buscar ahora» una vez al día. Instálalo una vez con:

```bash
tools/install_daily_timer.sh --time 09:00     # --print solo muestra las unidades
```

Después actívalo/desactívalo desde el interruptor del panel. Los registros quedan en `ui/state/daily-*.log`.

## Costo

La calificación usa **tu** suscripción de Claude Code (`claude -p`, modelo `sonnet` por defecto; cámbialo con `JOB_UI_MODEL=haiku|sonnet|opus`). El prefiltro, el puntaje de oportunidad/riesgo y el modelo aprendido no gastan nada. Para controlar el consumo, en el panel ajusta **Calificar por tanda** (cuántas vacantes califica cada corrida, por defecto 10) y el **puntaje mínimo del prefiltro** (por defecto 55: lo que queda por debajo no se califica solo).

## Configuración: `profile_config.json`

Archivo por usuario, **ignorado por git**, en la raíz. Si falta o un valor no es válido se usan los valores neutros de `profile_config.example.json`, clave por clave.

| Clave | Para qué sirve |
|---|---|
| `name` | Nombre en el encabezado del panel. Vacío = «primer uso». |
| `candidate_years`, `years_tolerance` | Años profesionales verificables y cuántos años extra puede pedir un anuncio sin contar como riesgo. |
| `current_salary_mxn`, `salary_floor_mxn` | Sueldo mensual actual y mínimo aceptable (MXN). Anclas del puntaje de sueldo y piso por defecto del filtro. |
| `spoken_english` | `true` si hablas inglés con soltura: los anuncios en inglés dejan de penalizarse. |
| `languages` | Tus idiomas con nivel MCER (A1–C2 o `native`) para leer, escribir y hablar: `[{"language": "German", "read": "B2", "write": "B1", "speak": "B1"}]`. Un idioma que no sea inglés/español con B1 o más agrega búsquedas de «ventaja de idioma». |
| `search.families` | Familias de búsqueda del barrido: `[{"name": "Python backend", "queries": [{"text": "python developer", "lang": "en"}]}]`. Cada consulta lleva su idioma. Sin esto se usa un conjunto genérico. Opcionales por familia: `indeed` (cadenas explícitas para Indeed) y `broad` (solo en búsquedas amplias). Ver el plan sin consultar nada: `bun run ui/sweep.ts --dry-run`; las cadenas de Indeed: `python3 tools/profile_config.py queries --portal indeed`. |
| `prefilter.stack_points` | Tu stack en el título: `[{"words": ["python"], "points": 12}]` (suma, con tope `stack_cap`). |
| `prefilter.skill_keep` | Palabras que salvan un título de las exclusiones por «otro stack». |
| `prefilter.stack_only` | Familias que no trabajas: `[{"words": ["sap"], "label": "SAP"}]`. |
| `prefilter.off_stack` | `{"words": [...], "points": -8}`: tecnologías ajenas que bajan el puntaje sin excluir. |
| `prefilter.spanish_title_bonus` | Puntos por título en español (0 si no te importa). |
| `skills.selected`, `skills.combo_partners`, `skills.primary` | Habilidades del cuadro «Cuánto pagan tus habilidades» (ids del catálogo en `ui/lib/skills.ts`). |

Las palabras de `prefilter` son fragmentos de expresión regular sin acentos y en minúsculas.

## Privacidad

Todo se queda en tu máquina; solo se hacen consultas públicas a los portales y las llamadas a Claude con tu sesión. **Nunca compartas ni subas a un repositorio**: `profile_config.json`, `CLAUDE.md` y los archivos de `.claude/skills/*/` ya llenos, `job_search_tracker.csv`, `job_scraper/`, `ui/state/`, `cv/main_*`, `cover_letters/cover_*`, `documents/` y `company_research/`. El `.gitignore` ya excluye los datos de uso; los archivos de perfil sí quedan rastreados si haces `git init`, así que usa un repositorio **privado**.

## Ética y términos de uso

Solo APIs y feeds públicos de los portales, con pausas entre llamadas y respetando `robots.txt`; sin sesiones robadas ni cuentas falsas. No hay postulación automática: los portales no ofrecen una vía autorizada y la automatización del navegador en LinkedIn/Indeed viola sus términos. El CLI de LinkedIn es solo para uso personal y de bajo volumen. Revisa tú cada CV y carta antes de enviarla: el sistema no debe inventar nada, y eres tú quien responde por lo que se envía.

## Pruebas

```bash
(cd ui && bun test)
python3 -m unittest discover -s tests
```

Más detalle en `SETUP.md`, `ui/README.md` y `CONTRIBUTING.md`.
