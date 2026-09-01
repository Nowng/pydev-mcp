/**
 * pythonEnvironmentInfo.ts — Gathers a snapshot of the active Python runtime environment.
 *
 * Used by the `inspect_environment` MCP tool so an LLM can quickly confirm which
 * interpreter is active, whether it is a virtualenv, how many packages are installed,
 * and a few key environment variables — without having to remember shell commands.
 */

import { resolvePythonCommand, runResolvedPythonCommand } from "./pythonResolver";

export interface EnvironmentInfo {
  /** Absolute path to the executable that ran the code (the venv python when available). */
  pythonExecutable: string;
  /** Short version such as "3.14.4". */
  pythonVersion: string;
  /** Full multi-line-safe version string from sys.version. */
  pythonFullVersion: string;
  /** True when running inside a virtualenv / venv / conda env. */
  inVirtualEnv: boolean;
  /** The active environment prefix path, or null when not inside one. */
  venvPath: string | null;
  /** Number of third-party packages reported by the interpreter's metadata. */
  installedPackagesCount: number;
  /** A curated subset of relevant environment variables (only those that are set). */
  keyEnvironmentVariables: Record<string, string>;
}

/**
 * Inline Python script that prints a single JSON object describing the runtime.
 * Kept dependency-free (uses stdlib only) so it runs even when pip/importlib.metadata is partial.
 */
const ENV_INFO_SCRIPT = `import sys, json

def _safe(fn, default):
    try:
        return fn()
    except Exception:
        return default

installed = []
try:
    from importlib.metadata import distributions
    for d in distributions():
        name = _safe(lambda: d.metadata["Name"], None)
        if name:
            installed.append(name)
except Exception:
    pass

# Fall back to pip list metadata names when importlib.metadata gave us nothing.
if not installed:
    try:
        import subprocess
        out = subprocess.run(
            [sys.executable, "-m", "pip", "list", "--format=json"],
            capture_output=True, text=True,
        )
        if out.returncode == 0:
            parsed = json.loads(out.stdout or "[]")
            installed = [p.get("name") for p in parsed if isinstance(p, dict) and p.get("name")]
    except Exception:
        pass

prefix = sys.prefix
base_prefix = getattr(sys, "base_prefix", None) or prefix
in_venv = base_prefix != prefix

key_env = {}
for key in ("VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH", "PYTHON_TOOLS_WORKSPACE"):
    val = _safe(lambda k=key: __import__("os").environ.get(k), None)
    if val is not None and str(val).strip() != "":
        key_env[key] = str(val)

short_version = str(sys.version_info.major)
if getattr(sys.version_info, "minor", None) is not None:
    short_version += "." + str(sys.version_info.minor)
if getattr(sys.version_info, "micro", None) is not None:
    short_version += "." + str(sys.version_info.micro)

payload = {
    "pythonExecutable": sys.executable,
    "pythonVersion": short_version,
    "pythonFullVersion": sys.version.replace("\\n", " ").strip(),
    "inVirtualEnv": bool(in_venv),
    "venvPath": prefix if in_venv else None,
    "installedPackagesCount": len(installed),
    "keyEnvironmentVariables": key_env,
}
print(json.dumps(payload))
`;

/**
 * Returns a snapshot of the active Python environment as seen through the resolved interpreter.
 * Never throws: on any failure it returns best-effort values derived from the resolved command.
 */
export async function getEnvironmentInfo(): Promise<EnvironmentInfo> {
  let pythonExecutable = "python";

  try {
    const cmd = await resolvePythonCommand();
    pythonExecutable = cmd.pythonExecutableUsed || pythonExecutable;

    const result = await runResolvedPythonCommand(cmd, ["-c", ENV_INFO_SCRIPT], 30);

    if (result.exitCode === 0 && !result.timedOut) {
      const raw = (result.stdout ?? "").trim();
      if (raw.length > 0) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          return buildInfo(parsed, pythonExecutable);
        } catch {
          // Fall through to best-effort below.
        }
      }
    }
  } catch (_err) {
    /* fall through */
  }

  // Best-effort fallback when the interpreter could not run our script.
  return {
    pythonExecutable,
    pythonVersion: "unknown",
    pythonFullVersion: "Unable to determine Python version.",
    inVirtualEnv: false,
    venvPath: null,
    installedPackagesCount: 0,
    keyEnvironmentVariables: {},
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function buildInfo(parsed: Record<string, unknown>, fallbackExecutable: string): EnvironmentInfo {
  const inVenv = parsed.inVirtualEnv === true;

  return {
    pythonExecutable: asString(parsed.pythonExecutable) ?? fallbackExecutable,
    pythonVersion: asString(parsed.pythonVersion) ?? "unknown",
    pythonFullVersion: asString(parsed.pythonFullVersion) ?? "unknown",
    inVirtualEnv: inVenv,
    venvPath: inVenv ? (asString(parsed.venvPath) ?? null) : null,
    installedPackagesCount: typeof parsed.installedPackagesCount === "number" ? parsed.installedPackagesCount : 0,
    keyEnvironmentVariables:
      parsed.keyEnvironmentVariables && typeof parsed.keyEnvironmentVariables === "object"
        ? (parsed.keyEnvironmentVariables as Record<string, string>)
        : {},
  };
}
