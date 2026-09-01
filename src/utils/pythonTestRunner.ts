import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { getWorkspaceRoot, resolveSafePath, resolveTestFilePath } from "./safePaths";

export interface RunPytestInput {
  testFileOrPath: string;
  additionalArgs?: Array<string>;
}

/**
 * Structured detail for a single failed / errored test. Returned so the LLM can debug precisely:
 * which test failed, where (file + line), what went wrong (assertion message with Expected/Actual
 * or exception type + message), and the full traceback.
 */
export interface PytestFailureDetail {
  /** pytest node id, e.g. "tests/test_solution.py::test_maxProfit_increasing_prices". */
  nodeID: string;
  /** Absolute file path of the failing test (best-effort). */
  location: string;
  /** Line number inside `location` where the failure originated. */
  line?: number | undefined;
  /** Assertion / exception message (pytest includes Expected/Actual for assertion failures). */
  message: string;
  /** Exception class name, when available (e.g. "ModuleNotFoundError"). */
  errorType?: string | undefined;
  /** Full traceback text for the failure, trimmed and length-capped. */
  traceback?: string;
}

export interface RunPytestResult {
  passed?: number | undefined;
  failed?: number | undefined;
  skipped?: number | undefined;
  total?: number;
  durationMs?: number;
  summary: string;
  /**
   * Present ONLY when pytest could not collect any test (e.g. an import or collection error such
   * as `ModuleNotFoundError`). It carries a concise, human-readable reason so callers surface *why*
   * the run failed instead of an opaque "Exit code: 2".
   */
  error?: string | undefined;
  /** Structured per-test failure details (empty array when all tests passed). */
  failures?: PytestFailureDetail[] | undefined;
  /** Captured pytest stdout, length-capped so the LLM can inspect test prints. */
  stdout?: string;
  /** Captured pytest stderr, length-capped. */
  stderr?: string;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

interface SpawnResultPayload { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }
type SpawnResult =
  | { spawnFailed: true }
  | { spawnFailed: false; result: SpawnResultPayload };

/** Extra options forwarded to the child process. */
interface SpawnOptions {
  /** Working directory for the child (deterministic regardless of caller's cwd). */
  cwd?: string;
  /** Additional environment variables merged over process.env (e.g. PYTHONPATH). */
  extraEnv?: NodeJS.ProcessEnv;
}

function spawnProcess(
  executable: string,
  args: Array<string>,
  timeoutSeconds: number,
  options: SpawnOptions & { cwd?: string } = {},
): Promise<SpawnResult> {
  const { cwd, extraEnv } = options;
  return new Promise((resolve) => {
    const child = spawn(
      executable,
      args,
      {
        shell: false,
        windowsHide: true,
        ...(cwd ? { cwd } : {}),
        ...(extraEnv && Object.keys(extraEnv).length > 0
          ? { env: { ...process.env, ...extraEnv } }
          : {}),
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      console.error("[DEBUG] SPAWN FAILED exe=", executable, "args=", JSON.stringify(args), "cwd=", options.cwd, "env=", JSON.stringify(options.extraEnv), "err=", err && err.code, err && err.message);
      resolve({ spawnFailed: true });
    });

    child.on("close", (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve({ spawnFailed: false, result: { stdout, stderr, exitCode, timedOut } });
    });
  });
}

/**
 * Builds a deterministic execution context for running pytest on a resolved test file.
 *
 * - `cwd` is the test file's own directory so the pytest cache and relative paths are stable
 *   regardless of where the MCP server itself was launched.
 * - `PYTHONPATH` is populated with every ancestor directory between the test file and the
 *   workspace root, so bare imports such as `from solution import maxProfit` (where `solution`
 *   lives at the project root) resolve deterministically instead of depending on process.cwd().
 */
function buildDeterministicTestContext(resolvedTestFile: string, projectRoot: string): { cwd: string; extraEnv: NodeJS.ProcessEnv } {
  const cwd = projectRoot;

  const ancestors: string[] = [];
  let current = path.dirname(resolvedTestFile);
  const boundary = getWorkspaceRoot();
  while (current !== undefined && current !== boundary) {
    if (current === projectRoot) {
      // Include a sibling `src/` dir (the usual package layout) even though it is not an ancestor.
      const srcDir = path.join(projectRoot, "src");
      try { fs.statSync(srcDir); ancestors.push(srcDir); } catch { /* no src */ }
    }
    ancestors.push(current);
    current = path.dirname(current);
  }
  // Ensure the workspace root itself is always on PYTHONPATH even if it equals the boundary.
  if (!ancestors.includes(boundary)) ancestors.push(boundary);

  const extraEnv: NodeJS.ProcessEnv = {};
  for (const dir of ancestors) {
    extraEnv.PYTHONPATH = extraEnv.PYTHONPATH ? `${extraEnv.PYTHONPATH}${path.delimiter}${dir}` : dir;
  }

  return { cwd, extraEnv };
}

/**
 * Dependency-free JUnit XML parser tailored to pytest output. Extracts one failure detail per
 * `<failure>`/`<error>` element: node id, file + line (from the traceback header), the assertion /
 * exception message, the exception type, and the full traceback text.
 */
function parseJUnitFailures(xml: string): PytestFailureDetail[] {
  const failures: PytestFailureDetail[] = [];
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  function parseAttrs(tag: string): Record<string, string> {
    // Reset lastIndex so a fresh tag is parsed from the start (the /g flag otherwise resumes
    // from where a previous call left off, returning empty results for later tags).
    attrRe.lastIndex = 0;
    const attrs: Record<string, string> = {};
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tag)) !== null) attrs[m[1]!] = m[2]!;
    return attrs;
  }

  // Each <testcase ...>...</testcase> block.
  const tcRe = /<testcase\b[^>]*>([\s\S]*?)<\/testcase>/g;
  let m: RegExpExecArray | null;
  while ((m = tcRe.exec(xml)) !== null) {
    const attrs = parseAttrs(m[0]);
    // Groups: fm[1]=tag name, fm[2]=attributes, fm[3]=content/traceback.
    const failureRe = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let fm: RegExpExecArray | null;
    while ((fm = failureRe.exec(m[0])) !== null) {
      const fa = parseAttrs(fm[2]!);
      const traceback = stripAnsi(fm[3]!).trim();

      // The traceback header is "<file>:<line>: in <name>" — gives us file + line even when the
      // testcase tag omits them (older/newer pytest versions differ).
      const locMatch = traceback.match(/^(.+):(\d+):\s*in\s+/);
      const relPath = locMatch ? locMatch[1]! : "";
      const location = relPath.length > 0 ? path.resolve(getWorkspaceRoot(), relPath) : attrs.file || "";

      failures.push({
        nodeID: pytestNodeID(attrs),
        location,
        line: locMatch ? Number(locMatch[2]) : undefined,
        message: fa.message || "",
        errorType: fa.type || undefined,
        traceback,
      });
    }
  }

  return failures;
}

/** Builds a pytest-style node id ("file::name") from JUnit attributes. */
function pytestNodeID(attrs: Record<string, string>): string {
  const name = attrs.name || "";
  if (!name) return "";
  if (attrs.file && !name.includes("::")) {
    // Keep it relative to the workspace root for readability; do not leak absolute paths.
    try {
      const rel = path.relative(getWorkspaceRoot(), attrs.file);
      if (rel !== "") return `${rel.replace(/\/+$/g, "")}::${name}`;
    } catch (_err) { /* fall through */ }
  }
  return name;
}

/** Truncates a possibly-long string to `limit` chars with an ellipsis. */
function cap(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n…` : trimmed;
}

/** First meaningful line of a failure's message/traceback — a concise one-line reason. */
function firstLineReason(detail: PytestFailureDetail): string {
  const source = detail.message || detail.traceback || "";
  const lines = source.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return source.slice(0, 200);
  return cap(lines[0]!, 200);
}

/**
 * Derives the project root (the directory that owns `resolvedTestFile`) by walking up from the test
 * file until a directory containing a `pyproject.toml` is found. Returns "" when no project is
 * found, so callers fall back to the workspace-root tests directory.
 */
async function deriveProjectRoot(resolvedTestFile: string): Promise<string> {
  const workspaceRoot = getWorkspaceRoot();
  let current = resolvedTestFile;
  while (current !== undefined && current !== workspaceRoot) {
    if (await isDirWithPyproject(current)) return current;
    current = path.dirname(current);
  }
  if (current === workspaceRoot) {
    try { const fsP = await import("node:fs/promises"); await fsP.stat(workspaceRoot); return workspaceRoot; } catch { /* fall through */ }
  }
  return "";
}

async function isDirWithPyproject(dir: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    const info = await stat(path.join(dir, "pyproject.toml"));
    return info.isFile();
  } catch { return false; }
}

export async function runPytestTests(input: RunPytestInput): Promise<RunPytestResult> {
  const testFile = input.testFileOrPath.trim();
  let passed = 0, failed = 0, skipped = 0, total = 0, durationMs = 0;

  try {
    // Resolve the test file against the project that contains the source target, NOT the bare
    // workspace root. "tests/test_main.py" therefore maps to <projectRoot>/tests/test_main.py so it
    // matches exactly where pydev_create_test_file() wrote it (shared resolver in safePaths.ts).
    const fsPromises = await import("node:fs/promises");
    const resolvedTestFile = await resolveTestFilePath(testFile, input.testFileOrPath);

    const args = ["-m", "pytest", resolvedTestFile, "--tb=short", ...(input.additionalArgs ?? [])];
    let timeoutSeconds = 120;
    if (input.additionalArgs?.includes("--timeout") && input.additionalArgs.length > input.additionalArgs.indexOf("--timeout") + 1) {
      const val = parseInt(input.additionalArgs[input.additionalArgs.indexOf("--timeout") + 1] || "300", 10);
      if (!isNaN(val)) timeoutSeconds = Math.max(60, val);
    }

    // Use resolvePythonCommand for venv-aware execution; fallback to system python.
    let pythonCmd = "python";
    try {
      const cmd = await (await Promise.resolve().then(() => import("./pythonResolver"))).resolvePythonCommand();
      if (cmd.pythonExecutableUsed) pythonCmd = cmd.pythonExecutableUsed;
    } catch (_err) {}

    // Run pytest with a deterministic cwd + PYTHONPATH so import resolution does not depend on
    // where the MCP server was launched. This makes bare project-root imports (e.g. `from solution
    // import maxProfit`) resolve reliably instead of failing collection with Exit code 2.
    //
    // We do NOT use a shell chain (`cd && source`). Instead we call the already-resolved venv
    // python executable directly (an absolute path) with a fixed cwd = <projectRoot>. That is the
    // only way to keep the child process self-contained and killable: killing the single `python`
    // child reaps pytest, so no orphaned shell lingers. PYTHONPATH carries every ancestor dir from
    // the source package up to the workspace root (incl. `<projectRoot>/src`) so bare imports resolve.
    const projectRoot = await deriveProjectRoot(resolvedTestFile);
    const { cwd: runCwd, extraEnv } = buildDeterministicTestContext(resolvedTestFile, projectRoot);

    // Capture structured failure details via JUnit XML (dependency-free to parse). This is the
    // authoritative source for which test failed and why, so we run with --tb=short for the console
    // summary too. The XML file is written inside the workspace temp dir and cleaned up afterward.
    const fs = await import("node:fs/promises");
    const xmlPath = resolveSafePath(`junit-${randomUUID()}.xml`);
    let failures: PytestFailureDetail[] = [];

    // Build the pytest argument list (junitxml + file + extra flags). With `shell: false` these are
    // passed straight through to the resolved venv python executable.
    const pytestArgs = ["-m", "pytest", resolvedTestFile, "--tb=short", "--junitxml", xmlPath, ...(input.additionalArgs ?? [])];

    try {
      const result: SpawnResult = await spawnProcess(
        pythonCmd,
        pytestArgs,
        Math.max(timeoutSeconds, 60),
        { cwd: runCwd, extraEnv },
      );

      // A successful spawn is NOT a failure — parse the pytest output for real counts.
      if (result.spawnFailed) {
        return { summary: `pytest could not be started.` };
      }

      const payload = result.result;
      const timedOut = payload.timedOut;
      const stdoutRaw = stripAnsi(payload.stdout);
      const stderrRaw = stripAnsi(payload.stderr);
      const combinedOutput = `${stdoutRaw}\n${stderrRaw}`;

      let match: RegExpMatchArray | null;
      if ((match = combinedOutput.match(/(\d+)\s+passed/))) { passed = parseInt(match[1]!, 10); }

      const failMatches = [...combinedOutput.matchAll(/(\d+)\s+failed/g)];
      for (const fm of failMatches) { failed += parseInt(fm[0].split(" ")[0] ?? "0", 10); }

      let skipMatch: RegExpMatchArray | null;
      if ((skipMatch = combinedOutput.match(/(\d+)\s+skipped/))) { skipped = parseInt(skipMatch[1]!, 10); }

      total = passed + failed + skipped;

      const durMatch = combinedOutput.match(/in\s+(\d+\.\d+)s/);
      if (durMatch) durationMs = Math.round(parseFloat(durMatch[1]!) * 1000);

      // Parse structured failure details from the JUnit XML.
      try {
        failures = parseJUnitFailures(await fs.readFile(xmlPath, "utf8"));
      } catch (_xmlErr) {
        /* fall through — details may be unavailable if the flag was unsupported */
      }

      // Order failures by line number (most relevant first) for the summary.
      const failingDetails = [...failures].sort((a, b) => String(b.line ?? 0).localeCompare(String(a.line ?? 0)));

      // A collection/import error yields no pass/fail/skip counts and a non-zero exit code. In that
      // case surface the real reason instead of an opaque "Exit code: 2".
      if (total === 0 && payload.exitCode !== null && payload.exitCode !== 0 && !timedOut) {
        const errorTail = extractCollectionError(combinedOutput);
        const exitCode = payload.exitCode ?? "unknown";
        return {
          summary: `Collection failed (Exit code: ${exitCode}). ${errorTail ?? "pytest reported a collection error."}`,
          error: errorTail,
        };
      }

      // Build an actionable summary. When tests fail, list each failing test with its location and
      // one-line reason so the LLM can jump straight to the bug instead of just seeing counts.
      const exitCode = payload.exitCode ?? (timedOut ? "timeout" : "unknown");
      let summary = `${passed} passed, ${failed} failed, ${skipped} skipped in ${(durationMs / 1000).toFixed(2)}s. Exit code: ${exitCode}.`;

      if (failed > 0 || failingDetails.length > 0) {
        const reasonLines = failingDetails.map((d) => `  • ${d.nodeID}${d.line ? ` (${d.line}):` : ""} — ${firstLineReason(d)}`);
        summary += `\n\nFailing tests:`;
        for (const r of reasonLines) summary += `\n${r}`;
        if (failingDetails.length > 0 && failingDetails.length < failures.length) {
          summary += `\n\n${failures.length - failingDetails.length} more failure(s) in \`failures\`.`;
        }
      }

      return {
        passed: passed > 0 ? passed : undefined,
        failed: total > 0 ? failed : undefined,
        skipped: total > 0 ? skipped : undefined,
        total,
        durationMs,
        summary,
        failures: failingDetails.length > 0 ? failingDetails : undefined,
        stdout: cap(stdoutRaw, 6000),
        stderr: cap(stderrRaw, 6000),
      };
    } finally {
      await fs.rm(xmlPath, { force: true }).catch(() => {});
    }
  } catch (err) {
    return { summary: `Error running pytest on '${testFile}': ${err instanceof Error ? err.message : String(err)}.` };
  }
}

/**
 * Extracts a concise, human-readable collection/import error from raw pytest output.
 * Returns `undefined` when no error marker is found.
 */
function extractCollectionError(combinedOutput: string, limit = 300): string | undefined {
  const lines = stripAnsi(combinedOutput)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Prefer a pytest error marker (e.g. "E   ModuleNotFoundError: ...").
  const errorIndex = lines.findIndex((l) => /^E\s/.test(l));
  const start = errorIndex >= 0 ? errorIndex : Math.max(0, lines.length - 6);
  const snippet = lines.slice(start).join("\n");
  return snippet.length > limit ? `${snippet.slice(0, limit)}\n…` : snippet;
}
