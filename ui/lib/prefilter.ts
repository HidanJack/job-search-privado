import { existsSync } from "node:fs";
import { join } from "node:path";
import { bunSweepSpawn, type SweepSpawn } from "./sweep";

/**
 * LLM-free Python steps around /rank: the prefilter that discards clearly
 * off-target postings before ranking, and the opportunity/risk refresh after.
 * A missing script (e.g. a stripped checkout) skips the step instead of failing the run.
 */
export type ToolName = "prefilter" | "opportunity";

export const toolArgv = (tool: ToolName): string[] =>
  tool === "prefilter"
    ? ["python3", "tools/prefilter.py", "run", "--write"]
    : ["python3", "tools/opportunity.py", "recompute", "--write"];

export async function runTool(
  root: string, tool: ToolName, log: (line: string) => void, spawn: SweepSpawn = bunSweepSpawn,
): Promise<boolean> {
  if (!existsSync(join(root, "tools", `${tool}.py`))) {
    log(`Omitido: no se encontró tools/${tool}.py.`);
    return true;
  }
  const label = tool === "prefilter" ? "Prefiltro" : "Oportunidad y riesgo";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const { code, stdout } = await spawn(toolArgv(tool), root, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (code !== 0) {
      log(`${label}: terminó con error (código ${code}).`);
      return false;
    }
    log(`${label}: ${stdout.trim().split("\n").at(-1) ?? "listo"}`);
    return true;
  } catch (err) {
    log(`${label}: ${(err as Error).message}`);
    return false;
  }
}
