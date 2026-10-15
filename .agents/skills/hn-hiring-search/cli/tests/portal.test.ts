import { afterEach, describe, expect, test } from "bun:test";
import { runSearch } from "../src/commands/search";
import { runDetail } from "../src/commands/detail";
import { firstLine, normalizeId, parseHeader, toResult, type AlgoliaCommentHit, type HnItem } from "../src/helpers";
import { CONTRACT_KEYS, baseOpts, capture, emptyFlags, fixture, mockFetch, requested, restore } from "./harness";

const threads = fixture<{ hits: Array<{ objectID: string; title: string }> }>("threads.json");
const comments = fixture<{ hits: AlgoliaCommentHit[] }>("comments.json");
const thread = fixture<HnItem>("thread_item.json");
const hiringId = threads.hits.find((h) => /who is hiring\?/i.test(h.title))!.objectID;

function route(url: string): unknown {
  if (url.includes("/search_by_date")) return threads;
  if (url.includes("/search?")) return comments;
  const m = url.match(/\/items\/(\d+)/);
  if (m && m[1] === String(thread.id)) return thread;
  if (m) return thread.children?.find((c) => String(c.id) === m[1]);
  return undefined;
}

afterEach(restore);

describe("HN header parsing", () => {
  test("pipe-separated header", () => {
    const h = parseHeader("Sidekick Labs | Senior SWE, R&D Engineer | REMOTE (US Timezones) | Full-time | $170k to $230k Base");
    expect(h.company).toBe("Sidekick Labs");
    expect(h.title).toBe("Senior SWE, R&D Engineer");
    expect(h.location).toBe("REMOTE (US Timezones)");
    expect(h.salary).toContain("$170k");
    expect(h.remote).toBe(true);
  });

  test("em-dash separated header with location inside the company segment", () => {
    const h = parseHeader("PrairieLearn (Remote US) — Full-Stack Software Engineer — TypeScript / Postgres");
    expect(h.company).toBe("PrairieLearn");
    expect(h.title).toBe("Full-Stack Software Engineer");
    expect(h.location).toBe("Remote US");
  });

  test("a role segment carrying its own location in parentheses", () => {
    const h = parseHeader("OneChronos | Engineering Manager, Data Platform (NYC, Hybrid) | Full-Time");
    expect(h.title).toContain("Engineering Manager");
    expect(h.location).toBe("NYC, Hybrid");
  });

  test("URLs are stripped from company and segments", () => {
    const h = parseHeader("Snout https://snout.com/ | Multiple Engineering + Product Roles | Remote US or Ontario, Canada");
    expect(h.company).toBe("Snout");
    expect(h.title).toBe("Multiple Engineering + Product Roles");
  });

  test("prose without separators yields no company", () => {
    expect(parseHeader("I lead a lab and we are hiring researchers").company).toBeNull();
  });

  test("firstLine stops at the first paragraph and decodes entities", () => {
    expect(firstLine("Acme | Dev | REMOTE<p>Details")).toBe("Acme | Dev | REMOTE");
    expect(firstLine('Acme | <a href="x">https:&#x2F;&#x2F;acme.io</a>')).toBe("Acme | https://acme.io");
  });

  test("results carry every contract key and point at the HN item", () => {
    for (const hit of comments.hits) {
      const r = toResult({ id: hit.objectID, html: hit.comment_text!, created_at: hit.created_at ?? null }) as unknown as Record<string, unknown>;
      for (const k of CONTRACT_KEYS) expect(k in r).toBe(true);
      expect(r.url).toBe(`https://news.ycombinator.com/item?id=${hit.objectID}`);
    }
  });

  test("normalizeId accepts ids and HN item URLs", () => {
    expect(normalizeId("50095921")).toBe("50095921");
    expect(normalizeId("https://news.ycombinator.com/item?id=50095921")).toBe("50095921");
    expect(normalizeId("abc")).toBeNull();
  });
});

describe("HN commands", () => {
  test("search resolves the newest 'Who is hiring?' thread (not 'Who wants to be hired?')", async () => {
    mockFetch(route);
    const io = capture();
    const code = await runSearch({ ...baseOpts, query: "python" }, emptyFlags());
    restore();
    expect(code).toBe(0);
    const searchUrl = new URL(requested.find((u) => u.includes("/search?"))!);
    expect(searchUrl.searchParams.get("tags")).toBe(`comment,story_${hiringId}`);
    const out = JSON.parse(io.out());
    expect(out.results.length).toBeGreaterThan(0);
    for (const r of out.results) expect(r.title).toBeTruthy();
  });

  test("without a query the thread's top-level comments are listed", async () => {
    mockFetch(route);
    const io = capture();
    await runSearch({ ...baseOpts }, emptyFlags({ thread: String(thread.id) }));
    restore();
    expect(requested.some((u) => u.endsWith(`/items/${thread.id}`))).toBe(true);
    expect(JSON.parse(io.out()).meta.total).toBe(thread.children!.filter((c) => c.text).length);
  });

  test("--latam drops US-only postings", async () => {
    mockFetch(route);
    const io = capture();
    await runSearch({ ...baseOpts, query: "python", latam: true }, emptyFlags());
    restore();
    for (const r of JSON.parse(io.out()).results) expect(String(r.location ?? "")).not.toMatch(/US only/i);
  });

  test("detail returns the full comment text", async () => {
    const child = thread.children!.find((c) => c.text)!;
    mockFetch(route);
    const io = capture();
    const code = await runDetail(`https://news.ycombinator.com/item?id=${child.id}`, "json");
    restore();
    expect(code).toBe(0);
    expect(JSON.parse(io.out()).description.length).toBeGreaterThan(20);
  });

  test("detail on a story id is rejected", async () => {
    mockFetch(route);
    const io = capture();
    const code = await runDetail(String(thread.id), "json");
    restore();
    expect(code).toBe(1);
    expect(JSON.parse(io.err()).code).toBe("BAD_ID");
  });
});
