import { afterEach, describe, expect, test } from "bun:test";
import { runSearch } from "../src/commands/search";
import { runDetail } from "../src/commands/detail";
import { fixMojibake, isJob, normalizeId, toResult, type RokJob } from "../src/helpers";
import { CONTRACT_KEYS, baseOpts, capture, emptyFlags, fixture, mockFetch, requested, restore } from "./harness";

const api = fixture<RokJob[]>("api.json");
const jobs = api.filter(isJob);

afterEach(restore);

describe("Remote OK mapping", () => {
  test("the leading legal notice is not a job", () => {
    expect(isJob(api[0])).toBe(false);
    expect(jobs.length).toBe(api.length - 1);
  });

  test("results carry every contract key and link to Remote OK", () => {
    for (const job of jobs) {
      const r = toResult(job) as unknown as Record<string, unknown>;
      for (const k of CONTRACT_KEYS) expect(k in r).toBe(true);
      for (const k of ["salary_min", "salary_max", "salary_currency", "salary_period"]) expect(k in r).toBe(true);
      expect(String(r.url).toLowerCase()).toStartWith("https://remoteok.com/remote-jobs/");
    }
  });

  test("empty location becomes null, never an empty string", () => {
    const blank = jobs.find((j) => !j.location)!;
    expect(toResult(blank).location).toBeNull();
  });

  test("mojibake from upstream double-decoding is repaired", () => {
    expect(fixMojibake("UtopiaÂ is")).toBe("Utopia is");
    expect(fixMojibake("cafÃ©")).toBe("café");
    expect(fixMojibake("plain text")).toBe("plain text");
  });

  test("normalizeId pulls the numeric id from ids, slugs and URLs", () => {
    expect(normalizeId("1137514")).toBe("1137514");
    expect(normalizeId("remote-payment-operations-specialist-utopia-1137514")).toBe("1137514");
    expect(normalizeId("https://remoteOK.com/remote-jobs/remote-payment-operations-specialist-utopia-1137514")).toBe("1137514");
    expect(normalizeId("no-id-here")).toBeNull();
  });
});

describe("Remote OK commands", () => {
  test("a single-word query is also sent as a tag", async () => {
    mockFetch(() => api);
    capture();
    await runSearch({ ...baseOpts, query: "python" }, emptyFlags());
    restore();
    expect(new URL(requested[0]).searchParams.get("tags")).toBe("python");
  });

  test("--latam drops jobs restricted to other places and keeps unspecified ones", async () => {
    mockFetch(() => api);
    const io = capture();
    await runSearch({ ...baseOpts, latam: true }, emptyFlags());
    restore();
    const locs = JSON.parse(io.out()).results.map((r: { location: string | null }) => r.location);
    expect(locs).toContain(null);
    expect(locs).not.toContain("Sterling Heights, Michigan");
  });

  test("pagination is applied after filtering and total reports the filtered count", async () => {
    mockFetch(() => api);
    const io = capture();
    await runSearch({ ...baseOpts, page: 2, limit: 2 }, emptyFlags());
    restore();
    const out = JSON.parse(io.out());
    expect(out.meta.total).toBe(jobs.length);
    expect(out.results.map((r: { id: string }) => r.id)).toEqual(jobs.slice(2, 4).map((j) => String(j.id)));
  });

  test("detail finds a job in the feed by URL", async () => {
    mockFetch(() => api);
    const io = capture();
    const code = await runDetail(jobs[0].url!, "json");
    restore();
    expect(code).toBe(0);
    const job = JSON.parse(io.out());
    expect(job.id).toBe(String(jobs[0].id));
    expect(job.apply_url).toBeTruthy();
  });

  test("detail NOT_FOUND for an id outside the feed", async () => {
    mockFetch(() => api);
    const io = capture();
    const code = await runDetail("9999999", "json");
    restore();
    expect(code).toBe(1);
    expect(JSON.parse(io.err()).code).toBe("NOT_FOUND");
  });
});
