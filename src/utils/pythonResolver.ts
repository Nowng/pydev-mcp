import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readPythonToolsConfig, writePythonToolsConfig } from "./pythonConfig";
import { getResolvedWorkspaceRoot } from "./safePaths";
import { probeVenvStatus, type VenvStatus } from "./pythonVenv";

export interface PythonProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface PythonRunProcessResult extends PythonProcessResult {
  pythonExecutableUsed: string;
}

export interface PythonCommand {
  command: string;
  argsPrefix: string[];
  pythonExecutableUsed: string;
}

export interface PythonInterpreterInfo {
  source: string;
  command: string;
  executablePath: string | null;
  version: string | null;
  usable: boolean;
  error?: string;
}

export interface ActivePythonInfo {
  executablePath: string;
  version: string;
}

export interface ActivePythonStatus {
  activePython: ActivePythonInfo | null;
  warnings: string[];
}

export interface PythonResolutionAttempt {
  command: string;
  argsPrefix: string[];
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  spawnFailed: boolean;
}

export interface PythonExecutableValidationDiagnostic {
  path: string;
  exists: boolean;
  isFile: boolean;
  versionOutput: string | null;
  accepted: boolean;
  error: string | null;
}

export class PythonVersionResolutionError extends Error {
  public readonly attempted: PythonResolutionAttempt[];
  public readonly available: PythonInterpreterInfo[];
  public readonly pythonLauncherOutput: string;
  public readonly noMatchReason: string;
  public readonly requestedVersion: string;
  public readonly directPathCandidates: PythonExecutableValidationDiagnostic[];
  public readonly activePython: ActivePythonInfo | null;

  public constructor(
    version: string,
    attempted: PythonResolutionAttempt[],
    available: PythonInterpreterInfo[],
    pythonLauncherOutput: string,
    noMatchReason: string,
    directPathCandidates: PythonExecutableValidationDiagnostic[],
    activePython: ActivePythonInfo | null,
  ) {
    super(`Unable to resolve Python ${version}.`);
    this.name = "PythonVersionResolutionError";
    this.requestedVersion = version;
    this.attempted = attempted;
    this.available = available;
    this.pythonLauncherOutput = pythonLauncherOutput;
    this.noMatchReason = noMatchReason;
    this.directPathCandidates = directPathCandidates;
    this.activePython = activePython;
  }
}

const PYTHON_VERSION_REGEX = /^3(\.\d{1,2})?$/;
const ENV_PYTHON_PATH = "PYDEV_MCP_PYTHON_PATH";

const PYTHON_CANDIDATES: Array<{ command: string; argsPrefix: string[] }> =
  process.platform === "win32"
  ? [
      { command: "py", argsPrefix: ["-3"] },
      { command: "python", argsPrefix: [] },
      { command: "python3", argsPrefix: [] },
      { command: "python.exe", argsPrefix: [] },
    ]
    : [
      { command: "python3", argsPrefix: [] },
      { command: "python", argsPrefix: [] },
      { command: "python3.12", argsPrefix: [] },
      { command: "python3.11", argsPrefix: [] },
      { command: "python3.10", argsPrefix: [] },
    ];

/**
 * Resolves a usable Python command for executing code/tools.
 *
 * Resolution order (first match wins):
 *   1. Explicitly configured path from .pydev-mcp-config.json or env var
 *   2. Venv python at <cwd>/.venv/... if present and functional
 *   3. System `python3` / `python` commands on PATH (existing fallback behavior)
 *   4. Known direct absolute paths (/opt/homebrew/bin/python3, etc.)
 */
export async function resolvePythonCommand(): Promise<PythonCommand> {
  const configuredCommand = await resolveConfiguredPythonCommand();
  if (configuredCommand !== null) {
    return configuredCommand;
  }

  // NEW: prefer venv python when available, probing the resolved workspace root (active project root, else
  // workspace root). Falls through to system Python otherwise.
  let venvCwd = getResolvedWorkspaceRoot();
  if (venvCwd === null) {
    venvCwd = process.cwd();
  }
  const venvStatus = await tryResolveVenvPython(venvCwd);
  if (venvStatus.command !== null && venvStatus.usable) {
    return { command: venvStatus.command, argsPrefix: [], pythonExecutableUsed: venvStatus.pythonExecutableUsed };
  }

  for (const candidate of PYTHON_CANDIDATES) {
    const result = await spawnProcess(
      candidate.command,
      [...candidate.argsPrefix, "-c", "import sys; print(sys.executable)"],
      5,
    );
    if (result.spawnFailed || result.result.timedOut || result.result.exitCode !== 0) {
      continue;
    }
    const pythonExecutableUsed = result.result.stdout.trim();
    if (pythonExecutableUsed.length === 0) continue;
    return {
      command: candidate.command,
      argsPrefix: candidate.argsPrefix,
      pythonExecutableUsed,
    };
  }

  // Try common absolute paths to address LM Studio PATH being too clean.
  for (const directPath of getGenericDirectPaths()) {
    const command = await pythonCommandFromPath(directPath);
    if (command !== null) return command;
  }

  throw new Error(
    "Unable to start Python. Tried configured path, `python`, and `python3`. Also tried venv at `.venv/`.\n" +
    `Tried commands: ${PYTHON_CANDIDATES.map(c => c.command).join(", ")} and ${getGenericDirectPaths().length} common paths. ` +
    "Please set Python Executable Path in plugin settings to full path (e.g. /opt/homebrew/bin/python3 or C:\\Python312\\python.exe)."
  );
}

/**
 * Attempts to resolve a venv-based python at the given `cwd`. Returns null on failure — never throws.
 */
async function tryResolveVenvPython(cwd: string): Promise<{ command: string | null; usable: boolean; pythonExecutableUsed: string }> {
  const status = await probeVenvStatus(cwd);

  if (!status.usable || !status.pythonPath) {
    return { command: null, usable: false, pythonExecutableUsed: "" };
  }

  // Validate the venv python actually runs and reports a version.
  try {
    const result = await spawnProcess(status.pythonPath, ["--version"], 3);
    if (result.spawnFailed || result.result.timedOut || result.result.exitCode !== 0) {
      return { command: null, usable: false, pythonExecutableUsed: "" };
    }

    return {
      command: status.pythonPath,
      usable: true,
      pythonExecutableUsed: status.pythonPath,
    };
  } catch (_err) {
    return { command: null, usable: false, pythonExecutableUsed: "" };
  }
}

/**
 * Returns information about the venv state at `cwd` (if any), or an empty result.
 */
export async function getActiveVenvStatus(cwd?: string): Promise<VenvInfo> {
  let workingCwd = cwd ?? getResolvedWorkspaceRoot();
  if (workingCwd === null) {
    workingCwd = process.cwd();
  }
  const status = await probeVenvStatus(workingCwd);

  return {
    exists: status.exists,
    pythonPath: status.pythonPath,
    version: status.version,
    usable: status.usable,
  };
}

export interface VenvInfo {
  exists: boolean;
  pythonPath: string | null;
  version: string | null;
  usable: boolean;
}

//... 以下中間邏輯維持你原本的，不變...

export async function runResolvedPythonCommand(
  pythonCommand: PythonCommand,
  args: string[],
  timeoutSeconds: number,
  cwd?: string,
): Promise<PythonRunProcessResult> {
  const result = await spawnProcess(
    pythonCommand.command,
    [...pythonCommand.argsPrefix, ...args],
    timeoutSeconds,
    cwd,
  );
  if (result.spawnFailed) {
    throw new Error("Unable to start Python after resolving the Python executable.");
  }
  return {
   ...result.result,
    pythonExecutableUsed: pythonCommand.pythonExecutableUsed,
  };
}

export async function listPythonInterpreters(): Promise<PythonInterpreterInfo[]> {
  const interpreters: PythonInterpreterInfo[] = [];
  if (process.platform === "win32") {
    for (const version of ["3.12", "3.13", "3.14"]) {
      interpreters.push(...await listDirectWindowsPythonCandidates(version));
    }
  }

  // Add venv interpreter to the top if it exists and is usable — so users see it in switch_python_version.
  let workspaceCwd = getResolvedWorkspaceRoot();
  if (workspaceCwd === null) {
    workspaceCwd = process.cwd();
  }
  const cwdVenv = await probeVenvStatus(workspaceCwd);
  if (cwdVenv.usable && cwdVenv.pythonPath !== null) {
    interpreters.unshift({
      source: "venv",
      command: `pydev-mcp venv (${cwdVenv.version ?? ""})`,
      executablePath: cwdVenv.pythonPath,
      version: cwdVenv.version,
      usable: true,
    });
  }

  const activeStatus = await getActivePythonStatus();
  if (activeStatus.activePython !== null) {
    interpreters.push({
      source: "active-config",
      command: activeStatus.activePython.executablePath,
      executablePath: activeStatus.activePython.executablePath,
      version: activeStatus.activePython.version,
      usable: true,
    });
  }
  const commonCommands: Array<{ source: string; command: string; argsPrefix: string[] }> = [
    { source: "python", command: "python", argsPrefix: [] },
    { source: "python3", command: "python3", argsPrefix: [] },
  ];
  for (const candidate of commonCommands) {
    interpreters.push(await probePythonCommand(candidate.source, candidate.command, candidate.argsPrefix));
  }
  return dedupeInterpreters(interpreters);
}

export async function getActivePythonStatus(): Promise<ActivePythonStatus> {
  const warnings: string[] = [];
  const config = await readPythonToolsConfig();
  if (config.pythonExecutablePath !== undefined) {
    try {
      const validation = await validatePythonExecutablePath(config.pythonExecutablePath);
      return { activePython: { executablePath: validation.executablePath, version: validation.version }, warnings };
    } catch (error) {
      warnings.push(`Configured Python interpreter is invalid and was ignored: ${getErrorMessage(error)}`);
    }
  }
  const envPythonPath = process.env[ENV_PYTHON_PATH];
  if (envPythonPath !== undefined && envPythonPath.trim().length > 0) {
    try {
      const validation = await validatePythonExecutablePath(envPythonPath);
      return { activePython: { executablePath: validation.executablePath, version: validation.version }, warnings };
    } catch (error) {
      warnings.push(`${ENV_PYTHON_PATH} is invalid and was ignored: ${getErrorMessage(error)}`);
    }
  }
  try {
    const pythonCommand = await resolveFallbackPythonCommand();
    const validation = await validatePythonExecutablePath(pythonCommand.pythonExecutableUsed);
    return { activePython: { executablePath: validation.executablePath, version: validation.version }, warnings };
  } catch (error) {
    warnings.push(getErrorMessage(error));
    return { activePython: null, warnings };
  }
}

export async function setPythonExecutablePath(executablePath: string): Promise<ActivePythonInfo> {
  const validation = await validatePythonExecutablePath(executablePath);
  await writePythonToolsConfig({ pythonExecutablePath: validation.executablePath });
  return { executablePath: validation.executablePath, version: validation.version };
}

export async function resolvePythonVersion(version: string): Promise<ActivePythonInfo> {
  validatePythonVersion(version);
  if (version === "3") {
    throw new PythonVersionResolutionError(version, [], [], "", "Please specify a minor version like 3.12, 3.13, or 3.14.", [], (await getActivePythonStatus()).activePython);
  }
  const attempted: PythonResolutionAttempt[] = [];
  const directPathCandidates: PythonExecutableValidationDiagnostic[] = [];
  const available: PythonInterpreterInfo[] = [];
  for (const candidatePath of getWindowsPythonCandidatePaths(version)) {
    const diagnostic = await validatePythonExecutable(candidatePath, version);
    directPathCandidates.push(diagnostic);
    if (diagnostic.accepted) {
      return { executablePath: candidatePath, version: diagnostic.versionOutput ?? `Python ${version}` };
    }
    available.push({
      source: "windows-direct-path",
      command: candidatePath,
      executablePath: candidatePath,
      version: diagnostic.versionOutput,
      usable: false,
      error: diagnostic.error ?? "Candidate did not match requested version.",
    });
  }
  const pathFallback = await resolveFromPathCommands(version);
  attempted.push(...pathFallback.attempted);
  if (pathFallback.activePython !== null) return pathFallback.activePython;
  const activeStatus = await getActivePythonStatus();
  throw new PythonVersionResolutionError(version, attempted, available, "", `No generic candidate path or PATH command resolved Python ${version}.`, directPathCandidates, activeStatus.activePython);
}

export async function validatePythonExecutablePath(executablePath: string, requestedVersion?: string): Promise<ActivePythonInfo> {
  validateExecutablePathInput(executablePath);
  const stats = await stat(executablePath);
  if (!stats.isFile()) throw new Error("Python executable path must point to a file.");
  const result = await spawnProcess(executablePath, ["--version"], 5);
  if (result.spawnFailed) throw new Error("Unable to start Python executable.");
  if (result.result.timedOut) throw new Error("Python executable timed out while checking --version.");
  if (result.result.exitCode !== 0) throw new Error("Python executable did not return a successful --version result.");
  const version = `${result.result.stdout}${result.result.stderr}`.trim();
  if (!version.toLowerCase().startsWith("python ")) throw new Error("Executable does not appear to be Python.");
  if (requestedVersion !== undefined && !version.startsWith(`Python ${requestedVersion}`)) {
    throw new Error(`Executable version ${JSON.stringify(version)} does not match requested Python ${requestedVersion}.`);
  }
  return { executablePath, version };
}

export function validatePythonVersion(version: string): void {
  if (!PYTHON_VERSION_REGEX.test(version)) throw new Error("version must be a simple Python 3 version such as `3`, `3.12`, or `3.14`.");
}

async function resolveConfiguredPythonCommand(): Promise<PythonCommand | null> {
  const config = await readPythonToolsConfig();
  if (config.pythonExecutablePath !== undefined) {
    const configuredCommand = await pythonCommandFromPath(config.pythonExecutablePath);
    if (configuredCommand !== null) return configuredCommand;
  }
  const envPythonPath = process.env[ENV_PYTHON_PATH];
  if (envPythonPath !== undefined && envPythonPath.trim().length > 0) {
    return await pythonCommandFromPath(envPythonPath);
  }
  return null;
}

async function resolveFallbackPythonCommand(): Promise<PythonCommand> {
  for (const candidate of PYTHON_CANDIDATES) {
    const command = await pythonCommandFromCommand(candidate.command, candidate.argsPrefix);
    if (command !== null) return command;
  }
  for (const directPath of getGenericDirectPaths()) {
    const command = await pythonCommandFromPath(directPath);
    if (command !== null) return command;
  }
  throw new Error("Unable to start Python. Tried `python` and `python3`.");
}

async function pythonCommandFromPath(executablePath: string): Promise<PythonCommand | null> {
  try {
    const validation = await validatePythonExecutablePath(executablePath);
    return { command: validation.executablePath, argsPrefix: [], pythonExecutableUsed: validation.executablePath };
  } catch { return null; }
}

async function pythonCommandFromCommand(command: string, argsPrefix: string[]): Promise<PythonCommand | null> {
  const result = await spawnProcess(command, [...argsPrefix, "-c", "import sys; print(sys.executable)"], 5);
  if (result.spawnFailed || result.result.timedOut || result.result.exitCode !== 0) return null;
  const pythonExecutableUsed = result.result.stdout.trim();
  if (pythonExecutableUsed.length === 0) return null;
  return { command, argsPrefix, pythonExecutableUsed };
}

function toResolutionAttempt(command: string, args: string[], result: { spawnFailed: true } | { spawnFailed: false; result: PythonProcessResult }): PythonResolutionAttempt {
  if (result.spawnFailed) {
    return { command: formatCommand(command, args), argsPrefix: args, exitCode: null, stderr: "Unable to start process.", timedOut: false, spawnFailed: true };
  }
  return { command: formatCommand(command, args), argsPrefix: args, exitCode: result.result.exitCode, stderr: trimDiagnosticOutput(result.result.stderr), timedOut: result.result.timedOut, spawnFailed: false };
}

function findMatchingLauncherEntry(available: PythonInterpreterInfo[], requestedVersion: string): PythonInterpreterInfo | null {
  if (requestedVersion === "3") return available.find((interpreter) => interpreter.executablePath !== null && interpreter.usable) ?? null;
  return available.find((interpreter) => interpreter.version === requestedVersion && interpreter.executablePath !== null) ?? null;
}

// === 核心修正處 1：補回變數宣告 + 移除尾空格 bug ===
export function getWindowsPythonCandidatePaths(version: string): string[] {
  const compactVersion = version.replace(".", "");
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const paths: string[] = [];

  if (localAppData !== undefined && localAppData.trim().length > 0) {
    if (version === "3.14") {
      paths.push(path.join(localAppData, "Python", "pythoncore-3.14-64", "python.exe"));
    }
    paths.push(path.join(localAppData, "Programs", "Python", `Python${compactVersion}`, "python.exe"));
  }
  if (programFiles !== undefined && programFiles.trim().length > 0) {
    paths.push(path.join(programFiles, `Python${compactVersion}`, "python.exe"));
  }
  if (programFilesX86 !== undefined && programFilesX86.trim().length > 0) {
    paths.push(path.join(programFilesX86, `Python${compactVersion}`, "python.exe"));
  }
  return dedupeStrings(paths);
}

// === 核心修正處 2：新增 Unix 路徑 ===
export function getUnixPythonCandidatePaths(): string[] {
  const home = os.homedir();
  return dedupeStrings([
    "/opt/homebrew/bin/python3",
    "/opt/homebrew/bin/python",
    "/usr/local/bin/python3",
    "/usr/local/bin/python",
    "/usr/bin/python3",
    "/usr/bin/python",
    path.join(home, ".pyenv/shims/python3"),
    path.join(home, ".pyenv/shims/python"),
    path.join(home, "miniconda3/bin/python3"),
    path.join(home, "anaconda3/bin/python3"),
    path.join(home, ".local/bin/python3"),
  ]);
}

function getGenericDirectPaths(): string[] {
  if (process.platform === "win32") {
    return ["3.12", "3.13", "3.14", "3.11", "3.10"].flatMap(v => getWindowsPythonCandidatePaths(v));
  }
  return getUnixPythonCandidatePaths();
}

export async function validatePythonExecutable(executablePath: string, requestedVersion?: string): Promise<PythonExecutableValidationDiagnostic> {
  const diagnostic: PythonExecutableValidationDiagnostic = { path: executablePath, exists: false, isFile: false, versionOutput: null, accepted: false, error: null };
  try {
    validateExecutablePathInput(executablePath);
    const stats = await stat(executablePath);
    diagnostic.exists = true;
    diagnostic.isFile = stats.isFile();
    if (!diagnostic.isFile) { diagnostic.error = "Path exists but is not a file."; return diagnostic; }
    const result = await spawnProcess(executablePath, ["--version"], 5);
    if (result.spawnFailed) { diagnostic.error = "Unable to start Python executable."; return diagnostic; }
    diagnostic.versionOutput = `${result.result.stdout}${result.result.stderr}`.trim();
    if (result.result.timedOut) { diagnostic.error = "Python executable timed out while checking --version."; return diagnostic; }
    if (result.result.exitCode !== 0) { diagnostic.error = "Python executable did not return a successful --version result."; return diagnostic; }
    if (!diagnostic.versionOutput.toLowerCase().startsWith("python ")) { diagnostic.error = "Executable does not appear to be Python."; return diagnostic; }
    if (requestedVersion !== undefined && !diagnostic.versionOutput.startsWith(`Python ${requestedVersion}`)) { diagnostic.error = `Executable version ${JSON.stringify(diagnostic.versionOutput)} does not match requested Python ${requestedVersion}.`; return diagnostic; }
    diagnostic.accepted = true;
    return diagnostic;
  } catch (error) { diagnostic.error = getErrorMessage(error); return diagnostic; }
}

async function listDirectWindowsPythonCandidates(version: string): Promise<PythonInterpreterInfo[]> {
  const interpreters: PythonInterpreterInfo[] = [];
  for (const candidatePath of getWindowsPythonCandidatePaths(version)) {
    const diagnostic = await validatePythonExecutable(candidatePath, version);
    const interpreter: PythonInterpreterInfo = { source: "windows-direct-path", command: candidatePath, executablePath: candidatePath, version: diagnostic.versionOutput, usable: diagnostic.accepted };
    if (diagnostic.error !== null) interpreter.error = diagnostic.error;
    interpreters.push(interpreter);
  }
  return interpreters;
}

async function resolveFromPathCommands(version: string): Promise<{ activePython: ActivePythonInfo | null; attempted: PythonResolutionAttempt[] }> {
  const attempted: PythonResolutionAttempt[] = [];
  for (const candidate of PYTHON_CANDIDATES) {
    const result = await spawnProcess(candidate.command, [...candidate.argsPrefix, "-c", "import sys; print(sys.executable)"], 5);
    attempted.push(toResolutionAttempt(candidate.command, [...candidate.argsPrefix, "-c", "import sys; print(sys.executable)"], result));
    if (result.spawnFailed || result.result.timedOut || result.result.exitCode !== 0) continue;
    const executablePath = result.result.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (executablePath === undefined || executablePath.length === 0) continue;
    const diagnostic = await validatePythonExecutable(executablePath, version);
    attempted.push(toResolutionAttempt(executablePath, ["--version"], await spawnProcess(executablePath, ["--version"], 3)));
    if (diagnostic.accepted) return { activePython: { executablePath, version: diagnostic.versionOutput ?? `Python ${version}` }, attempted };
  }
  return { activePython: null, attempted };
}

async function probePythonCommand(source: string, command: string, argsPrefix: string[]): Promise<PythonInterpreterInfo> {
  const commandLabel = [command,...argsPrefix].join(" ");
  const resolvedCommand = await pythonCommandFromCommand(command, argsPrefix);
  if (resolvedCommand === null) return { source, command: commandLabel, executablePath: null, version: null, usable: false, error: "Command did not resolve to a usable Python interpreter." };
  return await probePythonExecutable(source, commandLabel, resolvedCommand.pythonExecutableUsed);
}

async function probePythonExecutable(source: string, command: string, executablePath: string): Promise<PythonInterpreterInfo> {
  try {
    const validation = await validatePythonExecutablePath(executablePath);
    return { source, command, executablePath: validation.executablePath, version: validation.version, usable: true };
  } catch (error) {
    return { source, command, executablePath, version: null, usable: false, error: getErrorMessage(error) };
  }
}

function dedupeInterpreters(interpreters: PythonInterpreterInfo[]): PythonInterpreterInfo[] {
  const seen = new Set<string>(); const deduped: PythonInterpreterInfo[] = [];
  for (const interpreter of interpreters) {
    const key = interpreter.executablePath ?? `${interpreter.source}:${interpreter.command}`;
    const normalizedKey = key.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey); deduped.push(interpreter);
  }
  return deduped;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>(); const deduped: string[] = [];
  for (const value of values) {
    const normalizedValue = value.toLowerCase();
    if (seen.has(normalizedValue)) continue;
    seen.add(normalizedValue); deduped.push(value);
  }
  return deduped;
}

function validateExecutablePathInput(executablePath: string): void {
  if (executablePath.trim().length === 0) throw new Error("Python executable path is required.");
  if (executablePath.length > 500) throw new Error("Python executable path must be 500 characters or fewer.");
  if (executablePath.includes("\n") || executablePath.includes("\r")) throw new Error("Python executable path must not contain newline characters.");
}

function getErrorMessage(error: unknown): string { return error instanceof Error ? error.message : "Unknown error."; }
function formatCommand(command: string, args: string[]): string { return [command,...args].join(" "); }
function trimDiagnosticOutput(value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length <= 500) return trimmedValue;
  return `${trimmedValue.slice(0, 500)}...`;
}

function spawnProcess(executable: string, args: string[], timeoutSeconds: number, cwd?: string): Promise<{ spawnFailed: true } | { spawnFailed: false; result: PythonProcessResult }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, ...(cwd ? { cwd } : {}) });
    let stdout = ""; let stderr = ""; let timedOut = false; let settled = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, timeoutSeconds * 1000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", () => { if (settled) return; settled = true; clearTimeout(timeout); resolve({ spawnFailed: true }); });
    child.on("close", (exitCode) => {
      if (settled) return; settled = true; clearTimeout(timeout);
      resolve({ spawnFailed: false, result: { stdout, stderr, exitCode, timedOut } });
    });
  });
}
