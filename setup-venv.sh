#!/usr/bin/env bash
# setup-venv.sh — Manual helper to create a .venv inside the plugin's default Workspace/ directory
# (shared by all projects). Kept in lockstep with scripts/setupVenv.mjs: same venv location, same
# Python version detection, and same essential dev-tool packages (ruff, pytest, mypy, coverage,
# pytest-cov, bandit, build).
# Run this after cloning/forking or when you want explicit control over venv creation.
# The TypeScript code will auto-detect and use the venv if present, so running
# `lms dev` / installing from LM Studio Hub normally does NOT require manual setup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_NAME=".venv"
# v2.3: the venv is created inside the plugin's default Workspace/ directory, matching scripts/setupVenv.mjs.
WORKSPACE_DIR="${SCRIPT_DIR}/Workspace"
VENV_PATH="${WORKSPACE_DIR}/${VENV_NAME}"

echo "=== python-tools venv setup ==="
echo "Workspace root:    ${WORKSPACE_DIR}"
echo "Venv path:         ${VENV_PATH}"
echo ""

# v2.3: persist the default workspace root so the TypeScript runtime uses <pluginDir>/Workspace as its
# default. Merged with any existing .pydev-mcp-config.json (never overwrites pythonExecutablePath).
echo "[setup] Persisting default workspace root -> ${WORKSPACE_DIR} ..."
node -e '
  const fs = require("fs");
  const f = process.argv[1], ws = process.argv[2];
  let ex = {};
  try { ex = JSON.parse(fs.readFileSync(f, "utf8")) || {}; } catch (_) { ex = {}; }
  if (typeof ex !== "object" || ex === null || Array.isArray(ex)) ex = {};
  ex.workspaceRoot = ws;
  fs.writeFileSync(f, JSON.stringify(ex, null, 2) + "\n");
  console.log("   persisted workspaceRoot=" + ws);
' "${SCRIPT_DIR}/.pydev-mcp-config.json" "${WORKSPACE_DIR}" || echo "[warn] could not persist workspace root (continuing)"
echo ""

# --- 1. Detect system Python on PATH (prefer versioned commands, resolve symlinks). ---
PYTHON_CMD=""
for candidate in python3.14 python3.13 python3.12 python3 python; do
    if command -v "$candidate" &> /dev/null; then
        PYTHON_CMD="$candidate"
        break
    fi
done

if [[ -z "${PYTHON_CMD}" ]]; then
    echo "ERROR: No `python` or `python3*` found on PATH." >&2
    echo "Install Python 3.10+ first, e.g.:" >&2
    echo "" >&2
    echo "   macOS (Homebrew): brew install python" >&2
    echo "   Ubuntu/Debian:    sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip" >&2
    echo "   Fedora/RHEL:      sudo dnf install -y python3 python3-venv" >&2
    exit 1
fi

# Resolve symlinks so we use the real binary (avoids venv failures on containerized Python).
REAL_PYTHON="$(command -p readlink -f "$(command -v "${PYTHON_CMD}")")"
if [[ ! -x "${REAL_PYTHON}" ]]; then
    REAL_PYTHON="${PYTHON_CMD}" # Fall back to command name if realpath failed.
fi

echo "[detected] system Python: ${REAL_PYTHON} ($( "$REAL_PYTHON" --version 2>&1 ))"

# --- 2. Create the Workspace root and the venv inside it (if it does not exist yet) ---
mkdir -p "$WORKSPACE_DIR"
if [ ! -d "$VENV_PATH" ]; then
    echo "Creating virtual environment at ${VENV_PATH} ..."
    "${REAL_PYTHON}" -m venv "${VENV_PATH}"
else
    echo "[existing] Virtual environment already present at ${VENV_PATH}."
fi

# --- 3. Determine venv python executable (Linux/macOS: bin/python3; Windows would be Scripts/python.exe) ---
if [[ "$(uname)" == "Darwin" || "$(uname)" == "Linux" ]]; then
    VENV_PYTHON="${VENV_PATH}/bin/python3"
else
    # Defensive fallback for unknown/Windows-like systems.
    if [ -f "${VENV_PATH}/Scripts/python.exe" ]; then
        VENV_PYTHON="${VENV_PATH}/Scripts/python.exe"
    else
        VENV_PYTHON="${VENV_PATH}/bin/python3"
    fi
fi

# --- 4. Upgrade pip/setuptools/wheel inside the venv so that `pip install` works reliably ---
echo "Upgrading pip, setuptools and wheel in ${VENV_NAME} ..."
"${VENV_PYTHON}" -m pip install --upgrade --quiet pip setuptools wheel

# --- 5. Install the essential Python dev tools used by the MCP tools ---
# These are NOT part of Python's stdlib and must be installed inside the venv:
#   ruff (lint/format/bug-checks), pytest (tests), mypy (type checking),
#   coverage + pytest-cov (code coverage via run_project_coverage),
#   bandit (static security scanning via scan_project_security),
#   build (Python packaging via build_python_package).
echo "Installing essential Python dev tools in ${VENV_NAME} ..."
"${VENV_PYTHON}" -m pip install --quiet --upgrade ruff pytest mypy coverage pytest-cov bandit build || \
    echo "[warn] Could not auto-install some packages (maybe offline). Install them later with: ${VENV_PYTHON} -m pip install ruff pytest mypy coverage pytest-cov bandit build"

# --- 5b. Verify the essential dev tools are importable in the venv ---
echo "Verifying installed dev tools ..."
"${VENV_PYTHON}" - <<'PY'
import importlib.util as u
mods = ["pytest", "mypy", "coverage", "pytest_cov", "bandit", "build"]
for m in mods:
    print(("[ok]   " if u.find_spec(m) is not None else "[missing]"), m)
ruff = __import__("subprocess").run(["${VENV_PYTHON}", "-m", "ruff", "--version"], capture_output=True, text=True)
print(("[ok]   " if ruff.returncode == 0 else "[missing]"), "ruff")
PY

# --- 5. Verify the new interpreter reports a sensible version ---
VERSION=$("${VENV_PYTHON}" --version 2>&1)
echo ""
echo "=== Done! ==="
echo "Python in venv: ${VERSION} (${VENV_PYTHON})"
echo "Activate with:  source ${VENV_PATH}/bin/activate"
echo "Run plugin:     lms dev   (the TypeScript code auto-uses .venv/bin/python)"

# --- 5b. Copy profiling_worker_main.py to venv bin directory for subprocess invocation ---
# The worker script must exist in the venv's bin directory so that when tools spawn it
# via child_process.spawn, the path resolves correctly within the venv environment.
PROFILING_WORKER_SRC="${SCRIPT_DIR}/src/tools/_profiling_worker_main.py"
VENV_BIN_DIR="${VENV_PATH}/bin"

if [ -f "${PROFILING_WORKER_SRC}" ]; then
    echo "[setup] Copying _profiling_worker_main.py to venv bin directory..."
    mkdir -p "${VENV_BIN_DIR}"
    cp "${PROFILING_WORKER_SRC}" "${VENV_BIN_DIR}/_profiling_worker_main.py" 2>/dev/null || true
    if [ -f "${VENV_BIN_DIR}/_profiling_worker_main.py" ]; then
        echo "[setup] ✓ Copied _profiling_worker_main.py -> ${VENV_BIN_DIR}/_profiling_worker_main.py"
    else
        echo "[setup WARN] Failed to copy _profiling_worker_main.py (check permissions)"
    fi
else
    echo "[setup WARN] _profiling_worker_main.py not found at ${PROFILING_WORKER_SRC} — skipping copy step."
fi
