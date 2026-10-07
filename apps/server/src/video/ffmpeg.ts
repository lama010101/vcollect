// =============================================================================
// FFmpeg service — the SINGLE binary resolver & spawn abstraction.
//
// Locked resolution priority (per user decision):
//   1. Explicit configured path (FFMPEG_BIN_PATH / FFPROBE_BIN_PATH)
//   2. System binary discoverable in PATH
//   3. Bundled npm binary (ffmpeg-static / ffprobe-static)
//   4. Actionable error naming all three sources
//
// The app must NOT depend exclusively on PATH. All other video modules call
// this service — there is exactly one code path that spawns ffmpeg/ffprobe.
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../config.js";

// Bundled fallbacks (optional deps; imported lazily so missing packages don't
// crash a system-ffmpeg-only install at module load).
let bundledFfmpeg: string | null = null;
let bundledFfprobe: string | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  bundledFfmpeg = (await import("ffmpeg-static")).default as string;
} catch {
  bundledFfmpeg = null;
}
try {
  // ffprobe-static exposes platform-specific path under a subkey.
  const mod = (await import("ffprobe-static")).default as unknown as {
    path?: string;
  };
  bundledFfprobe = mod.path ?? null;
} catch {
  bundledFfprobe = null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolve an executable on PATH without spawning (no `which` dep).
// Walks PATH entries; on Windows also appends .exe.
async function findInPath(exe: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? "";
  const exts = platform() === "win32" ? ["", ".exe"] : [""];
  for (const dir of pathEnv.split(platform() === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, exe + ext);
      if (await pathExists(candidate)) return candidate;
    }
  }
  // Scoop shims live here on this box even if not always in PATH for the
  // current shell — check explicitly as a courtesy.
  if (platform() === "win32") {
    const scoopShim = join(homedir(), "scoop", "shims", `${exe}.exe`);
    if (await pathExists(scoopShim)) return scoopShim;
  }
  return null;
}

export interface ResolvedBinary {
  path: string;
  source: "config" | "path" | "bundled";
}

async function resolveBinary(
  kind: "ffmpeg" | "ffprobe",
  configured: string,
  bundled: string | null,
): Promise<ResolvedBinary> {
  // 1. explicit config
  if (configured) {
    if (await pathExists(configured)) {
      return { path: configured, source: "config" };
    }
    throw new FfmpegUnavailableError(
      kind,
      `Configured ${kind}BinPath="${configured}" does not exist or is not executable. ` +
        `Set FFMPEG_BIN_PATH/FFPROBE_BIN_PATH to a valid executable, ensure ${kind} is in PATH, ` +
        `or install the bundled fallback (npm install ${kind === "ffmpeg" ? "ffmpeg-static" : "ffprobe-static"}).`,
    );
  }
  // 2. PATH
  const inPath = await findInPath(kind);
  if (inPath) return { path: inPath, source: "path" };
  // 3. bundled
  if (bundled && (await pathExists(bundled))) {
    return { path: bundled, source: "bundled" };
  }
  // 4. actionable error
  throw new FfmpegUnavailableError(
    kind,
    `No ${kind} executable found. Tried: (1) env FFMPEG_BIN_PATH/FFPROBE_BIN_PATH — unset; ` +
      `(2) ${kind} in PATH — not found; (3) bundled npm package ${kind === "ffmpeg" ? "ffmpeg-static" : "ffprobe-static"} — ${bundled ? `present but missing at ${bundled}` : "not installed"}. ` +
      `Install system ${kind} (e.g. 'scoop install ffmpeg' on Windows, 'brew install ffmpeg' on macOS, ` +
      `or your distro's package) OR run 'npm install'.`,
  );
}

export class FfmpegUnavailableError extends Error {
  constructor(public readonly kind: "ffmpeg" | "ffprobe", message: string) {
    super(message);
    this.name = "FfmpegUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(
  bin: string,
  args: string[],
  opts: { logTag?: string; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  if (opts.logTag) console.debug(`[ffmpeg] ${opts.logTag}: ${bin} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Singleton service
// ---------------------------------------------------------------------------
export class FfmpegService {
  private ffmpeg?: ResolvedBinary;
  private ffprobe?: ResolvedBinary;
  private readonly log: boolean;

  constructor(opts: { log?: boolean } = {}) {
    this.log = opts.log ?? false;
  }

  /** Resolve both binaries once and log the chosen source. */
  async ensure(): Promise<{ ffmpeg: ResolvedBinary; ffprobe: ResolvedBinary }> {
    if (!this.ffmpeg) {
      this.ffmpeg = await resolveBinary("ffmpeg", config.ffmpegBinPath, bundledFfmpeg);
    }
    if (!this.ffprobe) {
      this.ffprobe = await resolveBinary("ffprobe", config.ffprobeBinPath, bundledFfprobe);
    }
    if (this.log) {
      console.log(
        `[ffmpeg] ffmpeg=${this.ffmpeg.path} (${this.ffmpeg.source}) ffprobe=${this.ffprobe.path} (${this.ffprobe.source})`,
      );
    }
    return { ffmpeg: this.ffmpeg, ffprobe: this.ffprobe };
  }

  ffmpegPath(): string {
    if (!this.ffmpeg) throw new FfmpegUnavailableError("ffmpeg", "ensure() not called yet");
    return this.ffmpeg.path;
  }

  ffprobePath(): string {
    if (!this.ffprobe) throw new FfmpegUnavailableError("ffprobe", "ensure() not called yet");
    return this.ffprobe.path;
  }

  async ffmpegExec(args: string[], tag?: string, opts: { signal?: AbortSignal } = {}): Promise<ExecResult> {
    await this.ensure();
    return run(this.ffmpegPath(), args, { logTag: tag, signal: opts.signal });
  }

  async ffprobeExec(args: string[], tag?: string): Promise<ExecResult> {
    await this.ensure();
    return run(this.ffprobePath(), args, { logTag: tag });
  }

  /** Spawn ffmpeg as a streaming child (for stdin-piped rawvideo input and
   *  other long-running invocations). Same single binary-resolution path —
   *  the caller owns stdin/stdout/stderr and lifecycle. */
  async ffmpegSpawn(args: string[], opts: { signal?: AbortSignal } = {}): Promise<ChildProcess> {
    await this.ensure();
    return spawn(this.ffmpegPath(), args, { windowsHide: true, signal: opts.signal });
  }

  /** ffmpeg version string (for diagnostics). */
  async version(): Promise<string> {
    const r = await this.ffmpegExec(["-version"]);
    return r.stdout.split("\n")[0] ?? "";
  }
}

// One shared instance for the whole app.
export const ffmpegService = new FfmpegService({ log: true });
