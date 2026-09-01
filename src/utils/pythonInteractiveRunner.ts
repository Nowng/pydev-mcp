import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { resolvePythonCommand } from "./pythonResolver";
import {
  ensurePythonFile,
  resolveRunCwd,
  validateArgs,
  validatePathInput,
  validateWindowTitle,
  ensureTempWorkspaceDir,
} from "./safePaths";

export interface LaunchInteractiveRequest {
  filePath: string;
  args?: string[];
  cwd?: string;
  windowTitle?: string;
}

export interface LaunchInteractiveResult {
  launched: true;
  pythonExecutableUsed: string;
  filePath: string;
  args: string[];
  cwd: string;
  launcherPath: string;
  sessionId?: string;
}

export async function writeTemporaryPythonFile(code: string): Promise<string> {
  validateCode(code);
  const tempDir = path.join(await ensureTempWorkspaceDir(), "pydev-mcp");
  const scriptPath = path.join(tempDir, `interactive-${randomUUID()}.py`);

  await mkdir(tempDir, { recursive: true });
  await writeFile(scriptPath, code, "utf8");
  return scriptPath;
}

export async function launchPythonFileInteractive(
  request: LaunchInteractiveRequest,
): Promise<LaunchInteractiveResult> {
  const resolvedFilePath = await ensurePythonFile(request.filePath);
  return await launchValidatedPythonFileInteractive(request, resolvedFilePath);
}

export async function launchTemporaryPythonFileInteractive(
  request: LaunchInteractiveRequest,
): Promise<LaunchInteractiveResult> {
  const resolvedFilePath = await ensurePythonFile(request.filePath);
  return await launchValidatedPythonFileInteractive(request, resolvedFilePath);
}

async function launchValidatedPythonFileInteractive(
  request: LaunchInteractiveRequest,
  resolvedFilePath: string,
): Promise<LaunchInteractiveResult> {
  const resolvedArgs = validateArgs(request.args);
  const resolvedCwd = await resolveRunCwd(request.cwd, resolvedFilePath);
  const resolvedWindowTitle = validateWindowTitle(request.windowTitle);
  const pythonCommand = await resolvePythonCommand();

  // Choose the terminal session manager based on platform.
  if (process.platform === "win32") {
    return await launchWindowsTerminalSession({
      pythonExecutable: pythonCommand.pythonExecutableUsed,
      scriptPath: resolvedFilePath,
      args: resolvedArgs,
      cwd: resolvedCwd,
      windowTitle: resolvedWindowTitle,
    });
  }

  if (process.platform === "linux" || process.platform === "darwin") {
    return await launchUnixTerminalSession({
      pythonExecutable: pythonCommand.pythonExecutableUsed,
      scriptPath: resolvedFilePath,
      args: resolvedArgs,
      cwd: resolvedCwd,
      windowTitle: resolvedWindowTitle,
    });
  }

  // Fallback for other platforms (e.g., Android) — try tmux/screen, or fall back to simple spawn.
  return await launchFallbackTerminalSession({
    pythonExecutable: pythonCommand.pythonExecutableUsed,
    scriptPath: resolvedFilePath,
    args: resolvedArgs,
    cwd: resolvedCwd,
    windowTitle: resolvedWindowTitle,
  });
}

function validateCode(code: string): void {
  if (code.trim().length === 0) {
    throw new Error("Python code cannot be empty.");
  }

  if (code.length > 50_000) {
    throw new Error("Python code must be 50000 characters or fewer.");
  }
}

/**
 * Launches a Python script in an interactive terminal session on Unix-like systems.
 * Uses `tmux` as primary, falls back to `screen` if tmux is not available.
 */
async function launchUnixTerminalSession(input: {
  pythonExecutable: string;
  scriptPath: string;
  args: string[];
  cwd: string;
  windowTitle?: string;
}): Promise<LaunchInteractiveResult> {
  const tempDir = path.join(tmpdir(), "pydev-mcp");
  const sessionId = randomUUID().slice(0, 8);

  try {
    // Try tmux first.
    await spawnDetached("tmux", ["new-session", "-d", "-s", `pydev-mcp-${sessionId}`, ...input.args, input.pythonExecutable, input.scriptPath]);

    const sessionName = `pydev-mcp-${sessionId}`;

    // Set window title if provided (tmux supports this).
    if (input.windowTitle !== undefined && input.windowTitle.trim().length > 0) {
      await spawnDetached("tmux", ["send-keys", "-t", sessionName, `:rename-window ${input.windowTitle}`]);
    }

    // Attach to the session so the process stays alive.
    await spawnDetached("tmux", ["attach-session", "-t", sessionName]);

    return {
      launched: true,
      pythonExecutableUsed: input.pythonExecutable,
      filePath: input.scriptPath,
      args: input.args,
      cwd: input.cwd,
      launcherPath: path.join(tempDir, `launch-${sessionId}.sh`),
      sessionId,
    };
  } catch (error) {
    // tmux not found — try screen.
    if (error instanceof Error && error.message.includes("ENOENT")) {
      try {
        await spawnDetached("screen", ["-S", `pydev-mcp-${sessionId}`, "-dmS", `pydev-mcp-${sessionId}`, ...input.args, input.pythonExecutable, input.scriptPath]);
        const sessionName = `pydev-mcp-${sessionId}`;
        if (input.windowTitle !== undefined && input.windowTitle.trim().length > 0) {
          await spawnDetached("screen", ["-X", "-r", sessionName, "hardcopy"]); // Screen doesn't support title well.
        }
        await spawnDetached("screen", ["-r", sessionName]);
        return {
          launched: true,
          pythonExecutableUsed: input.pythonExecutable,
          filePath: input.scriptPath,
          args: input.args,
          cwd: input.cwd,
          launcherPath: path.join(tempDir, `launch-${sessionId}.sh`),
          sessionId,
        };
      } catch (screenError) {
        // Both tmux and screen failed — fall back to simple spawn.
        return await launchFallbackTerminalSession(input);
      }
    }

    throw error;
  }
}

/**
 * Launches a Python script in an interactive terminal session on Windows.
 * Uses Windows Terminal (wt.exe) as primary, falls back to cmd.exe.
 */
async function launchWindowsTerminalSession(input: {
  pythonExecutable: string;
  scriptPath: string;
  args: string[];
  cwd: string;
  windowTitle: string;
}): Promise<LaunchInteractiveResult> {
  const tempDir = path.join(tmpdir(), "pydev-mcp");
  const launcherPath = path.join(tempDir, `launch-${randomUUID()}.cmd`);

  const argsForCmd = input.args.map(quoteForCmd).join(" ");
  const runCommand = `${quoteForCmd(input.pythonExecutable)} ${quoteForCmd(input.scriptPath)}${argsForCmd.length > 0 ? ` ${argsForCmd}` : ""}`;
  const content = [
    "@echo off",
    `title ${input.windowTitle}`,
    `cd /d ${quoteForCmd(input.cwd)}`,
    "echo.",
    `echo Python executable: ${quoteForCmd(input.pythonExecutable)}`,
    `echo Script: ${quoteForCmd(input.scriptPath)}`,
    "echo.",
    runCommand,
    "set EXIT_CODE=%ERRORLEVEL%",
    "echo.",
    `echo Python exited with code %EXIT_CODE%.`,
    "pause",
    "",
  ].join("\r\n");

  await mkdir(tempDir, { recursive: true });
  await writeFile(launcherPath, content, "utf8");

  try {
    await spawnDetached("wt.exe", ["cmd.exe", "/k", launcherPath]);
    return {
      launched: true,
      pythonExecutableUsed: input.pythonExecutable,
      filePath: input.scriptPath,
      args: input.args,
      cwd: input.cwd,
      launcherPath,
    };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) {
      throw error;
    }
    // Fall back to cmd.exe.
    const wrapperPath = path.join(tempDir, `open-${randomUUID()}.cmd`);
    const wrapperContent = [
      "@echo off",
      `start "" cmd.exe /k ${quoteForCmd(launcherPath)}`,
      "",
    ].join("\r\n");
    await writeFile(wrapperPath, wrapperContent, "utf8");
    await spawnDetached("cmd.exe", ["/c", wrapperPath]);
    return {
      launched: true,
      pythonExecutableUsed: input.pythonExecutable,
      filePath: input.scriptPath,
      args: input.args,
      cwd: input.cwd,
      launcherPath: wrapperPath,
    };
  }
}

/**
 * Fallback for unsupported platforms or when tmux/screen are unavailable.
 * Simply spawns the Python process in a visible terminal (non-detached).
 */
async function launchFallbackTerminalSession(input: {
  pythonExecutable: string;
  scriptPath: string;
  args: string[];
  cwd: string;
  windowTitle?: string;
}): Promise<LaunchInteractiveResult> {
  const tempDir = path.join(tmpdir(), "pydev-mcp");
  const launcherPath = path.join(tempDir, `launch-${randomUUID()}.sh`);

  // On Linux/macOS, use bash to run the Python script.
  const shellCommand = `${quoteForBash(input.pythonExecutable)} ${quoteForBash(input.scriptPath)} ${input.args.map(quoteForBash).join(" ")}`;
  const content = [
    `#!/bin/bash`,
    `echo "Python executable: ${quoteForBash(input.pythonExecutable)}"`,
    `echo "Script: ${quoteForBash(input.scriptPath)}"`,
    `echo "Arguments: ${input.args.join(' ')}"`,
    `echo "Working directory: ${input.cwd}"`,
    `echo ""`,
    `${shellCommand}`,
    "",
  ].join("\n");

  await mkdir(tempDir, { recursive: true });
  await writeFile(launcherPath, content, "utf8");

  // Spawn non-detached so the process stays alive until Python exits.
  await spawnDetached("bash", ["-c", launcherPath]);

  return {
    launched: true,
    pythonExecutableUsed: input.pythonExecutable,
    filePath: input.scriptPath,
    args: input.args,
    cwd: input.cwd,
    launcherPath,
  };
}

function quoteForBash(value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("Command value must not contain newline characters.");
  }
  // Escape backslashes and quotes for bash.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteForCmd(value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("Command value must not contain newline characters.");
  }
  return `"${value.replace(/%/g, "%%").replace(/"/g, '\\"')}"`;
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });

    child.once("error", (error) => {
      reject(new Error(`Failed to launch "${command}": ${error.message}`));
    });

    child.once("spawn", () => {
      // Detach from parent process so the spawned process continues running.
      child.unref();
      resolve();
    });
  });
}
