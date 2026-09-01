import { spawn } from "node:child_process";

import {
  resolvePythonCommand,
  type PythonRunProcessResult,
} from "./pythonResolver";
import {
  ensurePythonFile,
  resolveRunCwd,
  validateArgs,
} from "./safePaths";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 600;

export interface RunPythonFileRequest {
  filePath: string;
  args?: string[];
  cwd?: string;
  timeoutSeconds?: number;
}

export interface RunPythonFileResult extends PythonRunProcessResult {
  filePath: string;
  args: string[];
  cwd: string;
  success: boolean;
}

export async function runPythonFileInBackground(
  request: RunPythonFileRequest,
): Promise<RunPythonFileResult> {
  const timeoutSeconds = normalizeTimeoutSeconds(request.timeoutSeconds);
  // Resolve relative paths against the workspace root (not process.cwd()) so a request like
  // "palindrome-partitioning/src/solution.py" maps to <workspaceRoot>/palindrome-partitioning/src/solution.py.
  // ensurePythonFile() also enforces the .py extension, file existence, and the workspace-boundary safety check.
  const resolvedFilePath = await ensurePythonFile(request.filePath);
  const resolvedArgs = validateArgs(request.args);
  const resolvedCwd = await resolveRunCwd(request.cwd, resolvedFilePath);
  const pythonCommand = await resolvePythonCommand();

  const result = await runResolvedPythonCommandWithCwd(
    pythonCommand.command,
    [...pythonCommand.argsPrefix, resolvedFilePath, ...resolvedArgs],
    timeoutSeconds,
    resolvedCwd,
    pythonCommand.pythonExecutableUsed,
  );

  return {
    ...result,
    filePath: resolvedFilePath,
    args: resolvedArgs,
    cwd: resolvedCwd,
    success: !result.timedOut && result.exitCode === 0,
  };
}

function normalizeTimeoutSeconds(timeoutSeconds?: number): number {
  if (timeoutSeconds === undefined) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  if (!Number.isInteger(timeoutSeconds)) {
    throw new Error("timeoutSeconds must be an integer.");
  }

  if (timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be between 1 and ${MAX_TIMEOUT_SECONDS}.`);
  }

  return timeoutSeconds;
}

async function runResolvedPythonCommandWithCwd(
  executable: string,
  args: string[],
  timeoutSeconds: number,
  cwd: string,
  pythonExecutableUsed: string,
): Promise<PythonRunProcessResult> {
  const result = await spawnProcessWithCwd(executable, args, timeoutSeconds, cwd);

  if (result.spawnFailed) {
    throw new Error("Unable to start Python after resolving the Python executable.");
  }

  return {
    ...result.result,
    pythonExecutableUsed,
  };
}

function spawnProcessWithCwd(
  executable: string,
  args: string[],
  timeoutSeconds: number,
  cwd: string,
): Promise<{ spawnFailed: true } | { spawnFailed: false; result: Omit<PythonRunProcessResult, "pythonExecutableUsed"> }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
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
    }, timeoutSeconds * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({ spawnFailed: true });
    });

    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        spawnFailed: false,
        result: {
          stdout,
          stderr,
          exitCode,
          timedOut,
        },
      });
    });
  });
}
