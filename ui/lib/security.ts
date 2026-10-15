import { realpathSync, existsSync } from "node:fs";
import { isAbsolute, resolve, sep, extname } from "node:path";

export const MAX_URL_LENGTH = 2048;
export const MAX_FEEDBACK_LENGTH = 2000;

/** Hosts the server answers to. Anything else is treated as DNS rebinding. */
export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function isAllowedHost(host: string | null, port: number): boolean {
  return host !== null && allowedHosts(port).has(host.toLowerCase());
}

/** State-changing requests must come from the dashboard's own page. */
export function isAllowedOrigin(origin: string | null, port: number): boolean {
  if (origin === null) return false;
  return [...allowedHosts(port)].some((h) => origin.toLowerCase() === `http://${h}`);
}

/** A posting URL that is safe to pass inside a `claude -p` prompt. */
export function validateJobUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.toString();
}

/** User feedback goes into the prompt as plain text, one line, bounded. */
export function sanitizeFeedback(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FEEDBACK_LENGTH);
}

/**
 * Resolve a repo-relative path and confirm it stays inside one of the allowed
 * directories with an allowed extension. Returns the absolute path or null.
 */
export function safeResolve(
  root: string,
  rel: unknown,
  allowedDirs: string[],
  allowedExts: string[],
): string | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 512) return null;
  if (rel.includes("\0") || isAbsolute(rel)) return null;
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, rel);
  if (!allowedExts.includes(extname(target).toLowerCase())) return null;
  const inside = (abs: string) =>
    allowedDirs.some((dir) => abs.startsWith(resolve(rootAbs, dir) + sep));
  if (!inside(target)) return null;
  if (existsSync(target)) {
    // A symlink inside cv/ must not lead outside it.
    const real = realpathSync(target);
    const realRoot = realpathSync(rootAbs);
    const realInside = allowedDirs.some((dir) => {
      const d = resolve(realRoot, dir);
      return real.startsWith((existsSync(d) ? realpathSync(d) : d) + sep);
    });
    if (!realInside) return null;
  }
  return target;
}
