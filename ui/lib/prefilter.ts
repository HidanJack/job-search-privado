import { existsSync } from "node:fs";
import { join } from "node:path";
import { bunSweepSpawn, type SweepSpawn } from "./sweep";

/**
 * LLM-free Python steps around /rank: the prefilter that discards clearly
 * off-target postings before ranking, and the opportunity/risk refresh after.
 * A missing script (e.g. a stripped checkout) skips the step instead of failing the run.
 */
export type ToolName = "prefilter" | "opportunity" | "learned";

export const toolArgv = (tool: ToolName): string[] =>
  tool === "prefilter"
    ? ["python3", "tools/prefilter.py", "run", "--write"]
    : tool === "learned"
      ? ["python3", "tools/learned_score.py", "train"]
      : ["python3", "tools/opportunity.py", "recompute", "--write"];

interface Cv { spearman?: number; auc?: number; p10?: number; p25?: number }

const cvText = (name: string, m?: Cv) =>
  m ? `${name} spearman=${m.spearman} auc=${m.auc} p10=${m.p10} p25=${m.p25}` : null;

/** One log line for the learned-model training summary (labels, CV metrics); null if unparseable. */
export function learnedLine(stdout: string): string | null {
  try {
    const s = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
    const parts = [cvText("heurística", s.cv?.hand_full), cvText("blend", s.cv?.blend), cvText("aprendido", s.cv?.learned)].filter(Boolean);
    return `Modelo aprendido: ${s.labels} etiquetas (${s.good} buenas), ${s.active ? "activo" : "inactivo (pocas etiquetas)"}` +
      (parts.length ? ` · validación cruzada: ${parts.join(" | ")}` : "");
  } catch {
    return null;
  }
}

export async function runTool(
  root: string, tool: ToolName, log: (line: string) => void, spawn: SweepSpawn = bunSweepSpawn,
): Promise<boolean> {
  const script = tool === "learned" ? "learned_score" : tool;
  if (!existsSync(join(root, "tools", `${script}.py`))) {
    log(`Omitido: no se encontró tools/${script}.py.`);
    return true;
  }
  const label = tool === "prefilter" ? "Prefiltro" : tool === "learned" ? "Modelo aprendido" : "Oportunidad y riesgo";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tool === "learned" ? 180_000 : 60_000);
    const { code, stdout } = await spawn(toolArgv(tool), root, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (code !== 0) {
      log(`${label}: terminó con error (código ${code}).`);
      return false;
    }
    log((tool === "learned" ? learnedLine(stdout) : null) ?? `${label}: ${stdout.trim().split("\n").at(-1) ?? "listo"}`);
    return true;
  } catch (err) {
    log(`${label}: ${(err as Error).message}`);
    return false;
  }
}
