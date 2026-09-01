import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureTempWorkspaceDir, resolveRunCwd } from "./safePaths";
import {
  type PythonRunProcessResult,
  resolvePythonCommand,
  runResolvedPythonCommand,
} from "./pythonResolver";

export type PythonRunResult = PythonRunProcessResult;

const DEFAULT_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 20;
const MAX_CODE_LENGTH = 20_000;

export async function runPythonCode(
  code: string,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
): Promise<PythonRunResult> {
  validatePythonRequest(code, timeoutSeconds);

  const tempDir = await ensureTempWorkspaceDir();
  const filePath = path.join(tempDir, `run-${randomUUID()}.py`);

  await writeFile(filePath, code, "utf8");

  try {
    // Run from the workspace root (the scratch file lives under it) so imports of workspace
    // modules resolve deterministically instead of against process.cwd().
    const runCwd = await resolveRunCwd(undefined);
    return await runPythonFile(filePath, timeoutSeconds, runCwd);
  } finally {
    await rm(filePath, { force: true });
  }
}

function validatePythonRequest(code: string, timeoutSeconds: number): void {
  if (code.trim().length === 0) {
    throw new Error("Python code is required.");
  }

  if (code.length > MAX_CODE_LENGTH) {
    throw new Error(`Python code must be ${MAX_CODE_LENGTH} characters or fewer.`);
  }

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("timeoutSeconds must be a positive number.");
  }

  if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be ${MAX_TIMEOUT_SECONDS} seconds or fewer.`);
  }
}

async function runPythonFile(
  filePath: string,
  timeoutSeconds: number,
  cwd: string,
): Promise<PythonRunResult> {
  const pythonCommand = await resolvePythonCommand();
  return await runResolvedPythonCommand(pythonCommand, [filePath], timeoutSeconds, cwd);
}
