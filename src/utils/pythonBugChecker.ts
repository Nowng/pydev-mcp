import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolvePythonCommand, type PythonCommand, type PythonProcessResult } from "./pythonResolver";
import { ensurePythonFile, MAX_FILE_READ_BYTES } from "./safePaths";

export type BugCheckSeverity = "error" | "warning" | "info";
export type BugCheckIssueSource = "syntax" | "ruff" | "fallback-ast" | "runtime-smoke-test" | "tool";

export interface BugCheckIssue {
  severity: BugCheckSeverity;
  code?: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  source?: BugCheckIssueSource;
  occurrences?: number;
  additionalLocations?: Array<{ line: number; column?: number }>;
  details?: string;
}

export interface SmokeTestResult {
  enabled: boolean;
  timeoutMs: number;
  ran: boolean;
  timedOut: boolean;
  exitCode: number | null;
  detectedRuntimeError: boolean;
  summary: string;
}

export interface CheckForBugsResult {
  success: boolean;
  mode: "inline" | "file";
  filePath?: string;
  pythonExecutableUsed: string;
  syntaxOk: boolean;
  ruffAvailable: boolean;
  fallbackAstAvailable: boolean;
  staticAnalysisAvailable: boolean;
  smokeTest: SmokeTestResult;
  issuesFound: boolean;
  issueCount: number;
  shownIssueCount: number;
  truncated: boolean;
  summary: string;
  issues: BugCheckIssue[];
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

const DEFAULT_ANALYSIS_TIMEOUT_MS = 30_000;
const MAX_CODE_LENGTH = 50_000;
const DEFAULT_MAX_ISSUES = 20;
const ABSOLUTE_MAX_ISSUES = 100;
const MAX_ADDITIONAL_LOCATIONS = 5;
const MAX_RAW_OUTPUT_CHARS = 4000;
const DEFAULT_SMOKE_TEST_TIMEOUT_MS = 3000;
const MINIMUM_SMOKE_TEST_TIMEOUT_MS = 500;
const MAXIMUM_SMOKE_TEST_TIMEOUT_MS = 10_000;

export function stripAnsi(input: string): string {
  return input.replace(
    // Covers CSI, OSC, charset, and other common ECMA-48 escape/control sequences.
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    "",
  );
}

export async function checkPythonCodeForBugs(input: {
  code: string;
  runPyCompile?: boolean | undefined;
  maxIssues?: number | undefined;
  includeRawOutput?: boolean | undefined;
  runSmokeTest?: boolean | undefined;
  smokeTestTimeoutMs?: number | undefined;
  smokeTestArgs?: string[] | undefined;
}): Promise<CheckForBugsResult> {
  if (input.code.trim().length === 0) {
    throw new Error("code cannot be empty.");
  }

  if (input.code.length > MAX_CODE_LENGTH) {
    throw new Error(`code must be ${MAX_CODE_LENGTH} characters or fewer.`);
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pydev-mcp-"));
  const temporaryScriptPath = path.join(temporaryDirectory, "inline-check.py");

  try {
    await writeFile(temporaryScriptPath, input.code, "utf8");
    return await analyzePythonFile(temporaryScriptPath, {
      mode: "inline",
      maxIssues: input.maxIssues,
      includeRawOutput: input.includeRawOutput,
      runSmokeTest: input.runSmokeTest,
      smokeTestTimeoutMs: input.smokeTestTimeoutMs,
      smokeTestArgs: input.smokeTestArgs,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function checkPythonFileForBugs(
  filePath: string,
  options: {
    maxIssues?: number | undefined;
    includeRawOutput?: boolean | undefined;
    runSmokeTest?: boolean | undefined;
    smokeTestTimeoutMs?: number | undefined;
    smokeTestArgs?: string[] | undefined;
  } = {},
): Promise<CheckForBugsResult> {
  const resolvedFilePath = await ensurePythonFile(filePath);
  const fileStats = await stat(resolvedFilePath);

  if (fileStats.size > MAX_FILE_READ_BYTES) {
    throw new Error(`File is too large for bug checking (${fileStats.size} bytes). Maximum is ${MAX_FILE_READ_BYTES} bytes.`);
  }

  return await analyzePythonFile(resolvedFilePath, {
    mode: "file",
    maxIssues: options.maxIssues,
    includeRawOutput: options.includeRawOutput,
    runSmokeTest: options.runSmokeTest,
    smokeTestTimeoutMs: options.smokeTestTimeoutMs,
    smokeTestArgs: options.smokeTestArgs,
  });
}

export async function analyzePythonFile(
  filePath: string,
  options: {
    mode?: "inline" | "file" | undefined;
    maxIssues?: number | undefined;
    includeRawOutput?: boolean | undefined;
    runSmokeTest?: boolean | undefined;
    smokeTestTimeoutMs?: number | undefined;
    smokeTestArgs?: string[] | undefined;
  } = {},
): Promise<CheckForBugsResult> {
  const mode = options.mode ?? "file";
  const maxIssues = normalizeMaxIssues(options.maxIssues);
  const includeRawOutput = options.includeRawOutput ?? false;
  const runSmokeTest = options.runSmokeTest ?? true;
  const smokeTestTimeoutMs = normalizeSmokeTestTimeout(options.smokeTestTimeoutMs);
  const smokeTestArgs = sanitizeSmokeTestArgs(options.smokeTestArgs);
  const pythonCommand = await resolvePythonCommand();
  const issues: BugCheckIssue[] = [];
  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];

  const syntaxResult = await runPythonCommand(
    pythonCommand,
    ["-m", "py_compile", filePath],
    DEFAULT_ANALYSIS_TIMEOUT_MS,
    path.dirname(filePath),
  );

  stdoutParts.push(syntaxResult.stdout);
  stderrParts.push(syntaxResult.stderr);

  if (syntaxResult.timedOut) {
    issues.push({
      severity: "error",
      code: "PY_COMPILE_TIMEOUT",
      message: "Python syntax check timed out.",
      filePath,
      source: "syntax",
    });
  }

  const syntaxIssue = parsePyCompileError(syntaxResult.stderr, filePath);
  if (syntaxIssue !== null) {
    issues.push(syntaxIssue);
  }

  const syntaxOk = !syntaxResult.timedOut && syntaxResult.exitCode === 0;
  let ruffAvailable = false;
  let fallbackAstAvailable = false;
  let staticAnalysisAvailable = false;
  let exitCode = syntaxResult.exitCode;
  const smokeTest: SmokeTestResult = {
    enabled: runSmokeTest,
    timeoutMs: smokeTestTimeoutMs,
    ran: false,
    timedOut: false,
    exitCode: null,
    detectedRuntimeError: false,
    summary: runSmokeTest
      ? "Smoke test not run."
      : "Smoke test disabled.",
  };

  if (syntaxOk) {
    const sourceCode = await readFile(filePath, "utf8");
    issues.push(...collectTextWarnings(sourceCode, filePath));

    const ruffResult = await runRuff(pythonCommand, filePath);
    stderrParts.push(ruffResult.stderr);
    exitCode = ruffResult.exitCode;

    if (ruffResult.available) {
      ruffAvailable = true;
      staticAnalysisAvailable = true;
      issues.push(...ruffResult.issues);
    }

    const fallbackResult = await runFallbackAstChecker(pythonCommand, filePath);
    stderrParts.push(fallbackResult.stderr);

    if (fallbackResult.available) {
      fallbackAstAvailable = true;
      staticAnalysisAvailable = true;
      issues.push(...fallbackResult.issues);
    } else if (!ruffResult.available) {
      issues.push({
        severity: "info",
        code: "STATIC_ANALYSIS_UNAVAILABLE",
        message: "Syntax check passed, but ruff is not installed for the selected interpreter and the fallback AST checker could not run, so deeper static analysis was not run.",
        filePath,
        source: "tool",
      });
    }

    if (runSmokeTest) {
      smokeTest.ran = true;
      const runtimeResult = await runPythonCommand(
        pythonCommand,
        [filePath, ...smokeTestArgs],
        smokeTestTimeoutMs,
        path.dirname(filePath),
        smokeTestEnvironment(),
      );
      stdoutParts.push(runtimeResult.stdout);
      stderrParts.push(runtimeResult.stderr);
      smokeTest.timedOut = runtimeResult.timedOut;
      smokeTest.exitCode = runtimeResult.exitCode;

      if (runtimeResult.timedOut) {
        smokeTest.summary = `Smoke test timed out after ${smokeTestTimeoutMs} ms; no immediate startup crash detected.`;
      } else if (runtimeResult.exitCode === 0) {
        smokeTest.summary = "Runtime smoke test completed without immediate startup crash.";
      } else {
        const runtimeIssue = parseRuntimeError(runtimeResult.stderr, runtimeResult.stdout, filePath);
        issues.push(runtimeIssue);
        smokeTest.detectedRuntimeError = true;
        const runtimeName = runtimeIssue.message.split(":")[0]?.trim() || "runtime error";
        smokeTest.summary = `Runtime smoke test failed with ${runtimeName}.`;
      }
    }
  }

  const deduplicatedIssues = deduplicateIssues(issues);
  const issueCount = deduplicatedIssues.length;
  const shownIssues = deduplicatedIssues.slice(0, maxIssues);
  const shownIssueCount = shownIssues.length;
  const truncated = issueCount > shownIssueCount;
  const issuesFound = issueCount > 0;
  const summary = buildSummary({
    syntaxOk,
    ruffAvailable,
    fallbackAstAvailable,
    staticAnalysisAvailable,
    smokeTest,
    issueCount,
    shownIssueCount,
    truncated,
  });
  const result: CheckForBugsResult = {
    success: true,
    mode,
    pythonExecutableUsed: pythonCommand.pythonExecutableUsed,
    syntaxOk,
    ruffAvailable,
    fallbackAstAvailable,
    staticAnalysisAvailable,
    smokeTest,
    issuesFound,
    issueCount,
    shownIssueCount,
    truncated,
    summary,
    issues: shownIssues,
    exitCode,
  };

  if (mode === "file") {
    result.filePath = filePath;
  }

  if (includeRawOutput) {
    result.stdout = truncateRawOutput(stripAnsi(joinOutput(stdoutParts)));
    result.stderr = truncateRawOutput(stripAnsi(joinOutput(stderrParts)));
  }

  return sanitizeResult(result);
}

async function runRuff(
  pythonCommand: PythonCommand,
  filePath: string,
): Promise<{
  available: boolean;
  issues: BugCheckIssue[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const result = await runPythonCommand(
    pythonCommand,
    ["-m", "ruff", "check", filePath, "--output-format=json"],
    DEFAULT_ANALYSIS_TIMEOUT_MS,
    path.dirname(filePath),
  );

  const trimmedStdout = stripAnsi(result.stdout).trim();
  if (trimmedStdout.length > 0) {
    const parsedIssues = parseRuffJson(trimmedStdout, filePath);
    if (parsedIssues !== null) {
      return {
        available: true,
        issues: parsedIssues,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    }
  }

  if (isRuffUnavailable(result)) {
    return {
      available: false,
      issues: [],
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  if (result.exitCode === 0 && trimmedStdout.length === 0) {
    return {
      available: true,
      issues: [],
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  return {
    available: false,
    issues: [{
      severity: "info",
      code: "RUFF_OUTPUT_UNPARSEABLE",
      message: "Ruff ran but did not return parseable JSON output, so its diagnostics were ignored.",
      filePath,
      source: "tool",
    }],
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

async function runFallbackAstChecker(
  pythonCommand: PythonCommand,
  filePath: string,
): Promise<{
  available: boolean;
  issues: BugCheckIssue[];
  stdout: string;
  stderr: string;
}> {
  const result = await runPythonCommand(
    pythonCommand,
    ["-c", FALLBACK_AST_CHECKER, filePath],
    DEFAULT_ANALYSIS_TIMEOUT_MS,
    path.dirname(filePath),
  );

  if (result.exitCode !== 0 || result.timedOut) {
    return {
      available: false,
      issues: [],
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const parsedIssues = parseFallbackJson(result.stdout, filePath);
  if (parsedIssues === null) {
    return {
      available: false,
      issues: [],
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  return {
    available: true,
    issues: parsedIssues,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runPythonCommand(
  pythonCommand: PythonCommand,
  args: string[],
  timeoutMs: number,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<PythonProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(pythonCommand.command, [...pythonCommand.argsPrefix, ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr: stderr.length > 0 ? stderr : error.message,
        exitCode: null,
        timedOut,
      });
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
      });
    });
  });
}

function parseRuffJson(rawJson: string, fallbackFilePath: string): BugCheckIssue[] | null {
  const parsed: unknown = safeJsonParse(stripAnsi(rawJson));
  if (!Array.isArray(parsed)) {
    return null;
  }

  const issues: BugCheckIssue[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue;
    }

    const code = typeof item.code === "string" ? item.code : undefined;
    const message = typeof item.message === "string" ? stripAnsi(item.message) : "Ruff reported an issue.";
    const location = isRecord(item.location) ? item.location : {};
    const filename = typeof item.filename === "string" && item.filename.length > 0
      ? item.filename
      : fallbackFilePath;

    issues.push(buildIssue({
      severity: severityForRuffCode(code),
      code,
      message,
      filePath: filename,
      line: numberProperty(location, "row"),
      column: numberProperty(location, "column"),
      source: "ruff",
    }));
  }

  return issues;
}

function parseFallbackJson(rawJson: string, fallbackFilePath: string): BugCheckIssue[] | null {
  const parsed: unknown = safeJsonParse(stripAnsi(rawJson).trim());
  if (!Array.isArray(parsed)) {
    return null;
  }

  const issues: BugCheckIssue[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue;
    }

    const message = typeof item.message === "string" ? stripAnsi(item.message) : "Fallback AST checker reported an issue.";
    const severity = item.severity === "error" || item.severity === "warning" || item.severity === "info"
      ? item.severity
      : "warning";
    const code = typeof item.code === "string" ? item.code : undefined;
    const itemFilePath = typeof item.filePath === "string" && item.filePath.length > 0
      ? item.filePath
      : fallbackFilePath;

    issues.push(buildIssue({
      severity,
      code,
      message,
      filePath: itemFilePath,
      line: numberProperty(item, "line"),
      column: numberProperty(item, "column"),
      source: "fallback-ast",
    }));
  }

  return issues;
}

function collectTextWarnings(code: string, filePath: string): BugCheckIssue[] {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  let sawTabIndent = false;
  let sawSpaceIndent = false;
  let tabIndentLine: number | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      continue;
    }

    const leadingWhitespace = line.match(/^[\t ]+/)?.[0] ?? "";
    if (leadingWhitespace.includes("\t")) {
      sawTabIndent = true;
      tabIndentLine ??= index + 1;
    }

    if (leadingWhitespace.includes(" ")) {
      sawSpaceIndent = true;
    }
  }

  if (sawTabIndent && sawSpaceIndent) {
    return [buildIssue({
      severity: "warning",
      code: "MIXED_INDENTATION",
      message: "Code appears to mix tabs and spaces for indentation.",
      filePath,
      line: tabIndentLine,
      source: "tool",
    })];
  }

  return [];
}

function parsePyCompileError(stderr: string, filePath: string): BugCheckIssue | null {
  const trimmedStderr = stripAnsi(stderr).trim();
  if (trimmedStderr.length === 0) {
    return null;
  }

  const syntaxLine = trimmedStderr
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().includes("syntaxerror"));

  const lineNumberMatch = trimmedStderr.match(/line\s+(\d+)/i);
  const caretLine = trimmedStderr.split(/\r?\n/).find((line) => line.includes("^"));
  const caretColumn = caretLine === undefined ? undefined : Math.max(1, caretLine.indexOf("^") + 1);
  const lineNumberText = lineNumberMatch?.[1];
  const parsedLineNumber = lineNumberText === undefined ? undefined : Number.parseInt(lineNumberText, 10);

  return buildIssue({
    severity: "error",
    code: "SYNTAX_ERROR",
    message: syntaxLine?.trim() ?? "py_compile reported an error.",
    filePath,
    line: Number.isInteger(parsedLineNumber) ? parsedLineNumber : undefined,
    column: caretColumn,
    source: "syntax",
  });
}

function severityForRuffCode(code: string | undefined): BugCheckSeverity {
  if (code?.startsWith("F")) {
    return "error";
  }

  return "warning";
}

function isRuffUnavailable(result: PythonProcessResult): boolean {
  const combinedOutput = stripAnsi(`${result.stdout}\n${result.stderr}`).toLowerCase();
  return combinedOutput.includes("no module named ruff")
    || combinedOutput.includes("module named ruff")
    || combinedOutput.includes("ruff.__main__");
}

function normalizeMaxIssues(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_ISSUES;
  }

  return Math.min(ABSOLUTE_MAX_ISSUES, Math.max(1, Math.trunc(value)));
}

function deduplicateIssues(issues: BugCheckIssue[]): BugCheckIssue[] {
  const byKey = new Map<string, BugCheckIssue>();

  for (const issue of issues) {
    const key = dedupeKey(issue);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { ...issue, occurrences: 1 });
      continue;
    }

    existing.occurrences = (existing.occurrences ?? 1) + 1;
    if (
      issue.line !== undefined
      && (existing.line !== issue.line || existing.column !== issue.column)
      && (existing.additionalLocations?.length ?? 0) < MAX_ADDITIONAL_LOCATIONS
    ) {
      existing.additionalLocations ??= [];
      const duplicateLocation = existing.additionalLocations.some((location) => (
        location.line === issue.line && location.column === issue.column
      ));
      if (!duplicateLocation) {
        existing.additionalLocations.push(buildLocation(issue.line, issue.column));
      }
    }
  }

  return [...byKey.values()].map((issue) => {
    if (issue.occurrences === 1) {
      delete issue.occurrences;
    }

    if (issue.additionalLocations !== undefined && issue.additionalLocations.length === 0) {
      delete issue.additionalLocations;
    }

    return issue;
  });
}

function dedupeKey(issue: BugCheckIssue): string {
  if (issue.code === "FALLBACK_UNDEFINED_INSTANCE_ATTRIBUTE") {
    const parsed = parseUndefinedInstanceAttributeMessage(issue.message);
    if (parsed !== null) {
      return [
        issue.source ?? "",
        issue.code,
        parsed.className,
        parsed.attributeName,
      ].join("|");
    }
  }

  return [
    issue.source ?? "",
    issue.code ?? "",
    issue.message,
    issue.filePath ?? "",
    issue.line ?? "",
    issue.column ?? "",
  ].join("|");
}

function parseUndefinedInstanceAttributeMessage(message: string): { className: string; attributeName: string } | null {
  const match = message.match(/self\.([A-Za-z_][A-Za-z0-9_]*)'.*class '([^']+)'/);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }

  return {
    attributeName: match[1],
    className: match[2],
  };
}

function buildLocation(line: number, column: number | undefined): { line: number; column?: number } {
  const location: { line: number; column?: number } = { line };
  if (column !== undefined) {
    location.column = column;
  }
  return location;
}

function buildSummary(input: {
  syntaxOk: boolean;
  ruffAvailable: boolean;
  fallbackAstAvailable: boolean;
  staticAnalysisAvailable: boolean;
  smokeTest: SmokeTestResult;
  issueCount: number;
  shownIssueCount: number;
  truncated: boolean;
}): string {
  if (!input.syntaxOk) {
    return `Syntax check failed with ${input.issueCount} ${pluralize("error", input.issueCount)}.`;
  }

  if (input.truncated) {
    return `Syntax check passed. Found ${input.issueCount} issues; showing ${input.shownIssueCount} due to maxIssues.`;
  }

  const runtimeIssueDetected = input.smokeTest.detectedRuntimeError;
  if (runtimeIssueDetected) {
    const runtimeName = input.smokeTest.summary
      .replace("Runtime smoke test failed with ", "")
      .replace(/\.$/, "")
      .trim() || "runtime error";
    if (input.issueCount === 1) {
      return `Syntax check passed, but runtime smoke test failed with ${runtimeName}.`;
    }
    return `Syntax check passed, runtime smoke test failed with ${runtimeName}, and ${input.issueCount - 1} additional static ${pluralize("issue", input.issueCount - 1)} were found.`;
  }

  if (input.issueCount > 0) {
    if (!input.ruffAvailable && input.fallbackAstAvailable) {
      return `Syntax check passed. Ruff unavailable; fallback AST checks found ${input.issueCount} possible ${pluralize("issue", input.issueCount)}.`;
    }

    return `Syntax check passed. Static analysis found ${input.issueCount} ${pluralize("issue", input.issueCount)}.`;
  }

  if (!input.ruffAvailable && input.fallbackAstAvailable) {
    const staticPrefix = "Syntax check passed. Ruff unavailable; fallback AST checks found no issues.";
    if (input.smokeTest.enabled && input.smokeTest.ran && input.smokeTest.timedOut) {
      return `${staticPrefix} ${input.smokeTest.summary}`;
    }
    if (input.smokeTest.enabled && input.smokeTest.ran) {
      return `${staticPrefix} Runtime smoke test found no immediate startup crash.`;
    }
    return staticPrefix;
  }

  if (input.smokeTest.enabled && input.smokeTest.ran && input.smokeTest.timedOut) {
    return `Syntax check passed. ${input.smokeTest.summary}`;
  }

  if (input.smokeTest.enabled && input.smokeTest.ran) {
    return "Syntax check passed. Static checks found no issues. Runtime smoke test found no immediate startup crash.";
  }

  if (!input.staticAnalysisAvailable) {
    return "Syntax check passed. Static analysis was unavailable.";
  }

  return "Syntax check passed. Static checks found no issues.";
}

function normalizeSmokeTestTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SMOKE_TEST_TIMEOUT_MS;
  }

  const timeout = Math.trunc(value);
  return Math.min(MAXIMUM_SMOKE_TEST_TIMEOUT_MS, Math.max(MINIMUM_SMOKE_TEST_TIMEOUT_MS, timeout));
}

function sanitizeSmokeTestArgs(value: string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseRuntimeError(stderr: string, stdout: string, fallbackFilePath: string): BugCheckIssue {
  const sanitizedStderr = stripAnsi(stderr);
  const sanitizedStdout = stripAnsi(stdout);
  const traceback = extractTraceback(sanitizedStderr) ?? extractTraceback(sanitizedStdout);
  if (traceback === null) {
    return buildIssue({
      severity: "error",
      code: "RUNTIME_ERROR",
      message: "Runtime smoke test failed with a non-zero exit code.",
      filePath: fallbackFilePath,
      source: "runtime-smoke-test",
      details: "Crash occurred during startup. No Python traceback was captured.",
    });
  }

  const exceptionLine = compactExceptionLine(traceback.lines[traceback.lines.length - 1]?.trim() || "RuntimeError");
  const frames = traceback.frames.filter((frame) => frame.filePath.length > 0);
  const preferredFrame = [...frames].reverse().find((frame) => path.resolve(frame.filePath) === path.resolve(fallbackFilePath))
    ?? frames[frames.length - 1];
  const functionName = preferredFrame?.functionName ?? "unknown frame";
  const details = preferredFrame === undefined
    ? "Crash occurred during startup."
    : `Crash occurred during startup. Last user-code frame: ${functionName} at line ${preferredFrame.line}.`;

  return buildIssue({
    severity: "error",
    code: "RUNTIME_ERROR",
    message: exceptionLine,
    filePath: preferredFrame?.filePath ?? fallbackFilePath,
    line: preferredFrame?.line,
    source: "runtime-smoke-test",
    details,
  });
}

function extractTraceback(output: string): { lines: string[]; frames: Array<{ filePath: string; line: number; functionName?: string; sourceLine?: string }> } | null {
  const lines = stripAnsi(output).split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().startsWith("Traceback (most recent call last):"));
  if (startIndex < 0) {
    return null;
  }

  const tracebackLines = lines.slice(startIndex).filter((line) => line.trim().length > 0);
  if (tracebackLines.length < 2) {
    return null;
  }

  const frames: Array<{ filePath: string; line: number; functionName?: string; sourceLine?: string }> = [];
  for (let index = 0; index < tracebackLines.length; index += 1) {
    const line = tracebackLines[index];
    if (line === undefined) {
      continue;
    }
    const frameMatch = line.match(/^\s*File "([^"]+)", line (\d+), in (.+)$/);
    if (frameMatch === null || frameMatch[1] === undefined || frameMatch[2] === undefined) {
      continue;
    }

    const sourceLine = tracebackLines[index + 1]?.trim();
    const parsedLine = Number.parseInt(frameMatch[2], 10);
    if (!Number.isFinite(parsedLine)) {
      continue;
    }

    const frame: { filePath: string; line: number; functionName?: string; sourceLine?: string } = {
      filePath: frameMatch[1],
      line: parsedLine,
    };
    const functionName = frameMatch[3]?.trim();
    if (functionName !== undefined && functionName.length > 0) {
      frame.functionName = functionName;
    }
    if (sourceLine !== undefined && !sourceLine.startsWith("File ")) {
      frame.sourceLine = sourceLine;
    }
    frames.push(frame);
  }

  return {
    lines: tracebackLines,
    frames,
  };
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function truncateRawOutput(output: string): string {
  const sanitized = stripAnsi(output);
  if (sanitized.length <= MAX_RAW_OUTPUT_CHARS) {
    return sanitized;
  }

  return `${sanitized.slice(0, MAX_RAW_OUTPUT_CHARS)}...[truncated]`;
}

function joinOutput(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("\n");
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function numberProperty(value: Record<string, unknown>, key: string): number | undefined {
  const property = value[key];
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function buildIssue(input: {
  severity: BugCheckSeverity;
  code?: string | undefined;
  message: string;
  filePath?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
  source?: BugCheckIssueSource | undefined;
  details?: string | undefined;
}): BugCheckIssue {
  const issue: BugCheckIssue = {
    severity: input.severity,
    message: stripAnsi(input.message),
  };

  if (input.code !== undefined) {
    issue.code = stripAnsi(input.code);
  }

  if (input.filePath !== undefined) {
    issue.filePath = stripAnsi(input.filePath);
  }

  if (input.line !== undefined) {
    issue.line = input.line;
  }

  if (input.column !== undefined) {
    issue.column = input.column;
  }

  if (input.source !== undefined) {
    issue.source = input.source;
  }

  if (input.details !== undefined) {
    issue.details = stripAnsi(input.details);
  }

  return issue;
}

function smokeTestEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

function compactExceptionLine(exceptionLine: string): string {
  return stripAnsi(exceptionLine).replace(/\s+/g, " ").trim();
}

function sanitizeResult(result: CheckForBugsResult): CheckForBugsResult {
  const sanitized: CheckForBugsResult = {
    ...result,
    pythonExecutableUsed: stripAnsi(result.pythonExecutableUsed),
    summary: stripAnsi(result.summary),
    smokeTest: {
      ...result.smokeTest,
      summary: stripAnsi(result.smokeTest.summary),
    },
    issues: result.issues.map((issue) => {
      const sanitizedIssue: BugCheckIssue = {
        ...issue,
        message: stripAnsi(issue.message),
      };
      if (issue.code !== undefined) {
        sanitizedIssue.code = stripAnsi(issue.code);
      }
      if (issue.filePath !== undefined) {
        sanitizedIssue.filePath = stripAnsi(issue.filePath);
      }
      if (issue.details !== undefined) {
        sanitizedIssue.details = stripAnsi(issue.details);
      }
      return sanitizedIssue;
    }),
  };

  if (result.filePath !== undefined) {
    sanitized.filePath = stripAnsi(result.filePath);
  }
  if (result.stdout !== undefined) {
    sanitized.stdout = truncateRawOutput(result.stdout);
  }
  if (result.stderr !== undefined) {
    sanitized.stderr = truncateRawOutput(result.stderr);
  }

  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FALLBACK_AST_CHECKER = String.raw`
import ast
import builtins
import json
import sys

file_path = sys.argv[1]
source = open(file_path, "r", encoding="utf8").read()
tree = ast.parse(source, filename=file_path)
builtin_names = set(dir(builtins))
issues = []

def issue(severity, code, message, node):
    issues.append({
        "severity": severity,
        "code": code,
        "message": message,
        "filePath": file_path,
        "line": getattr(node, "lineno", None),
        "column": getattr(node, "col_offset", 0) + 1,
    })

def assigned_names(node):
    names = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)):
            names.add(child.id)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(child.name)
        elif isinstance(child, ast.ExceptHandler) and child.name:
            names.add(child.name)
        elif isinstance(child, ast.Import):
            for alias in child.names:
                names.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(child, ast.ImportFrom):
            for alias in child.names:
                if alias.name != "*":
                    names.add(alias.asname or alias.name)
    return names

module_defined = set()
for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        module_defined.add(node.name)
    elif isinstance(node, ast.Import):
        for alias in node.names:
            module_defined.add(alias.asname or alias.name.split(".")[0])
    elif isinstance(node, ast.ImportFrom):
        for alias in node.names:
            if alias.name != "*":
                module_defined.add(alias.asname or alias.name)
    else:
        module_defined.update(assigned_names(node))

class ParentAnnotator(ast.NodeVisitor):
    def generic_visit(self, node):
        for child in ast.iter_child_nodes(node):
            child.parent = node
        super().generic_visit(node)

ParentAnnotator().visit(tree)

def function_arg_names(node):
    args = set()
    all_args = list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs)
    if node.args.vararg:
        all_args.append(node.args.vararg)
    if node.args.kwarg:
        all_args.append(node.args.kwarg)
    for arg in all_args:
        args.add(arg.arg)
    return args

def is_definition_name(node):
    parent = getattr(node, "parent", None)
    return (
        isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and parent.name == node.id
    )

class UndefinedNameVisitor(ast.NodeVisitor):
    def __init__(self, defined):
        self.defined = defined

    def visit_FunctionDef(self, node):
        local_defined = set(self.defined)
        local_defined.update(function_arg_names(node))
        local_defined.update(assigned_names(node))
        UndefinedNameVisitor(local_defined).visit_statements(node.body)

    def visit_AsyncFunctionDef(self, node):
        self.visit_FunctionDef(node)

    def visit_Lambda(self, node):
        return

    def visit_ClassDef(self, node):
        class_defined = set(self.defined)
        class_defined.update(assigned_names(node))
        UndefinedNameVisitor(class_defined).visit_statements(node.body)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load) and node.id not in self.defined and node.id not in builtin_names and not is_definition_name(node):
            issue("error", "FALLBACK_UNDEFINED_NAME", f"Possible undefined name '{node.id}'.", node)

    def visit_statements(self, statements):
        for statement in statements:
            self.visit(statement)

UndefinedNameVisitor(set(module_defined)).visit_statements(tree.body)

class SelfAttributeVisitor(ast.NodeVisitor):
    def visit_ClassDef(self, node):
        assigned = set()
        methods = set()
        class_attributes = set()
        properties = set()
        reads = []
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                methods.add(item.name)
                for decorator in item.decorator_list:
                    if isinstance(decorator, ast.Name) and decorator.id == "property":
                        properties.add(item.name)
                    elif isinstance(decorator, ast.Attribute) and decorator.attr == "getter":
                        properties.add(item.name)
                continue
            targets = []
            if isinstance(item, (ast.Assign, ast.AnnAssign)):
                targets = item.targets if isinstance(item, ast.Assign) else [item.target]
            elif isinstance(item, ast.AugAssign):
                targets = [item.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    class_attributes.add(target.id)

        for item in node.body:
            if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if not item.args.args:
                continue
            self_name = item.args.args[0].arg
            for child in ast.walk(item):
                if (
                    isinstance(child, ast.Attribute)
                    and isinstance(child.value, ast.Name)
                    and child.value.id == self_name
                ):
                    if isinstance(child.ctx, ast.Store):
                        assigned.add(child.attr)
                    elif isinstance(child.ctx, ast.Load):
                        reads.append(child)
        for read in reads:
            if (
                read.attr not in assigned
                and read.attr not in methods
                and read.attr not in class_attributes
                and read.attr not in properties
                and not read.attr.startswith("__")
            ):
                issue(
                    "warning",
                    "FALLBACK_UNDEFINED_INSTANCE_ATTRIBUTE",
                    f"Possible undefined instance attribute 'self.{read.attr}' is read but never assigned in class '{node.name}'.",
                    read,
                )
        self.generic_visit(node)

SelfAttributeVisitor().visit(tree)
print(json.dumps(issues))
`;
