// Standalone portal sweep (no Claude): bun run ui/sweep.ts [--days N]
import { resolve } from "node:path";
import { loadSearchSettings } from "./lib/search_settings";
import { runConfiguredSweep, runSweep } from "./lib/sweep";

const root = resolve(import.meta.dir, "..");
const i = process.argv.indexOf("--days");
const days = i > 0 ? Number(process.argv[i + 1]) : NaN;
const log = (line: string) => console.log(line);

if (Number.isInteger(days) && days >= 1 && days <= 90) {
  log(`Barrido con ventana de ${days} días (sin tocar tus ajustes).`);
  const stats = await runSweep({ root, maxDays: days, log });
  console.log(JSON.stringify({ ...stats, perQuery: stats.perQuery.filter((q) => q.added > 0) }, null, 2));
} else {
  log(`Ventana guardada: ${loadSearchSettings(root).maxDays} días.`);
  const stats = await runConfiguredSweep(root, log);
  console.log(JSON.stringify({ ...stats, perQuery: stats.perQuery.filter((q) => q.added > 0) }, null, 2));
}
