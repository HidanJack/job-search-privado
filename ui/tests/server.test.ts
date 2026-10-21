import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../server";
import { BASE_TOOLS, type SpawnedProcess, type Spawner } from "../lib/runner";

const FIXTURES = join(import.meta.dir, "fixtures");
const BASE = "http://127.0.0.1:8787";
const ORIGIN = { Origin: BASE, Host: "127.0.0.1:8787", "Content-Type": "application/json" };

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "job-ui-srv-"));
  mkdirSync(join(root, "job_scraper"));
  mkdirSync(join(root, "cv"));
  cpSync(join(FIXTURES, "seen_jobs.json"), join(root, "job_scraper", "seen_jobs.json"));
  cpSync(join(FIXTURES, "tracker.csv"), join(root, "job_search_tracker.csv"));
  writeFileSync(join(root, "cv", "main_acme.pdf"), "%PDF-1.4 test");
  writeFileSync(join(root, "CLAUDE.md"), "# Alex\n- **Freshness window:** 4 days\n");
  return root;
}

/** Fake `claude`: records argv and replays canned stream-json lines. */
function fakeSpawner(lines: string[], calls: string[][], code = 0): Spawner {
  return (argv) => {
    calls.push(argv);
    const body = lines.map((l) => l + "\n").join("");
    const proc: SpawnedProcess = {
      stdout: new Response(body).body!,
      exited: Promise.resolve(code),
      kill() {},
    };
    return proc;
  };
}

const get = (h: ReturnType<typeof createHandler>, path: string, headers: Record<string, string> = { Host: "127.0.0.1:8787" }) =>
  h.handle(new Request(BASE + path, { headers }));
const post = (h: ReturnType<typeof createHandler>, path: string, body: unknown, headers: Record<string, string> = ORIGIN) =>
  h.handle(new Request(BASE + path, { method: "POST", headers, body: JSON.stringify(body) }));

const emptySweep = async () => ({ code: 0, stdout: JSON.stringify({ meta: { count: 0, page: 1 }, results: [] }) });
const noSave = async () => ({ added: 0, skipped: 0 });

async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await Bun.sleep(5);
}

describe("server", () => {
  test("serves the page and the jobs API", async () => {
    const h = createHandler({ root: tempRoot(), spawner: fakeSpawner([], []) });
    const page = await get(h, "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
    const data = await (await get(h, "/api/jobs?maxDays=365&minSalary=0")).json();
    expect(data.profile.ready).toBe(true);
    expect(data.ranked.length).toBe(4);
  });

  test("serves bundled fonts with the font mime type", async () => {
    const h = createHandler({ root: tempRoot(), spawner: fakeSpawner([], []) });
    const r = await get(h, "/fonts/dm-sans-latin-400-normal.woff2");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("font/woff2");
    expect(r.headers.get("cache-control")).toBe("public, max-age=86400");
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await get(h, "/fonts/nope.woff2")).status).toBe(404);
  });

  test("font route rejects path traversal and non-woff2 files", async () => {
    const h = createHandler({ root: tempRoot(), spawner: fakeSpawner([], []) });
    for (const p of ["/fonts/..%2f..%2fserver.ts", "/fonts/../server.ts", "/fonts/OFL-DMSans.txt"]) {
      const r = await get(h, p);
      expect(r.status).not.toBe(200);
      expect(await r.text()).not.toContain("createHandler");
    }
  });

  test("rejects foreign Host (DNS rebinding) and foreign Origin on actions", async () => {
    const h = createHandler({ root: tempRoot(), spawner: fakeSpawner([], []) });
    expect((await get(h, "/api/jobs", { Host: "evil.com" })).status).toBe(403);
    const r = await post(h, "/api/run/search", {}, { ...ORIGIN, Origin: "https://evil.com" });
    expect(r.status).toBe(403);
    const noOrigin = await post(h, "/api/run/search", {}, { Host: "127.0.0.1:8787", "Content-Type": "application/json" });
    expect(noOrigin.status).toBe(403);
    const form = await h.handle(new Request(BASE + "/api/run/search", { method: "POST", headers: { ...ORIGIN, "Content-Type": "text/plain" }, body: "{}" }));
    expect(form.status).toBe(400);
  });

  test("file endpoint serves PDFs only from cv/ and cover_letters/", async () => {
    const h = createHandler({ root: tempRoot(), spawner: fakeSpawner([], []) });
    expect((await get(h, "/api/file?path=cv/main_acme.pdf")).status).toBe(200);
    expect((await get(h, "/api/file?path=cv/../job_search_tracker.csv")).status).toBe(404);
    expect((await get(h, "/api/file?path=%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await get(h, "/api/file?path=job_scraper/seen_jobs.json")).status).toBe(404);
  });

  test("apply run: validated URL, argv passed to the spawner, ui-result stored", async () => {
    const calls: string[][] = [];
    const final = JSON.stringify({
      type: "result", is_error: false,
      result: 'ok\n```ui-result\n{"stage":"done","cv_pdf":"cv/main_acme.pdf","cover_pdf":null}\n```',
    });
    const h = createHandler({ root: tempRoot(), spawner: fakeSpawner([final], calls) });
    expect((await post(h, "/api/run/apply", { url: "javascript:alert(1)" })).status).toBe(400);
    const res = await post(h, "/api/run/apply", { url: "https://www.getonbrd.com/jobs/backend-python-acme", feedback: "más\nRust" });
    expect(res.status).toBe(200);
    await waitFor(() => h.runs.current?.status !== "running");
    expect(calls[0][2]).toBe("/apply [ui-mode] https://www.getonbrd.com/jobs/backend-python-acme [feedback] más Rust");
    expect(h.runs.current?.result?.stage).toBe("done");
    expect(h.store.all()["https://www.getonbrd.com/jobs/backend-python-acme"].cv_pdf).toBe("cv/main_acme.pdf");
  });

  test("only one run at a time; search runs /job-scraper then /rank", async () => {
    const calls: string[][] = [];
    let release!: (n: number) => void;
    const slow: Spawner = (argv) => {
      calls.push(argv);
      return { stdout: new Response("").body!, exited: new Promise((r) => (release = r)), kill() {} };
    };
    const h = createHandler({ root: tempRoot(), spawner: slow, sweepSpawn: emptySweep, sweepSave: noSave });
    expect((await post(h, "/api/run/search", {})).status).toBe(200);
    expect((await post(h, "/api/run/apply", { url: "https://a.com/j" })).status).toBe(409);
    await waitFor(() => calls.length === 1);
    release(0);
    await waitFor(() => calls.length === 2);
    release(0);
    await waitFor(() => h.runs.current?.status !== "running");
    expect(calls.map((c) => c[2])).toEqual(["/job-scraper indeed-only days=7", "/rank"]);
  });

  test("search pipeline: sweep first (window from settings), Indeed-only prompt, then rank; stores the coverage summary", async () => {
    const calls: string[][] = [];
    const sweepCalls: string[][] = [];
    const root = tempRoot();
    const h = createHandler({
      root, spawner: fakeSpawner([], calls),
      sweepSpawn: async (argv) => { sweepCalls.push(argv); return { code: 0, stdout: JSON.stringify({ meta: { count: 0, page: 1 }, results: [] }) }; },
      sweepSave: noSave,
    });
    await post(h, "/api/search-settings", { maxDays: 12 });
    expect((await post(h, "/api/run/search", {})).status).toBe(200);
    await waitFor(() => h.runs.current?.status !== "running");
    expect(h.runs.current?.status).toBe("done");
    expect(sweepCalls.length).toBeGreaterThan(50);
    expect(sweepCalls.every((a) => a[a.indexOf("--jobage") + 1] === "12")).toBe(true);
    expect(calls.map((c) => c[2])).toEqual(["/job-scraper indeed-only days=12", "/rank"]);
    const texts = h.runs.current!.events.map((e) => e.text);
    expect(texts.some((t) => /^Revisamos \d+ búsquedas en 5 portales \+ Indeed: 0 vacantes nuevas\.$/.test(t))).toBe(true);
    const settings = await (await get(h, "/api/search-settings")).json();
    expect(settings.lastSweep.calls).toBe(sweepCalls.length);
    expect(settings.lastSweep.coverage).toContain("5 portales + Indeed");
  });

  test("search pipeline keeps going when every portal call fails, and ends as failed", async () => {
    const calls: string[][] = [];
    const h = createHandler({
      root: tempRoot(), spawner: fakeSpawner([], calls),
      sweepSpawn: async () => ({ code: 1, stdout: "" }), sweepSave: noSave,
    });
    await post(h, "/api/run/search", {});
    await waitFor(() => h.runs.current?.status !== "running");
    expect(calls.map((c) => c[2])).toEqual(["/job-scraper indeed-only days=7", "/rank"]);
    expect(h.runs.current?.status).toBe("failed");
  });

  test("rank run: Origin enforced, runs only /rank with the rank tools, respects the lock", async () => {
    const calls: string[][] = [];
    let release!: (n: number) => void;
    const slow: Spawner = (argv) => {
      calls.push(argv);
      return { stdout: new Response("").body!, exited: new Promise((r) => (release = r)), kill() {} };
    };
    const h = createHandler({ root: tempRoot(), spawner: slow });
    expect((await post(h, "/api/run/rank", {}, { ...ORIGIN, Origin: "https://evil.com" })).status).toBe(403);
    expect(calls.length).toBe(0);
    expect((await post(h, "/api/run/rank", {})).status).toBe(200);
    expect((await post(h, "/api/run/rank", {})).status).toBe(409);
    expect((await post(h, "/api/run/search", {})).status).toBe(409);
    await waitFor(() => calls.length === 1);
    release(0);
    await waitFor(() => h.runs.current?.status !== "running");
    expect(calls.length).toBe(1);
    const argv = calls[0];
    expect(argv[0]).toBe("claude");
    expect(argv.slice(1, 3)).toEqual(["-p", "/rank"]);
    const tools = argv.slice(argv.indexOf("--allowedTools") + 1);
    expect(tools).toEqual([...BASE_TOOLS]);
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(h.runs.current?.kind).toBe("rank");
  });

  test("jobs API reports pending and ranked totals regardless of filters", async () => {
    const h = createHandler({ root: tempRoot(), spawner: fakeSpawner([], []) });
    const data = await (await get(h, "/api/jobs?maxDays=0&minSalary=99999999&includeNoSalary=0&includeUndated=0")).json();
    expect(data.ranked.length).toBe(0);
    expect(data.counts.rankedTotal).toBeGreaterThan(0);
    expect(data.counts.pending).toBeGreaterThan(0);
  });

  test("approve marks the drafted tracker row as applied", async () => {
    const root = tempRoot();
    const h = createHandler({ root, spawner: fakeSpawner([], []) });
    const res = await post(h, "/api/applications/approve", { url: "https://www.getonbrd.com/jobs/backend-python-acme" });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, "job_search_tracker.csv"), "utf8")).toContain(",portal,applied,,82,");
    const again = await post(h, "/api/applications/approve", { url: "https://www.getonbrd.com/jobs/backend-python-acme" });
    expect(again.status).toBe(404);
  });

  test("SSE replays a finished run's events", async () => {
    const final = JSON.stringify({ type: "result", is_error: false, result: "done" });
    const h = createHandler({ root: tempRoot(), spawner: fakeSpawner([final], []) });
    const { id } = await (await post(h, "/api/run/search", {})).json();
    await waitFor(() => h.runs.current?.status !== "running");
    const text = await (await get(h, `/api/run/events?id=${id}`)).text();
    expect(text).toContain('"type":"end"');
    expect(text).toContain("/rank");
    expect((await get(h, "/api/run/events?id=nope")).status).toBe(404);
  });
});
