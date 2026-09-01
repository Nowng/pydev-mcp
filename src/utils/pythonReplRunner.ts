/**
 * pythonReplRunner.ts — launches a persistent, interactive Python REPL session in the user's terminal.
 *
 * Unlike the file-based interactive runners (`pythonInteractiveRunner`), which save a `.py` script and run it,
 * this runner opens a bare Python interpreter prompt so an LLM (or human) can type commands one at a time,
 * inspect results immediately, and carry state across calls — a Jupyter-like experience delivered through MCP.
 *
 * It returns immediately after launching a persistent session (via tmux / screen / a detached shell on Unix,
 * or Windows Terminal / cmd.exe on Windows), mirroring the behavior of the other interactive tools.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { resolvePythonCommand } from "./pythonResolver";
import { getWorkspaceRoot, validateWorkingDirectory } from "./safePaths";

export interface RunReplRequest {
  cwd?: string;
  timeoutSeconds?: number;
}

export interface RunReplResult {
  launched: true;
  pythonExecutableUsed: string;
  cwd: string;
  sessionId: string;
  sessionManager: string;
  message: string;
}

const SESSION_PREFIX = "pydev-mcp-repl";

/**
 * Launches a persistent interactive Python REPL.
 *
 * @param request.cwd        Optional working directory (validated to live inside the workspace root).
 *                           Defaults to the configured workspace root so the REPL starts in the project.
 * @param request.timeoutSeconds Optional number of seconds to keep the session alive before it is
 *                               auto-terminated (best-effort; guaranteed only when tmux is available).
 *                               Omit for an indefinitely persistent session.
 */
export async function launchPythonRepl(request: RunReplRequest): Promise<RunReplResult> {
  const resolvedCwd = (await validateWorkingDirectory(request.cwd)) ?? getWorkspaceRoot();
  const pythonCommand = await resolvePythonCommand();
  const pythonExecutable = pythonCommand.pythonExecutableUsed;

  if (process.platform === "win32") {
    return launchWindowsRepl(pythonExecutable, resolvedCwd, request.timeoutSeconds);
  }

  return launchUnixRepl(pythonExecutable, resolvedCwd, request.timeoutSeconds);
}

/** Unix / macOS: tmux (primary) → screen (fallback) → detached bash (final fallback). */
async function launchUnixRepl(
  pythonExecutable: string,
  cwd: string,
  timeoutSeconds?: number,
): Promise<RunReplResult> {
  const sessionId = `${SESSION_PREFIX}-${randomUUID().slice(0, 8)}`;

  // Primary: a detached tmux session running the bare interpreter (persistent across calls).
  try {
    await spawnDetached("tmux", ["new-session", "-d", "-s", sessionId, pythonExecutable]);
    armSessionTimeout("tmux", ["kill-session", "-t", sessionId], timeoutSeconds);
    return successResult(pythonExecutable, cwd, sessionId, "tmux");
  } catch (error) {
    if (!isENOENT(error)) throw error;
  }

  // Fallback 1: screen.
  try {
    await spawnDetached("screen", ["-S", sessionId, "-dmS", sessionId, pythonExecutable]);
    armSessionTimeout("screen", ["-S", sessionId, "-X", "quit"], timeoutSeconds);
    return successResult(pythonExecutable, cwd, sessionId, "screen");
  } catch (error) {
    if (!isENOENT(error)) throw error;
  }

  // Fallback 2: plain detached bash running the interpreter inside a launcher script.
  return launchFallbackRepl(pythonExecutable, cwd, sessionId);
}

async function launchFallbackRepl(
  pythonExecutable: string,
  cwd: string,
  sessionId: string,
): Promise<RunReplResult> {
  const tempDir = path.join(tmpdir(), "pydev-mcp");
  const launcherPath = path.join(tempDir, `repl-${sessionId}.sh`);

  const content = [
    `#!/bin/bash`,
    `echo "Python REPL launched: ${quoteForBash(pythonExecutable)} (interactive session)"`,
    `echo "Working directory: ${quoteForBash(cwd)}"`,
    `echo "Type exit() or press Ctrl-D to quit."`,
    `echo ""`,
    `${quoteForBash(pythonExecutable)}`,
    ``,
  ].join("\n");

  await mkdir(tempDir, { recursive: true });
  await writeFile(launcherPath, content, "utf8");

  // The detached bash keeps running until the interpreter exits.
  await spawnDetached("bash", ["-c", launcherPath]);

  return successResult(pythonExecutable, cwd, sessionId, "spawn");
}

/** Windows: Windows Terminal (primary) → cmd.exe (fallback). */
async function launchWindowsRepl(
  pythonExecutable: string,
  cwd: string,
  timeoutSeconds?: number,
): Promise<RunReplResult> {
  const sessionId = `${SESSION_PREFIX}-${randomUUID().slice(0, 8)}`;
  const tempDir = path.join(tmpdir(), "pydev-mcp");
  const launcherPath = path.join(tempDir, `repl-${sessionId}.cmd`);

  const content = [
    "@echo off",
    `title Python REPL (${sessionId})`,
    `cd /d ${quoteForCmd(cwd)}`,
    "echo.",
    `echo Python executable: ${quoteForCmd(pythonExecutable)}`,
    "echo Type exit() or Ctrl-D to quit.",
    "echo.",
    `${quoteForCmd(pythonExecutable)}`,
    "",
  ].join("\r\n");

  await mkdir(tempDir, { recursive: true });
  await writeFile(launcherPath, content, "utf8");

  try {
    await spawnDetached("wt.exe", ["cmd.exe", "/k", launcherPath]);
    return successResult(pythonExecutable, cwd, sessionId, "windows-terminal");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("ENOENT")) throw error;

    const wrapperPath = path.join(tempDir, `open-${sessionId}.cmd`);
    const wrapperContent = [
      "@echo off",
      `start "" cmd.exe /k ${quoteForCmd(launcherPath)}`,
      "",
    ].join("\r\n");
    await writeFile(wrapperPath, wrapperContent, "utf8");
    await spawnDetached("cmd.exe", ["/c", wrapperPath]);
    return successResult(pythonExecutable, cwd, sessionId, "windows-cmd");
  }
}

function successResult(
  pythonExecutable: string,
  cwd: string,
  sessionId: string,
  sessionManager: string,
): RunReplResult {
  return {
    launched: true,
    pythonExecutableUsed: pythonExecutable,
    cwd,
    sessionId,
    sessionManager,
    message: `Persistent Python REPL launched via ${sessionManager}. The session is now available for interactive use.`,
  };
}

/**
 * Arms a best-effort timer that terminates the session after `timeoutSeconds`. Unref'd so it never
 * blocks the host process from exiting (e.g. during smoke tests). No-op when timeoutSeconds is unset.
 */
function armSessionTimeout(
  sessionManager: string,
  killArgs: string[],
  timeoutSeconds?: number,
): void {
  if (timeoutSeconds === undefined || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return;
  }

  const timer = setTimeout(() => {
    spawnDetached(sessionManager, killArgs).catch(() => {
      /* best-effort termination — ignore failures */
    });
  }, timeoutSeconds * 1000);
  timer.unref();
}

function quoteForBash(value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("Command value must not contain newline characters.");
  }

  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteForCmd(value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("Command value must not contain newline characters.");
  }

  return `"${value.replace(/%/g, "%%").replace(/"/g, '\\"')}"`;
}

function isENOENT(error: unknown): boolean {
  return error instanceof Error && /ENOENT/.test(error.message);
}

/** Detached spawn that never rejects on its own and detaches from the parent. */
function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: false, detached: true, stdio: "ignore" });

    child.once("error", (error) => {
      reject(new Error(`Failed to launch "${command}": ${error.message}`));
    });

    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
