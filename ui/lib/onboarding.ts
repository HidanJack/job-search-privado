import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { isConfigFilled, loadProfileConfig } from "./profile_config";
import {
  ONBOARD_DENY, ONBOARD_DIR_REL, ONBOARD_PERMISSION_MODE, ONBOARD_TOOLS, type PipelineStep, type Run,
} from "./runner";
import { bunSweepSpawn, type SweepSpawn } from "./sweep";

/**
 * First-run onboarding backend. The CV and the user's words are untrusted data:
 * extraction, schema validation and the final file writes are deterministic Python
 * tools (tools/onboarding_*.py); the only LLM step is the headless `/onboard` run
 * that drafts ui/state/onboarding/proposal.json.
 */
export const TOOLS_DIR = resolve(import.meta.dir, "..", "..", "tools");
/** Explicit cap for the upload route only (the rest of the API keeps its 16 KB cap). */
export const MAX_UPLOAD_BODY = 2.5 * 1024 * 1024;
export const MAX_PROPOSAL_BODY = 512 * 1024;
export const MAX_FREE_TEXT = 20_000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt", ".md"]);
const REMOTE = ["remote", "hybrid", "onsite", "any"] as const;
const PLACEHOLDER = "[YOUR_NAME]";
const PROFILE_FILE = ".claude/skills/job-application-assistant/01-candidate-profile.md";

export class OnboardingError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface Answers {
  salary_floor_mxn: number | null;
  city: string | null;
  remote: (typeof REMOTE)[number] | null;
  languages: string[];
}

export const stagingDir = (root: string) => join(root, ONBOARD_DIR_REL);
const stagingFile = (root: string, name: string) => join(stagingDir(root), name);

/** Remove everything under ui/state/onboarding/ (raw uploads, extracted text, proposal). */
export function clearStaging(root: string): void {
  rmSync(stagingDir(root), { recursive: true, force: true });
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Request parsing (every limit enforced here, before anything touches disk)
// ---------------------------------------------------------------------------

/** Reads a request body, giving up (null) as soon as it exceeds `max` bytes. */
export async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").replace(/[ \t]+/g, " ").trim();

export function parseAnswers(raw: unknown): Answers {
  const out: Answers = { salary_floor_mxn: null, city: null, remote: null, languages: [] };
  if (raw === undefined || raw === null || raw === "") return out;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new OnboardingError(400, "bad_answers", "Las respuestas deben ser un objeto.");
  const a = raw as Record<string, unknown>;
  const salary = a.salary_floor_mxn;
  if (salary !== undefined && salary !== null && salary !== "") {
    const n = typeof salary === "string" ? Number(salary.replace(/[,\s]/g, "")) : salary;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 1_000_000) {
      throw new OnboardingError(400, "bad_answers", "El sueldo mínimo debe ser un número entero de MXN al mes (entre 1 y 1,000,000).");
    }
    out.salary_floor_mxn = n;
  }
  if (a.city !== undefined && a.city !== null && a.city !== "") {
    if (typeof a.city !== "string" || clean(a.city).length > 80) throw new OnboardingError(400, "bad_answers", "La ciudad debe ser un texto corto.");
    out.city = clean(a.city) || null;
  }
  if (a.remote !== undefined && a.remote !== null && a.remote !== "") {
    if (!REMOTE.includes(a.remote as never)) throw new OnboardingError(400, "bad_answers", "La modalidad debe ser remote, hybrid, onsite o any.");
    out.remote = a.remote as Answers["remote"];
  }
  if (a.languages !== undefined && a.languages !== null) {
    if (!Array.isArray(a.languages) || a.languages.length > 10 || a.languages.some((l) => typeof l !== "string" || clean(l).length > 60)) {
      throw new OnboardingError(400, "bad_answers", "Los idiomas deben ser una lista de hasta 10 textos cortos (por ejemplo «Alemán B2»).");
    }
    out.languages = (a.languages as string[]).map(clean).filter(Boolean);
  }
  return out;
}

export interface AnalyzeInput {
  text: string;
  file: { name: string; data: Uint8Array } | null;
  answers: Answers;
}

function fileExt(name: unknown): string {
  const ext = typeof name === "string" ? extname(name.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase() : "";
  if (!ALLOWED_EXT.has(ext)) throw new OnboardingError(400, "unsupported_type", "Formato no admitido. Usa PDF, DOCX, TXT o MD.");
  return ext;
}

function decodeBase64(b64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) throw new OnboardingError(400, "bad_request", "El archivo no está bien codificado (base64).");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export async function parseAnalyzeRequest(req: Request): Promise<AnalyzeInput> {
  const body = await readLimited(req, MAX_UPLOAD_BODY);
  if (body === null) {
    throw new OnboardingError(413, "too_large", "La subida pesa demasiado (máximo 2.5 MB en total; el archivo, hasta 2 MB).");
  }
  const type = req.headers.get("content-type") ?? "";
  let text = "";
  let file: AnalyzeInput["file"] = null;
  let rawAnswers: unknown;
  if (type.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await new Response(body as unknown as BodyInit, { headers: { "content-type": type } }).formData();
    } catch {
      throw new OnboardingError(400, "bad_request", "No se pudo leer el formulario enviado.");
    }
    const t = form.get("text");
    if (typeof t === "string") text = t;
    const f = form.get("file");
    if (f && typeof f !== "string" && f.size > 0) file = { name: f.name, data: new Uint8Array(await f.arrayBuffer()) };
    const a = form.get("answers");
    if (typeof a === "string" && a.trim()) {
      try {
        rawAnswers = JSON.parse(a);
      } catch {
        throw new OnboardingError(400, "bad_answers", "Las respuestas no son JSON válido.");
      }
    }
  } else if (type.startsWith("application/json")) {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new OnboardingError(400, "bad_request", "El cuerpo no es JSON válido.");
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new OnboardingError(400, "bad_request", "El cuerpo debe ser un objeto JSON.");
    const j = json as Record<string, unknown>;
    if (j.text !== undefined && typeof j.text !== "string") throw new OnboardingError(400, "bad_request", "«text» debe ser texto.");
    text = (j.text as string | undefined) ?? "";
    if (j.fileBase64 !== undefined && j.fileBase64 !== null) {
      if (typeof j.fileBase64 !== "string") throw new OnboardingError(400, "bad_request", "«fileBase64» debe ser texto.");
      file = { name: typeof j.filename === "string" ? j.filename : "", data: decodeBase64(j.fileBase64) };
    }
    rawAnswers = j.answers;
  } else {
    throw new OnboardingError(415, "bad_request", "Envía multipart/form-data o JSON.");
  }
  if (text.length > MAX_FREE_TEXT) throw new OnboardingError(400, "text_too_long", `El texto libre es demasiado largo (máximo ${MAX_FREE_TEXT} caracteres).`);
  if (file) {
    fileExt(file.name);
    if (file.data.byteLength > MAX_FILE_BYTES) throw new OnboardingError(400, "file_too_large", "El archivo pesa más de 2 MB.");
    if (file.data.byteLength === 0) file = null;
  }
  if (!file && !text.trim()) throw new OnboardingError(400, "empty", "Sube tu CV o cuéntanos sobre ti en el cuadro de texto.");
  return { text, file, answers: parseAnswers(rawAnswers) };
}

// ---------------------------------------------------------------------------
// Python tools
// ---------------------------------------------------------------------------

export async function py(spawn: SweepSpawn, script: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<{ code: number; json: any }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const { code, stdout } = await spawn(["python3", join(TOOLS_DIR, script), ...args], cwd, { signal: ctl.signal });
    try {
      return { code, json: JSON.parse(stdout.trim().split("\n").at(-1) ?? "") };
    } catch {
      return { code, json: null };
    }
  } finally {
    clearTimeout(timer);
  }
}

export interface Extraction {
  text: string;
  warnings: string[];
}

async function extractWith(spawn: SweepSpawn, root: string, flag: "--file" | "--free", name: string, data: Uint8Array | string, display?: string): Promise<Extraction> {
  const path = stagingFile(root, name);
  mkdirSync(stagingDir(root), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  try {
    const { json } = await py(spawn, "onboarding_extract.py", [flag, path, ...(display ? ["--name", display] : [])], root);
    if (!json) throw new OnboardingError(500, "extract_failed", "No se pudo leer el archivo (falló la herramienta de extracción).");
    if (json.error) {
      const status = json.error === "pdftotext_missing" ? 503 : 400;
      throw new OnboardingError(status, String(json.error), String(json.message ?? "No se pudo leer el archivo."));
    }
    return { text: String(json.text), warnings: Array.isArray(json.warnings) ? json.warnings.map(String) : [] };
  } finally {
    rmSync(path, { force: true }); // raw upload / free text never outlives the extraction
  }
}

/** Extract the CV file (if any) and the free text; both pass through the posting guard. */
export async function extractInputs(spawn: SweepSpawn, root: string, input: AnalyzeInput): Promise<{ cv: Extraction | null; free: Extraction | null }> {
  let cv: Extraction | null = null;
  let free: Extraction | null = null;
  if (input.file) {
    const ext = fileExt(input.file.name);
    cv = await extractWith(spawn, root, "--file", `upload${ext}`, input.file.data, `upload${ext}`);
  }
  if (input.text.trim()) free = await extractWith(spawn, root, "--free", "free.txt", input.text);
  return { cv, free };
}

export function buildInputText(o: { nonce: string; today: string; answers: Answers; free: string | null; cv: string | null }): string {
  const section = (name: string, body: string) => `=== BEGIN ${name} ${o.nonce} ===\n${body}\n=== END ${name} ${o.nonce} ===\n`;
  const a = o.answers;
  const answers = [
    `salary_floor_mxn: ${a.salary_floor_mxn ?? "(not given)"}`,
    `city: ${a.city ?? "(not given)"}`,
    `remote: ${a.remote ?? "(not given)"}`,
    `languages: ${a.languages.length ? a.languages.join("; ") : "(not given)"}`,
  ].join("\n");
  return (
    `NONCE: ${o.nonce}\nTODAY: ${o.today}\n` +
    section("ANSWERS", answers) +
    (o.free ? section("FREE_TEXT", o.free) : "") +
    (o.cv ? section("CV_TEXT", o.cv) : "")
  );
}

export interface ValidationResult {
  ok: boolean;
  errors: { path: string; message: string }[];
  repairs: string[];
  flagged: string[];
  proposal: Record<string, any> | null;
}

export async function validateProposalFile(spawn: SweepSpawn, root: string, path: string): Promise<ValidationResult> {
  const { json } = await py(spawn, "onboarding_proposal.py", ["validate", "--in", path], root);
  if (!json || typeof json.ok !== "boolean") {
    return { ok: false, errors: [{ path: "", message: "No se pudo validar la propuesta." }], repairs: [], flagged: [], proposal: null };
  }
  return json as ValidationResult;
}

/** Spanish one-liner for the first few schema errors. */
export function describeErrors(errors: { path: string; message: string }[]): string {
  const shown = errors.slice(0, 5).map((e) => e.message);
  return shown.join(" ") + (errors.length > 5 ? ` (y ${errors.length - 5} más)` : "");
}

// ---------------------------------------------------------------------------
// Analysis pipeline
// ---------------------------------------------------------------------------

const ISO_DAY = () => new Date().toLocaleDateString("en-CA");

/** Stage the input, then return the pipeline steps: headless /onboard and validation of its proposal. */
export async function prepareAnalysis(spawn: SweepSpawn, root: string, input: AnalyzeInput): Promise<PipelineStep[]> {
  clearStaging(root);
  try {
    const { cv, free } = await extractInputs(spawn, root, input);
    const nonce = randomBytes(8).toString("hex");
    const warnings = [...(cv?.warnings ?? []), ...(free?.warnings ?? [])];
    writeAtomic(stagingFile(root, "input.txt"), buildInputText({ nonce, today: ISO_DAY(), answers: input.answers, free: free?.text ?? null, cv: cv?.text ?? null }));
    writeAtomic(stagingFile(root, "extract.json"), JSON.stringify({ warnings }));
  } catch (err) {
    clearStaging(root);
    throw err;
  }
  return [
    {
      title: "Leyendo tu perfil y proponiendo tu configuración (/onboard)", prompt: "/onboard", tools: ONBOARD_TOOLS,
      permissionMode: ONBOARD_PERMISSION_MODE, deny: ONBOARD_DENY,
    },
    { title: "Revisando la propuesta (sin IA)", task: (log) => finishAnalysis(spawn, root, log) },
  ];
}

/** Validate what Claude wrote; keep only the normalised proposal and carry the extraction warnings into it. */
export async function finishAnalysis(spawn: SweepSpawn, root: string, log: (line: string) => void): Promise<boolean> {
  const path = stagingFile(root, "proposal.json");
  rmSync(stagingFile(root, "validation.json"), { force: true });
  if (!existsSync(path)) {
    writeAtomic(stagingFile(root, "validation.json"), JSON.stringify({ errors: [{ path: "", message: "La IA no escribió ninguna propuesta." }] }));
    log("La IA no escribió la propuesta. Vuelve a intentarlo.");
    return false;
  }
  const res = await validateProposalFile(spawn, root, path);
  if (!res.ok || !res.proposal) {
    writeAtomic(stagingFile(root, "validation.json"), JSON.stringify({ errors: res.errors }));
    rmSync(path, { force: true });
    log(`La propuesta no cumple el formato: ${describeErrors(res.errors)} Vuelve a intentarlo.`);
    return false;
  }
  let extra: string[] = [];
  try {
    extra = JSON.parse(readFileSync(stagingFile(root, "extract.json"), "utf8")).warnings ?? [];
  } catch {}
  const proposal = res.proposal;
  proposal.warnings = [...new Set([...extra, ...proposal.warnings])];
  writeAtomic(path, JSON.stringify(proposal, null, 2) + "\n");
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  log(`Propuesta lista: ${n(proposal.experience.length, "experiencia", "experiencias")}, ${n(proposal.skills.length, "habilidad", "habilidades")}, ` +
    `${n(proposal.search_families.length, "familia de búsqueda", "familias de búsqueda")} y ${n(proposal.questions.length, "pregunta", "preguntas")}.`);
  return true;
}

// ---------------------------------------------------------------------------
// Status, proposal, confirm
// ---------------------------------------------------------------------------

export interface OnboardingStatus {
  needed: boolean;
  step: "input" | "analyzing" | "review" | "done";
  hasProposal: boolean;
  /** Errors of the last analysis when its proposal was rejected. */
  validation: { path: string; message: string }[] | null;
  run: (Omit<Run, "events">) | null;
}

const hasPlaceholder = (path: string) => !existsSync(path) || readFileSync(path, "utf8").includes(PLACEHOLDER);

export function profileNeeded(root: string): boolean {
  return !isConfigFilled(loadProfileConfig(root)) || hasPlaceholder(join(root, "CLAUDE.md")) || hasPlaceholder(join(root, PROFILE_FILE));
}

export function onboardingStatus(root: string, current: Run | null): OnboardingStatus {
  const needed = profileNeeded(root);
  const hasProposal = existsSync(stagingFile(root, "proposal.json"));
  const run = current && current.kind === "onboard" ? { ...current, events: undefined } : null;
  let validation: OnboardingStatus["validation"] = null;
  try {
    validation = JSON.parse(readFileSync(stagingFile(root, "validation.json"), "utf8")).errors ?? null;
  } catch {}
  const step: OnboardingStatus["step"] = run?.status === "running" ? "analyzing" : hasProposal ? "review" : needed ? "input" : "done";
  return { needed, step, hasProposal, validation, run: run as OnboardingStatus["run"] };
}

export async function readProposal(spawn: SweepSpawn, root: string): Promise<ValidationResult> {
  const path = stagingFile(root, "proposal.json");
  if (!existsSync(path)) throw new OnboardingError(404, "no_proposal", "Todavía no hay una propuesta. Primero analiza tu CV.");
  return validateProposalFile(spawn, root, path);
}

/** Re-validate an edited proposal and store the normalised version. Invalid input never replaces the stored one. */
export async function saveProposal(spawn: SweepSpawn, root: string, edited: unknown): Promise<ValidationResult> {
  if (!edited || typeof edited !== "object" || Array.isArray(edited)) {
    throw new OnboardingError(400, "bad_request", "La propuesta debe ser un objeto JSON.");
  }
  if (!existsSync(stagingFile(root, "proposal.json"))) throw new OnboardingError(404, "no_proposal", "Todavía no hay una propuesta. Primero analiza tu CV.");
  const candidate = stagingFile(root, "proposal.candidate.json");
  writeAtomic(candidate, JSON.stringify(edited));
  try {
    const res = await validateProposalFile(spawn, root, candidate);
    if (!res.ok || !res.proposal) throw new OnboardingError(422, "invalid_proposal", `La propuesta no es válida. ${describeErrors(res.errors)}`, res.errors);
    writeAtomic(stagingFile(root, "proposal.json"), JSON.stringify(res.proposal, null, 2) + "\n");
    return res;
  } finally {
    rmSync(candidate, { force: true });
  }
}

export interface ConfirmResult {
  ok: true;
  written: { path: string; bytes: number }[];
  backups: string[];
  unchanged: string[];
}

export async function confirmProposal(spawn: SweepSpawn, root: string, currentSalary: unknown): Promise<ConfirmResult> {
  if (!existsSync(stagingFile(root, "proposal.json"))) throw new OnboardingError(404, "no_proposal", "No hay una propuesta que confirmar.");
  const args = ["--root", root, "--proposal", stagingFile(root, "proposal.json")];
  if (currentSalary !== undefined && currentSalary !== null && currentSalary !== "") {
    const n = typeof currentSalary === "string" ? Number(currentSalary.replace(/[,\s]/g, "")) : currentSalary;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 1_000_000) {
      throw new OnboardingError(400, "bad_request", "El sueldo actual debe ser un número entero de MXN al mes (entre 1 y 1,000,000).");
    }
    args.push("--current-salary", String(n));
  }
  const { code, json } = await py(spawn, "onboarding_apply.py", args, root);
  if (!json) throw new OnboardingError(500, "apply_failed", "No se pudo escribir tu perfil (falló la herramienta).");
  if (code !== 0 || !json.ok) {
    const status = json.error === "private_repo" ? 409 : json.error === "invalid_proposal" || json.error === "flagged" ? 422 : 500;
    throw new OnboardingError(status, String(json.error ?? "apply_failed"), String(json.message ?? "No se pudo escribir tu perfil."), json.details);
  }
  clearStaging(root);
  return json as ConfirmResult;
}

export const bunToolSpawn: SweepSpawn = bunSweepSpawn;
