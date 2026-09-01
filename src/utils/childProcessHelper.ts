/**
 * childProcessHelper.ts — tiny, dependency-free spawn wrapper used by several utils.
 *
 * Always captures stdout/stderr (never inherits), resolves after the process closes or times out,
 * and never rejects: failures are reported via `spawnFailed` so callers can degrade gracefully.
 */

import { spawn } from "node:child_process";

export interface ChildResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface SpawnOutcome {
  spawnFailed: boolean;
  result: ChildResult;
}

/**
 * Spawns `executable` with `args`, capturing output. Resolves (never rejects).
 * @param executable absolute or PATH-resolvable binary path.
 * @param args       argument array (not including the executable name).
 * @param timeoutMs  kill-after threshold in milliseconds.
 * @param cwd        optional working directory for the child process.
 */
export function spawnChild(
  executable: string,
  args: string[],
  timeoutMs = 30_000,
  cwd?: string | undefined,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, ...(cwd ? { cwd } : {}) });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (_err) {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawnFailed: true, result: { stdout, stderr, exitCode: null, timedOut } });
    });

    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawnFailed: false, result: { stdout, stderr, exitCode, timedOut } });
    });
  });
}
