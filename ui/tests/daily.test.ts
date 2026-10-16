import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../server";
import {
  DAILY_UNIT, type CommandRunner, getDailyStatus, parseShow, parseSystemdTime, readLastResult, toggleArgv,
} from "../lib/daily";

const BASE = "http://127.0.0.1:8787";
const ORIGIN = { Origin: BASE, Host: "127.0.0.1:8787", "Content-Type": "application/json" };
const SHOW = "NextElapseUSecRealtime=Fri 2026-10-16 09:00:00 CST\nLastTriggerUSec=\n";

function fakeSystemctl(calls: string[][], enabled = "enabled"): CommandRunner {
  return async (argv) => {
    calls.push(argv);
    if (argv[2] === "is-enabled") return { code: enabled === "enabled" ? 0 : 1, stdout: `${enabled}\n` };
    if (argv[2] === "show") return { code: 0, stdout: SHOW };
    return { code: 0, stdout: "" };
  };
}

const missing: CommandRunner = async () => null;

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "job-ui-daily-"));
}

const post = (h: ReturnType<typeof createHandler>, body: unknown, headers: Record<string, string> = ORIGIN) =>
  h.handle(new Request(`${BASE}/api/daily`, { method: "POST", headers, body: JSON.stringify(body) }));

describe("systemctl parsing", () => {
  test("reads local timestamps and ignores the zone label", () => {
    const iso = parseSystemdTime("Fri 2026-10-16 09:00:00 CST")!;
    const d = new Date(iso);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 16, 9, 0]);
  });

  test("empty or n/a timestamps are null", () => {
    expect(parseSystemdTime("")).toBeNull();
    expect(parseSystemdTime("n/a")).toBeNull();
    expect(parseShow(SHOW).lastRun).toBeNull();
    expect(parseShow(SHOW).nextRun).not.toBeNull();
  });
});

describe("daily status", () => {
  test("enabled timer with next run", async () => {
    const calls: string[][] = [];
    const s = await getDailyStatus(tempRoot(), fakeSystemctl(calls));
    expect(s.available).toBe(true);
    expect(s.enabled).toBe(true);
    expect(s.nextRun).not.toBeNull();
    expect(calls[0]).toEqual(["systemctl", "--user", "is-enabled", DAILY_UNIT]);
  });

  test("disabled timer", async () => {
    const s = await getDailyStatus(tempRoot(), fakeSystemctl([], "disabled"));
    expect(s.enabled).toBe(false);
  });

  test("systemctl missing reports unavailable", async () => {
    expect(await getDailyStatus(tempRoot(), missing)).toEqual({ available: false });
  });

  test("last result comes from the newest daily log", () => {
    const root = tempRoot();
    mkdirSync(join(root, "ui", "state"), { recursive: true });
    writeFileSync(join(root, "ui", "state", "daily-2026-10-15.log"), "x END /rank exit=0\n");
    writeFileSync(
      join(root, "ui", "state", "daily-2026-10-16.log"),
      "x START /job-scraper\n{\"type\":\"result\"}\nx END /job-scraper exit=0\nx END /rank exit=1\n",
    );
    expect(readLastResult(root)).toEqual({ file: "daily-2026-10-16.log", ok: false, step: "/rank", exitCode: 1 });
  });
});

describe("POST /api/daily", () => {
  test("argv is fixed for enable and disable", () => {
    expect(toggleArgv(true)).toEqual(["systemctl", "--user", "enable", "--now", DAILY_UNIT]);
    expect(toggleArgv(false)).toEqual(["systemctl", "--user", "disable", "--now", DAILY_UNIT]);
  });

  test("toggles through the injected runner", async () => {
    const calls: string[][] = [];
    const h = createHandler({ root: tempRoot(), commandRunner: fakeSystemctl(calls) });
    const res = await post(h, { enabled: false });
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual(["systemctl", "--user", "disable", "--now", DAILY_UNIT]);
  });

  test("rejects a foreign Origin without running anything", async () => {
    const calls: string[][] = [];
    const h = createHandler({ root: tempRoot(), commandRunner: fakeSystemctl(calls) });
    const res = await post(h, { enabled: true }, { ...ORIGIN, Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("rejects non-boolean payloads", async () => {
    const calls: string[][] = [];
    const h = createHandler({ root: tempRoot(), commandRunner: fakeSystemctl(calls) });
    for (const body of [{ enabled: "true" }, { enabled: 1 }, {}, { enabled: "--now; rm -rf" }]) {
      expect((await post(h, body)).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  test("systemctl missing returns 503", async () => {
    const h = createHandler({ root: tempRoot(), commandRunner: missing });
    expect((await post(h, { enabled: true })).status).toBe(503);
  });
});
