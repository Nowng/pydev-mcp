/**
 * pythonVenv.ts — Venv (virtual environment) management utilities.
 * 
 * Detects and creates a `.venv` directory under the plugin's working directory,
 * so that pip-installed packages are available to all MCP tools without affecting
 * system-wide Python installations.
 */

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Returns the venv python executable path, or null if no usable venv is found at `cwd/.venv/`.
 * 
 * Linux/macOS convention:   `<cwd>/.venv/bin/python3` (or `python`)
 * Windows convention:        `<cwd>/venv/Scripts/python.exe`  or `<cwd>/.venv/...`
 */
export function getVenvPythonPath(cwd: string): string | null {
  const candidatePaths = getVenvCandidatePaths(cwd);

  for (const candidate of candidatePaths) {
    if (candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}

/**
 * Returns possible venv python executable paths for a given cwd.
 */
export function getVenvCandidatePaths(cwd: string): Array<string> {
  const candidates: Array<string> = [];

  if (process.platform === "win32") {
    // Windows convention uses `venv/` rather than `.venv/`.
    candidates.push(path.join(cwd, "venv", "Scripts", "python.exe"));
    candidates.push(path.join(cwd, ".venv", "Scripts", "python.exe"));
  } else {
    // Linux / macOS convention uses `.venv/` with `bin/python3`.
    candidates.push(path.join(cwd, ".venv", "bin", "python3"));
    candidates.push(path.join(cwd, ".venv", "bin", "python"));
  }

  return dedupeStrings(candidates);
}

export interface VenvStatus {
  exists: boolean;
  pythonPath: string | null;
  version: string | null;
  usable: boolean;
}

/**
 * Probes a venv directory to determine if it is present and functional.
 */
export async function probeVenvStatus(cwd: string): Promise<VenvStatus> {
  const pythonPath = getVenvPythonPath(cwd);

  if (pythonPath === null) {
    return { exists: false, pythonPath: null, version: null, usable: false };
  }

  try {
    await fs.access(pythonPath);
  } catch (_err) {
    // File does not exist or is inaccessible.
    return { exists: false, pythonPath: null, version: null, usable: false };
  }

  const result = await probeExecutableVersion(pythonPath);
  return {
    exists: true,
    pythonPath,
    version: result.version ?? null,
    usable: result.usable,
  };
}

export interface VenvSetupResult {
  success: boolean;
  venvPath?: string | null;
  error?: string | null;
}

/**
 * Creates a Python venv at `<cwd>/.venv/` (or `./venv/` on Windows) using the best available system Python.
 * After creation, upgrades pip/setuptools/wheel inside the new venv so that packages can be installed reliably.
 * Also copies _profiling_worker_main.py to the venv's bin directory for subprocess invocation.
 */
export async function setupVenv(cwd: string): Promise<VenvSetupResult> {
  // --- Detect a working absolute python path (more reliable than generic commands on symlinks / containers). ---
  const resolvedPythonPath = await resolveBestSystemPython();

  if (!resolvedPythonPath) {
    return { success: false, error: "No usable system Python found." };
  }

  // Skip setup if a working venv already exists.
  try {
    const status = await probeVenvStatus(cwd);
    if (status.usable && status.pythonPath !== null) {
      return { success: true, venvPath: resolvedPythonPath };
    }
  } catch (_err) { /* ignore; proceed to create */ }

  // --- Create the venv at <cwd>/.venv/ or <cwd>/venv/ depending on platform. ---
  const parentDir = process.platform === "win32" ? path.join(cwd, "venv") : path.join(cwd, ".venv");

  const venvCreationResult = await spawnProcess(resolvedPythonPath, ["-m", "venv", parentDir], 60);

  if (venvCreationResult.spawnFailed || venvCreationResult.result.timedOut) {
    return { success: false, error: `Unable to create venv at ${parentDir}.` };
  }

  // Verify the new python executable is present.
  const newVenvPython = getVenvPythonPath(cwd);
  if (newVenvPython === null) {
    return { success: false, error: "venv created but no expected python executable was found." };
  }

  // --- Upgrade pip inside the venv so that `pip install` works reliably. ---
  const upgradeResult = await spawnProcess(
    newVenvPython,
    ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"],
    120,
  );

  if (upgradeResult.spawnFailed || upgradeResult.result.timedOut) {
    // venv itself is usable; the pip upgrade failure does not make setup fail.
    return { success: true, venvPath: newVenvPython };
  }

  // --- Copy profiling_worker_main.py to venv bin directory for subprocess invocation ---
  const PROFILING_WORKER_SRC = path.join(process.cwd(), "src", "tools", "_profiling_worker_main.py");
  const VENV_BIN_DIR = path.join(cwd, ".venv", "bin");

  if (existsSync(PROFILING_WORKER_SRC)) {
    try {
      await fs.mkdir(VENV_BIN_DIR, { recursive: true });
      await fs.copyFile(PROFILING_WORKER_SRC, path.join(VENV_BIN_DIR, "_profiling_worker_main.py"));
      console.log(`[setup] ✓ Copied _profiling_worker_main.py -> ${path.join(VENV_BIN_DIR, "_profiling_worker_main.py")}`);
    } catch (err) {
      console.warn(`[setup WARN] Failed to copy _profiling_worker_main.py: ${(err as Error).message}`);
    }
  } else {
    console.warn(`[setup WARN] _profiling_worker_main.py not found at ${PROFILING_WORKER_SRC} — skipping copy step.`);
  }

  return { success: true, venvPath: newVenvPython };
}

/**
 * Finds a reliable system Python executable path on this machine — prefers absolute paths so it works even when python3 is only a symlink or shim.
 */
async function resolveBestSystemPython(): Promise<string | null> {
  // Strategy A: try common commands but capture sys.executable (which gives the real underlying binary).
  const candidates = process.platform === "win32"
    ? [
        { cmd: "py", prefix: ["-3"] },
        { cmd: "python.exe", prefix: [] as string[] },
      ]
    : [
        { cmd: "python3.14", prefix: [] as string[] },
        { cmd: "python3.13", prefix: [] as string[] },
        { cmd: "python3.12", prefix: [] as string[] },
        { cmd: "python3", prefix: [] as string[] },
        { cmd: "python", prefix: [] as string[] },
      ];

  for (const c of candidates) {
    const result = await spawnProcess(c.cmd, [...c.prefix, "-c", "import sys; print(sys.executable)"], 5);
    if (!result.spawnFailed && !result.result.timedOut && result.result.exitCode === 0) {
      const executableUsed = result.result.stdout.trim();
      // Resolve symlinks so we always use the real binary path.
      try {
        const resolvedPath = await fs.realpath(executableUsed);
        if (resolvedPath.length > 0) return resolvedPath;
      } catch (_err2) { /* keep original */ }

      if (executableUsed.length > 0) return executableUsed;
    }
  }

  // Strategy B: try known absolute paths directly.
  for (const directPath of getGenericDirectPaths()) {
    const result = await spawnProcess(directPath, ["--version"], 3);
    if (!result.spawnFailed && !result.result.timedOut && result.result.exitCode === 0) {
      try {
        return await fs.realpath(directPath);
      } catch (_err3) { /* keep original */ }
      return directPath;
    }
  }

  // Strategy C: scan /usr/bin and /usr/local/bin for python* executables.
  const scanned = await scanPythonBinaries();
  if (scanned !== null) return scanned;

  return null;
}

/**
 * Scans `/usr/bin` and `/usr/local/bin` for any `python3.*`, `python3`, or `python` binary that can report a version.
 */
async function scanPythonBinaries(): Promise<string | null> {
  const candidates = dedupeStrings([
    "/opt/homebrew/bin/python3",
    "/opt/homebrew/bin/python",
    "/usr/local/bin/python3",
    "/usr/local/bin/python",
    "/usr/bin/python3",
    "/usr/bin/python",
    ...getPyenvShims(),
  ]);

  for (const p of candidates) {
    try {
      await fs.access(p);
      const result = await spawnProcess(p, ["--version"], 2);
      if (!result.spawnFailed && !result.result.timedOut && result.result.exitCode === 0) {
        return p;
      }
    } catch (_err4) { /* try next */ }
  }

  // If /usr/bin/python3 is a symlink that fails on its own, still consider it usable by following the link. 
  for (const p of candidates) {
    if (p.startsWith("/opt/homebrew") || p.startsWith("/usr/local/") || p.startsWith("/usr/bin/")) {
      try {
        const resolved = await fs.realpath(p);
        const result = await spawnProcess(resolved, ["--version"], 2);
        if (!result.spawnFailed && !result.result.timedOut && result.result.exitCode === 0) {
          return p; // Return the symlink itself so user tools see a stable name.
        }
      } catch (_err5) { /* skip */ }
    }
  }

  return null;
}

function getPyenvShims(): string[] {
  const home = os.homedir();
  if (!home || process.platform !== "linux" && process.platform !== "darwin") return [];
  // Note: pyenv is only common on dev machines; skip in CI/containers.
  try {
    void fs.access(home);
    return [path.join(home, ".pyenv/shims/python3"), path.join(home, ".pyenv/shims/python")];
  } catch (_err) {
    return [];
  }
}

async function probeExecutableVersion(executablePath: string): Promise<{ version: string | null; usable: boolean }> {
  const result = await spawnProcess(executablePath, ["--version"], 3);

  if (result.spawnFailed || result.result.timedOut) {
    return { version: null, usable: false };
  }

  if (result.result.exitCode !== 0) {
    return { version: null, usable: false };
  }

  const combined = `${result.result.stdout}${result.result.stderr}`.trim();
  if (!combined.toLowerCase().startsWith("python ")) {
    return { version: null, usable: false };
  }

  return { version: combined, usable: true };
}

function getGenericDirectPaths(): string[] {
  const home = os.homedir() ?? "";
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "";
    return dedupeStrings([
      path.join(localAppData, "Python", "pythoncore-3.14-64", "python.exe"),
      path.join(localAppData, "Python", "pythoncore-3.13-64", "python.exe"),
      path.join(programFiles, "Python314", "python.exe"),
    ].filter((p) => p.length > 0));
  }

  return dedupeStrings([
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    path.join(home, ".pyenv/shims/python3"),
    path.join(home, "miniconda3/bin/python3"),
    path.join(home, "anaconda3/bin/python3"),
  ].filter((p) => p.length > 0));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function spawnProcess(executable: string, args: string[], timeoutSeconds: number): Promise<{ spawnFailed: true } | { spawnFailed: false; result: PythonProcessResult }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ spawnFailed: true });
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ spawnFailed: false, result: { stdout, stderr, exitCode, timedOut } });
    });
  });
}

export interface PythonProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}
