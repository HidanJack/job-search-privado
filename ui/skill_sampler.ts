// Samples salaries per skill from the portal CLIs (no Claude, no network
// except what the CLIs do). Usage: bun run ui/skill_sampler.ts
import { resolve } from "node:path";
import { aggregatePath, GROUPS, sampleAll } from "./lib/skills";

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const { aggregate, rawPath, calls } = await sampleAll({ root, log: (l) => console.error(l) });
  const failed = calls.filter((c) => c.error).length;
  console.log(`Calls: ${calls.length} (${failed} failed). Raw: ${rawPath}`);
  console.log(`Aggregate: ${aggregatePath(root)}  FX: ${JSON.stringify(aggregate.fx)} (${aggregate.fx_source})`);
  console.log(`Unique: ${aggregate.totals.unique_jobs}, relevant: ${aggregate.totals.relevant_jobs}, used: ${aggregate.totals.used_with_salary}`);
  console.log(`Discards: ${JSON.stringify(aggregate.discards)}`);
  console.log("skill | group | n | median MXN/month");
  for (const row of [...aggregate.skills, aggregate.combo]) {
    for (const g of GROUPS) {
      const s = row.groups[g];
      console.log(`${row.label} | ${g} | ${s.n} | ${s.median === null ? `insufficient${s.n ? ` (${s.min}-${s.max})` : ""}` : s.median}`);
    }
  }
}
