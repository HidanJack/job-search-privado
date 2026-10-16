import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DAILY_UNIT = "job-search-daily.timer";

/** Runs a fixed argv; resolves null when the binary is missing. */
export type CommandRunner = (argv: string[]) => Promise<{ code: number; stdout: string } | null>;

export const bunCommandRunner: CommandRunner = async (argv) => {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  } catch {
    return null;
  }
};

export const isEnabledArgv = () => ["systemctl", "--user", "is-enabled", DAILY_UNIT];
export const showArgv = () => [
  "systemctl", "--user", "show", DAILY_UNIT, "--property=NextElapseUSecRealtime,LastTriggerUSec",
];
export const toggleArgv = (enabled: boolean) => [
  "systemctl", "--user", enabled ? "enable" : "disable", "--now", DAILY_UNIT,
];

/**
 * systemctl prints timestamps as "Fri 2026-10-16 09:00:00 CST" in the
 * machine's local zone; the server runs on that same machine, so the
 * date/time part is read as local time and the zone label is ignored.
 */
export function parseSystemdTime(value: string | undefined): string | null {
  const m = value?.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

export function parseShow(stdout: string): { nextRun: string | null; lastRun: string | null } {
  const props: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return {
    nextRun: parseSystemdTime(props.NextElapseUSecRealtime),
    lastRun: parseSystemdTime(props.LastTriggerUSec),
  };
}

export interface LastResult {
  file: string;
  ok: boolean;
  step: string;
  exitCode: number;
}

/** Last "END <step> exit=N" line of the newest daily log, if any. */
export function readLastResult(root: string): LastResult | null {
  const dir = join(root, "ui", "state");
  if (!existsSync(dir)) return null;
  const logs = readdirSync(dir).filter((f) => /^daily-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  const file = logs.at(-1);
  if (!file) return null;
  const ends = readFileSync(join(dir, file), "utf8").split("\n").filter((l) => / END \S+ exit=-?\d+$/.test(l));
  const last = ends.at(-1);
  if (!last) return null;
  const [, step, code] = last.match(/ END (\S+) exit=(-?\d+)$/)!;
  return { file, ok: Number(code) === 0, step, exitCode: Number(code) };
}

export interface DailyStatus {
  available: boolean;
  enabled?: boolean;
  nextRun?: string | null;
  lastRun?: string | null;
  lastResult?: LastResult | null;
}

export async function getDailyStatus(root: string, run: CommandRunner): Promise<DailyStatus> {
  const enabled = await run(isEnabledArgv());
  if (enabled === null) return { available: false };
  const show = await run(showArgv());
  const times = show && show.code === 0 ? parseShow(show.stdout) : { nextRun: null, lastRun: null };
  return {
    available: true,
    enabled: enabled.code === 0 && enabled.stdout.trim() === "enabled",
    ...times,
    lastResult: readLastResult(root),
  };
}

export async function setDaily(enabled: boolean, run: CommandRunner): Promise<boolean | null> {
  const result = await run(toggleArgv(enabled));
  return result === null ? null : result.code === 0;
}
