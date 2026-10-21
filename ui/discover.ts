// Market check for the career paths /discover proposed, without the dashboard and without Claude:
//   bun run ui/discover.ts probe [--root DIR]     real portal calls (one page each), writes ui/state/discovery/market.json
//   bun run ui/discover.ts plan  [--root DIR]     prints the portal/query plan, no network
import { resolve } from "node:path";
import { MAX_PROBE_PATHS, PROBE_PORTALS, discoveryDir, newDiscoveryState, pickQueries, readProposals, runProbe } from "./lib/discovery";

const args = process.argv.slice(2);
const cmd = args[0];
const rootFlag = args.indexOf("--root");
const root = resolve(rootFlag >= 0 && args[rootFlag + 1] ? args[rootFlag + 1] : resolve(import.meta.dir, ".."));

if (cmd === "plan") {
  const { paths } = readProposals(root);
  for (const p of paths.slice(0, MAX_PROBE_PATHS)) {
    for (const q of pickQueries(p.search_queries)) console.log(`${p.id} | ${PROBE_PORTALS.join(",")} | ${q.text}`);
  }
  console.log(`Plan: ${Math.min(paths.length, MAX_PROBE_PATHS)} caminos. No se hizo ninguna consulta.`);
} else if (cmd === "probe") {
  const ok = await runProbe(root, newDiscoveryState(), (l) => console.log(l));
  console.log(ok ? `Listo: ${discoveryDir(root)}/market.json` : "Todas las consultas fallaron.");
  process.exit(ok ? 0 : 1);
} else {
  console.error("Uso: bun run ui/discover.ts probe|plan [--root DIR]");
  process.exit(2);
}
