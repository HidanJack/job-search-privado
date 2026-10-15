import { afterEach, describe, expect, test } from "bun:test";
import { runSearch } from "../src/commands/search";
import { runDetail } from "../src/commands/detail";
import { himAcceptsLatam, himId, normalizeId, toResult, type HimEnvelope } from "../src/helpers";
import { CONTRACT_KEYS, baseOpts, capture, emptyFlags, fixture, mockFetch, requested, restore } from "./harness";

const search = fixture<HimEnvelope>("search.json");
const [worldwide, mexico, restricted] = search.jobs;

afterEach(restore);

describe("Himalayas mapping", () => {
  test("results carry every contract key", () => {
    for (const job of search.jobs) {
      const r = toResult(job) as unknown as Record<string, unknown>;
      for (const k of CONTRACT_KEYS) expect(k in r).toBe(true);
      expect(r.remote).toBe(true);
    }
  });

  test("id is company/slug taken from the job URL", () => {
    expect(himId("https://himalayas.app/companies/acme/jobs/python-dev")).toBe("acme/python-dev");
    expect(normalizeId("https://himalayas.app/companies/acme/jobs/python-dev")).toBe("acme/python-dev");
    expect(normalizeId("acme/python-dev")).toBe("acme/python-dev");
    expect(normalizeId("not an id")).toBeNull();
  });

  test("location lists hiring countries, or worldwide when unrestricted", () => {
    expect(toResult(worldwide).location).toBe("Remote (worldwide)");
    expect(toResult(mexico).location).toBe("Remote (Mexico, Colombia)");
  });

  test("latam filter keeps unrestricted and Mexico-listed jobs only", () => {
    expect(himAcceptsLatam(worldwide)).toBe(true);
    expect(himAcceptsLatam(mexico)).toBe(true);
    expect(himAcceptsLatam(restricted)).toBe(restricted.locationRestrictions?.some((c) => /mexico/i.test(c)) ?? true);
  });
});

describe("Himalayas commands", () => {
  test("a query uses the search endpoint; limit slices the 20-per-page window", async () => {
    mockFetch(() => search);
    const io = capture();
    const code = await runSearch({ ...baseOpts, query: "python", limit: 3 }, emptyFlags({ country: "Mexico" }));
    restore();
    expect(code).toBe(0);
    const url = new URL(requested[0]);
    expect(url.pathname).toBe("/jobs/api/search");
    expect(url.searchParams.get("q")).toBe("python");
    expect(url.searchParams.get("country")).toBe("Mexico");
    const out = JSON.parse(io.out());
    expect(out.results).toHaveLength(3);
    expect(out.meta.total).toBe(5000);
  });

  test("no query pages the feed by cursor, never by offset", async () => {
    let n = 0;
    mockFetch(() => ({ ...search, nextCursor: `c${++n}` }));
    capture();
    await runSearch({ ...baseOpts, page: 2, limit: 5 }, emptyFlags());
    restore();
    expect(requested).toHaveLength(2);
    expect(new URL(requested[1]).searchParams.get("cursor")).toBe("c1");
    expect(requested.some((u) => u.includes("offset="))).toBe(false);
  });

  test("--latam filters the window", async () => {
    mockFetch(() => search);
    const io = capture();
    await runSearch({ ...baseOpts, query: "python", latam: true }, emptyFlags());
    restore();
    const ids = JSON.parse(io.out()).results.map((r: { id: string }) => r.id);
    expect(ids).toContain(himId(worldwide.guid));
    expect(ids).toContain(himId(mexico.guid));
  });

  test("detail matches the exact job URL from search results", async () => {
    mockFetch(() => search);
    const io = capture();
    const code = await runDetail(himId(mexico.guid)!, "json");
    restore();
    expect(code).toBe(0);
    expect(JSON.parse(io.out()).url).toBe(mexico.guid);
  });

  test("detail NOT_FOUND when search never returns the id", async () => {
    mockFetch(() => ({ ...search, jobs: [] }));
    const io = capture();
    const code = await runDetail("ghost/no-such-job", "json");
    restore();
    expect(code).toBe(1);
    expect(JSON.parse(io.err()).code).toBe("NOT_FOUND");
  });
});
