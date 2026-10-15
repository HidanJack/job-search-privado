import { afterEach, describe, expect, test } from "bun:test";
import { runSearch } from "../src/commands/search";
import { runDetail } from "../src/commands/detail";
import { gobAcceptsLatam, normalizeId, slugQuery, toResult, type GobEnvelope } from "../src/helpers";
import { CONTRACT_KEYS, baseOpts, capture, emptyFlags, fixture, mockFetch, requested, restore } from "./harness";

const search = fixture<GobEnvelope>("search.json");
const byModality = (m: string) => search.data.find((j) => j.attributes.remote_modality === m)!;

afterEach(restore);

describe("GetOnBoard mapping", () => {
  test("results carry every contract key, never omitted", () => {
    for (const job of search.data) {
      const r = toResult(job) as unknown as Record<string, unknown>;
      for (const k of CONTRACT_KEYS) expect(k in r).toBe(true);
      expect(typeof r.title).toBe("string");
      expect(String(r.url)).toStartWith("https://www.getonbrd.com/jobs/");
    }
  });

  test("company name comes from the expanded company relationship", () => {
    expect(toResult(byModality("fully_remote")).company).toBeTruthy();
  });

  test("location describes the remote modality", () => {
    expect(toResult(byModality("fully_remote")).location).toBe("Remote (anywhere)");
    expect(toResult(byModality("no_remote")).location).toContain("(on-site)");
    expect(toResult(byModality("hybrid")).location).toContain("Mexico");
  });

  test("salary is USD per month", () => {
    const withSalary = search.data.map(toResult).find((r) => r.salary);
    expect(withSalary?.salary).toMatch(/^USD \d+.*\/month$/);
  });

  test("latam filter: fully remote or Mexico listed; remote_local elsewhere is excluded", () => {
    expect(gobAcceptsLatam(byModality("fully_remote").attributes)).toBe(true);
    expect(gobAcceptsLatam(byModality("hybrid").attributes)).toBe(true);
    expect(gobAcceptsLatam(byModality("remote_local").attributes)).toBe(false);
    expect(gobAcceptsLatam(byModality("no_remote").attributes)).toBe(false);
  });

  test("normalizeId accepts ids and getonbrd URLs only", () => {
    expect(normalizeId("backend-dev-acme-remote-1a2b")).toBe("backend-dev-acme-remote-1a2b");
    expect(normalizeId("https://www.getonbrd.com/jobs/programming/backend-dev-acme-remote-1a2b")).toBe("backend-dev-acme-remote-1a2b");
    expect(normalizeId("https://evil.example/jobs/x")).toBeNull();
    expect(slugQuery("semi-senior-java-developer-etl-23people-remote-ebb4")).toBe("semi senior java developer etl 23people");
  });
});

describe("GetOnBoard commands", () => {
  test("search requests the search endpoint with company expansion and emits {meta, results}", async () => {
    mockFetch(() => search);
    const io = capture();
    const code = await runSearch({ ...baseOpts, query: "python" }, emptyFlags({ country: "mx" }));
    restore();
    expect(code).toBe(0);
    const url = new URL(requested[0]);
    expect(url.pathname).toBe("/api/v0/search/jobs");
    expect(url.searchParams.get("query")).toBe("python");
    expect(url.searchParams.get("country_code")).toBe("MX");
    expect(url.searchParams.get("expand")).toBe('["company"]');
    const out = JSON.parse(io.out());
    expect(out.meta.count).toBe(search.data.length);
    expect(out.results).toHaveLength(search.data.length);
  });

  test("--latam drops postings not open to a Mexico-based candidate", async () => {
    mockFetch(() => search);
    const io = capture();
    await runSearch({ ...baseOpts, query: "python", latam: true }, emptyFlags());
    restore();
    const ids = JSON.parse(io.out()).results.map((r: { id: string }) => r.id);
    expect(ids).toContain(byModality("fully_remote").id);
    expect(ids).not.toContain(byModality("remote_local").id);
  });

  test("--category browses the category endpoint", async () => {
    mockFetch(() => search);
    capture();
    await runSearch({ ...baseOpts }, emptyFlags({ category: "programming" }));
    restore();
    expect(new URL(requested[0]).pathname).toBe("/api/v0/categories/programming/jobs");
  });

  test("no query, country, remote or category is a BAD_ARG without any request", async () => {
    mockFetch(() => search);
    const io = capture();
    const code = await runSearch({ ...baseOpts }, emptyFlags());
    restore();
    expect(code).toBe(1);
    expect(JSON.parse(io.err()).code).toBe("BAD_ARG");
    expect(requested).toHaveLength(0);
  });

  test("detail finds the exact id via search and returns the stitched description", async () => {
    const target = byModality("fully_remote");
    mockFetch(() => search);
    const io = capture();
    const code = await runDetail(target.id, "json");
    restore();
    expect(code).toBe(0);
    const job = JSON.parse(io.out());
    expect(job.id).toBe(target.id);
    expect(job.description).toContain("## ");
  });

  test("detail reports NOT_FOUND when no search page has the id", async () => {
    mockFetch(() => ({ data: [], meta: { page: 1, per_page: 100, total_pages: 1 } }));
    const io = capture();
    const code = await runDetail("ghost-role-nowhere-ffff", "json");
    restore();
    expect(code).toBe(1);
    expect(JSON.parse(io.err()).code).toBe("NOT_FOUND");
  });
});
