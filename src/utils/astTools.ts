/**
 * astTools.ts — shared runner for the self-contained Python AST helper scripts under
 * `.pydev-tools/_ast/`. Each helper emits a JSON document on stdout; this module resolves
 * the active Python interpreter (venv-aware), spawns the helper, parses its JSON output, and
 * always resolves (never rejects) so MCP tool callers can degrade gracefully.
 */

import { spawnChild } from "./childProcessHelper";
import { resolvePythonCommand, type PythonCommand } from "./pythonResolver";
import path from "node:path";

export interface AstToolRunOptions {
  /** Working directory for the helper process (typically a workspace/target path). */
  cwd?: string;
  /** Overall timeout in seconds. Defaults to 30. */
  timeoutSeconds?: number;
}

export interface AstToolRunResult {
  ok: boolean;
  error?: string;
  stdout: string;
  raw: Record<string, unknown>;
}

/**
 * Runs a single Python AST helper script and returns its parsed JSON output.
 * @param script path to the `.py` helper (e.g. "rename.py").
 * @param args   CLI arguments appended after the script name.
 */
export async function runAstHelper(
  script: string,
  args: string[],
  opts: AstToolRunOptions = {},
): Promise<AstToolRunResult> {
  const timeoutMs = Math.max(5000, (opts.timeoutSeconds ?? 30) * 1000);

  let cmd: PythonCommand;
  try {
    cmd = await resolvePythonCommand();
  } catch (_err) {
    return { ok: false, error: "Could not resolve a Python interpreter.", stdout: "", raw: {} };
  }

  // argsPrefix (e.g. ["-m", "pytest"]) precedes the script; the script then its CLI args.
  // Resolve the helper to an ABSOLUTE path so it is found regardless of opts.cwd, and run
  // from the plugin root (process.cwd()) so any relative target paths passed as CLI args
  // resolve correctly against the workspace root instead of a nested cwd.
  const fullArgs = [...cmd.argsPrefix, path.resolve(process.cwd(), script), ...args];

  const outcome = await spawnChild(cmd.pythonExecutableUsed, fullArgs, timeoutMs, process.cwd());
  if (outcome.spawnFailed) {
    return {
      ok: false,
      error: `Python helper "${script}" failed to start. ${outcome.result.stderr.trim() || "No interpreter found."}`,
      stdout: "",
      raw: {},
    };
  }

  const stdout = outcome.result.stdout.trim();
  let raw: Record<string, unknown> = {};
  if (stdout.length > 0) {
    try {
      raw = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      raw = {
        error: `Python helper "${script}" produced non-JSON output. Raw tail:\n${stdout.slice(-2000)}`,
      };
    }
  }

  return { ok: true, stdout, raw };
}
