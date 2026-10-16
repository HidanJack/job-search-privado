import { afterEach, describe, expect, test } from "bun:test";
import {
  acceptsLatam,
  cleanHtml,
  decodeEntities,
  formatSalary,
  formatSalaryFields,
  getJson,
  matchesLocation,
  matchesQuery,
  paginate,
  toIsoDate,
  withinDays,
} from "../src/helpers";
import { runCLI } from "./helpers";

// Network-free: every CLI case below fails validation before any request is made.

function err(stderr: string): { error?: string; code?: string } {
  try {
    return JSON.parse(stderr);
  } catch {
    return {};
  }
}

describe("CLI flag validation", () => {
  test("no command prints help and exits 1", async () => {
    const r = await runCLI([]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("USAGE");
  });

  test("unknown command exits 1 with BAD_CMD", async () => {
    const r = await runCLI(["frobnicate"]);
    expect(r.exitCode).toBe(1);
    expect(err(r.stderr).code).toBe("BAD_CMD");
  });

  test("unknown flag exits 1 with UNKNOWN_FLAG instead of being dropped", async () => {
    const r = await runCLI(["search", "-q", "python", "--bogus", "x"]);
    expect(r.exitCode).toBe(1);
    expect(err(r.stderr).code).toBe("UNKNOWN_FLAG");
  });

  test("bad --format exits 1 with BAD_ARG", async () => {
    const r = await runCLI(["search", "-q", "python", "--format", "xml"]);
    expect(r.exitCode).toBe(1);
    expect(err(r.stderr).code).toBe("BAD_ARG");
  });

  for (const name of ["jobage", "page", "limit"]) {
    for (const bad of ["foo", "1.5", "0"]) {
      test(`--${name} ${bad} exits 1 with BAD_ARG`, async () => {
        const r = await runCLI(["search", "-q", "python", `--${name}`, bad]);
        expect(r.exitCode).toBe(1);
        expect(err(r.stderr).code).toBe("BAD_ARG");
        expect(err(r.stderr).error).toContain(name);
      });
    }
  }

  test("detail without an id exits 1 with NO_ID", async () => {
    const r = await runCLI(["detail"]);
    expect(r.exitCode).toBe(1);
    expect(err(r.stderr).code).toBe("NO_ID");
  });

  test("detail --format table is rejected", async () => {
    const r = await runCLI(["detail", "123", "--format", "table"]);
    expect(r.exitCode).toBe(1);
    expect(err(r.stderr).code).toBe("BAD_ARG");
  });

  test("detail rejects search-only flags", async () => {
    const r = await runCLI(["detail", "123", "--latam"]);
    expect(r.exitCode).toBe(1);
    expect(err(r.stderr).code).toBe("UNKNOWN_FLAG");
  });
});

describe("shared helpers", () => {
  test("acceptsLatam keeps worldwide/LatAm/Mexico and unknown, drops other single regions", () => {
    expect(acceptsLatam(null)).toBe(true);
    expect(acceptsLatam("Remote")).toBe(true);
    expect(acceptsLatam("Anywhere")).toBe(true);
    expect(acceptsLatam("REMOTE (Worldwide)")).toBe(true);
    expect(acceptsLatam("LATAM, USA")).toBe(true);
    expect(acceptsLatam("Canada, Mexico, USA")).toBe(true);
    expect(acceptsLatam("Ciudad de México")).toBe(true);
    expect(acceptsLatam("REMOTE (US only, US time zones)")).toBe(false);
    expect(acceptsLatam("Poland, Portugal, UK")).toBe(false);
    expect(acceptsLatam("Remote (U.S. Eastern/Central Time)")).toBe(false);
  });

  test("matchesLocation is case- and accent-insensitive", () => {
    expect(matchesLocation("Ciudad de México (hybrid)", "mexico")).toBe(true);
    expect(matchesLocation(null, "mexico")).toBe(false);
    expect(matchesLocation(null, undefined)).toBe(true);
  });

  test("matchesQuery requires every term", () => {
    expect(matchesQuery("Senior Python Backend Engineer", "python backend")).toBe(true);
    expect(matchesQuery("Senior Python Engineer", "python rust")).toBe(false);
    expect(matchesQuery("anything", undefined)).toBe(true);
  });

  test("withinDays keeps undated postings and drops old ones", () => {
    const now = Date.parse("2026-10-15T00:00:00Z");
    expect(withinDays("2026-10-13T00:00:00Z", 4, now)).toBe(true);
    expect(withinDays("2026-10-01T00:00:00Z", 4, now)).toBe(false);
    expect(withinDays(null, 4, now)).toBe(true);
    expect(withinDays("2020-01-01T00:00:00Z", null, now)).toBe(true);
  });

  test("toIsoDate accepts epoch seconds and ISO strings", () => {
    expect(toIsoDate(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIsoDate("2026-10-14T16:00:05+00:00")).toBe("2026-10-14T16:00:05.000Z");
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate("not a date")).toBeNull();
  });

  test("cleanHtml turns lists into lines and decodes entities", () => {
    expect(cleanHtml("<ul><li>Python &amp; Rust</li><li>SQL</li></ul>")).toBe("- Python & Rust\n- SQL");
    expect(cleanHtml("")).toBeNull();
    expect(decodeEntities("https:&#x2F;&#x2F;a.com")).toBe("https://a.com");
  });

  test("formatSalary normalizes periods and drops zeroes", () => {
    expect(formatSalary(85000, 95000, "USD", "yearly")).toBe("USD 85000–95000/year");
    expect(formatSalary(0, 0, "USD", "year")).toBeNull();
    expect(formatSalary(2000, null, "USD", "monthly")).toBe("USD 2000/month");
  });

  test("formatSalaryFields gives numeric fields, null when absent", () => {
    expect(formatSalaryFields(85000, 95000, "usd", "yearly")).toEqual({
      salary_min: 85000, salary_max: 95000, salary_currency: "USD", salary_period: "year",
    });
    expect(formatSalaryFields(2000, null, "USD", "monthly")).toEqual({
      salary_min: 2000, salary_max: 2000, salary_currency: "USD", salary_period: "month",
    });
    expect(formatSalaryFields(0, 0, "USD", "year")).toEqual({
      salary_min: null, salary_max: null, salary_currency: null, salary_period: null,
    });
    expect(formatSalaryFields(undefined, undefined)).toEqual({
      salary_min: null, salary_max: null, salary_currency: null, salary_period: null,
    });
  });

  test("paginate slices 1-indexed pages", () => {
    expect(paginate([1, 2, 3, 4, 5], 2, 2)).toEqual([3, 4]);
    expect(paginate([1, 2], 3, 2)).toEqual([]);
  });
});

describe("getJson", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("retries a 429 then returns the parsed body", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1
        ? new Response("slow down", { status: 429 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const body = await getJson<{ ok: boolean }>("https://example.test/x", { baseDelay: 1 });
    expect(body).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("returns null on 404", async () => {
    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await getJson("https://example.test/x")).toBeNull();
  });

  test("surfaces the API's own error message on a 4xx", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Invalid 'geo' value" }), { status: 400, statusText: "Bad Request" })) as unknown as typeof fetch;
    await expect(getJson("https://example.test/x")).rejects.toThrow("Invalid 'geo' value");
  });

  test("an unreachable host fails fast with a clear message", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(getJson("https://example.test/x")).rejects.toThrow("could not reach example.test");
  });
});
