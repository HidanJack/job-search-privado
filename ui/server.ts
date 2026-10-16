import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bunCommandRunner, getDailyStatus, setDaily, type CommandRunner } from "./lib/daily";
import { filterJobs, loadJobs, parseFilters, skipJob } from "./lib/jobs";
import { loadProfile } from "./lib/profile";
import {
  APPLY_TOOLS, BASE_TOOLS, ResultStore, SEARCH_TOOLS, RunManager, buildApplyPrompt, bunSpawner, type Spawner,
} from "./lib/runner";
import { isAllowedHost, isAllowedOrigin, safeResolve, sanitizeFeedback, validateJobUrl } from "./lib/security";
import { loadTracker, updateTrackerFile } from "./lib/tracker";

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
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
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
}

export function createHandler(opts: ServerOptions = {}) {
  const root = opts.root ?? ROOT;
  const port = opts.port ?? 8787;
  const store = new ResultStore(root);
  const runs = new RunManager(root, opts.spawner ?? bunSpawner, opts.claudeBin ?? "claude", store);
  const commandRunner = opts.commandRunner ?? bunCommandRunner;

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // DNS-rebinding guard: only answer to our own host names.
    if (!isAllowedHost(req.headers.get("host"), port)) return json({ error: "host_not_allowed" }, 403);

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

    switch (url.pathname) {
      case "/api/jobs": {
        const profile = loadProfile(root);
        const filters = parseFilters(url.searchParams, {
          maxDays: profile.freshnessDays,
          minSalaryMxn: profile.salaryFloorMxn,
        });
        const all = loadJobs(root, new Date());
        const { ranked, unranked } = filterJobs(all, filters);
        const counts = {
          pending: all.filter((j) => j.status === "new").length,
          rankedTotal: all.filter((j) => j.status === "ranked").length,
        };
        return json({ profile, filters, ranked, unranked, counts, results: store.all() });
      }
      case "/api/tracker":
        return json(loadTracker(root));
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
        const run = runs.start("search", "Buscar y calificar vacantes", [
          { prompt: "/job-scraper", tools: SEARCH_TOOLS, title: "Buscando vacantes en los portales (/job-scraper)" },
          { prompt: "/rank", tools: BASE_TOOLS, title: "Calificando las vacantes nuevas (/rank)" },
        ]);
        return run ? json({ id: run.id }) : json({ error: "busy" }, 409);
      }
      case "/api/run/rank": {
        const run = runs.start("rank", "Calificar vacantes pendientes", [
          { prompt: "/rank", tools: BASE_TOOLS, title: "Calificando las vacantes pendientes (/rank)" },
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
      case "/api/daily": {
        // The boolean is the only user input; the systemctl argv is fixed.
        if (typeof body.enabled !== "boolean") return json({ error: "bad_request" }, 400);
        const ok = await setDaily(body.enabled, commandRunner);
        if (ok === null) return json({ error: "systemctl_unavailable" }, 503);
        if (!ok) return json({ error: "systemctl_failed" }, 500);
        return json(await getDailyStatus(root, commandRunner));
      }
      case "/api/jobs/skip": {
        if (typeof body.key !== "string" || body.key.length > 2048) return json({ error: "bad_request" }, 400);
        return skipJob(root, body.key) ? json({ ok: true }) : json({ error: "not_found" }, 404);
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
