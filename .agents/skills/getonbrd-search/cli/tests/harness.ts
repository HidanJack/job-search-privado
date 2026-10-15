import { readFileSync } from "fs";
import { join } from "path";

// Test harness: route mocked fetch calls to local fixtures and capture output.

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8")) as T;
}

const originalFetch = globalThis.fetch;
const originalOut = process.stdout.write;
const originalErr = process.stderr.write;

export const requested: string[] = [];

/** Serve `route(url)`'s body (or a 404 when it returns undefined). */
export function mockFetch(route: (url: string) => unknown): void {
  requested.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const body = route(url);
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

export function capture(): { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  process.stdout.write = ((c: string | Uint8Array) => ((out += c.toString()), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((err += c.toString()), true)) as typeof process.stderr.write;
  return { out: () => out, err: () => err };
}

export function restore(): void {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalOut;
  process.stderr.write = originalErr;
}

export const CONTRACT_KEYS = ["id", "title", "company", "location", "date", "url"];

export const baseOpts = {
  query: undefined as string | undefined,
  location: undefined as string | undefined,
  jobage: null as number | null,
  page: 1,
  limit: 25,
  format: "json" as "json" | "table" | "plain",
  latam: false,
};

export function emptyFlags(extra: Record<string, string | boolean> = {}) {
  return { _: ["search"], ...extra } as { _: string[]; [k: string]: string | boolean | string[] };
}
