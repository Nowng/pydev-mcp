import { spawn as childSpawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePythonCommand } from "./pythonResolver";
import { ensurePythonFile } from "./safePaths";

export interface RunLintResult {
  lintErrors: Array<{ line?: number; column?: number; message: string; severity: "error" | "warning" }>;
  totalLinesChecked: number;
}

interface SpawnResultPayload { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }
type SpawnResult =
  | { spawnFailed: true }
  | { spawnFailed: false; result: SpawnResultPayload };

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

async function spawnProcess(executable: string, args: Array<string>, timeoutSeconds: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = childSpawn(executable, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (c: string) => { stdout += c; });
    child.stderr.on("data", (c: string) => { stderr += c; });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawnFailed: true });
    });

    child.on("close", (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawnFailed: false, result: { stdout, stderr, exitCode, timedOut } });
    });
  });
}

/** Parse `ruff check --output-format=json` output. This ruff version reports nested `location.row/column`,
 *  a top-level `code`/`name`, `message`, and an explicit `severity` ("error" | "warning"). */
function parseRuffJson(output: string): Array<{ line?: number; column?: number; message: string; severity: "error" | "warning" }> {
  const errors: Array<{ line?: number; column?: number; message: string; severity: "error" | "warning" }> = [];
  try {
    const parsed = JSON.parse(stripAnsi(output)) as
      | Array<{ code?: string; name?: string; message?: string; severity?: string; location?: { row?: number; column?: number } }>
      | null;

    for (const res of parsed ?? []) {
      if (!res.code && !res.name) continue;
      errors.push({
        line: res.location?.row ?? 0,
        column: res.location?.column ?? 0,
        message: `[${res.code || res.name}] ${res.message ?? ""}`.trim(),
        severity: (res.severity ?? "error").toLowerCase() === "warning" ? "warning" : "error",
      });
    }
  } catch (_err) {
    /* JSON parse failure — leave empty; caller may fall back to ast.parse elsewhere */
  }
  return errors;
}

/** Validate Python syntax via ast.parse WITHOUT executing the code. Safe + works on Python 3.11+. */
async function runSyntaxCheck(execPath: string, tmpFile: string, lintErrors: RunLintResult["lintErrors"]): Promise<void> {
  const check = await spawnProcess(execPath, ["-c", "import sys,ast; ast.parse(open(sys.argv[1],'rb').read().decode())", tmpFile], 8);
  if (!check.spawnFailed && check.result.exitCode !== 0) {
    lintErrors.push({ message: "Python syntax error detected (ruff unavailable — falling back to ast.parse).", severity: "error" });
  }
}

/**
 * Lint a Python source string using the venv-aware interpreter (resolvePythonCommand prefers <cwd>/.venv).
 * Prefers `python -m ruff check --output-format=json` for reliable structured diagnostics; falls back to an
 * offline ast.parse syntax check when ruff is unavailable. Does NOT execute the provided code.
 */
export async function analyzePythonFileForLint(code: string): Promise<RunLintResult> {
  const totalLinesChecked = code.split("\n").length;
  const lintErrors: RunLintResult["lintErrors"] = [];

  let execPath = "python";
  try {
    const cmd = await resolvePythonCommand();
    if (cmd.pythonExecutableUsed) execPath = cmd.pythonExecutableUsed;
  } catch (_err) {
    /* keep fallback to system python */
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ruff-"));
  const tmpFile = path.join(tmpDir, "check.py");

  try {
    await fs.writeFile(tmpFile, code, "utf8");

    // Detect ruff availability via the venv python (`python -m ruff`).
    const versionProbe = await spawnProcess(execPath, ["-m", "ruff", "--version"], 10);
    const ruffAvailable = !versionProbe.spawnFailed && (versionProbe.result.exitCode === 0 || versionProbe.result.timedOut);

    if (ruffAvailable) {
      const check = await spawnProcess(execPath, ["-m", "ruff", "check", "--output-format=json", tmpFile], 30);
      if (!check.spawnFailed) {
        lintErrors.push(...parseRuffJson(stripAnsi(check.result.stdout)));
      } else {
        await runSyntaxCheck(execPath, tmpFile, lintErrors);
      }
    } else {
      // Fallback: pure syntax validation via ast.parse (does not execute the code).
      await runSyntaxCheck(execPath, tmpFile, lintErrors);
    }
  } catch (_err) {
    lintErrors.push({ message: "Unable to run linter.", severity: "error" });
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }

  return { lintErrors, totalLinesChecked };
}

/**
 * Lint an existing Python .py file (path resolved against the effective root and validated to be
 * inside the workspace). Prefers `python -m ruff check --output-format=json` for structured
 * diagnostics; falls back to an offline ast.parse syntax check when ruff is unavailable.
 * When autoFix is true, runs `ruff check --fix` so style issues are repaired in place.
 */
export async function analyzePythonFileForLintFromFile(
  filePath: string,
  autoFix: boolean = false,
): Promise<RunLintResult> {
  const resolvedFilePath = await ensurePythonFile(filePath);

  let totalLinesChecked = 0;
  try {
    const source = await fs.readFile(resolvedFilePath, "utf8");
    totalLinesChecked = source.split("\n").length;
  } catch (_err) {
    totalLinesChecked = 0;
  }

  const lintErrors: RunLintResult["lintErrors"] = [];

  let execPath = "python";
  try {
    const cmd = await resolvePythonCommand();
    if (cmd.pythonExecutableUsed) execPath = cmd.pythonExecutableUsed;
  } catch (_err) {
    /* keep fallback to system python */
  }

  try {
    // Detect ruff availability via the venv python (`python -m ruff`).
    const versionProbe = await spawnProcess(execPath, ["-m", "ruff", "--version"], 10);
    const ruffAvailable = !versionProbe.spawnFailed && (versionProbe.result.exitCode === 0 || versionProbe.result.timedOut);

    if (ruffAvailable) {
      const ruffArgs = autoFix
        ? ["-m", "ruff", "check", "--fix", "--output-format=json", resolvedFilePath]
        : ["-m", "ruff", "check", "--output-format=json", resolvedFilePath];
      const check = await spawnProcess(execPath, ruffArgs, 30);
      if (!check.spawnFailed) {
        lintErrors.push(...parseRuffJson(stripAnsi(check.result.stdout)));
      } else {
        await runSyntaxCheck(execPath, resolvedFilePath, lintErrors);
      }
    } else {
      // Fallback: pure syntax validation via ast.parse (does not execute the file).
      await runSyntaxCheck(execPath, resolvedFilePath, lintErrors);
    }
  } catch (_err) {
    lintErrors.push({ message: "Unable to run linter.", severity: "error" });
  }

  return { lintErrors, totalLinesChecked };
}
