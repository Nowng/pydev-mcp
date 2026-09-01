/**
 * runCoverage.ts — runs pytest with `pytest-cov` to report per-file and project-wide code coverage.
 *
 * The tool is venv-aware (uses the resolved interpreter) and always returns a structured result rather
 * than throwing, so an LLM can inspect partial output even when tests are missing or a run fails.
 *
 * Path handling (Phase 4): `sourcePath` / `testPath` are validated with `ensureDirectory`, which now
 * gives contextual, file-vs-dir-aware errors (naming the field and hinting at the sibling parameter).
 * pytest is run from the workspace root with absolute paths (unambiguous regardless of cwd), and the
 * returned coverage table — together with the `sourcePath` / `testPath` result fields — is rewritten
 * to be relative to the workspace root (`path.relative(workspaceRoot, abs)`), so reports show e.g.
 * `src/utils/runCoverage.py` instead of opaque absolute paths like `/mnt/md0/.../Workspace/src/...`.
 */

import path from "node:path";
import { spawnChild } from "./childProcessHelper";
import { ensureDirectory, getWorkspaceRoot, resolveRunCwd } from "./safePaths";
import { resolvePythonCommand } from "./pythonResolver";

export interface RunCoverageInput {
  /** Directory / package whose coverage to measure (default: workspace root). */
  sourcePath?: string;
  /** Directory or test file that holds the tests to run (default: same as sourcePath). */
  testPath?: string;
  /** Extra pytest arguments appended after coverage flags. */
  extraArgs?: string[];
  /** Overall timeout in seconds. Default 300. */
  timeoutSeconds?: number;
}

export interface CoverageFileEntry {
  file: string;
  statements: number;
  missed: number;
  coverPercent: number;
}

export interface RunCoverageResult {
  /** Workspace-root-relative path to the code whose coverage was measured (or "." for the root). */
  sourcePath: string;
  /** Workspace-root-relative path to the tests that were collected (or "." for the root). */
  testPath: string;
  exitCode: number | null;
  timedOut: boolean;
  totalCoveragePercent?: number;
  coveredLines?: number;
  totalLines?: number;
  filesScanned: number;
  /** pytest-cov term-missing table with file paths relative to the workspace root. */
  coverageTable: string;
  summary: string;
}

export async function runProjectCoverage(input: RunCoverageInput = {}): Promise<RunCoverageResult> {
  const workspaceRoot = getWorkspaceRoot();

  // Validate source/test directories with contextual, file-vs-dir-aware errors. When a user passes a
  // file where a directory is expected (the classic coverage mistake), the error now names the field,
  // says it is a file, and points at the sibling parameter to use instead.
  const sourcePathAbs = input.sourcePath && input.sourcePath.trim().length > 0
    ? await ensureDirectory(input.sourcePath, {
        fieldName: "sourcePath",
        hint: "Provide a directory (the code package) whose coverage to measure. Use `testPath` for your tests directory.",
      })
    : workspaceRoot;
  const testPathAbs = input.testPath && input.testPath.trim().length > 0
    ? await ensureDirectory(input.testPath, {
        fieldName: "testPath",
        hint: "Point this at your tests directory or a test file. `sourcePath` is the code whose coverage is measured.",
      })
    : sourcePathAbs;

  let pythonExecutableUsed = "python";
  try {
    const cmd = await resolvePythonCommand();
    pythonExecutableUsed = cmd.pythonExecutableUsed || pythonExecutableUsed;
  } catch (_err) {
    // fall back to a bare `python` invocation and surface the note in the summary
  }

  const timeoutSeconds = Math.max(60, input.timeoutSeconds ?? 300);

  // Run pytest from the workspace root with ABSOLUTE source/test paths. Absolute paths are unambiguous
  // and work regardless of cwd; running from the workspace root keeps the working directory
  // deterministic (the same rule every other tool uses). We rewrite the resulting table to
  // workspace-root relative afterwards so the user never sees opaque absolute paths.
  const args = [
    "-m", "pytest",
    testPathAbs,
    `--cov=${sourcePathAbs}`,
    "--cov-report=term-missing",
    ...(input.extraArgs ?? []),
  ];

  // Run from the workspace root (not process.cwd()) so the working directory is deterministic. Paths
  // are absolute, so pytest works regardless of cwd.
  const runCwd = await resolveRunCwd(undefined);
  const outcome = await spawnChild(pythonExecutableUsed, args, timeoutSeconds * 1000, runCwd);
  if (outcome.spawnFailed) {
    return buildResult(
      relPath(workspaceRoot, sourcePathAbs),
      relPath(workspaceRoot, testPathAbs),
      null, false,
      `Coverage tool could not be started. Ensure 'pytest-cov' is installed: pip install pytest-cov.`,
    );
  }

  const payload = outcome.result;
  const stdout = stripAnsi(payload.stdout);
  const parsed = parseCoverage(stdout);

  let summary = parsed.summary;
  if (payload.exitCode === 1 && parsed.totalCoveragePercent === undefined) {
    // pytest exit code 1 means test failures, not a coverage failure.
    summary = `${summary} Exit code: ${payload.exitCode}.`;
  } else {
    summary = `${summary} Exit code: ${payload.exitCode ?? (payload.timedOut ? "timeout" : "unknown")}.`;
  }

  return buildResult(
    relPath(workspaceRoot, sourcePathAbs),
    relPath(workspaceRoot, testPathAbs),
    payload.exitCode,
    payload.timedOut,
    summary,
    { ...parsed, coverageTable: toWorkspaceRelative(workspaceRoot, parsed.coverageTable) },
  );
}

/** Returns `abs` made relative to `root`; falls back to "." when they resolve to the same directory. */
function relPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel === "" ? "." : rel;
}

function buildResult(
  sourcePath: string,
  testPath: string,
  exitCode: number | null,
  timedOut: boolean,
  summary: string,
  parsed?: { totalCoveragePercent?: number; coveredLines?: number; totalLines?: number; filesScanned: number; coverageTable: string },
): RunCoverageResult {
  return {
    sourcePath,
    testPath,
    exitCode,
    timedOut,
    ...(parsed?.totalCoveragePercent !== undefined ? { totalCoveragePercent: parsed.totalCoveragePercent } : {}),
    ...(parsed?.coveredLines !== undefined ? { coveredLines: parsed.coveredLines } : {}),
    ...(parsed?.totalLines !== undefined ? { totalLines: parsed.totalLines } : {}),
    filesScanned: parsed?.filesScanned ?? 0,
    coverageTable: parsed?.coverageTable ?? "",
    summary,
  };
}

interface CoverageParse {
  totalCoveragePercent?: number;
  coveredLines?: number;
  totalLines?: number;
  filesScanned: number;
  coverageTable: string;
  summary: string;
}

function parseCoverage(stdout: string): CoverageParse {
  const lines = stdout.split(/\r?\n/);

  // Everything between the coverage header and the end of the term-missing table.
  const tableLines: string[] = [];
  let inTable = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (/coverage:|^={3,}/.test(trimmed) && /coverage/.test(trimmed)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      tableLines.push(raw);
    }
  }

  let totalCoveragePercent: number | undefined;
  let coveredLines: number | undefined;
  let totalLines: number | undefined;
  const fileEntries: CoverageFileEntry[] = [];

  for (const raw of tableLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (/^TOTAL\s/i.test(trimmed)) {
      const m = /^TOTAL\s+(\d+)\s+(\d+)\s+(\d+)%/i.exec(trimmed);
      if (m) {
        const stmts = Number(m[1] ?? "0");
        const miss = Number(m[2] ?? "0");
        totalCoveragePercent = Number(m[3] ?? "0");
        coveredLines = stmts - miss;
        totalLines = stmts;
      }
      continue;
    }
    // Data row: <file>  <stmts>  <missed>  <cover>%
    const m = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)%\s*$/.exec(trimmed);
    if (m && !/^File\s/i.test(trimmed) && !/required:/i.test(trimmed)) {
      const g1 = m[1] ?? "";
      fileEntries.push({
        file: g1.trim(),
        statements: Number(m[2] ?? "0"),
        missed: Number(m[3] ?? "0"),
        coverPercent: Number(m[4] ?? "0"),
      });
    }
  }

  const filesScanned = fileEntries.length;
  const coverageTable = truncateLines(tableLines.slice(0, 40), 6000);

  if (totalCoveragePercent === undefined) {
    let summary = "pytest-cov ran but no coverage total was produced.";
    if (/no tests ran/i.test(stdout)) {
      summary = "No tests were collected — nothing was executed, so coverage could not be measured. Add or point `testPath` at your test files.";
    } else if (/could not import/i.test(stdout) || /error/i.test(stdout)) {
      summary = "pytest reported errors while collecting/running; see the raw output for details.";
    }
    return { filesScanned, coverageTable, summary };
  }

  const verb = totalCoveragePercent === 100 ? "passed" : "completed";
  return {
    totalCoveragePercent,
    ...(coveredLines !== undefined ? { coveredLines } : {}),
    ...(totalLines !== undefined ? { totalLines } : {}),
    filesScanned,
    coverageTable,
    summary: `Coverage ${verb}: ${totalCoveragePercent}% (${coveredLines}/${totalLines} statements covered) across ${filesScanned} measured file(s).`,
  };
}

/**
 * Rewrites a pytest-cov term-missing table so every file path is reported relative to the workspace
 * root (`path.relative(workspaceRoot, abs)`), turning opaque absolute paths (e.g.
 * /mnt/md0/.../Workspace/src/foo.py) into workspace-relative ones (src/foo.py). Lines that do not
 * start with the workspace-root prefix are left untouched.
 */
function toWorkspaceRelative(workspaceRoot: string, tableText: string): string {
  const prefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
  return tableText
    .split("\n")
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .join("\n");
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncateLines(lines: string[], maxBytes: number): string {
  let acc = "";
  for (const line of lines) {
    if (Buffer.byteLength(acc + line, "utf8") > maxBytes) {
      break;
    }
    acc += `${line}\n`;
  }
  return acc.trim();
}
