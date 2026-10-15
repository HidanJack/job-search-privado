import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TRACKER_PATH = "job_search_tracker.csv";

// Canonical vocabulary lives in /outcome's "Tracker status vocabulary"; legacy
// space spellings are read as their underscore forms and never written.
export const STATUSES = [
  "drafted", "applied", "interview", "offer", "hired",
  "rejected", "no_response", "offer_declined", "withdrawn",
] as const;
const NOT_A_RESPONSE = new Set(["drafted", "applied", "no_response"]);

export function normalizeStatus(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

interface ParsedRecord {
  fields: string[];
  start: number;
  end: number; // exclusive, before the line break
}

/** RFC 4180 parser that remembers each record's span so untouched rows are kept byte-for-byte. */
export function parseCsv(text: string): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (;;) {
      if (i >= text.length) {
        fields.push(field);
        break;
      }
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (c === '"') {
          quoted = false;
          i++;
        } else {
          field += c;
          i++;
        }
      } else if (c === '"') {
        quoted = true;
        i++;
      } else if (c === ",") {
        fields.push(field);
        field = "";
        i++;
      } else if (c === "\r" || c === "\n") {
        fields.push(field);
        break;
      } else {
        field += c;
        i++;
      }
    }
    const end = i;
    if (text[i] === "\r") i++;
    if (text[i] === "\n") i++;
    if (!(fields.length === 1 && fields[0] === "" && end === start)) records.push({ fields, start, end });
  }
  return records;
}

export function serializeField(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface TrackerRow {
  [column: string]: string;
}

export function readTracker(text: string): { header: string[]; rows: TrackerRow[] } {
  const records = parseCsv(text);
  if (records.length === 0) return { header: [], rows: [] };
  const header = records[0].fields.map((h) => h.trim());
  const rows = records.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r.fields[i] ?? ""])));
  return { header, rows };
}

/**
 * Moves the open `drafted` row for this posting URL to `applied`, dated today.
 * Only that row's bytes change; every other line is left exactly as it was.
 */
export function markApplied(text: string, url: string, today: string): { text: string } | { error: string } {
  const records = parseCsv(text);
  if (records.length < 2) return { error: "tracker_empty" };
  const header = records[0].fields.map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const [iSource, iStatus, iDate] = [col("source"), col("status"), col("date")];
  if (iSource < 0 || iStatus < 0 || iDate < 0) return { error: "tracker_header" };
  const match = [...records.slice(1)]
    .reverse()
    .find((r) => (r.fields[iSource] ?? "").trim() === url && normalizeStatus(r.fields[iStatus] ?? "") === "drafted");
  if (!match) return { error: "row_not_found" };
  const fields = [...match.fields];
  while (fields.length < header.length) fields.push("");
  fields[iStatus] = "applied";
  fields[iDate] = today;
  const line = fields.map(serializeField).join(",");
  return { text: text.slice(0, match.start) + line + text.slice(match.end) };
}

export function updateTrackerFile(root: string, url: string, today: string): { ok: true } | { error: string } {
  const path = join(root, TRACKER_PATH);
  if (!existsSync(path)) return { error: "tracker_missing" };
  const result = markApplied(readFileSync(path, "utf8"), url, today);
  if ("error" in result) return result;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, result.text, "utf8");
  renameSync(tmp, path);
  return { ok: true };
}

export function portalOf(source: string): string {
  try {
    return new URL(source).hostname.replace(/^www\./, "") || "desconocido";
  } catch {
    return source ? "texto pegado" : "desconocido";
  }
}

interface Rate {
  sent: number;
  responded: number;
  rate: number;
}

function addTo(map: Record<string, Rate>, key: string, responded: boolean) {
  const r = (map[key] ??= { sent: 0, responded: 0, rate: 0 });
  r.sent++;
  if (responded) r.responded++;
  r.rate = r.responded / r.sent;
}

/** Pipeline counts plus response rate by channel and by portal host. */
export function trackerStats(rows: TrackerRow[]) {
  const pipeline: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const byChannel: Record<string, Rate> = {};
  const byPortal: Record<string, Rate> = {};
  for (const row of rows) {
    const status = normalizeStatus(row.status ?? "");
    pipeline[status] = (pipeline[status] ?? 0) + 1;
    if (status === "drafted" || status === "") continue; // never sent
    const responded = !NOT_A_RESPONSE.has(status);
    addTo(byChannel, row.channel?.trim() || "sin canal", responded);
    addTo(byPortal, portalOf(row.source?.trim() ?? ""), responded);
  }
  return { pipeline, byChannel, byPortal };
}

export function loadTracker(root: string) {
  const path = join(root, TRACKER_PATH);
  const { rows } = existsSync(path) ? readTracker(readFileSync(path, "utf8")) : { rows: [] as TrackerRow[] };
  return { rows, ...trackerStats(rows) };
}
