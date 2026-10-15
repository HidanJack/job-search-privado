---
framework_version: 1.0.1
---

# Interview Preparation Guide

<!-- Populated 2026-10-15 from Analisis_Proyectos_CV.md (verified project analysis).
Facts only; gaps marked [ASK LUIS] must be filled before using an example in an interview.
Never name Intelitax end clients - describe them generically. -->

## STAR Format

Structure answers as: **Situation** (context), **Task** (your responsibility), **Action** (what you did), **Result** (outcome).

Keep answers to 1-2 minutes. Be specific. End with what you learned or would do differently.

## Ready-Made STAR Examples

### 1. Multi-tenant migration security audit (security, ownership, quality)
**S:** Intelitax's reconciliation pipeline (parser, cleaner, extractor, matcher, marking, frontend) was built to serve one client at a time. It had to move to a multi-user platform on Kubernetes/EKS that used a third party's real authentication service.
**T:** Lead the migration and make sure one client could never reach another client's data.
**A:** Integrated authentication at the edge with nginx `auth_request` against the platform's auth service. During my own audit I found that any valid session could read, download or reprocess another client's `job_id` - the check validated *that* a user existed, not *whose* job it was. I designed per-client ownership (first owner of a `job_id` wins; any other client gets 403), replicated it in the three affected services, protected the read-modify-write with a lock, and added service-to-service auth for internal services.
**R:** Vulnerability closed in all 3 services before production; build, nginx config and container verified; known remaining limits (logical vs physical isolation, development WSGI server) documented explicitly instead of hidden.
**Use for:** "Tell me about a security issue you found", "A time you went beyond the requirements", "How do you ensure quality?"

### 2. Race condition found in multi-client audit (debugging, concurrency)
**S:** The third-generation matching engine (MATCHER_V2) was being prepared for production with several clients running in parallel.
**T:** Validate it under realistic multi-client use before release.
**A:** Ran my own multi-client audit, found a real race condition, fixed it, and added auth plus per-RFC scoping inside the matcher itself (not only at the edge). [ASK LUIS: exact symptom and fix of the race condition]
**R:** Bug closed before production; access control enforced in the engine, not just at nginx.
**Use for:** "Hardest bug you've fixed", "Experience with concurrency"

### 3. Python-to-Rust rewrite of the matching engine (performance, correctness)
**S:** Bank reconciliation was modeled as a weighted graph (NetworkX) and the matching core was compute-heavy.
**T:** Rewrite the core for production performance without losing functional correctness.
**A:** Ported the 7-pass matching core to Rust via PyO3 (~1,636 lines) with rayon parallelism and ahash; diagnosed and fixed 6 porting bugs, documenting exactly which logic had been lost and how it was recovered; added semantic matching with sentence-transformers and a disk cache.
**R:** On a real manufacturing client case, unmatched movements dropped from 82 to 2 after a post-process that needed no Rust rebuild; validated on a second pilot client with a different accounting system without touching the engine. [ASK LUIS: speed-up measured, if any]
**Use for:** "Performance optimization", "Learning a new language/technology", "Ensuring correctness during a rewrite"

### 4. Decoding obfuscated PDF fonts without OCR (problem solving, reverse engineering)
**S:** Some Mexican bank statements embed "scrambled" fonts: text renders correctly but extracts as garbage, so the pipeline fell back to slower, error-prone OCR.
**T:** Recover the real text deterministically.
**A:** Wrote a custom binary CFF parser (fontTools could not read standalone CFF) and rebuilt the code-to-glyph mapping, validated against declared widths (Type1). Later found a second mechanism (Type3, meaningless glyph names) and solved it with font fingerprinting (SHA-256 of FontMatrix + Widths, stable across months of the same bank template) plus glyph-shape comparison for unseen fonts; unified both behind one API.
**R:** 100% OCR-free text extraction on real statements from the affected bank; 7/7 decoder validations; a reusable library instead of one-off fixes.
**Use for:** "Most technically challenging problem", "A creative solution", "Working without existing libraries"

### 5. Knoto: moving an LLM app fully on-device (architecture decisions, AI reliability)
**S:** Personal assistant that ingests life documents and answers questions; first version ran on a server (FastAPI + Kùzu + Ollama).
**T:** Keep user data private without losing answer quality.
**A:** Migrated to 100% on-device (SQLite + llama.rn); designed guardrails where code computes/verifies sensitive data (CURP, RFC, ages, kinship) and the LLM only drafts; built a 20-case eval harness with ground truth from real documents; A/B tested quantized builds and set temperature 0 after observing character hallucination on IDs.
**R:** On-device chat matched the server's coverage and the server chat was retired as dead code; one quantized build scored 8/8 vs 3/4 on relational questions - a gap invisible in generic benchmarks.
**Use for:** "A difficult architecture decision", "How do you make AI/LLM output reliable?", "Tell me about a side project"

### 6. AI-augmented engineering workflow (process, AI tooling)
**S:** AI coding agents speed up implementation but introduce unverified assumptions and hallucinated code.
**T:** Use Claude Code productively without lowering quality.
**A:** Design first (diagrams, specs, phased plans with tests), then let agents implement; review and test everything. Built 7 own agents for weak spots: requirements interrogator, architect, tenth-man contrarian, feasibility recon on real data, diagrammer, browser-verified UX designer, and a memoryless synthetic-user accountant for usability tests.
**R:** Faster delivery with the decisions and verification kept on my side. [ASK LUIS: one concrete case where an agent's output was wrong and he caught it]
**Use for:** "How do you use AI tools?", "Do you still write code?" (answer: yes - I own design, review and tests; agents accelerate implementation)

## Common Tough Questions

### "Why did you leave [previous company]?" / "Why are you looking now?"
> [ASK LUIS - be honest, forward-looking, no negativity about Intelitax]

### "You don't have [specific skill/experience]."
> Acknowledge the gap, bridge to the closest real experience (e.g. no Spark at scale → ETL over 1M+ records with Polars and a Rust extension for heavy compute), and state how you'd close it.

### "Your English?"
> Honest: "I read and write technical English daily (documentation, code, specs); my spoken English is basic-intermediate and I'm actively improving it." Never claim fluency.

### "Your degree?"
> Licenciatura at UPIICSA-IPN not completed; lead with 3+ years in production, professional license and certifications. Never misstate it.

### "Where do you see yourself in 5 years?"
> [ASK LUIS] - evidence suggests: designing architecture for data/backend systems and high-performance components.

### "What's your biggest weakness?"
> [ASK LUIS] - candidate option grounded in evidence: spoken English, with the concrete mitigation he is using.

### "Why this company specifically?"
> Customize per company. Must reference: specific projects, company values, market position, or team structure. Never give a generic answer.

## Questions You Should Ask Interviewers

### About the Role
- "What does a typical week look like in this role?"
- "What would success look like in the first 6 months?"
- "What's the biggest challenge the team is facing right now?"

### About the Team
- "How big is the team, and how do you divide work?"
- "What does the development/project lifecycle look like, from idea to production?"
- "How do you onboard new team members?"

### About Tech & Growth
- "What's your current tech stack for [relevant area]?"
- "Is there room to grow into more architectural or strategic decisions?"
- "How does the team stay current with new tools and methods?"
- "How does the team use AI coding tools, and how is their output reviewed?"

### About Culture (use these to prevent disappointment)
- "How would you describe the team culture?"
- "What does professional development look like here?"
- "Is there flexibility for remote/hybrid work?"
- "What's the balance between development/new projects and maintenance work?"
- "How would you describe the leadership style in this team?"
- "What do people who thrive here have in common?"

## Phone/Video Interview Tips
- Have STAR examples written out (use this file)
- Keep a glass of water nearby
- Smile when speaking (it changes your tone)
- Ask for clarification if a question is vague
- It's OK to take 5 seconds to think before answering
- End with: "Is there anything else you'd like to know about my background?"
- Practice live coding and system design **without AI assistance** - most technical interviews still test this

## After the Application (Best Practice)

### Follow-Up Etiquette
- **Don't call to "stand out"** or to learn more about the role post-submission - this risks a negative impression
- If the employer specified a timeline, respect it and wait
- If no timeline was given and significant time has passed (2+ weeks), a brief call to ask about status is acceptable
- If you have genuinely new, relevant information to share, a short follow-up is fine

### Thank-You Notes
- When you receive any update (interview invitation, rejection, or status update), send a brief thank-you message
- Express appreciation for their time and the process
- Keep it short (2-3 sentences)

## Roleplay Guidelines
When the user asks for interview practice:
1. Ask which role/company to simulate
2. Start with easy warm-up questions ("Tell me about yourself")
3. Progress to role-specific technical questions
4. Include 1-2 behavioral questions using the competencies from the job posting
5. End with a tough question or curveball
6. After each answer, give brief feedback: what worked, what to sharpen
7. Suggest which STAR example would work best for each question
