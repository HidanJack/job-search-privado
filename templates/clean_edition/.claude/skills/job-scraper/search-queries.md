# Search Queries for Job Scraper

<!-- STARTER SET (the portal-CLI sweep and the Indeed step read `search.families` from profile_config.json, not this file; the first-run onboarding writes them): the role families below (Python backend, data engineering, AI/LLM, any backend, plus neighbor families) are examples. /setup rewrites them for your profile; edit them freely. [YOUR_CITY] marks where your city goes. -->

## Installed portal CLIs (primary for `/scrape`)

`/scrape` discovers every portal skill under `.agents/skills/*/SKILL.md` and runs its CLI first. Shipped country-agnostic CLIs include `linkedin-search` and `freehire-search`; Danish demos and any skill you add with `/add-portal` are included the same way. You do **not** need a matching `site:` line below for those CLIs to run.

The `site:` query templates in this file are the **WebSearch fallback** — for portals without a CLI, company career pages, or when a CLI fails.

## LatAm / remote portal CLI queries

Five public-API portals for a Mexico-based developer (the families are a starter set: replace the keywords with your own roles). `--latam`
drops postings restricted to other countries. The recency window is not fixed here: it comes from
the dashboard settings (`ui/state/settings.json`, `search.maxDays`, default 7) - append
`--jobage <maxDays>` to every line below. The dashboard's "Buscar ahora" and the daily timer run these
CLI queries themselves (`ui/lib/sweep.ts`, English and Spanish, paginated); the LLM only does Indeed. Run
each query in English and, where the portal carries Spanish-language postings
(GetOnBoard, Himalayas), in Spanish too: Himalayas matches the query against the
title, so "python backend" misses a title like "Desarrollador Python Senior". Credit Remote OK and Jobicy and keep their original posting URLs
(their API terms).

**Python backend**
```
getonbrd-search  search -q python --latam
getonbrd-search  search -q "desarrollador backend" --country MX
himalayas-search search -q "python backend" --country Mexico
himalayas-search search -q "desarrollador python" --country Mexico
himalayas-search search -q python --country Mexico
himalayas-search search -q "desarrollador python" --latam
remoteok-search  search --tags python,backend --latam
jobicy-search    search -q python --geo latam
hn-hiring-search search -q "python backend" --latam
```

**Data engineering**
```
getonbrd-search  search -q "data engineer" --latam
getonbrd-search  search --category data-science-analytics --country MX
himalayas-search search -q "data engineer" --latam
jobicy-search    search -q "data engineer" --geo latam
hn-hiring-search search -q "data engineer" --latam
```

**AI engineering / LLM (Python)**
```
getonbrd-search  search -q "ia" --latam
getonbrd-search  search -q "llm" --latam
himalayas-search search -q "ai engineer python" --latam
remoteok-search  search --tags ai,python --latam
hn-hiring-search search -q "llm python" --latam
```

**Remote LatAm / Mexico sweep (any backend role)**
```
getonbrd-search  search --category programming --country MX
himalayas-search search -q backend --country Mexico
jobicy-search    search --geo mexico --industry dev
jobicy-search    search --geo latam --industry dev
```

Each line is `bun run .agents/skills/<portal>/cli/src/cli.ts <args>`.

**Language scope:** write every query category in every language listed in your CLAUDE.md Languages table (typically 1-2, sometimes more). A posting requiring a language you have *not* declared, as a job condition, is excluded before scoring; a posting requiring a *higher level* than you declared in a language you *do* work in is flagged for your own judgment, not excluded — see `04-job-evaluation.md`'s Language Gate, the single source of truth for this rule. Translate each category's keywords rather than machine-translating word-for-word (e.g. "Frontend Developer" -> "Desarrollador Frontend", not a literal word-for-word translation) if you work in more than one language.

**Neighbor role families (secondary targets; Spanish first, Mexico/LatAm)**

Same flags as above. Spanish is the primary language here because these roles are mostly hired locally; the strict posting-language rule means English-only postings come back flagged.
```
# Web / landing pages / frontend
getonbrd-search  search -q "desarrollador frontend" --country MX
getonbrd-search  search -q "desarrollador web" --latam
getonbrd-search  search -q react --latam
himalayas-search search -q "frontend developer" --latam
remoteok-search  search --tags react,frontend --latam
jobicy-search    search -q "web developer" --geo latam
# Automation / RPA with Python
getonbrd-search  search -q "automatización python" --latam
getonbrd-search  search -q rpa --country MX
himalayas-search search -q "automation engineer python" --latam
# Data analyst / BI
getonbrd-search  search -q "analista de datos" --country MX
getonbrd-search  search --category data-science-analytics --latam
himalayas-search search -q "data analyst" --latam
jobicy-search    search -q "data analyst" --geo latam
# QA automation
getonbrd-search  search -q "QA automation" --latam
getonbrd-search  search -q "analista QA" --country MX
himalayas-search search -q "qa automation" --latam
remoteok-search  search --tags qa,testing --latam
# Technical support / implementation of software products
getonbrd-search  search -q "soporte técnico software" --country MX
getonbrd-search  search -q "implementación software" --country MX
```
`linkedin-search` and `freehire-search`: reuse the Spanish titles above (e.g. "Desarrollador Frontend", "Analista de Datos", "Analista QA", "Soporte técnico de software") with Mexico / [YOUR_CITY].

## Indeed MX (MCP)

Indeed Mexico cannot be scraped (its robots.txt blocks it), but the account has the
official Indeed connector: `mcp__claude_ai_Indeed__search_jobs` (params `search`,
`location`, `country_code`, optional `job_type`). Always use `country_code: "MX"`.
Run each query three times: `location: "[YOUR_CITY]"`, `location: "México"`
(nationwide postings, often Home Office, that neither of the others returns) and
`location: "remote"` (Indeed answers remote with "Desde casa"). The connector returns
at most 10 results per call ordered by relevance, not date, so coverage comes from
many specific queries, not from paging. Queries are in Spanish because Indeed MX
postings are mostly Spanish. `/job-scraper` Step 1d describes how to run and store them.

**Where the strings come from:** run `python3 tools/profile_config.py queries --portal indeed`
(add `--broad` for the neighbour families). It prints the search strings of each role family
from `search.families` in your `profile_config.json`, which the dashboard's first-run onboarding
fills in from your CV. The table below is only the fallback when that file has no families yet.

| Role family | `search` values |
|---|---|
| Python backend | `desarrollador python`, `desarrollador backend python`, `programador python` |
| Data engineer | `ingeniero de datos`, `data engineer python`, `ETL python` |
| AI engineer | `ingeniero de inteligencia artificial`, `AI engineer`, `AI engineer python`, `applied AI engineer`, `machine learning engineer`, `LLM`, `desarrollador python IA` |
| Web developer | `desarrollador web`, `desarrollador frontend react` |
| Full stack / AI-assisted development | `desarrollador full stack`, `full stack python`, `full stack IA`, `Claude`, `desarrollador IA generativa`, `ingeniero de IA full stack` |
| Automation / RPA with Python | `automatización python`, `desarrollador RPA` |
| Data analyst / BI | `analista de datos`, `analista BI sql` |
| QA automation | `QA automation`, `analista QA automatización` |
| Support / implementation | `soporte técnico software`, `implementación software` |

By default run the first three families (edit this to your own priorities) plus "Full stack / AI-assisted development"; the neighbor families on "broad" or when
the user names them.

## Search Sites

Primary (Mexico; no CLI - WebSearch `site:` fallback only, never automated scraping):
- **occ.com.mx** - largest general job board in Mexico (ToS forbids mass collection: WebSearch only, low volume)
- **mx.computrabajo.com** - large Mexican board (anti-bot; WebSearch only)
- **mx.indeed.com** - prefer the official Indeed connector when available; otherwise WebSearch
- **linkedin.com/jobs** - filter: Mexico / [YOUR_CITY]; also covered by `linkedin-search` CLI
- **getonbrd.com** - LatAm tech board (CLI installed)

Secondary (company career pages via Google):
- Direct Google searches with `site:` filters for known target companies; Greenhouse/Lever/Ashby boards (`site:boards.greenhouse.io`, `site:jobs.lever.co`, `site:jobs.ashbyhq.com`) with "Mexico" or "LATAM"

## Query Categories

Queries are grouped by priority. Write **each category in every language from your Languages table** (see Language scope above). Combine each query with your location terms (e.g. your city, region, or metro area) where the site supports it.

**Organize by function, not job title.** The same underlying work carries different titles across companies and markets (a "Data Scientist" role at one employer may be posted as "Insights Analyst" or "Data Consultant" at another). Name each priority category after the function it covers, and list several plausible job titles as query variants within that category rather than betting an entire priority tier on one exact title string.

### Priority 1: Python backend engineering

These match your strongest and most desired career direction.

```
site:occ.com.mx "desarrollador python" "[YOUR_CITY]"
site:occ.com.mx "backend developer" python remoto
site:mx.computrabajo.com "desarrollador python"
site:linkedin.com/jobs "Python Developer" Mexico remote
site:linkedin.com/jobs "Backend Engineer" Python LATAM
site:boards.greenhouse.io "Python" "Mexico"
site:jobs.lever.co "Backend" "LATAM"
```

### Priority 2: Data engineering and financial-data automation

These match your domain expertise (ETL, data pipelines, document AI/OCR); add your own domain keywords.

```
site:occ.com.mx "data engineer" OR "ingeniero de datos" "[YOUR_CITY]"
site:mx.computrabajo.com "ingeniero de datos" python
site:linkedin.com/jobs "Data Engineer" Python Mexico
site:linkedin.com/jobs "[YOUR_DOMAIN_KEYWORD]" python Mexico
site:linkedin.com/jobs "OCR" OR "document AI" python remote LATAM
```

### Priority 3: AI engineering (Python + LLMs / agents)

Adjacent roles you could pivot into (AI engineer, Python developer IA).

```
site:linkedin.com/jobs "AI Engineer" Python Mexico
site:occ.com.mx "python" "inteligencia artificial" "[YOUR_CITY]"
site:linkedin.com/jobs "agentic" OR "LLM" Python remote LATAM
site:jobs.ashbyhq.com "AI Engineer" "LATAM"
```

### Priority 4: Broader Technical / Consulting

Wider net for general technical roles.

```
site:occ.com.mx "programador python" "[YOUR_CITY]"
site:mx.computrabajo.com "analista programador" python
site:linkedin.com/jobs "Software Engineer" Python Mexico remote
site:occ.com.mx "consultor" python datos
```

### Priority 5: Neighbor role families (web, automation, data analyst, QA, support)

Simpler roles that still pay at or above your salary floor. Flag freelance / per-project postings in the results.

```
# (a) Web developer / landing pages / frontend
site:occ.com.mx "desarrollador web" OR "desarrollador frontend" "[YOUR_CITY]"
site:mx.computrabajo.com "desarrollador frontend" react
site:linkedin.com/jobs "Desarrollador Frontend" OR "Desarrollador Web" México remoto
site:linkedin.com/jobs "landing page" desarrollador México
# (b) Automation / RPA with Python
site:occ.com.mx "automatización" python OR rpa "[YOUR_CITY]"
site:mx.computrabajo.com "desarrollador rpa" OR "automatización de procesos"
site:linkedin.com/jobs "RPA Developer" OR "Automation Engineer" Python México
# (c) Data analyst / BI
site:occ.com.mx "analista de datos" OR "analista BI" python sql "[YOUR_CITY]"
site:mx.computrabajo.com "analista de datos" excel sql
site:linkedin.com/jobs "Analista de Datos" OR "Data Analyst" México remoto
# (d) QA automation
site:occ.com.mx "QA automation" OR "analista QA" "[YOUR_CITY]"
site:linkedin.com/jobs "QA Automation" pytest OR selenium México
site:mx.computrabajo.com "automatización de pruebas" OR "tester QA"
# (e) Support / implementation of software products
site:occ.com.mx "implementador" OR "soporte técnico" software "[YOUR_CITY]"
site:linkedin.com/jobs "soporte técnico" OR "customer success" software México

```

## Location Filter

Remote roles open to Mexico/LATAM are always acceptable. For hybrid/on-site roles, define acceptable areas:
- [YOUR_CITY] - acceptable
- Remote (Mexico, LATAM, "Americas" time zones, worldwide) - ideal
- Your metropolitan area - acceptable for hybrid
- Other cities, hybrid or on-site - too far unless you are open to relocating
- Remote restricted to US/EU residents only - not eligible

## Language Filter

Your working languages and levels are in CLAUDE.md's Languages table. When filtering scraped results, apply `04-job-evaluation.md`'s Language Gate: a posting requiring a language you haven't declared at all is excluded; a posting requiring a higher level than you declared in a language you do work in is not excluded, flag it clearly instead (see `job-scraper/SKILL.md`'s Step 3 "Quick Fit Assessment" for how the flag surfaces in `/scrape` output). Postings simply *written* in a language you don't work in, that don't require it on the job, are fine.

## Date Filter

Only include jobs posted within the last 14 days, or with an application deadline that has not yet passed. If a posting date cannot be determined, include it but flag as "date unknown".

## Adapting Queries

If the user specifies a focus area, select queries from the matching category and also generate 2-3 custom queries for that focus. For example:
- "/scrape [focus_area]" -> relevant category queries + custom focus-specific queries
