import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bunCommandRunner, getDailyStatus, setDaily, type CommandRunner } from "./lib/daily";
import { filterJobs, forceRankJob, loadJobs, parseFilters, prefilteredJobs, recoverJob, skipJob, splitByGate } from "./lib/jobs";
import { runTool } from "./lib/prefilter";
import { loadSearchSettings, parseSearchPatch, saveSearchSettings } from "./lib/search_settings";
import {
  coverageLine, countIndeed, finalizeCoverage, readLastSweep, runConfiguredSweep, type SweepSaver, type SweepSpawn,
} from "./lib/sweep";
import { computeReadings, loadMarket, loadSettings, marketJobs, parseSettings, saveSettings } from "./lib/market";
import { loadProfile } from "./lib/profile";
import { WEAK_REFERENCE, bunCliSpawner, buildSummary, loadAggregate, sampleAll, type CliSpawner } from "./lib/skills";
import {
  APPLY_TOOLS, BASE_TOOLS, ResultStore, SEARCH_TOOLS, RunManager, buildApplyPrompt, bunSpawner, indeedPrompt, type Spawner,
} from "./lib/runner";
import { isAllowedHost, isAllowedOrigin, safeResolve, sanitizeFeedback, validateJobUrl } from "./lib/security";
import { loadTracker, updateTrackerFile } from "./lib/tracker";
import {
  MAX_PROPOSAL_BODY, OnboardingError, clearStaging, confirmProposal, onboardingStatus, parseAnalyzeRequest, prepareAnalysis,
  readLimited, readProposal, saveProposal,
} from "./lib/onboarding";
import { bunSweepSpawn } from "./lib/sweep";

const ROOT = resolve(import.meta.dir, "..");
const PUBLIC = join(import.meta.dir, "public");
const MAX_BODY = 16 * 1024;

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};
// Strict name pattern (no dots/slashes) doubles as the path-traversal guard.
const FONT_FILE = /^\/fonts\/[a-z0-9-]+\.woff2$/;
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

const todayIso = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return null;
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export interface ServerOptions {
  root?: string;
  port?: number;
  spawner?: Spawner;
  claudeBin?: string;
  commandRunner?: CommandRunner;
  marketPath?: string;
  /** Spawner for the portal CLIs used by the market refresh (no Claude). */
  cliSpawner?: CliSpawner;
  /** Test hooks for the portal sweep (no real CLIs / no real scrape_state). */
  sweepSpawn?: SweepSpawn;
  sweepSave?: SweepSaver;
  /** Test hook: skip the pause between portal calls. */
  samplerPauseMs?: number;
  /** Spawner for the onboarding Python tools (extract, validate, apply). Defaults to the real one. */
  toolSpawn?: SweepSpawn;
}

export function createHandler(opts: ServerOptions = {}) {
  const root = opts.root ?? ROOT;
  const port = opts.port ?? 8787;
  const store = new ResultStore(root);
  const runs = new RunManager(root, opts.spawner ?? bunSpawner, opts.claudeBin ?? "claude", store);
  const commandRunner = opts.commandRunner ?? bunCommandRunner;
  const toolSpawn = opts.toolSpawn ?? bunSweepSpawn;

  const onboardingError = (err: unknown): Response => {
    if (err instanceof OnboardingError) {
      return json({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }, err.status);
    }
    throw err;
  };

  /** Smaller JSON body (confirm/cancel); an empty body is an empty object. */
  async function smallBody(req: Request, max = MAX_BODY): Promise<Record<string, unknown>> {
    const bytes = await readLimited(req, max);
    if (bytes === null) throw new OnboardingError(413, "too_large", "El cuerpo de la petición es demasiado grande.");
    if (bytes.byteLength === 0) return {};
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new OnboardingError(400, "bad_request", "Envía JSON.");
    try {
      const v = JSON.parse(new TextDecoder().decode(bytes));
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {}
    throw new OnboardingError(400, "bad_request", "El cuerpo debe ser un objeto JSON válido.");
  }

  async function handleOnboarding(req: Request, pathname: string): Promise<Response> {
    const route = pathname.slice("/api/onboarding/".length);
    try {
      if (req.method === "GET") {
        if (route === "status") return json(onboardingStatus(root, runs.current));
        if (route === "proposal") {
          const res = await readProposal(toolSpawn, root);
          if (!res.ok) return json({ error: "invalid_proposal", message: "La propuesta guardada no es válida.", details: res.errors }, 422);
          return json({ proposal: res.proposal, flagged: res.flagged, repairs: res.repairs });
        }
        return json({ error: "not_found" }, 404);
      }
      if (req.method !== "POST" && req.method !== "PUT") return json({ error: "method_not_allowed" }, 405);
      if (!isAllowedOrigin(req.headers.get("origin"), port)) return json({ error: "origin_not_allowed" }, 403);

      if (req.method === "PUT" && route === "proposal") {
        const bytes = await readLimited(req, MAX_PROPOSAL_BODY);
        if (bytes === null) throw new OnboardingError(413, "too_large", "La propuesta es demasiado grande.");
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new OnboardingError(400, "bad_request", "El cuerpo no es JSON válido.");
        }
        if (runs.busy() && runs.current?.kind === "onboard") throw new OnboardingError(409, "busy", "Espera a que termine el análisis.");
        const edited = body && typeof body === "object" && !Array.isArray(body) && "proposal" in body ? (body as { proposal: unknown }).proposal : body;
        const res = await saveProposal(toolSpawn, root, edited);
        return json({ proposal: res.proposal, flagged: res.flagged, repairs: res.repairs });
      }
      if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

      switch (route) {
        case "analyze": {
          if (runs.busy()) throw new OnboardingError(409, "busy", "Hay otra tarea en curso; espera a que termine.");
          const input = await parseAnalyzeRequest(req);
          const steps = await prepareAnalysis(toolSpawn, root, input);
          const run = runs.startPipeline("onboard", "Analizar tu perfil", steps);
          if (!run) {
            clearStaging(root);
            throw new OnboardingError(409, "busy", "Hay otra tarea en curso; espera a que termine.");
          }
          return json({ id: run.id });
        }
        case "confirm": {
          if (runs.busy()) throw new OnboardingError(409, "busy", "Hay otra tarea en curso; espera a que termine.");
          const body = await smallBody(req);
          return json(await confirmProposal(toolSpawn, root, body.current_salary_mxn));
        }
        case "cancel": {
          if (runs.busy() && runs.current?.kind === "onboard") throw new OnboardingError(409, "busy", "Espera a que termine el análisis.");
          await smallBody(req);
          clearStaging(root);
          return json({ ok: true });
        }
        default:
          return json({ error: "not_found" }, 404);
      }
    } catch (err) {
      return onboardingError(err);
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // DNS-rebinding guard: only answer to our own host names.
    if (!isAllowedHost(req.headers.get("host"), port)) return json({ error: "host_not_allowed" }, 403);

    // Onboarding has its own body limits (upload 2.5 MB, proposal 512 KB) and also takes PUT.
    if (url.pathname.startsWith("/api/onboarding/")) return handleOnboarding(req, url.pathname);

    if (req.method === "POST") {
      if (!isAllowedOrigin(req.headers.get("origin"), port)) return json({ error: "origin_not_allowed" }, 403);
      return handlePost(url.pathname, req);
    }
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

    if (STATIC[url.pathname]) {
      const file = STATIC[url.pathname];
      return new Response(readFileSync(join(PUBLIC, file)), {
        headers: { ...SECURITY_HEADERS, "Content-Type": MIME[file.split(".").pop()!] },
      });
    }

    if (FONT_FILE.test(url.pathname)) {
      const fontPath = join(PUBLIC, url.pathname);
      if (!existsSync(fontPath)) return json({ error: "not_found" }, 404);
      return new Response(readFileSync(fontPath), {
        headers: { ...SECURITY_HEADERS, "Content-Type": MIME.woff2, "Cache-Control": "public, max-age=86400" },
      });
    }

    switch (url.pathname) {
      case "/api/jobs": {
        const profile = loadProfile(root);
        const saved = loadSearchSettings(root);
        const filters = parseFilters(url.searchParams, {
          maxDays: saved.maxDays,
          minSalaryMxn: saved.minSalaryMxn,
          includeNoSalary: saved.includeUnpublishedSalary,
          includeUndated: saved.includeUndated,
          hideEnglish: saved.hideEnglish,
          modalities: saved.modalities,
        });
        const all = loadJobs(root, new Date());
        const { ranked, unranked } = filterJobs(all, filters);
        const prefiltered = prefilteredJobs(all);
        const gate = splitByGate(all.filter((j) => j.status === "new"), saved.minPrefilterScore);
        const shown = splitByGate(unranked, saved.minPrefilterScore);
        const counts = {
          pending: gate.eligible.length + gate.gated.length,
          eligible: gate.eligible.length,
          gated: gate.gated.length,
          rankedTotal: all.filter((j) => j.status === "ranked").length,
          prefilteredOut: prefiltered.length,
        };
        // The search settings are the one source of truth for the window and the
        // salary floor; CLAUDE.md's values are only the first-run defaults.
        return json({
          profile: { ...profile, freshnessDays: saved.maxDays, salaryFloorMxn: saved.minSalaryMxn },
          filters, ranked, unranked: shown.eligible, gated: shown.gated, prefiltered, rankBatch: saved.rankBatch,
          minPrefilterScore: saved.minPrefilterScore, counts, results: store.all(),
        });
      }
      case "/api/tracker":
        return json(loadTracker(root));
      case "/api/settings":
        return json(loadSettings(root));
      case "/api/search-settings": {
        const lastSweep = readLastSweep(root);
        return json({ search: loadSearchSettings(root), lastSweep: lastSweep && { ...lastSweep, coverage: coverageLine(lastSweep) } });
      }
      case "/api/market": {
        let market;
        try {
          market = loadMarket(opts.marketPath);
        } catch {
          return json({ error: "market_data_invalid" }, 500);
        }
        const jobs = marketJobs(loadJobs(root, new Date()));
        const settings = loadSettings(root);
        return json({ market, jobs, settings, readings: computeReadings(market, jobs, settings) });
      }
      case "/api/skills": {
        const aggregate = loadAggregate(root);
        return json({ aggregate, summary: aggregate ? buildSummary(aggregate) : null, reference: WEAK_REFERENCE });
      }
      case "/api/daily":
        return json(await getDailyStatus(root, commandRunner));
      case "/api/run":
        return json({ run: runs.current && { ...runs.current, events: undefined } });
      case "/api/run/events":
        return sse(url.searchParams.get("id"));
      case "/api/file": {
        const path = safeResolve(root, url.searchParams.get("path"), ["cv", "cover_letters"], [".pdf"]);
        if (!path || !existsSync(path)) return json({ error: "not_found" }, 404);
        return new Response(Bun.file(path), {
          headers: {
            ...SECURITY_HEADERS,
            "Content-Type": "application/pdf",
            "Content-Disposition": url.searchParams.get("download") === "1" ? "attachment" : "inline",
          },
        });
      }
      case "/api/form-fields": {
        const path = safeResolve(root, url.searchParams.get("path"), [join("documents", "applications")], [".txt"]);
        if (!path || !existsSync(path)) return json({ error: "not_found" }, 404);
        return json({ text: readFileSync(path, "utf8") });
      }
      default:
        return json({ error: "not_found" }, 404);
    }
  }

  async function handlePost(pathname: string, req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    if (body === null) return json({ error: "bad_request" }, 400);

    switch (pathname) {
      case "/api/run/search": {
        let indeedBefore = 0;
        const run = runs.startPipeline("search", "Buscar y calificar vacantes", [
          {
            title: "Barrido de los 5 portales (sin IA)", optional: true,
            task: async (log) => {
              indeedBefore = countIndeed(root);
              const stats = await runConfiguredSweep(root, log, { spawn: opts.sweepSpawn, save: opts.sweepSave });
              return stats.calls === 0 || stats.failures < stats.calls;
            },
          },
          {
            title: "Buscando en Indeed México", optional: true,
            prompt: indeedPrompt(loadSearchSettings(root).maxDays), tools: SEARCH_TOOLS,
          },
          {
            title: "Resumen de cobertura",
            task: async (log) => {
              finalizeCoverage(root, indeedBefore, log);
              return true;
            },
          },
          { title: "Descartando lo que no va contigo (sin IA)", optional: true, task: (log) => runTool(root, "prefilter", log, opts.sweepSpawn) },
          { prompt: "/rank", tools: BASE_TOOLS, title: "Calificando las mejores vacantes nuevas (/rank)" },
          { title: "Calculando oportunidad y riesgo (sin IA)", optional: true, task: (log) => runTool(root, "opportunity", log, opts.sweepSpawn) },
        ]);
        return run ? json({ id: run.id }) : json({ error: "busy" }, 409);
      }
      case "/api/run/rank": {
        const run = runs.startPipeline("rank", "Calificar vacantes pendientes", [
          { title: "Descartando lo que no va contigo (sin IA)", optional: true, task: (log) => runTool(root, "prefilter", log, opts.sweepSpawn) },
          { prompt: "/rank", tools: BASE_TOOLS, title: "Calificando las mejores vacantes pendientes (/rank)" },
          { title: "Calculando oportunidad y riesgo (sin IA)", optional: true, task: (log) => runTool(root, "opportunity", log, opts.sweepSpawn) },
        ]);
        return run ? json({ id: run.id }) : json({ error: "busy" }, 409);
      }
      case "/api/run/apply": {
        const jobUrl = validateJobUrl(body.url);
        if (!jobUrl) return json({ error: "invalid_url" }, 400);
        const prompt = buildApplyPrompt(jobUrl, body.acknowledgeKnockouts === true, sanitizeFeedback(body.feedback));
        const run = runs.start(
          "apply", "Preparando CV y carta",
          [{ prompt, tools: APPLY_TOOLS, title: "Generando CV y carta (/apply)" }],
          jobUrl,
        );
        return run ? json({ id: run.id }) : json({ error: "busy" }, 409);
      }
      case "/api/market/refresh": {
        const run = runs.startTask("market", "Actualizar datos de mercado", async (log) => {
          const { aggregate, calls } = await sampleAll({
            root, spawn: opts.cliSpawner ?? bunCliSpawner, pauseMs: opts.samplerPauseMs, log,
          });
          const failed = calls.filter((c) => c.error).length;
          log(`Listo: ${aggregate.totals.used_with_salary} vacantes con sueldo usable (${failed} consultas fallidas de ${calls.length}).`);
          return failed < calls.length;
        });
        return run ? json({ id: run.id }) : json({ error: "busy" }, 409);
      }
      case "/api/daily": {
        // The boolean is the only user input; the systemctl argv is fixed.
        if (typeof body.enabled !== "boolean") return json({ error: "bad_request" }, 400);
        const ok = await setDaily(body.enabled, commandRunner);
        if (ok === null) return json({ error: "systemctl_unavailable" }, 503);
        if (!ok) return json({ error: "systemctl_failed" }, 500);
        return json(await getDailyStatus(root, commandRunner));
      }
      case "/api/settings": {
        const settings = parseSettings(body);
        if (!settings) return json({ error: "invalid_settings" }, 400);
        saveSettings(root, settings);
        return json(settings);
      }
      case "/api/search-settings": {
        const patch = parseSearchPatch(body);
        if (!patch) return json({ error: "invalid_settings" }, 400);
        const merged = { ...loadSearchSettings(root), ...patch };
        saveSearchSettings(root, merged);
        return json(merged);
      }
      case "/api/jobs/skip": {
        if (typeof body.key !== "string" || body.key.length > 2048) return json({ error: "bad_request" }, 400);
        return skipJob(root, body.key) ? json({ ok: true }) : json({ error: "not_found" }, 404);
      }
      case "/api/jobs/recover": {
        if (typeof body.key !== "string" || body.key.length > 2048) return json({ error: "bad_request" }, 400);
        return recoverJob(root, body.key) ? json({ ok: true }) : json({ error: "not_found" }, 404);
      }
      case "/api/jobs/force-rank": {
        if (typeof body.key !== "string" || body.key.length > 2048) return json({ error: "bad_request" }, 400);
        return forceRankJob(root, body.key) ? json({ ok: true }) : json({ error: "not_found" }, 404);
      }
      case "/api/applications/approve": {
        const jobUrl = validateJobUrl(body.url);
        if (!jobUrl) return json({ error: "invalid_url" }, 400);
        const result = updateTrackerFile(root, jobUrl, todayIso());
        return "error" in result ? json(result, 404) : json(result);
      }
      default:
        return json({ error: "not_found" }, 404);
    }
  }

  function sse(id: string | null): Response {
    const run = runs.current;
    if (!run || run.id !== id) return json({ error: "not_found" }, 404);
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        for (const e of run.events) send(e);
        if (run.status !== "running") {
          send({ type: "end", run: { ...run, events: undefined } });
          controller.close();
          return;
        }
        unsubscribe = runs.subscribe((e) => {
          send(e);
          if (e.type === "done") {
            send({ type: "end", run: { ...run, events: undefined } });
            unsubscribe();
            controller.close();
          }
        });
      },
      cancel() {
        unsubscribe();
      },
    });
    return new Response(stream, {
      headers: { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" },
    });
  }

  return { handle, runs, store };
}

if (import.meta.main) {
  const port = Number(process.env.JOB_UI_PORT ?? 8787);
  const { handle } = createHandler({ port, claudeBin: process.env.CLAUDE_BIN ?? "claude" });
  Bun.serve({ hostname: "127.0.0.1", port, fetch: handle, idleTimeout: 0 });
  console.log(`Panel de búsqueda de empleo en http://127.0.0.1:${port}`);
}
