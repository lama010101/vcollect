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

// --- Separation extras (stem splitting) ----------------------------------------
// Stem splitting keeps its own install set OUT of the base requirements: torch
// + demucs are ~600 MB and only needed when a user asks for HQ separation.
// Install goes into the SAME managed venv, stamped by a hash of the package
// spec so a spec bump reinstalls exactly once.

export const SEP_STAMP_PATH = join(VENV_DIR, ".sep-deps-sha256");
const SEP_SPEC = "torch>=2.6,<3|torchaudio>=2.6,<3|demucs>=4.1,<5|cpu";

export type SepSetupPhase = "idle" | "engine" | "torch" | "demucs" | "ready" | "error";
let sepSetupState: { phase: SepSetupPhase; detail: string } = { phase: "idle", detail: "" };
let sepSetupPromise: Promise<void> | null = null;

function sepSpecHash(): string {
  return createHash("sha256").update(SEP_SPEC).digest("hex");
}

/** Separation status — stamp file present = extras installed (lazy probe; the
 *  real check runs in the worker via `sep_status` when a job starts). */
export function sepStatus(): { installed: boolean; phase: SepSetupPhase; detail: string } {
  const installed = existsSync(SEP_STAMP_PATH) && readFileSync(SEP_STAMP_PATH, "utf8") === sepSpecHash();
  return {
    installed,
    phase: installed && sepSetupState.phase !== "error" ? "ready" : sepSetupState.phase,
    detail: installed ? "separation extras installed" : sepSetupState.detail,
  };
}

async function provisionSeparation(): Promise<void> {
  sepSetupState = { phase: "engine", detail: "ensuring the engine venv" };
  const venvExe = await ensureEngine(); // creates + provisions the venv first
  if (existsSync(SEP_STAMP_PATH) && readFileSync(SEP_STAMP_PATH, "utf8") === sepSpecHash()) {
    sepSetupState = { phase: "ready", detail: "separation extras installed" };
    return;
  }
  // CPU wheels first — the default PyPI torch on Windows pulls the ~2.4 GB
  // CUDA build; the pytorch.org CPU index gives ~190 MB. torchaudio must match.
  sepSetupState = { phase: "torch", detail: "installing torch (CPU wheels, ~190 MB)" };
  const t = await runPython(venvExe, [
    "-m", "pip", "install", "--disable-pip-version-check",
    "--index-url", "https://download.pytorch.org/whl/cpu",
    "torch>=2.6,<3", "torchaudio>=2.6,<3",
  ]);
  if (t.exitCode !== 0) {
    throw new EngineError(500, "SEP_TORCH_FAILED", `pip install torch (cpu) failed: ${(t.stderr || t.stdout).split("\n").filter(Boolean).slice(-10).join("\n").slice(-1000)}`);
  }
  sepSetupState = { phase: "demucs", detail: "installing demucs (~80 MB + deps)" };
  const d = await runPython(venvExe, ["-m", "pip", "install", "--disable-pip-version-check", "demucs>=4.1,<5"]);
  if (d.exitCode !== 0) {
    throw new EngineError(500, "SEP_DEMUCS_FAILED", `pip install demucs failed: ${(d.stderr || d.stdout).split("\n").filter(Boolean).slice(-10).join("\n").slice(-1000)}`);
  }
  writeFileSync(SEP_STAMP_PATH, sepSpecHash());
  sepSetupState = { phase: "ready", detail: "separation extras installed" };
}

export async function ensureSeparation(): Promise<void> {
  if (!sepSetupPromise) {
    sepSetupPromise = provisionSeparation().catch((e) => {
      sepSetupState = { phase: "error", detail: (e as Error).message };
      sepSetupPromise = null;
      throw e;
    });
  }
  return sepSetupPromise;
}

/** Non-blocking kick — used by POST /api/visualizer/sep-setup. */
export function kickSeparationSetup(): void {
  void ensureSeparation().catch(() => {/* surfaced via sepStatus() */});
}
