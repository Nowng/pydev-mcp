#!/usr/bin/env node

/**
 * scripts/setupVenv.mjs — LM Studio plugin: python-tools automatic venv setup.
 * 
 * Invoked via `"postinstall": "node scripts/setupVenv.mjs"` in package.json so that
 * when the plugin is installed/pushed to LM Studio, a Python virtual environment is
 * created under <pluginDir>/Workspace/.venv/ and pip/setuptools/wheel are upgraded inside it.
 * 
 * This ensures every MCP tool call (run_python, install_module, etc.) uses an isolated
 * venv python instead of system-wide Python — so `pip install` works for the plugin's
 * own dependencies without touching user system packages.
 * 
 * This is the single, shared venv for every project scaffolded under <pluginDir>/Workspace.
 * Idempotent: if a working .venv already exists it is left alone and only pip upgrade runs.
 */

import { spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { statSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import osModule from "node:os";

const PLUGIN_DIR = process.cwd();
const VENV_NAME  = process.platform === "win32" ? "venv" : ".venv";
const WORKSPACE_DIR = path.join(PLUGIN_DIR, "Workspace");
// Resolved in main() once the default workspace root (<pluginDir>/Workspace) has been established.
let VENV_DIR = path.join(WORKSPACE_DIR, VENV_NAME);

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[setup] ${msg}`); }
function warn(msg) { console.warn(`[setup WARN] ${msg}`); }

/**
 * Persists the default workspace root into .pydev-mcp-config.json (MERGED with any existing config so
 * we never overwrite a previously stored pythonExecutablePath). The TypeScript runtime reads this value
 * as the default workspace root when no explicit "Workspace Folder Path" is set in LM Studio.
 *
 * Writes to BOTH the plugin directory and dist/ directory to handle both:
 *   - Development: plugin runs from source (PLUGIN_DIR)
 *   - Production/LM Studio: plugin runs from dist/ (dist/parent_dir)
 */
async function persistWorkspaceRoot(absWorkspace) {
  // Write to plugin root directory
  const cfgPath = path.join(PLUGIN_DIR, ".pydev-mcp-config.json");
  let existing = {};
  try {
    const raw = await fs.readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
  } catch (_err) {
    existing = {};
  }
  const merged = { ...existing, workspaceRoot: absWorkspace };
  try {
    await fs.writeFile(cfgPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    log(`Persisted default workspace root -> ${absWorkspace} (${cfgPath})`);
  } catch (err) {
    warn(`Failed to persist workspace root to ${cfgPath}: ${err?.message ?? err}`);
  }

  // Also write to dist/ directory for production/LM Studio deployments.
  // LM Studio may unpack the plugin from dist/ into a temp location, so we need
  // a copy here too. This ensures config is found regardless of where the plugin runs from.
  const DIST_DIR = path.join(PLUGIN_DIR, "dist");
  try {
    await fs.mkdir(DIST_DIR, { recursive: true });
    const distCfgPath = path.join(DIST_DIR, ".pydev-mcp-config.json");
    await fs.writeFile(distCfgPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    log(`Persisted default workspace root -> ${absWorkspace} (${distCfgPath})`);
  } catch (err) {
    warn(`Failed to persist workspace root to dist: ${err?.message ?? err}`);
  }
}

async function hasWorkingPip(venvPythonPath) {
  try {
    const r = spawnSync(venvPythonPath, ["-m", "pip", "--version"], { encoding: "utf8" });
    if (r.status === 0 && !r.error) return true;
  } catch (_err) {}
  return false;
}

async function ensurePipInstalled(venvPythonPath, venvDir) {
  // If pip is missing inside the fresh venv, try `ensurepip` first. 
  const r = spawnSync(venvPythonPath, ["-m", "ensurepip"], { encoding: "utf8" });
  if (r.status === 0 && !r.error) return true;
  warn("ensurepip failed — attempting to bootstrap pip via get-pip.py");
  try {
    const tmp = path.join(venvDir, "get-pip-bootstrap.py");
    await fs.writeFile(tmp, `import urllib.request as _u; import sys; data=_u.urlopen('https://bootstrap.pypa.io/get-pip.py').read(); exec(data)`, 'utf8');
    spawnSync(venvPythonPath, [tmp], { stdio: "inherit" });
  } catch (err2) { warn(`pip bootstrap failed: ${err2?.message}`); return false; }
  const ok = await hasWorkingPip(venvPythonPath);
  if (!ok) { try { await fs.rm(tmp, { force: true }); } catch {} }
  return ok;
}

// ── Essential third-party tooling for the MCP tools ────────────────────────────
// The python-tools plugin relies on the following packages that are NOT part of Python's stdlib:
//   * `ruff`        → run_linter_and_formatter, check_for_bugs, check_for_bugs_in_file (lint/format/JSON diagnostics)
//   * `pytest`      → run_tests (pass/fail/skip counts & summary)
//   * `mypy`        → type_check_project (project-wide static type checking)
//   * `coverage`    → run_project_coverage (measures executed lines of code)
//   * `pytest-cov`  → run_project_coverage (integrates coverage into the pytest run)
//   * `bandit`      → scan_project_security (static application security testing / CWE scanning)
//   * `build`       → build_python_package (creates sdist + wheel artifacts: python -m build)
// Everything else the tools use (py_compile, ast.parse, pip) ships with Python itself.
// These must be installed INSIDE the venv so every tool call uses them from <cwd>/.venv.

// Packages the MCP tools depend on that are NOT part of Python's stdlib. Kept in sync with
// setup-venv.sh (see its "essential dev tools" step) and documented in README/skills.
const ESSENTIAL_PACKAGES = ["ruff", "pytest", "mypy", "coverage", "pytest-cov", "bandit", "build"];

async function installEssentialPackages(venvPython) {
  if (!venvPython) {
    warn("Cannot install dev tools — no venv python available.");
    return;
  }

  const hasPip = await hasWorkingPip(venvPython);
  if (!hasPip) {
    warn(`Skipping essential package install — the venv has no working pip. Upgrade pip and rerun setup later.`);
    return;
  }

  log(`Installing essential Python dev tools (${ESSENTIAL_PACKAGES.join(", ")}) into the venv…`);
  try {
    const r = spawnSync(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", ...ESSENTIAL_PACKAGES], { stdio: "inherit" });
    if (r.status !== 0 && !r.error) warn(`pip install of dev tools returned exit=${r.status} (continuing setup)`);
    else log("Installed essential Python dev tools into the venv.");
  } catch (_e) {
    // Never fail setup just because these optional dev tools couldn't be fetched.
    warn(`Failed to auto-install dev tools (${ESSENTIAL_PACKAGES.join(", ")}) — you can install them later with: pip install ${ESSENTIAL_PACKAGES.join(" ")}`);
  }

  await verifyEssentialPackages(venvPython);
}

/**
 * Verify that each essential package is importable / present in the venv and print a checklist.
 * `ruff` (a CLI) is checked via `python -m ruff --version`; the rest are checked by importing them.
 */
async function verifyEssentialPackages(venvPython) {
  if (!(await hasWorkingPip(venvPython))) {
    warn("Skipping package verification — the venv has no working pip.");
    return;
  }

  log("Verifying installed dev tools…");

  const modulePkgs = ["pytest", "mypy", "coverage", "pytest_cov", "bandit", "build"];
  for (const mod of modulePkgs) {
    const r = spawnSync(venvPython, ["-c", `import importlib.util as _u; print(_u.find_spec("${mod}") is not None)`], { encoding: "utf8" });
    const ok = r && r.status === 0 && !r.error && String(r.stdout).trim().toLowerCase() === "true";
    log(ok ? `[ok]      ${mod} installed` : `[missing] ${mod} NOT found — install it later with: pip install ${mod === "pytest_cov" ? "pytest-cov" : mod}`);
  }

  // ruff is primarily a CLI; confirm it runs.
  const ruff = spawnSync(venvPython, ["-m", "ruff", "--version"], { encoding: "utf8" });
  const ruffOk = ruff && ruff.status === 0 && !ruff.error && /ruff/i.test(String(ruff.stdout + ruff.stderr));
  log(ruffOk ? `[ok]      ruff installed` : `[missing] ruff NOT found — install it later with: pip install ruff`);
}

// ── Detect best system Python (prefer absolute path so symlinks/snapshots work on containers). ───

async function findBestSystemPython() {
  // Strategy A — probe via sys.executable to get the real binary path.
  const candidates = process.platform === "win32"
    ? [ ["py", ["-3"]], ["python.exe"], ["python3.exe"]]
    : [ ["python3.14"], ["python3.13"], ["python3.12"], ["python3.11"], ["python3.10"], ["python3"], ["python"] ];

  for (const c of candidates) {
    const r = spawnSync(c[0], [...c.slice(1), "-c", "import sys; print(sys.executable, end='')"]);
    if (r.status === 0 && !r.error && r.stdout.length > 2) {
      return { cmd: c[0], prefix: c.slice(1), resolvedPath: String(r.stdout).trim() };
    }
  }

  // Strategy B — scan known absolute paths on Unix/macOS.
  if (process.platform !== "win32") {
    const home = osModule.homedir();
    for (const p of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].concat(
      home ? [`/home/${home}/miniconda3/bin/python3`, `/home/${home}/anaconda3/bin/python3`] : []
    )) {
      if (!existsSync(p)) continue;
      const r = spawnSync(p, ["--version"], { encoding: "utf8" });
      if (r.status === 0 && !r.error) return { cmd: p, prefix: [], resolvedPath: p };
    }
  }

  // Strategy C — on Linux look for any python3.* binary in /usr/bin or /usr/local/bin.
  if (process.platform === "linux") {
    const candidates = [];
    try {
      for (const d of ["/usr/bin", "/usr/local/bin"]) {
        const entries = await fs.readdir(d);
        for (const e of entries) {
          if (/^python3\.(\\d+)$/.test(e)) candidates.push(path.join(d, e));
        }
      }
    } catch {}
    // Prefer highest minor version first.
    candidates.sort((a,b) => { const ma = +/\\d+$/.exec(a)?.[0]||0; const mb = +/\\d+$/.exec(b)?.[0]||0; return mb-ma; });
    for (const p of candidates.slice(0, 4)) {
      try {
        await fs.access(p);
        const r = spawnSync(p, ["--version"], { encoding: "utf8" });
        if (r.status === 0 && !r.error) return { cmd: p, prefix: [], resolvedPath: p };
      } catch {}
    }
  }

  warn("No usable system Python found. Install Python 3.x before running this setup.");
  return null;
}

// ── Main flow ────────────────────────────────────────────────────────────────

async function main() {
  log(`Plugin directory: ${PLUGIN_DIR}`);

  // (v2.3) Establish the default workspace root (<pluginDir>/Workspace) BEFORE creating the venv,
  // persist it for the TS runtime, and locate the venv inside it. This keeps the venv scoped under
  // the workspace root that config.ts / safePaths.ts resolve as the default.
  try {
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  } catch (err) {
    warn(`Could not create Workspace directory ${WORKSPACE_DIR}: ${err?.message ?? err}`);
  }
  const absWorkspace = path.resolve(WORKSPACE_DIR);
  VENV_DIR = path.join(absWorkspace, VENV_NAME);
  await persistWorkspaceRoot(absWorkspace);

  log(`Default workspace root: ${absWorkspace}`);
  log(`Venv will be at:   ${VENV_DIR}`);

  const best = await findBestSystemPython();
  if (!best) process.exit(10); // explicit code so install-state can differentiate.

  log(`Using system python: ${best.resolvedPath} (${await probeVersion(best)})`);

  // --- Copy profiling_worker_main.py to venv bin directory for subprocess invocation ────
  // The worker script must exist in the venv's bin directory so that when tools spawn it
  // via child_process.spawn, the path resolves correctly within the venv environment.
  const PROFILING_WORKER_SRC = path.join(PLUGIN_DIR, "src", "tools", "_profiling_worker_main.py");
  const VENV_BIN_DIR = path.join(VENV_DIR, "bin");
  
  if (!existsSync(PROFILING_WORKER_SRC)) {
    warn(`_profiling_worker_main.py not found at ${PROFILING_WORKER_SRC} — skipping copy step.`);
  } else {
    // Ensure the venv bin directory exists
    try { mkdirSync(VENV_BIN_DIR, { recursive: true }); } catch (_err) {}
    
    if (!existsSync(PROFILING_WORKER_SRC)) {
      warn(`_profiling_worker_main.py still not found after ensuring directory: ${PROFILING_WORKER_SRC}`);
    } else {
      log("Copying _profiling_worker_main.py to venv bin directory…");
      try {
        await fs.copyFile(PROFILING_WORKER_SRC, path.join(VENV_BIN_DIR, "_profiling_worker_main.py"));
        log(`✓ Copied ${PROFILING_WORKER_SRC} -> ${path.join(VENV_BIN_DIR, "_profiling_worker_main.py")}`);
      } catch (err) {
        warn(`Failed to copy _profiling_worker_main.py: ${err?.message ?? err}`);
      }
    }
  }

  // --- Create fresh venv using the ABSOLUTE resolved python path to avoid symlink issues on containers ---
  try { await fs.mkdir(VENV_DIR, { recursive: true }); } catch {}

  const createResult = spawnSync(best.resolvedPath, ["-m", "venv", VENV_DIR], { stdio: "inherit" });
  if (createResult.status !== 0) { warn(`venv creation failed with exit=${createResult.status}`); process.exit(10); }

  // Verify pip is actually present and functional inside the fresh venv. If it's broken, fix it now.
  const hasPip = await hasWorkingPip(path.join(VENV_DIR, "bin", "python3"));
  if (!hasPip) {
    log("Bootstrapping pip into venv (ensurepip)…");
    spawnSync(path.join(VENV_DIR, "bin", "python3"), ["-m", "ensurepip"], { stdio: "inherit" });
    await ensurePipInstalled(path.join(VENV_DIR, "bin", "python3"), VENV_DIR);
  }

  log("Upgrading pip/setuptools/wheel in venv…");
  const upgraded = await hasWorkingPip(path.join(VENV_DIR, "bin", "python3"));
  if (upgraded) {
    try { spawnSync(path.join(VENV_DIR, "bin", "python3"), ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], { stdio: "inherit" }); } catch {} // non-fatal.
  } else {
    warn("No pip found in venv — please install one manually or rerun setup later.");
  }

  await installEssentialPackages(path.join(VENV_DIR, "bin", "python3"));

  log(`Done! Activate with:`);
  if (process.platform === "win32") log(`   ${VENV_DIR}\\Scripts\\activate`);
  else                         log(`   source ${path.join(VENV_DIR, "bin", "activate")}`);
}

async function probeVersion(pythonInfo) {
  try {
    const r = spawnSync(pythonInfo.resolvedPath, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && !r.error) return String(r.stdout).trim() || "unknown";
  } catch {}
  return "unknown version";
}

main().catch(err => { console.error("[setup] Unhandled error:", err?.message ?? String(err)); process.exit(1); });
