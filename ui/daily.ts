// Unattended run of the same steps as the UI's "Buscar ahora" button, for the
// daily systemd timer. Usage: bun run ui/daily.ts [--rank-only]
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASE_TOOLS, SEARCH_TOOLS, buildArgv, indeedPrompt } from "./lib/runner";
import { loadSearchSettings } from "./lib/search_settings";
import { isStale, sampleAll } from "./lib/skills";
import { runTool } from "./lib/prefilter";
import { countIndeed, finalizeCoverage, runConfiguredSweep } from "./lib/sweep";

const root = resolve(import.meta.dir, "..");
const claudeBin = process.env.CLAUDE_BIN ?? "claude";
const rankOnly = process.argv.includes("--rank-only");

const stateDir = join(root, "ui", "state");
mkdirSync(stateDir, { recursive: true });
const logFile = join(stateDir, `daily-${new Date().toLocaleDateString("sv-SE")}.log`);
const log = (line: string) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

const steps = [
  ...(rankOnly ? [] : [{ prompt: indeedPrompt(loadSearchSettings(root).maxDays), tools: SEARCH_TOOLS }]),
  { prompt: "/rank", tools: BASE_TOOLS },
];

let failed = false;
let indeedBefore = 0;
// 1) Deterministic portal sweep (no Claude). A failure never blocks the Claude steps.
if (!rankOnly) {
  log("START sweep");
  indeedBefore = countIndeed(root);
  try {
    const stats = await runConfiguredSweep(root, log);
    const total = stats.calls > 0 && stats.failures === stats.calls;
    log(`END sweep exit=${total || stats.saveErrors > 0 ? 1 : 0}`);
    if (total || stats.saveErrors > 0) failed = true;
  } catch (err) {
    log(`END sweep exit=1 ${(err as Error).message}`);
    failed = true;
  }
}
// 2) Indeed (MCP, LLM) and 3) /rank, with the deterministic prefilter in front
// of /rank (it only scores the top rankBatch) and opportunity/risk after it.
for (const step of steps) {
  if (step.prompt === "/rank") {
    log("RUN prefilter");
    const ok = await runTool(root, "prefilter", log);
    log(`DONE prefilter ok=${ok}`); // not "END": the dashboard reads the last END line as the run result
  }
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
  log(`END ${step.prompt.split(" ")[0]} exit=${code}`);
  if (code !== 0) failed = true;
  if (!rankOnly && step.prompt.startsWith("/job-scraper")) finalizeCoverage(root, indeedBefore, log);
  if (step.prompt === "/rank") {
    log("RUN opportunity");
    const ok = await runTool(root, "opportunity", log);
    log(`DONE opportunity ok=${ok}`);
  }
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
