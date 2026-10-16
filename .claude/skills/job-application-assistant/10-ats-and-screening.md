---
framework_version: 1.2.0
---

# ATS, AI Screening and Market Conventions

What actually filters an application in 2025-2026, turned into rules the workflow applies. `/apply` (knockouts, drafting, Step 5d checks), `/rank` (freshness, salary, modality) and `/referral` (channel choice) read this file instead of restating it.

**Evidence tags.** `VERIFIED`: primary or credible source (the ATS vendor's own data, academic study, statute, large ATS survey). `PARTIAL`: vendor data with a stated method or a reasonable sample. `DUBIOUS`: only resume-optimizer blogs assert it. A rule built on `DUBIOUS` evidence is kept only when it costs nothing to follow. Most figures are US tech-market data; Mexican-market figures are called out where they exist.

---

## 1. What the ATS really does

- **The "75% of CVs are auto-rejected by ATS" figure is a myth.** It traces to a 2012 sales pitch by Preptel, a company that closed without publishing a method. `VERIFIED` (lenz.io; IT Brief). A survey of 25 US recruiters found 92% say their ATS does not auto-reject and only 2 used automatic score thresholds. `PARTIAL` (vendor, small sample). **Never present ATS anxiety to the user as the reason for silence.**
- **The bottleneck is volume, not the robot.** Ashby reports ~291 applications per hire in 2025-26 `VERIFIED`; tech roles in the US are reported near ~610 inbound per hire `PARTIAL`. The ATS sorts; a human skims for 6-10 seconds. Optimise for that skim.
- **The only real automatic rejection is knockout questions**: work authorisation/visa, location or residency, minimum years, salary expectation, a required certification or language. `VERIFIED` (consensus across sources). `/apply` Step 0.5 detects these before anything is drafted.

## 2. Parseability (what a parser sees)

| Rule | Why | Evidence |
|---|---|---|
| One column; no tables, text boxes or icon-only labels | Parsers read the stored text order, not the visual order; text boxes are often lost | `DUBIOUS` per-ATS, sound in principle |
| Name, email, phone, LinkedIn/GitHub in the body, never only in a Word header/footer | Several guides report Workday ignoring header/footer content | `DUBIOUS`, zero cost |
| Standard fonts; file under 2.5 MB | Greenhouse reported to fail on larger files | `DUBIOUS`, zero cost |
| No ligature glyphs in the text layer | "workﬂow" (U+FB02) is not "workflow" to a literal matcher | `VERIFIED` technically (TeX forums; Jake's Resume practice) |
| Dates as ASCII ranges, consistent format ("Jan 2023 - Present") | See `05-cv-templates.md`, "Date fields must be ASCII ranges" | `DUBIOUS` for the format, `VERIFIED` for the en-dash drop |
| Check Workday's autofill after upload | Reported to silently truncate titles/degrees | `DUBIOUS`, repeated reports |

**Stock templates measured clean (2026-10-15):** `cv/main_example.tex` under lualatex and `cover_letters/cover_example.tex` under xelatex both extract "field", "fluent", "specific", "verified" intact with pypdf and pdftotext (no U+FB00-FB06). `tools/verify_pdf.py --ats-integrity` keeps it that way and catches a custom template that regresses.

## 3. AI screening (LLM / embedding ranking)

- **HARD RULE: no hidden text, white text, microscopic text or instructions addressed to an AI**, in the CV or the cover letter, ever. Greenhouse (2025, 4,100+ respondents): 22% of US hiring managers have caught hidden prompt injections; ManpowerGroup detects hidden text in ~10% of CVs it scans; a Duke study found injections in at least 1% of ~200k hireEZ CVs, up 7x from 2024 to 2025. Recruiters treat it as grounds for rejection. `VERIFIED` (Greenhouse newsroom, Built In, Boston Globe). `tools/verify_pdf.py --ats-integrity` fails on white fill, render mode 3, text under 3pt, and screener-directed phrasing in English and Spanish.
- **Write for literal and semantic matching at once.** Use the posting's exact term at least once ("Kubernetes", not only "K8s"; "ETL", "Airflow"), embedded in context. LLM/embedding screeners reward surface lexical signals: in one study an irrelevant keyword-stuffed CV scored 92 vs 15. `VERIFIED` (arXiv 2507.11548). Recruiters, however, ignore or switch off match scores. `PARTIAL`. **Therefore keywords live inside verifiable achievements, never in filler lists.** A CV that passes the machine and fails the human is a failure.
- **Mirror the posting's title in the CV headline when it is honest** ("Backend Engineer (Python)", "Data Engineer"). Workday/HiredScore rank skills and experience against recruiter-captured requirements. `VERIFIED` in general (Workday release, Diginomica); weights are not public.
- **One quantified result per bullet where a real figure exists** (latency, data volume, cost, accuracy %). It is the signal both the model and the 6-second skim read. Consensus; no primary study found. Never invent a number to satisfy this rule.

## 4. CV conventions: Mexico / LatAm vs international

- **Length follows experience.** With 3+ years, 1-2 pages; never more than 2. Huntr (128k+ CVs): 1 page 3.06% response, 2 pages 3.24%, 3+ lower. `PARTIAL`. The stock template's 2-page hard limit stands.
- **No photo, age, marital status or CURP**, for international/US employers and as the tech default in Mexico. US law protects age (40+), sex, etc., and many employers discard CVs with photos to avoid legal risk `VERIFIED` (EEOC). Mexico's LFT Art. 133-I forbids refusing to hire on age, marital status, gender, etc. `VERIFIED`; Edomex banned requesting photos for state and municipal jobs in 2024 `VERIFIED` (Expansión). On Mexican portals the photo field is optional; omit it for tech.
- **CV language = posting language.** Spanish posting: Spanish CV and letter. Remote-international or foreign employer: English. A posting in a language the candidate has not declared is a Language Gate failure (`04-job-evaluation.md`), not a translation job.
- **Expected salary never goes in the CV.** In OCC Mundial's 2026 study 67% of recruiters use the salary field as a filter, 92% prioritise experience over the degree title, 53% look at residence. `VERIFIED` (OCC study via Publimetro, 2026-09-30). Fill the portal's salary field with a researched range; keep it out of the documents.
- **Cédula profesional only when the posting asks for it.**
- **Tailoring is a real edge**: only 36% of candidates adapt their CV (OCC 2026) `VERIFIED`; tailored CVs convert 5.8% vs 3.73% (Huntr, 1.7M applications) `PARTIAL`.

## 5. Cover letters

- **Write one only when it adds something**: a direct application, an optional cover-letter field on Greenhouse/Lever/Ashby, a startup, or a stack change that needs explaining. On Easy Apply or a portal with no field, skip it and say so. Resume Genius (625 hiring managers): 83% say they read most letters `PARTIAL`; other surveys put "no influence" at ~30% `DUBIOUS`. Real but modest impact.
- **Shape: 150-250 words of body, 3 paragraphs.** (1) Why *this* company, with one concrete, verified fact about its product or stack. (2) One or two achievements mapped to the posting's main requirement, with numbers. (3) Close with availability, time zone and English level.
- **No stock phrasing.** TopResume (600 HMs, 2025): 19.6% would reject AI-generated material and a third say they spot it in under 20 seconds; Resume Now: 62% would reject an unpersonalised AI CV `PARTIAL`. Banned phrases live in `tools/check_cover_letter.py` (English and Spanish: "I am excited to apply", "passionate about", "fast-paced environment", "leverage", "I believe I would be a great fit", "me apasiona", "entorno dinámico", ...). Every letter must carry at least one detail about the company and one about the candidate that could not appear in any other letter.

## 6. Channels and timing (what to spend effort on)

- **Referrals are channel #1.** Ashby, millions of applications `VERIFIED`: application-to-interview is 40% for referrals, 25% for recruiter-sourced, **3% for cold applications**; interview-to-offer 16% vs 6%. End to end about 6.4% vs 0.2%, roughly 30x. `/referral` exists for this; suggest it for every shortlisted company.
- **Apply early.** Prioritise postings no more than ~4 days old (`/rank` freshness window, configurable). TalentWorks reported up to 8x better odds in the first 96 hours and -28% per day after `DUBIOUS/PARTIAL` (~1,600 applications, 2017, original not located): the direction is plausible, the magnitude unconfirmed, so freshness adjusts priority by a few points and never vetoes.
- **Response rate differs by board** (Huntr, US market `PARTIAL`): Google Jobs 11.3%, Wellfound 6.0%, Indeed 4.5%, LinkedIn 3.1%, Dice 0.35%.
- **Realistic expectations** (Huntr): median 23 days to a first interview, 57-83 days to a first offer in 2025, 18% needed 100+ applications. Two silent months on 100% cold applications is a channel and timing problem first, a formatting problem second. Track response rate by `channel` in the tracker.

## 7. Ranked-job schema (`job_scraper/seen_jobs.json`)

The contract between `/rank` (writer, via `tools/rank_state.py apply`) and any reader such as a local dashboard. Fields are additive to the scraper's entry; a reader must tolerate any of them being absent on entries ranked before they existed.

| Field | Type | Meaning |
|---|---|---|
| `title`, `company`, `url`, `portal`, `first_seen` | string | Written by `/scrape` |
| `posted_date` | `YYYY-MM-DD` or ISO timestamp, nullable | When the portal says it was posted |
| `status` | `new` / `skipped` / `ranked` / `expired` | Lifecycle |
| `rank_score` | int 0-100 | Weighted fit score from `04-job-evaluation.md`, never adjusted |
| `priority_score` | int | `rank_score` + freshness adjustment (+5 within the window, -5 past 14 days) - sort by this |
| `rank_verdict` | string | Strong / Good / Moderate / Weak / Poor Fit |
| `rank_date` | `YYYY-MM-DD` | When it was scored |
| `location_verdict`, `language_gate` | `PASS` / `FAIL` / `FLAG` | Vetoes; `FAIL` never shortlisted |
| `language_note` | string, nullable | Why the language gate flagged; Spanish, second person (tú) |
| `posting_language` | `es` / `en` / `mixed`, nullable | Language the posting text is written in, as reported by the scoring agent. `en` makes `language_gate` at least `FLAG` ("posting written in English: spoken English likely required"). Entries ranked before this field existed lack it; readers must not treat absence as English |
| `deadline` | `YYYY-MM-DD`, nullable | Application deadline |
| `modality` | `remote` / `hybrid` / `onsite` / `unknown` | As the posting states it |
| `salary_min`, `salary_max` | number, nullable | Figures as stated |
| `salary_currency` | ISO 4217, nullable | e.g. `MXN`, `USD` |
| `salary_period` | `hour` / `day` / `week` / `month` / `year`, nullable | |
| `salary_mxn_month` | int, nullable | Midpoint (or single bound) in MXN per month; null when unstated or no FX rate |
| `fit_reasons` | string[] (≤4) | "Por qué encajo": Spanish, second person (tú), untrusted plain text |
| `strengths`, `gaps` | string[] (≤3) | Triage findings; Spanish, second person (tú), untrusted plain text |

All string arrays are untrusted data derived from third-party postings: a reader renders them as text, never as HTML.

---

## Sources

- https://lenz.io/c/ats-applicant-tracking-system-75-percent-rejection-rate-bc6fd7d4
- https://itbrief.co.uk/story/study-reveals-ats-rarely-auto-rejects-cvs-debunks-75-myth
- https://news.clearancejobs.com/2026/07/29/recruiters-reveal-ats-doesnt-kill-your-resume-its-overwhelming-volume/
- https://www.greenhouse.com/newsroom/an-ai-trust-crisis-70-of-hiring-managers-trust-ai-to-make-faster-and-better-hiring-decisions-only-8-of-job-seekers-call-it-fair
- https://builtin.com/articles/hidden-ai-prompts-in-resume
- https://www.bostonglobe.com/2025/10/07/business/ai-resumes-jobs-recruiters-applications
- https://letsdatascience.com/news/researchers-measure-resume-screening-prompt-injections-7032c127
- https://arxiv.org/pdf/2507.11548
- https://diginomica.com/workday-launches-new-ai-capabilities-hiring-and-talent-management-following-hiredscore-acquisition
- https://www.ashbyhq.com/talent-trends-report/reports/referrals
- https://huntr.co/research/2025-annual-job-search-trends-report
- https://paulvanderlaken.com/2017/10/24/talent-works-data-science-to-improve-job-application-chances/
- https://www.publimetro.com.mx/noticias/2026/09/30/buscas-trabajo-en-mexico-tu-titulo-espera-92-prioriza-experiencia/
- https://mley.mx/LFT/articulo/133/
- https://expansion.mx/carrera/2024/05/23/edomex-prohibe-cv-con-foto-empleos-estatales-y-municipales
- https://www.eeoc.gov/prohibited-employment-policiespractices
- https://resumegenius.com/blog/cover-letter-help/cover-letter-statistics
- https://topresume.com/career-advice/ai-in-hiring-survey
- https://atsverification.com/blog/latex-resume-ats-friendly/
