/**
 * buildPythonPackage.ts — builds / installs a Python project.
 *   - mode "editable" : `pip install -e .` (installs the project, dev-friendly).
 *   - mode "build"    : `python -m build` (produces sdist + wheel under <project>/dist/).
 *   - mode "both"     : build artifacts first, then editable-install them.
 *
 * The tool is venv-aware and always returns a structured result rather than throwing on build errors.
 */

import path from "node:path";

import { spawnChild } from "./childProcessHelper";
import { ensureDirectory } from "./safePaths";
import { getResolvedWorkspaceRoot } from "./safePaths";
import { resolvePythonCommand } from "./pythonResolver";

export type BuildMode = "editable" | "build" | "both";

export interface BuildPythonPackageInput {
  /** Project directory containing pyproject.toml/setup.py (default: workspace root). */
  projectPath?: string;
  /** Which operation to run. Default "both". */
  mode?: BuildMode;
  /** Extra arguments appended to the underlying pip / build command. */
  extraArgs?: string[];
  /** Overall timeout in seconds. Default 600. */
  timeoutSeconds?: number;
}

export interface BuildPythonPackageResult {
  projectPath: string;
  mode: string;
  exitCode: number | null;
  timedOut: boolean;
  steps: Array<{ name: string; succeeded: boolean; note?: string }>;
  stdout: string;
  message: string;
}

export async function buildPythonPackage(input: BuildPythonPackageInput = {}): Promise<BuildPythonPackageResult> {
  let projectPath = input.projectPath && input.projectPath.trim().length > 0
    ? await ensureDirectory(input.projectPath)
    : getResolvedWorkspaceRoot();

  // Handle null workspace root — fall back to process.cwd().
  if (projectPath === null) {
    projectPath = process.cwd();
  }

  const mode: BuildMode = input.mode ?? "both";
  const timeoutSeconds = Math.max(60, input.timeoutSeconds ?? 600);

  let pythonExecutableUsed = "python";
  try {
    const cmd = await resolvePythonCommand();
    pythonExecutableUsed = cmd.pythonExecutableUsed || pythonExecutableUsed;
  } catch (_err) {
    // fall back to a bare `python` invocation
  }

  const steps: Array<{ name: string; succeeded: boolean; note?: string }> = [];
  let combinedStdout = "";
  let finalExitCode: number | null = null;
  let timedOut = false;

  const runStep = async (name: string, args: string[], extraNote?: string): Promise<void> => {
    const outcome = await spawnChild(pythonExecutableUsed, args, timeoutSeconds * 1000, projectPath);
    if (outcome.spawnFailed) {
      steps.push({ name, succeeded: false, note: `${name} could not be started (is the tool installed?)` });
      return;
    }
    const payload = outcome.result;
    combinedStdout += `\n----- ${name} -----\n${stripAnsi(payload.stdout).trim()}\n`;
    if (payload.timedOut) {
      timedOut = true;
      finalExitCode = null;
      steps.push({ name, succeeded: false, note: `timed out after ${timeoutSeconds}s` });
      return;
    }
    finalExitCode = payload.exitCode;
    steps.push({ name, succeeded: payload.exitCode === 0, ...(extraNote ? { note: extraNote } : {}) });
  };

  if (mode === "build" || mode === "both") {
    await runStep("build", ["-m", "build", "--outdir", path.join(projectPath, "dist"), ...(input.extraArgs ?? [])],
      "Requires the 'build' package: pip install build");
  }

  if (mode === "editable" || mode === "both") {
    await runStep("editable-install", ["-m", "pip", "install", "-e", ".", ...(input.extraArgs ?? [])],
      "Editable install into the project venv.");
  }

  const message = buildMessage(mode, steps);
  return {
    projectPath,
    mode,
    exitCode: finalExitCode,
    timedOut,
    steps,
    stdout: trimStdout(combinedStdout),
    message,
  };
}

function buildMessage(mode: BuildMode, steps: Array<{ name: string; succeeded: boolean }>): string {
  const parts = steps.map((s) => `${s.name}: ${s.succeeded ? "ok" : "failed"}`);
  const allOk = steps.length > 0 && steps.every((s) => s.succeeded);
  return `build_python_package (${mode}) — ${parts.join(" | ")}. Overall: ${allOk ? "success" : "see step notes / stdout."}`;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function trimStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length <= 8000) return trimmed;
  return `${trimmed.slice(0, 8000)}\n... [truncated]`;
}
