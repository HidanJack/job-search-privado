// Unattended run of the same steps as the UI's "Buscar ahora" button, for the
// daily systemd timer. Usage: bun run ui/daily.ts [--rank-only]
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASE_TOOLS, SEARCH_TOOLS, buildArgv } from "./lib/runner";
import { isStale, sampleAll } from "./lib/skills";

const root = resolve(import.meta.dir, "..");
const claudeBin = process.env.CLAUDE_BIN ?? "claude";
const rankOnly = process.argv.includes("--rank-only");

const stateDir = join(root, "ui", "state");
mkdirSync(stateDir, { recursive: true });
const logFile = join(stateDir, `daily-${new Date().toLocaleDateString("sv-SE")}.log`);
const log = (line: string) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

const steps = [
  ...(rankOnly ? [] : [{ prompt: "/job-scraper", tools: SEARCH_TOOLS }]),
  { prompt: "/rank", tools: BASE_TOOLS },
];

let failed = false;
for (const step of steps) {
  log(`START ${step.prompt}`);
  const proc = Bun.spawn(buildArgv(claudeBin, step.prompt, step.tools), {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  appendFileSync(logFile, out);
  if (err) appendFileSync(logFile, `STDERR ${err}\n`);
  log(`END ${step.prompt} exit=${code}`);
  if (code !== 0) failed = true;
}
// Market salaries by skill: refresh only when the aggregate is missing or older than 15 days.
// A failure here never fails the daily run (it only costs a stale chart).
if (isStale(root)) {
  log("START skill_sampler");
  try {
    const { aggregate, calls } = await sampleAll({ root });
    log(`END skill_sampler exit=0 used=${aggregate.totals.used_with_salary} failed_calls=${calls.filter((c) => c.error).length}`);
  } catch (err) {
    log(`END skill_sampler exit=1 ${(err as Error).message}`);
  }
} else {
  log("SKIP skill_sampler (aggregate is fresh)");
}
process.exit(failed ? 1 : 0);
