# Search Queries for Job Scraper

<!-- Personalized 2026-10-15 for Luis Catalán (Python backend / data / AI engineer, CDMX, remote or hybrid). Target titles: Python Developer, Backend Developer, Data Engineer, Software Engineer, Desarrollador/a de software, Analista/Programador Python. -->

## Installed portal CLIs (primary for `/scrape`)

`/scrape` discovers every portal skill under `.agents/skills/*/SKILL.md` and runs its CLI first. Shipped country-agnostic CLIs include `linkedin-search` and `freehire-search`; Danish demos and any skill you add with `/add-portal` are included the same way. You do **not** need a matching `site:` line below for those CLIs to run.

The `site:` query templates in this file are the **WebSearch fallback** — for portals without a CLI, company career pages, or when a CLI fails.

## LatAm / remote portal CLI queries

Five public-API portals for a Mexico-based Python / backend / data engineer. `--latam`
drops postings restricted to other countries; `--jobage 4` keeps the newest. Run
each query in English and, where the portal is Spanish-language (GetOnBoard), in
Spanish too. Credit Remote OK and Jobicy and keep their original posting URLs
(their API terms).

**Python backend**
```
getonbrd-search  search -q python --latam --jobage 4
getonbrd-search  search -q "desarrollador backend" --country MX --jobage 4
himalayas-search search -q "python backend" --country Mexico --jobage 4
remoteok-search  search --tags python,backend --latam --jobage 4
jobicy-search    search -q python --geo latam --jobage 4
hn-hiring-search search -q "python backend" --latam
```

**Data engineering**
```
getonbrd-search  search -q "data engineer" --latam --jobage 4
getonbrd-search  search --category data-science-analytics --country MX --jobage 4
himalayas-search search -q "data engineer" --latam --jobage 4
jobicy-search    search -q "data engineer" --geo latam --jobage 4
hn-hiring-search search -q "data engineer" --latam
```

**Rust / high-performance Python**
```
himalayas-search search -q rust --latam --jobage 7
remoteok-search  search -q rust --latam --jobage 7
hn-hiring-search search -q rust --latam
getonbrd-search  search -q rust --latam
```

**AI engineering / LLM (Python)**
```
getonbrd-search  search -q "ia" --latam --jobage 4
getonbrd-search  search -q "llm" --latam --jobage 4
himalayas-search search -q "ai engineer python" --latam --jobage 4
remoteok-search  search --tags ai,python --latam --jobage 4
hn-hiring-search search -q "llm python" --latam
```

**Remote LatAm / Mexico sweep (any backend role)**
```
getonbrd-search  search --category programming --country MX --jobage 4
himalayas-search search -q backend --country Mexico --jobage 4
jobicy-search    search --geo mexico --industry dev --jobage 4
jobicy-search    search --geo latam --industry dev --jobage 4
```

Each line is `bun run .agents/skills/<portal>/cli/src/cli.ts <args>`.

**Language scope:** write every query category in every language listed in your CLAUDE.md Languages table (typically 1-2, sometimes more). A posting requiring a language you have *not* declared, as a job condition, is excluded before scoring; a posting requiring a *higher level* than you declared in a language you *do* work in is flagged for your own judgment, not excluded — see `04-job-evaluation.md`'s Language Gate, the single source of truth for this rule. Translate each category's keywords rather than machine-translating word-for-word (e.g. "Frontend Developer" -> "Desarrollador Frontend", not a literal word-for-word translation) if you work in more than one language.

## Search Sites

Primary (Mexico; no CLI - WebSearch `site:` fallback only, never automated scraping):
- **occ.com.mx** - largest general job board in Mexico (ToS forbids mass collection: WebSearch only, low volume)
- **mx.computrabajo.com** - large Mexican board (anti-bot; WebSearch only)
- **mx.indeed.com** - prefer the official Indeed connector when available; otherwise WebSearch
- **linkedin.com/jobs** - filter: Mexico / Ciudad de México; also covered by `linkedin-search` CLI
- **getonbrd.com** - LatAm tech board (CLI installed)

Secondary (company career pages via Google):
- Direct Google searches with `site:` filters for known target companies; Greenhouse/Lever/Ashby boards (`site:boards.greenhouse.io`, `site:jobs.lever.co`, `site:jobs.ashbyhq.com`) with "Mexico" or "LATAM"

## Query Categories

Queries are grouped by priority. Write **each category in every language from your Languages table** (see Language scope above). Combine each query with your location terms (e.g. your city, region, or metro area) where the site supports it.

**Organize by function, not job title.** The same underlying work carries different titles across companies and markets (a "Data Scientist" role at one employer may be posted as "Insights Analyst" or "Data Consultant" at another). Name each priority category after the function it covers, and list several plausible job titles as query variants within that category rather than betting an entire priority tier on one exact title string.

### Priority 1: Python backend engineering

These match your strongest and most desired career direction.

```
site:occ.com.mx "desarrollador python" "Ciudad de México"
site:occ.com.mx "backend developer" python remoto
site:mx.computrabajo.com "desarrollador python"
site:linkedin.com/jobs "Python Developer" Mexico remote
site:linkedin.com/jobs "Backend Engineer" Python LATAM
site:boards.greenhouse.io "Python" "Mexico"
site:jobs.lever.co "Backend" "LATAM"
```

### Priority 2: Data engineering and financial-data automation

These match your domain expertise (ETL, reconciliation, fintech, document AI/OCR).

```
site:occ.com.mx "data engineer" OR "ingeniero de datos" "Ciudad de México"
site:mx.computrabajo.com "ingeniero de datos" python
site:linkedin.com/jobs "Data Engineer" Python Mexico
site:linkedin.com/jobs fintech conciliación python Mexico
site:linkedin.com/jobs "OCR" OR "document AI" python remote LATAM
```

### Priority 3: AI engineering (Python + LLMs / agents)

Adjacent roles you could pivot into (AI engineer, Python developer IA).

```
site:linkedin.com/jobs "AI Engineer" Python Mexico
site:occ.com.mx "python" "inteligencia artificial" "Ciudad de México"
site:linkedin.com/jobs "agentic" OR "LLM" Python remote LATAM
site:jobs.ashbyhq.com "AI Engineer" "LATAM"
```

### Priority 4: Broader Technical / Consulting

Wider net for general technical roles.

```
site:occ.com.mx "programador python" "Ciudad de México"
site:mx.computrabajo.com "analista programador" python
site:linkedin.com/jobs "Software Engineer" Python Mexico remote
site:occ.com.mx "consultor" python datos
```

## Location Filter

Remote roles open to Mexico/LATAM are always acceptable. For hybrid/on-site roles, define acceptable areas:
- Ciudad de México (any alcaldía) - acceptable
- Remote (Mexico, LATAM, "Americas" time zones, worldwide) - ideal
- Zona metropolitana del Valle de México (Edomex next to CDMX) - acceptable for hybrid
- Other Mexican cities, hybrid or on-site - too far (relocation is a deal-breaker)
- Remote restricted to US/EU residents only - not eligible

## Language Filter

Your working languages and levels are in CLAUDE.md's Languages table. When filtering scraped results, apply `04-job-evaluation.md`'s Language Gate: a posting requiring a language you haven't declared at all is excluded; a posting requiring a higher level than you declared in a language you do work in is not excluded, flag it clearly instead (see `job-scraper/SKILL.md`'s Step 3 "Quick Fit Assessment" for how the flag surfaces in `/scrape` output). Postings simply *written* in a language you don't work in, that don't require it on the job, are fine.

## Date Filter

Only include jobs posted within the last 14 days, or with an application deadline that has not yet passed. If a posting date cannot be determined, include it but flag as "date unknown".

## Adapting Queries

If the user specifies a focus area, select queries from the matching category and also generate 2-3 custom queries for that focus. For example:
- "/scrape [focus_area]" -> relevant category queries + custom focus-specific queries
