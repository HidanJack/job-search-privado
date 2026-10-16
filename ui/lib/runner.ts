import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tools a headless run may use beyond `.claude/settings.json`, which already
 * allows every portal CLI, rank_state.py, job_key.py, salary_lookup.py,
 * verify_pdf.py, verify_layout.py and pdftotext. Without these a `claude -p`
 * run cannot reach the web or compile, because print mode has no prompt to ask.
 * Deliberately absent: curl (posting text is untrusted and could steer an
 * outbound request) and any unrestricted Bash.
 */
export const BASE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "WebFetch", "WebSearch", "Agent", "Skill"];
/**
 * /job-scraper stores results only through tools/scrape_state.py (SKILL.md
 * Step 4). Listed here as well as in settings.json so the one write path the
 * run depends on never hinges on a permission prompt print mode cannot show.
 */
export const SEARCH_TOOLS = [
  ...BASE_TOOLS,
  "Bash(python tools/scrape_state.py:*)",
  "Bash(python3 tools/scrape_state.py:*)",
];
export const APPLY_TOOLS = [
  ...BASE_TOOLS,
  "Bash(cd cv && lualatex:*)",
  "Bash(cd ../cover_letters && xelatex:*)",
  "Bash(cd cover_letters && xelatex:*)",
  "Bash(lualatex:*)",
  "Bash(xelatex:*)",
  "Bash(python tools/check_cover_letter.py:*)",
  "Bash(python3 tools/check_cover_letter.py:*)",
  "Bash(rm -f cv/main_:*)",
];

export type RunKind = "search" | "rank" | "apply" | "market";

export function buildArgv(claudeBin: string, prompt: string, tools: string[]): string[] {
  // The prompt is one argv element and always starts with "/", so it can
  // never be read as a flag. --allowedTools is variadic and must come last.
  return [
    claudeBin, "-p", prompt,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--allowedTools", ...tools,
  ];
}

export function buildApplyPrompt(url: string, acknowledgeKnockouts: boolean, feedback: string): string {
  let prompt = "/apply [ui-mode]";
  if (acknowledgeKnockouts) prompt += " [knockouts-acknowledged]";
  prompt += ` ${url}`;
  if (feedback) prompt += ` [feedback] ${feedback}`;
  return prompt;
}

export interface UiResult {
  stage: "done" | "knockout" | "error";
  company?: string;
  role?: string;
  url?: string;
  cv_pdf?: string | null;
  cover_pdf?: string | null;
  cover_letter_skipped_reason?: string | null;
  form_fields?: string | null;
  fit_score?: number | null;
  knockouts?: { requirement: string; answer: string }[];
  keywords?: { covered: string[]; missing: string[] };
  questions?: string[];
  message?: string;
}

/** Pulls the last ```ui-result block out of /apply's final message. */
export function parseUiResult(text: string): UiResult | null {
  const blocks = [...text.matchAll(/```ui-result\s*\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return null;
  try {
    const value = JSON.parse(blocks[blocks.length - 1][1]);
    if (!value || typeof value !== "object" || !["done", "knockout", "error"].includes(value.stage)) return null;
    return value as UiResult;
  } catch {
    return null;
  }
}

export interface ProgressEvent {
  id: number;
  type: "step" | "text" | "tool" | "done" | "error";
  text: string;
}

/** Turns one stream-json line into zero or more short progress messages. */
export function describeStreamLine(line: string): { type: ProgressEvent["type"]; text: string; result?: string; isError?: boolean }[] {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  const out: { type: ProgressEvent["type"]; text: string; result?: string; isError?: boolean }[] = [];
  if (msg?.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ type: "text", text: block.text.trim().slice(0, 600) });
      } else if (block?.type === "tool_use") {
        const input = block.input ?? {};
        const detail = input.command ?? input.file_path ?? input.url ?? input.query ?? input.description ?? input.skill ?? "";
        out.push({ type: "tool", text: `${block.name}${detail ? `: ${String(detail).slice(0, 160)}` : ""}` });
      }
    }
  } else if (msg?.type === "result") {
    const result = typeof msg.result === "string" ? msg.result : "";
    out.push({ type: msg.is_error ? "error" : "text", text: "Ejecución terminada.", result, isError: Boolean(msg.is_error) });
  }
  return out;
}

export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
export type Spawner = (argv: string[], cwd: string) => SpawnedProcess;

export const bunSpawner: Spawner = (argv, cwd) => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  return { stdout: proc.stdout, exited: proc.exited, kill: () => proc.kill() };
};

export interface Run {
  id: string;
  kind: RunKind;
  label: string;
  url: string | null;
  status: "running" | "done" | "failed";
  startedAt: string;
  events: ProgressEvent[];
  result: UiResult | null;
}

type Listener = (e: ProgressEvent) => void;

/** One headless run at a time; events are buffered so a late SSE client can replay them. */
export class RunManager {
  current: Run | null = null;
  private listeners = new Set<Listener>();
  private seq = 0;

  constructor(
    private root: string,
    private spawner: Spawner,
    private claudeBin: string,
    private store: ResultStore,
  ) {}

  busy(): boolean {
    return this.current?.status === "running";
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(run: Run, type: ProgressEvent["type"], text: string) {
    const event = { id: ++this.seq, type, text };
    run.events.push(event);
    if (run.events.length > 2000) run.events.shift();
    for (const fn of this.listeners) fn(event);
  }

  /** Runs each prompt in order; stops at the first failure. Returns null if busy. */
  start(kind: RunKind, label: string, prompts: { prompt: string; tools: string[]; title: string }[], url: string | null = null): Run | null {
    if (this.busy()) return null;
    const run: Run = {
      id: crypto.randomUUID(), kind, label, url, status: "running",
      startedAt: new Date().toISOString(), events: [], result: null,
    };
    this.current = run;
    void this.execute(run, prompts);
    return run;
  }

  /**
   * Runs an in-process task (no Claude) under the same lock and event stream as
   * the headless runs. The task reports progress through `log`; a false return
   * or a throw marks the run failed. Returns null if busy.
   */
  startTask(kind: RunKind, label: string, task: (log: (text: string) => void) => Promise<boolean>): Run | null {
    if (this.busy()) return null;
    const run: Run = {
      id: crypto.randomUUID(), kind, label, url: null, status: "running",
      startedAt: new Date().toISOString(), events: [], result: null,
    };
    this.current = run;
    void (async () => {
      try {
        this.emit(run, "step", label);
        const ok = await task((text) => this.emit(run, "text", text));
        run.status = ok ? "done" : "failed";
        if (!ok) this.emit(run, "error", "La tarea terminó con errores.");
      } catch (err) {
        run.status = "failed";
        this.emit(run, "error", `La tarea falló: ${(err as Error).message}`);
      }
      this.emit(run, "done", run.status === "done" ? "Listo." : "Terminó con errores.");
    })();
    return run;
  }

  private async execute(run: Run, prompts: { prompt: string; tools: string[]; title: string }[]) {
    try {
      let lastResult = "";
      for (const step of prompts) {
        this.emit(run, "step", step.title);
        const proc = this.spawner(buildArgv(this.claudeBin, step.prompt, step.tools), this.root);
        const { ok, result } = await this.pump(run, proc);
        const code = await proc.exited;
        lastResult = result;
        if (!ok || code !== 0) {
          run.status = "failed";
          this.emit(run, "error", `El paso "${step.title}" terminó con error (código ${code}).`);
          break;
        }
      }
      if (run.kind === "apply") {
        run.result = parseUiResult(lastResult);
        if (run.url && run.result) this.store.save(run.url, run.result);
      }
      if (run.status === "running") run.status = "done";
      this.emit(run, "done", run.status === "done" ? "Listo." : "Terminó con errores.");
    } catch (err) {
      run.status = "failed";
      this.emit(run, "error", `No se pudo ejecutar claude: ${(err as Error).message}`);
      this.emit(run, "done", "Terminó con errores.");
    }
  }

  private async pump(run: Run, proc: SpawnedProcess): Promise<{ ok: boolean; result: string }> {
    const decoder = new TextDecoder();
    let buffer = "";
    let ok = true;
    let result = "";
    const handle = (line: string) => {
      for (const item of describeStreamLine(line)) {
        if (item.result !== undefined) {
          result = item.result;
          if (item.isError) ok = false;
        }
        this.emit(run, item.type, item.text);
      }
    };
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) handle(buffer);
    return { ok, result };
  }
}

/** Last /apply result per posting URL, so the review screen survives a reload. */
export class ResultStore {
  private path: string;
  constructor(root: string) {
    this.path = join(root, "ui", "state", "results.json");
  }
  all(): Record<string, UiResult & { updated_at: string }> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return {};
    }
  }
  save(url: string, result: UiResult) {
    const data = this.all();
    data[url] = { ...result, updated_at: new Date().toISOString() };
    mkdirSync(join(this.path, ".."), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}
