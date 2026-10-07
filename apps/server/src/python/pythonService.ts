// =============================================================================
// Python engine service — the SINGLE Python interpreter resolver & venv
// provisioner. Mirrors video/ffmpeg.ts resolution priorities.
//
// Interpreter resolution (for the engine worker):
//   1. Explicit configured path (PYTHON_BIN_PATH) — used as-is; deps are the
//      user's responsibility (worker reports MISSING_DEP if absent)
//   2. Managed venv at apps/server/python/.venv — auto-created on first use
//      and pip-installed from requirements.txt (reinstalled only when the
//      requirements sha256 changes)
//   3. If neither is available and none can be bootstrapped → actionable error
//
// Base interpreter (for creating the venv), in order:
//   config path → `python` on PATH → `python3` → `py -3` launcher
// =============================================================================

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { access, constants, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { config, PROJECT_ROOT } from "../config.js";

export const PYTHON_DIR = resolve(PROJECT_ROOT, "apps", "server", "python");
export const REQUIREMENTS_PATH = join(PYTHON_DIR, "requirements.txt");
export const VENV_DIR = join(PYTHON_DIR, ".venv");
export const VENV_PYTHON =
  platform() === "win32" ? join(VENV_DIR, "Scripts", "python.exe") : join(VENV_DIR, "bin", "python");
export const DEPS_STAMP_PATH = join(VENV_DIR, ".deps-sha256");

export class EngineError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface PythonExe {
  /** Executable path. */
  exe: string;
  /** Args prepended to every invocation (e.g. ["-3"] for the py launcher). */
  argsPrefix: string[];
  source: "config" | "venv" | "path" | "py-launcher";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

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
  if (platform() === "win32") {
    // The py launcher + per-user installs live here even when PATH misses them.
    for (const c of [
      join(homedir(), "AppData", "Local", "Programs", "Python", "Launcher", "py.exe"),
      join(homedir(), "AppData", "Local", "Microsoft", "WindowsApps", `${exe}.exe`),
    ]) {
      if (await pathExists(c)) return c;
    }
  }
  return null;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Spawn an interpreter once and collect its output (used for venv/pip ops). */
export function runPython(py: PythonExe, args: string[], opts: { cwd?: string; onLine?: (line: string) => void } = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(py.exe, [...py.argsPrefix, ...args], { cwd: opts.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const onChunk = (buf: string, isErr: boolean) => {
      for (const line of buf.split(/\r?\n/)) if (line.trim()) opts.onLine?.(line);
      return isErr ? (stderr += buf) : (stdout += buf);
    };
    child.stdout.on("data", (d) => onChunk(d.toString(), false));
    child.stderr.on("data", (d) => onChunk(d.toString(), true));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ exitCode: code ?? -1, stdout, stderr }));
  });
}

async function pythonVersion(py: PythonExe): Promise<string> {
  const r = await runPython(py, ["--version"]);
  return (r.stdout.trim() || r.stderr.trim()).replace(/^Python\s+/i, "") || "unknown";
}

/** Verify a candidate is a real interpreter (the WindowsApps python.exe is a
 *  Microsoft Store stub: it is executable, prints an error and exits != 0). */
async function realPython(py: PythonExe): Promise<boolean> {
  try {
    const r = await runPython(py, ["--version"]);
    return r.exitCode === 0 && /Python \d+\.\d+/i.test(r.stdout + r.stderr);
  } catch {
    return false;
  }
}

/** Resolve an interpreter that can create the managed venv. On Windows the
 *  `py` launcher is tried first: it only launches REAL installed Pythons,
 *  while PATH's python.exe may be the Microsoft Store stub. */
export async function resolveBasePython(): Promise<PythonExe> {
  const candidates: PythonExe[] = [];
  if (config.pythonBinPath) {
    if (!(await pathExists(config.pythonBinPath))) {
      throw new EngineError(
        500,
        "ENGINE_NO_PYTHON",
        `Configured PYTHON_BIN_PATH="${config.pythonBinPath}" does not exist or is not executable.`,
      );
    }
    candidates.push({ exe: config.pythonBinPath, argsPrefix: [], source: "config" });
  } else {
    if (platform() === "win32") {
      const py = await findInPath("py");
      if (py) candidates.push({ exe: py, argsPrefix: ["-3"], source: "py-launcher" });
    }
    for (const exe of ["python", "python3"]) {
      const found = await findInPath(exe);
      if (found) candidates.push({ exe: found, argsPrefix: [], source: "path" });
    }
  }
  for (const c of candidates) {
    if (await realPython(c)) return c;
  }
  throw new EngineError(
    500,
    "ENGINE_NO_PYTHON",
    "No working Python interpreter found. Install Python 3.11+ (https://python.org or 'winget install Python.Python.3.13'), " +
      "or set PYTHON_BIN_PATH to a python.exe, or set TWIO_ENGINE_DISABLED=1 to disable engine features. " +
      `(tried: ${candidates.map((c) => c.exe).join(", ") || "none"})`,
  );
}

function requirementsHash(): string {
  if (!existsSync(REQUIREMENTS_PATH)) {
    throw new EngineError(500, "ENGINE_FILES_MISSING", `Missing ${REQUIREMENTS_PATH}`);
  }
  return createHash("sha256").update(readFileSync(REQUIREMENTS_PATH)).digest("hex").slice(0, 16);
}

// --- Public status (non-provisioning) -----------------------------------------

export type SetupPhase = "idle" | "venv" | "deps" | "ready" | "error" | "disabled";

export interface EngineStatus {
  ok: boolean;
  disabled: boolean;
  phase: SetupPhase;
  python: { path: string; source: PythonExe["source"]; version: string } | null;
  venvPath: string;
  depsInstalled: boolean;
  detail: string;
}

let setupState: { phase: SetupPhase; detail: string; python: EngineStatus["python"] } = {
  phase: "idle",
  detail: "engine not initialized yet",
  python: null,
};
let setupPromise: Promise<PythonExe> | null = null;

export async function engineStatus(): Promise<EngineStatus> {
  const disabled = config.engineDisabled;
  const venvReady = existsSync(VENV_PYTHON);
  let want = "";
  try {
    want = requirementsHash();
  } catch {
    /* requirements.txt missing → treated as not installed */
  }
  const depsInstalled = venvReady && want !== "" && existsSync(DEPS_STAMP_PATH) && readFileSync(DEPS_STAMP_PATH, "utf8") === want;
  const ok = disabled ? false : (config.pythonBinPath ? await pathExists(config.pythonBinPath) : venvReady && depsInstalled);
  return {
    ok,
    disabled,
    phase: disabled ? "disabled" : setupState.phase,
    python: setupState.python ?? (config.pythonBinPath
      ? { path: config.pythonBinPath, source: "config", version: "(unverified)" }
      : venvReady && depsInstalled
        ? { path: VENV_PYTHON, source: "venv", version: "installed" }
        : null),
    venvPath: VENV_DIR,
    depsInstalled,
    detail: disabled ? "engine disabled via TWIO_ENGINE_DISABLED" : setupState.detail,
  };
}

// --- Provisioning --------------------------------------------------------------

async function provision(): Promise<PythonExe> {
  if (config.engineDisabled) {
    throw new EngineError(503, "ENGINE_DISABLED", "Python engine disabled (TWIO_ENGINE_DISABLED=1).");
  }
  // Configured interpreter wins — use it directly, skip venv entirely.
  if (config.pythonBinPath) {
    const py = await resolveBasePython();
    const version = await pythonVersion(py);
    setupState = { phase: "ready", detail: `using configured interpreter`, python: { path: py.exe, source: "config", version } };
    return py;
  }

  const venvExe: PythonExe = { exe: VENV_PYTHON, argsPrefix: [], source: "venv" };
  const want = requirementsHash();

  if (existsSync(VENV_PYTHON)) {
    if (existsSync(DEPS_STAMP_PATH) && readFileSync(DEPS_STAMP_PATH, "utf8") === want) {
      const version = await pythonVersion(venvExe);
      setupState = { phase: "ready", detail: "venv ready", python: { path: VENV_PYTHON, source: "venv", version } };
      return venvExe;
    }
    // Venv exists but deps changed/missing → (re)install below.
  } else {
    const base = await resolveBasePython();
    const baseVersion = await pythonVersion(base);
    setupState = { phase: "venv", detail: `creating venv with ${base.exe} (${baseVersion})`, python: null };
    const v = await runPython(base, ["-m", "venv", VENV_DIR]);
    if (v.exitCode !== 0 || !existsSync(VENV_PYTHON)) {
      throw new EngineError(500, "ENGINE_VENV_FAILED", `python -m venv failed (${base.exe}): ${(v.stderr || v.stdout).slice(-800)}`);
    }
  }

  setupState = { phase: "deps", detail: "installing engine dependencies (pip)", python: null };
  await mkdir(VENV_DIR, { recursive: true });
  const pip = await runPython(venvExe, ["-m", "pip", "install", "--disable-pip-version-check", "-r", REQUIREMENTS_PATH], {
    cwd: PYTHON_DIR,
  });
  if (pip.exitCode !== 0) {
    throw new EngineError(
      500,
      "ENGINE_DEPS_FAILED",
      `pip install -r requirements.txt failed: ${(pip.stderr || pip.stdout).split("\n").filter(Boolean).slice(-12).join("\n").slice(-1200)}`,
    );
  }
  writeFileSync(DEPS_STAMP_PATH, want);
  const version = await pythonVersion(venvExe);
  setupState = { phase: "ready", detail: "venv ready", python: { path: VENV_PYTHON, source: "venv", version } };
  return venvExe;
}

/** Resolve the engine interpreter, provisioning the managed venv on first use.
 *  Concurrent callers share one in-flight setup; a failed setup clears the
 *  promise so the next call retries. */
export async function ensureEngine(): Promise<PythonExe> {
  if (!setupPromise) {
    setupPromise = provision().catch((e) => {
      setupState = { phase: "error", detail: (e as Error).message, python: setupState.python };
      setupPromise = null;
      throw e;
    });
  }
  return setupPromise;
}

/** Non-blocking setup kick — used by POST /api/engine/setup. */
export function kickEngineSetup(): void {
  void ensureEngine().catch(() => {/* surfaced via engineStatus() */});
}
