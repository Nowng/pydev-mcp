/**
 * pythonDebugger.ts — Runs Python code and reports a full traceback plus per-frame variable inspection.
 *
 * When debugging, seeing the values of local variables at each frame is far more useful than a bare
 * error message. This utility executes the target under an inline Python harness that, on failure,
 * walks the entire traceback and dumps `f_locals` for every frame; on success it prints a snapshot
 * of the top-level variables. All output is returned to the LLM as plain text plus structured fields.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";

import { spawnChild } from "./childProcessHelper";
import { resolvePythonCommand } from "./pythonResolver";
import { ensurePythonFile, resolveRunCwd, ensureTempWorkspaceDir } from "./safePaths";

export interface RunWithDebuggerOptions {
  /** Inline Python source. Provide this OR `filePath` (at least one is required). */
  code?: string | undefined;
  /** Path to an existing `.py` file inside the workspace. */
  filePath?: string | undefined;
  /** Command-line arguments passed to the target as sys.argv[1:]. */
  args?: string[] | undefined;
  /** Working directory for the run. Defaults to the target file's directory (or cwd). */
  cwd?: string | undefined;
  /** Timeout in seconds. Defaults to 60, clamped between 5 and 300. */
  timeoutSeconds?: number | undefined;
}

export interface RunWithDebuggerResult {
  success: boolean;
  timedOut: boolean;
  exitCode: number | null;
  pythonExecutableUsed: string;
  targetPath: string;
  /** Combined stdout + stderr from the debug run (readable traceback / frame inspection). */
  output: string;
}

/**
 * Inline Python harness written to a temp file, then executed as `<python> <harness> <target> [args...]`.
 * Uses only stdlib. Avoids regex/backslashes so it is safe inside a TS template literal.
 */
const DEBUG_HARNESS = `
import sys, os, json, argparse

def truncate(s, limit):
    s = str(s)
    return s if len(s) <= limit else s[:limit] + \"...(truncated)\"

def frame_locals_repr(frame_locals, limit=2000):
    try:
        keys = list(frame_locals.keys())
    except Exception:
        return \"{}\"
    items = []
    for k in keys:
        try:
            v = repr(frame_locals[k])
        except Exception:
            v = \"<unrepresentable>\"
        items.append(\"%s: %s\" % (k, truncate(v, limit)))
    payload = \"{ \" + \", \".join(items) + \" }\"
    return truncate(payload, 3000)

def dump_exc(exc_type, exc_value, exc_tb):
    lines = []
    lines.append(\"=== DEBUG RUN FAILED ===\")
    lines.append(\"%s: %s\" % (exc_type.__name__, str(exc_value)))
    lines.append(\"\")
    lines.append(\"--- Traceback & per-frame variable inspection ---\")
    depth = 0
    tb = exc_tb
    while tb is not None:
        f = tb.tb_frame
        lines.append(\"[frame %d] %s:%d in %s\" % (depth, f.f_code.co_filename, tb.tb_lineno, f.f_code.co_name))
        lines.append(\"    locals: %s\" % frame_locals_repr(f.f_locals))
        tb = tb.tb_next
        depth += 1
    sys.stderr.write(\"\\n\".join(lines) + \"\\n\")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(\"target\")
    parser.add_argument(\"args\", nargs=\"*\")
    opts = parser.parse_args()

    target = opts.target
    program_args = opts.args

    try:
        with open(target, \"r\", encoding=\"utf8\") as fh:
            code = fh.read()
    except Exception as e:
        sys.stderr.write(\"=== DEBUG RUN ERROR ===\\n\")
        sys.stderr.write(\"Could not read target file: %s\\n\" % str(e))
        sys.exit(2)

    ns = {\"__name__\": \"__main__\", \"__file__\": target, \"__builtins__\": __import__(\"builtins\")}

    try:
        exec(compile(code, target, \"exec\"), ns)
    except SystemExit:
        raise
    except BaseException as e:
        dump_exc(type(e), e, e.__traceback__)
        sys.exit(1)

    sys.stdout.write(\"\\n=== DEBUG RUN OK ===\\n\")
    names = [k for k in ns.keys() if not k.startswith(\"__\")]
    items = []
    for k in names:
        try:
            v = repr(ns[k])
        except Exception:
            v = \"<unrepresentable>\"
        items.append(\"%s: %s\" % (k, truncate(v, 500)))
    sys.stdout.write(\"Top-level variables (%d):\\n\" % len(items))
    for it in items[:50]:
        sys.stdout.write(\"    \" + it + \"\\n\")

main()
`;

/** Runs code/file under the debug harness and returns structured output plus readable traceback/inspection. */
export async function runWithDebugger(options: RunWithDebuggerOptions): Promise<RunWithDebuggerResult> {
  const timeoutSeconds = normalizeTimeout(options.timeoutSeconds);
  const args = options.args ?? [];

  const pythonCommand = await resolvePythonCommand();
  const execPath = pythonCommand.pythonExecutableUsed || "python";

  let temporaryDir: string | null = null;
  let targetPath = "";

  try {
    // Always create an isolated temp dir *inside the workspace* for the harness so we never
    // litter the user's project and so execution cwd / import resolution stays deterministic.
    const tempDirName = `debug-${randomUUID()}`;
    temporaryDir = path.join(await ensureTempWorkspaceDir(), tempDirName);
    await mkdir(temporaryDir, { recursive: true });
    const harnessPath = path.join(temporaryDir, "debug_harness.py");
    await writeFile(harnessPath, DEBUG_HARNESS, "utf8");

    if (options.filePath !== undefined && options.filePath.trim().length > 0) {
      targetPath = await ensurePythonFile(options.filePath);
    } else if (options.code !== undefined && options.code.trim().length > 0) {
      const targetFile = path.join(temporaryDir, "debug_target.py");
      targetPath = targetFile;
      await writeFile(targetFile, options.code, "utf8");
    } else {
      throw new Error("Provide either 'code' (inline source) or 'filePath' (a .py file) to debug.");
    }

    // Derive the cwd from the user's target file only when they passed one. For inline code the
    // target lives in our workspace scratch dir, so default to the workspace root instead — this
    // keeps `from solution import Solution`-style imports resolvable regardless of process.cwd().
    const cwd = await resolveRunCwd(options.cwd, options.filePath ? targetPath : undefined);

    const outcome = await spawnChild(
      execPath,
      ["-u", harnessPath, targetPath, ...args],
      timeoutSeconds * 1000,
      cwd,
    );

    return {
      success: !outcome.result.timedOut && outcome.result.exitCode === 0,
      timedOut: outcome.result.timedOut,
      exitCode: outcome.result.exitCode ?? null,
      pythonExecutableUsed: execPath,
      targetPath,
      output: (outcome.result.stdout + "\n" + outcome.result.stderr).trim(),
    };
  } finally {
    if (temporaryDir !== null) {
      await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 60;
  }
  return Math.min(300, Math.max(5, Math.trunc(value)));
}
