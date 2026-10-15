import { afterEach, describe, expect, test } from "bun:test";
import { runSearch } from "../src/commands/search";
import { runDetail } from "../src/commands/detail";
import { normalizeId, slugTag, toResult, type JobicyEnvelope } from "../src/helpers";
import { CONTRACT_KEYS, baseOpts, capture, emptyFlags, fixture, mockFetch, requested, restore } from "./harness";

const page = fixture<JobicyEnvelope>("search.json");
const jobs = page.jobs!;

afterEach(restore);

describe("Jobicy mapping", () => {
  test("results carry every contract key and keep the original job URL", () => {
    for (const job of jobs) {
      const r = toResult(job) as unknown as Record<string, unknown>;
      for (const k of CONTRACT_KEYS) expect(k in r).toBe(true);
      expect(r.url).toBe(job.url);
    }
  });

  test("id is the slug so detail can search its title words", () => {
    expect(toResult(jobs[0]).id).toBe(jobs[0].jobSlug!);
    expect(normalizeId("155385-ai-platform-engineer")).toBe("155385");
    expect(normalizeId("https://jobicy.com/jobs/155385-ai-platform-engineer")).toBe("155385");
    expect(normalizeId("155385")).toBe("155385");
    expect(slugTag("155385-ai-platform-engineer")).toBe("ai platform engineer");
  });

  test("location squeezes the API's double spaces", () => {
    const multi = jobs.find((j) => (j.jobGeo ?? "").includes(","))!;
    expect(toResult(multi).location).not.toContain("  ");
  });
});

describe("Jobicy commands", () => {
  test("query maps to tag; geo and industry pass through server-side", async () => {
    mockFetch(() => page);
    capture();
    await runSearch({ ...baseOpts, query: "python", limit: 10 }, emptyFlags({ geo: "LATAM", industry: "dev" }));
    restore();
    const p = new URL(requested[0]).searchParams;
    expect(p.get("tag")).toBe("python");
    expect(p.get("geo")).toBe("latam");
    expect(p.get("industry")).toBe("dev");
    expect(p.get("count")).toBe("10");
  });

  test("page 2 follows the cursor from page 1", async () => {
    mockFetch(() => page);
    capture();
    await runSearch({ ...baseOpts, page: 2 }, emptyFlags());
    restore();
    expect(requested).toHaveLength(2);
    expect(new URL(requested[1]).searchParams.get("cursor")).toBe(page.nextCursor!);
  });

  test("--latam keeps Anywhere and drops Europe-only roles", async () => {
    mockFetch(() => page);
    const io = capture();
    await runSearch({ ...baseOpts, latam: true }, emptyFlags());
    restore();
    const locs = JSON.parse(io.out()).results.map((r: { location: string }) => r.location);
    expect(locs).toContain("Anywhere");
    expect(locs.some((l: string) => l.includes("Poland"))).toBe(false);
  });

  test("an API success:false is reported as SEARCH_FAILED", async () => {
    mockFetch(() => ({ success: false, error: "Invalid 'geo' value" }));
    const io = capture();
    const code = await runSearch({ ...baseOpts }, emptyFlags({ geo: "narnia" }));
    restore();
    expect(code).toBe(1);
    expect(JSON.parse(io.err()).error).toContain("Invalid 'geo' value");
  });

  test("detail searches the slug's words first and returns the description", async () => {
    mockFetch(() => page);
    const io = capture();
    const code = await runDetail(jobs[0].url, "json");
    restore();
    expect(code).toBe(0);
    expect(new URL(requested[0]).searchParams.get("tag")).toBe(slugTag(jobs[0].url));
    expect(JSON.parse(io.out()).description).toBeTruthy();
  });
});
