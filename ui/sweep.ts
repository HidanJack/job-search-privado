// Standalone portal sweep (no Claude): bun run ui/sweep.ts [--days N]
// Dry run (no network, writes nothing): bun run ui/sweep.ts --dry-run [--json]
import { resolve } from "node:path";
import { loadSearchSettings } from "./lib/search_settings";
import { formatPlan, planSweep, runConfiguredSweep, runSweep } from "./lib/sweep";

const root = resolve(import.meta.dir, "..");
const i = process.argv.indexOf("--days");
const days = i > 0 ? Number(process.argv[i + 1]) : NaN;
const log = (line: string) => console.log(line);

if (process.argv.includes("--dry-run")) {
  const tasks = planSweep(root);
  console.log(process.argv.includes("--json") ? JSON.stringify(tasks) : formatPlan(tasks));
  process.exit(0);
}

if (Number.isInteger(days) && days >= 1 && days <= 90) {
  log(`Barrido con ventana de ${days} días (sin tocar tus ajustes).`);
  const stats = await runSweep({ root, maxDays: days, log });
  console.log(JSON.stringify({ ...stats, perQuery: stats.perQuery.filter((q) => q.added > 0) }, null, 2));
} else {
  log(`Ventana guardada: ${loadSearchSettings(root).maxDays} días.`);
  const stats = await runConfiguredSweep(root, log);
  console.log(JSON.stringify({ ...stats, perQuery: stats.perQuery.filter((q) => q.added > 0) }, null, 2));
}
