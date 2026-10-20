---
framework_version: 1.1.3
---

# Candidate Profile

<!-- Populated 2026-10-15 from documents/cv/CV_Luis_Catalan_2026_actualizado.pdf,
documents/projects/Analisis_Proyectos_CV.md and the portfolio (hidanjack.github.io).
Nothing here may be embellished: every claim used in a CV or letter must trace back to this file. -->

> **CONFIDENTIALITY RULE (hard):** never name Intelitax's end clients in any CV, cover letter,
> form answer or message. Describe them generically ("a media-sector client", "a manufacturing
> client", "a dental-clinic client"). Client names may appear in internal analysis documents
> only; they must never reach a generated application document.

## Identity
- **Name:** Luis Catalán Reyes
- **Programming history (INTERNAL context only):** never write it in CVs, cover letters or form answers: programs since about age 12 (~15 years self-taught); verifiable professional experience ~3.5-4 years (since Aug 2022). Use it only for ranking/risk and interview prep; he may bring it up himself in interviews.
- **Location:** Ciudad de México (CDMX), Mexico
- **Phone:** +52 55 6427 2782
- **Email:** luis.catalan.r@hotmail.com
- **LinkedIn:** https://www.linkedin.com/in/luis-catalán-reyes-032a48329
- **GitHub:** https://github.com/HidanJack
- **Portfolio:** https://hidanjack.github.io
- **Status:** Employed as Software Developer at Intelitax (Jan 2025 - present); actively looking for a new role
- **Constraints:** Based in CDMX. Prefers remote or hybrid; on-site in CDMX acceptable. Work authorization: Mexican citizen based in CDMX; no US work authorization assumed - international roles via remote contractor/EOR arrangements. **UNCONFIRMED - ask Luis.**
- **Professional license:** Cédula Profesional No. 11454578 (mention only when a posting or form asks for it)
- **Never include:** photo, age, marital status, CURP, expected salary (salary goes only in form fields)

### Languages
<!-- Every language you can work in professionally, with your honest level. Used by the
Language Gate in 04-job-evaluation.md and by job-scraper/search-queries.md's query-language
generation. Omit any language you don't actually work in - an undeclared language is treated as
a hard no, not a gap to smooth over. -->

| Language | Level | Notes |
|----------|-------|-------|
| Spanish | Native | |
| English | B1 overall (reading/writing ~B2, speaking ~A2) | Confirmed by Luis 2026-10-15: reads and writes well, limited conversational speaking. Written English CVs/letters are fine. Postings requiring fluent/conversational spoken English or English-language interviews -> FLAG (not reject) and list "spoken English" as an explicit gap. |

## Education

| Degree | Period | Institution | Key Topics |
|--------|--------|-------------|------------|
| Licenciatura en Ciencias de la Informática (not completed / "trunca") | Dates not stated in sources | UPIICSA - Instituto Politécnico Nacional (IPN) | Informatics |
| Profesional Técnico Bachiller (P.T.B.) en Informática, con título y cédula profesional de técnico (No. 11454578) | Dates not stated in sources | CONALEP Estado de México 236 | Informatics; technician-level título, not a licenciatura |

### Certifications
- Python Profesional
- Backend con Microservicios
- Ruta de Arquitectura de Software; Fundamentos de Arquitectura de Software
- DevOps: Bases y Conceptos; Git; GitHub Actions
- Replicación de Bases de Datos
- Fundamentos de IA; Desarrollo con IA: de 0 a Producción
- Fundamentos de Azure; Despliegue Web en Azure
- Cisco CCNA: Introducción a Redes; CCNA2 Routing y Switching; CCNA3 Escalamiento de Redes
- Python - Santander Open Academy
- Microsoft Office Specialist: Excel 2010, Excel 2013, Word 2013, PowerPoint 2013

## Professional Experience

### Software Developer - Intelitax / Soluciones Analíticas para Empresas S.A. de C.V. (Jan 2025 - Present)
Ciudad de México
- Built ETL pipelines that clean, normalize and consolidate financial data from multiple formats (CSV, Excel, TXT), processing more than 1 million records.
- Implemented OCR extraction from Mexican bank-statement PDFs (Tesseract, OpenCV, YOLOv10 layout detection) with ~95% accuracy; uses a YOLOv10 (PyTorch) object-detection model to detect bank transactions in statement tables, alongside OCR (computer vision applied to financial documents; not stated whether he trained the weights - never write "trained"); 23 Mexican banks supported in the deep-learning generation.
- Designed an in-house reverse-engineering library that decodes two different kinds of obfuscated ("scrambled") embedded PDF fonts - Type1/CFF via a custom binary CFF parser and code-to-glyph reconstruction, Type3 via font fingerprinting (SHA-256 of FontMatrix + Widths) plus glyph-shape matching - extracting text 100% without OCR, behind one unified API.
- Built and later rewrote in Rust (PyO3, rayon) a multi-criteria graph-based matching engine (NetworkX, Neo4j) for bank reconciliation; on a real manufacturing client case, unmatched movements dropped from 82 to 2. Diagnosed and fixed 6 logic bugs introduced while porting from Python to Rust.
- Third-generation matcher (MATCHER_V2): architecture documented in draw.io diagrams before coding, phased reversible migration with feature flags and golden tests (3 levels), built a ~1,000-line test harness from zero on a codebase that had none.
- Led the migration of the pipeline to a multi-tenant platform on Kubernetes/EKS integrated with a real third-party auth service (nginx auth_request, JWT); in self-initiated audits found and fixed a cross-tenant authorization vulnerability (any valid session could read another client's job) and a race condition, before production. Per-client job ownership, service-to-service auth, generated-and-validated K8s ConfigMaps, React (Vite + Tailwind) frontend.
- Built end-to-end QA: a regression run of the full pipeline over 211 real PDFs from 11 banks (~88-89% success per stage).
- Uses AI agents (Claude Code) as part of development with engineering controls: design-first diagrams, specification, TDD and adversarial review; built 7 own agents (see Technical Skills > AI-Augmented Engineering).

### Information Analyst - Grupo Gabssa (Aug 2023 - Aug 2024)
- Automated analysis, consolidation and reporting of business data with Python scripts, reducing manual processing work.
- Built an OCR + self-trained document-classification model (scikit-learn; demandas, invitation letters and other document types) that organized 7 TB of PDFs on the company NAS
- INTERNAL only: the end clients of this call center (housing-loan collections) must not be named in CVs/letters; use generic wording ("documentos legales y de cobranza").

### Technology Analyst - Ingeniería Integral Consultores México (Aug 2022 - Aug 2023)
- Developed Python analysis scripts for technology requirements and supported IT infrastructure.

## Independent Projects
- **Knoto** (personal, 100% on-device AI assistant): React Native/Expo + TypeScript app with a local LLM (llama.rn) for chat and document extraction, no cloud. Knowledge graph projected to SQLite, GPU-rendered graph (Skia), own "closeness circles" relationship-priority algorithm based on social-network literature, proactive expiry alerts. Anti-hallucination guardrails: deterministic code computes/verifies sensitive data (CURP, RFC, ages, kinship) and the LLM only drafts the answer; 20-case evaluation harness with ground truth read from real documents; empirical A/B of quantized GGUF builds (3/4 vs 8/8 on relational questions). Migrated from server architecture (FastAPI + Kùzu) to fully on-device. 22 test suites (13 Python + 9 TypeScript).
- **GG (Git Guardian)** (personal): 3-component distributed system built in 4 days - local Python agent (Typer), FastAPI backend (async SQLAlchemy, WebSockets with reconnection/backoff, APScheduler) and Expo mobile app - that watches Git repos and notifies in real time about unbacked changes, with heuristic (non-AI) Conventional Commit suggestions and dual auth (JWT for users + SHA-256-hashed API keys for devices). Fixed a production timezone bug.
- **Apex Face Studio / DeepFace** (personal): real-time face-swap for webcam, video and a Gradio web UI using InsightFace + ONNX Runtime (OpenVINO on Intel CPU), multi-photo embedding averaging, ffmpeg audio remux.
- **Soffia.mx CFDI reconciliation** (2026): hexagonal architecture (domain / application / infrastructure / presentation) with an optimal-assignment adapter using scipy's linear_sum_assignment (Hungarian algorithm) and RapidFuzz name similarity; tests per layer plus end-to-end; CLI.
- **reparto** (logistics/invoicing correlation): Neo4j graph (Company/Invoice/Waybill), Cypher queries, layered architecture, confidence-scored matching.
- **Portfolio**: https://hidanjack.github.io (Astro + Tailwind, GitHub Actions deploy; built by Luis himself, confirmed 2026-10-15).

## Technical Skills

### Programming & ML
- **Python** (advanced): Pandas, Polars, NumPy, OpenPyXL, FastAPI, Flask, SQLAlchemy, pytest, ThreadPoolExecutor/ProcessPoolExecutor
- **Rust** (intermediate-advanced, via PyO3 extensions): rayon, ahash
- **SQL**, **TypeScript/JavaScript** (React, React Native/Expo), Cypher
- OCR & documents: Tesseract, OpenCV, YOLOv10 (PyTorch; transaction detection in bank-statement tables), deepdoctection, docTR, PyMuPDF, binary parsing of embedded CFF/Type1/Type3 fonts
- ML/AI (pre-LLM): has trained his own document-classification model (scikit-learn) since 2023 (Grupo Gabssa), in addition to LLM work with Claude since Jan 2025; uses PyTorch via YOLOv10 detection of bank transactions in statement tables at Intelitax (verified on disk: ultralytics YOLOv10, torch; whether he trained the weights is NOT stated - never write "trained" about YOLO); TensorFlow: stated by Luis, no evidence found - do not put in CVs; never attribute these to the Gabssa classifier
- ML/AI: deep learning, embeddings (sentence-transformers), on-device LLMs (llama.rn, Ollama), InsightFace/ONNX
- Graphs & matching: NetworkX, Neo4j, RapidFuzz, scipy (combinatorial optimization)

### AI-Augmented Engineering
- Uses Claude Code agents to accelerate implementation while keeping design, code review and testing under his own responsibility. Never present this as "no longer writing code".
- **7 own agents (his design):** interrogator (requirements, exposes assumptions before design), architect (architecture with tradeoffs), tenth-man (designated contrarian that attacks plans), recon (feasibility measured on real data), diagrammer (diagrams as code, Mermaid/draw.io), ux-designer (designs UI and verifies it in a real browser), contadora (memoryless synthetic user - a skeptical Mexican accountant - for uncontaminated usability tests).
- **Third-party tools he uses and configures (not his authorship):** gentle-ai (spec-driven workflow, adversarial reviewers), Engram persistent memory via MCP, MCP servers (Context7, browser).
- LLM reliability: guardrails (compute/verify in code, LLM only drafts), evals with real ground truth (Knoto).
- Keywords that appear in postings: Agentic AI, AI agents, multi-agent systems, LLM, Claude Code, MCP (Model Context Protocol), evals / LLM evaluation, guardrails, context engineering.

### Domain Expertise
- Mexican bank reconciliation and accounting (bank statements, accounting ledgers, CFDI, CLABE validation)
- Financial document processing (OCR, PDF internals, reverse engineering of obfuscated fonts)
- Graph-based record matching and reconciliation
- Multi-tenant security on platform migrations

### Software & Tools
- Docker/Podman, Kubernetes (EKS), nginx, Git, GitHub Actions, AWS S3 (boto3), Kafka, Azure, Selenium, LaTeX-free docs tooling, draw.io

## Publications
None.

## Awards
None stated in sources.

## References
Available upon request (no referees recorded yet).
