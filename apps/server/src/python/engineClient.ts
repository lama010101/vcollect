// =============================================================================
// Engine client — owns the twio_engine worker subprocess and speaks NDJSON
// over its stdio. The worker is spawned lazily on first call, reused for all
// subsequent calls, and respawned automatically if it dies.
//
//   request  → {"id","method","params"}      (one JSON object per line)
//   response ← {"id","ok",result|error}      (one JSON object per line)
//
// Cancellation: aborting a request kills the worker (it is stateless — all
// cacheable output lives on disk). The next call respawns it.
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensureEngine, PYTHON_DIR, type PythonExe } from "./pythonService.js";

export class EngineRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly trace?: string[],
  ) {
    super(message);
    this.name = "EngineRpcError";
  }
}

export interface EngineCallOptions {
  signal?: AbortSignal;
  /** Hard timeout for a single call (default none — analysis can be slow). */
  timeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
}

type PythonProvider = () => Promise<PythonExe>;

export class EngineClient {
  private proc: ChildProcess | null = null;
  private stdoutBuf = "";
  private stderrTail = "";
  private pending = new Map<string, Pending>();
  private spawning: Promise<void> | null = null;
  /** Called with stderr lines so provisioning errors are diagnosable. */
  onStderr?: (line: string) => void;

  constructor(private readonly pythonProvider: PythonProvider = () => ensureEngine()) {}

  /** True when a worker process is currently running. */
  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  private async spawn(): Promise<void> {
    const py = await this.pythonProvider();
    const proc = spawn(py.exe, [...py.argsPrefix, "-m", "twio_engine.worker"], {
      cwd: PYTHON_DIR,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.stdoutBuf = "";
    this.stderrTail = "";
    proc.stdout!.on("data", (d: Buffer) => this.onStdout(d.toString("utf8")));
    proc.stderr!.on("data", (d: Buffer) => {
      this.stderrTail += d.toString("utf8");
      if (this.stderrTail.length > 4000) this.stderrTail = this.stderrTail.slice(-4000);
      for (const line of this.stderrTail.split(/\r?\n/)) if (line.trim()) this.onStderr?.(line);
    });
    proc.on("error", () => this.teardown(new EngineRpcError("WORKER_SPAWN_FAILED", `engine worker failed to start (${py.exe})`)));
    proc.on("close", (code) => {
      const tail = this.stderrTail.trim().split(/\r?\n/).slice(-6).join("\n");
      this.teardown(
        new EngineRpcError(
          "WORKER_DIED",
          `engine worker exited unexpectedly (code ${code})${tail ? ` — ${tail.slice(-600)}` : ""}`,
        ),
      );
    });
  }

  private ensure(): Promise<void> {
    if (this.alive) return Promise.resolve();
    this.spawning ??= this.spawn().finally(() => (this.spawning = null));
    return this.spawning;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    for (;;) {
      const nl = this.stdoutBuf.indexOf("\n");
      if (nl < 0) return;
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: string; message?: string; trace?: string[] } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // stray non-JSON output — ignore
      }
      const id = typeof msg.id === "string" ? msg.id : null;
      const p = id ? this.pending.get(id) : undefined;
      if (!p) continue;
      this.pending.delete(id!);
      p.timer && clearTimeout(p.timer);
      if (msg.ok === true) p.resolve(msg.result);
      else p.reject(new EngineRpcError(msg.error?.code ?? "ENGINE_ERROR", msg.error?.message ?? "engine error", msg.error?.trace));
    }
  }

  /** Reject every pending call and drop the process handle. */
  private teardown(err: Error): void {
    for (const p of this.pending.values()) {
      p.timer && clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.proc = null;
  }

  /** Kill the worker; next call() spawns a fresh one. */
  kill(): void {
    const proc = this.proc;
    this.teardown(new EngineRpcError("WORKER_KILLED", "engine worker was killed"));
    try {
      proc?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  /** Call a worker method. AbortSignal kills the worker (it is stateless —
   *  all cacheable output lives on disk). */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, opts: EngineCallOptions = {}): Promise<T> {
    if (opts.signal?.aborted) throw new EngineRpcError("CANCELLED", "call aborted");
    await this.ensure();
    const id = randomUUID();
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolvePromise, reject) => {
        const pending: Pending = { resolve: resolvePromise as (v: unknown) => void, reject };
        if (opts.timeoutMs) {
          pending.timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new EngineRpcError("TIMEOUT", `engine call ${method} timed out after ${opts.timeoutMs} ms`));
          }, opts.timeoutMs);
        }
        if (opts.signal) {
          pending.onAbort = onAbort = () => {
            // Killing the worker rejects every pending request via teardown.
            this.kill();
          };
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
        this.pending.set(id, pending);
        try {
          this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
        } catch (e) {
          this.pending.delete(id);
          pending.timer && clearTimeout(pending.timer);
          reject(e);
        }
      });
    } finally {
      if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Shared client using the managed engine interpreter. */
export const engineClient = new EngineClient();
