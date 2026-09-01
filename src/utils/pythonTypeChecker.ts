/**
 * pythonTypeChecker.ts — Runs a project-wide static type checker (mypy or pyright).
 *
 * Deeper than `check_for_bugs` (which is per-file / compile + ruff only): this scans an entire
 * directory tree with mypy/pyright, which understands cross-module type flow. Output is parsed into
 * error / warning / note counts plus a human-readable summary. When the chosen checker is not installed
 * inside the active venv, the tool reports it as unavailable rather than failing.
 */

import { stat } from "node:fs/promises";

import { spawnChild } from "./childProcessHelper";
import { resolvePythonCommand } from "./pythonResolver";
import { resolveSafePath } from "./safePaths";

export type TypeCheckerName = "mypy" | "pyright";

export interface TypeCheckOptions {
  checker?: TypeCheckerName | undefined;
  extraArgs?: string[] | undefined;
  timeoutSeconds?: number | undefined;
}

export interface TypeCheckResult {
  checker: TypeCheckerName;
  targetPath: string;
  available: boolean;
  exitCode: number | null;
  errorCount: number;
  warningCount: number;
  noteCount: number;
  summary: string;
  rawOutputTruncated: string;
}

const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_RAW_OUTPUT_CHARS = 8000;
const DIAGNOSTIC_RE = /^(.*?):(\d+):(\d+)?:\s*(error|warning|note|info)\b(.*)$/i;

/**
 * Runs a project-wide type check against `targetPath` (a file or directory inside the workspace).
 */
export async function typeCheckProject(
  targetPath: string,
  options: TypeCheckOptions = {},
): Promise<TypeCheckResult> {
  const checker = options.checker ?? "mypy";
  const resolvedTarget = await resolveSafePath(targetPath, "targetPath");

  const stats = await stat(resolvedTarget).catch(() => null);
  if (stats === null || !stats.isDirectory()) {
    throw new Error(`Type-check target is not a readable directory: ${resolvedTarget}`);
  }

  const timeoutSeconds = normalizeTimeout(options.timeoutSeconds);
  const extraArgs = options.extraArgs ?? [];

  const execPath = await resolveExecutable();

  // Availability probe — cheap `--version` check against the active venv interpreter.
  const versionProbe = await spawnChild(execPath, ["-m", checker, "--version"], 10_000);
  if (versionProbe.spawnFailed || versionProbe.result.exitCode !== 0) {
    return unavailableResult(checker, resolvedTarget, installHint(checker));
  }

  const cmdArgs = buildCheckerCommand(checker, resolvedTarget, extraArgs);
  const result = await spawnChild(execPath, cmdArgs, timeoutSeconds * 1000);

  const parsed = parseDiagnosticOutput(result.result.stdout + "\n" + result.result.stderr, checker);
  const summary = buildSummary({ checker, ...parsed, available: true });

  return {
    checker,
    targetPath: resolvedTarget,
    available: true,
    exitCode: result.result.exitCode ?? null,
    errorCount: parsed.errorCount,
    warningCount: parsed.warningCount,
    noteCount: parsed.noteCount,
    summary,
    rawOutputTruncated: truncate(result.result.stdout + "\n" + result.result.stderr),
  };
}

function installHint(checker: TypeCheckerName): string {
  return checker === "pyright"
    ? "`pyright` is not installed for the active venv. Install it with: pip install pyright (then re-run)."
    : "`mypy` is not installed for the active venv. Install it with: pip install mypy (then re-run).";
}

function unavailableResult(checker: TypeCheckerName, targetPath: string, message: string): TypeCheckResult {
  return {
    checker,
    targetPath,
    available: false,
    exitCode: null,
    errorCount: 0,
    warningCount: 0,
    noteCount: 0,
    summary: message,
    rawOutputTruncated: "",
  };
}

function buildCheckerCommand(
  checker: TypeCheckerName,
  targetPath: string,
  extraArgs: string[],
): string[] {
  const base = ["-m", checker];
  // mypy: silence per-file overhead for project-wide scans unless the user overrides.
  if (checker === "mypy") {
    return [...base, "--follow-imports=silent", targetPath, ...extraArgs];
  }
  return [...base, targetPath, ...extraArgs];
}

async function resolveExecutable(): Promise<string> {
  try {
    const cmd = await resolvePythonCommand();
    if (cmd.pythonExecutableUsed) {
      return cmd.pythonExecutableUsed;
    }
  } catch (_err) {
    /* fall back to system python */
  }
  return "python";
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.trunc(value)));
}

interface ParsedDiagnostics {
  errorCount: number;
  warningCount: number;
  noteCount: number;
}

function parseDiagnosticOutput(output: string, checker: TypeCheckerName): ParsedDiagnostics {
  const counts: ParsedDiagnostics = { errorCount: 0, warningCount: 0, noteCount: 0 };
  if (!output) {
    return counts;
  }

  // pyright prefixes diagnostics with "error:" / "warning:" but no file:line when using `-m`;
  // mypy uses `file:line:col: severity:`. We handle both by scanning for severity tokens on
  // diagnostic-shaped lines.
  const lines = output.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let match: RegExpExecArray | null = null;
    if (checker === "mypy") {
      match = DIAGNOSTIC_RE.exec(line);
    } else {
      // pyright style: `path:line:col: error: msg` or bare `error:`.
      const m = /^(.*?):(\d+):(\d+)?:\s*(error|warning)\b(.*)$/i.exec(line);
      if (m) {
        match = [m[0], m[1], m[2], m[3], undefined, m[4]?.toLowerCase(), m[5]] as unknown as RegExpExecArray;
      } else {
        const bare = /\b(error|warning)\b/.exec(line);
        if (bare) {
          match = [line, "", "", "", undefined, (bare[1] ?? "").toLowerCase(), ""] as unknown as RegExpExecArray;
        }
      }
    }

    if (match === null) continue;
    const severity = (match[5] ?? "").toLowerCase();
    if (severity === "error") counts.errorCount += 1;
    else if (severity === "warning" || severity === "info") counts.warningCount += 1;
    else if (severity === "note") counts.noteCount += 1;
  }

  return counts;
}

function buildSummary(input: {
  checker: TypeCheckerName;
  available: boolean;
  errorCount: number;
  warningCount: number;
  noteCount: number;
}): string {
  const { errorCount, warningCount, noteCount } = input;
  if (errorCount === 0 && warningCount === 0) {
    return `${input.checker} found no type issues in the target.`;
  }

  const parts: string[] = [];
  if (errorCount > 0) parts.push(`${errorCount} error${pluralizeSuffix(errorCount)}`);
  if (warningCount > 0) parts.push(`${warningCount} warning${pluralizeSuffix(warningCount)}`);
  if (noteCount > 0) parts.push(`${noteCount} note${pluralizeSuffix(noteCount)}`);

  return `${input.checker} found ${parts.join(", ")} in the target.`;
}

function pluralizeSuffix(count: number): string {
  return count === 1 ? "" : "s";
}

function truncate(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= MAX_RAW_OUTPUT_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_RAW_OUTPUT_CHARS)}...[truncated]`;
}
