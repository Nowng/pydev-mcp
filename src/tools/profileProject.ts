import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import { spawn, spawnSync } from "child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Import the tool definition from the tool registry
import { getToolDefinition } from "../utils/toolRegistry";
import { getWorkspaceRoot } from "../utils/safePaths";

const TOOL_DEFINITION = getToolDefinition("pydev_profile")!;

/**
 * pydev_profile_project — Run cProfile on a Python project and return a structured summary.
 */

export const profileProjectTool = tool({
  name: TOOL_DEFINITION.name,
  description: `
    Run cProfile on a Python project to identify performance bottlenecks.

    Returns a structured JSON summary including:
      - Top-N functions by total time (hotspots)
      - Top-N functions by cumulative time (bottlenecks)
      - Function call counts and average call duration
      - Flamegraph-style call tree (limited depth)
      - Optional natural-language explanation of bottlenecks

    Use this to find slow functions, expensive imports, or inefficient algorithms.

    Parameters:
      targetPath — Directory to profile (relative to workspace root). Defaults to '.'.
      timeoutSeconds — Maximum runtime for profiling. Defaults to 60s.
      topN — Number of top functions to include in the summary. Defaults to 20.
      includeCallTree — Include a flamegraph-style call tree. Defaults to true.
      maxCallTreeDepth — Maximum depth of the call tree. Defaults to 5.
      explainBottlenecks — Include natural-language explanation of bottlenecks. Defaults to true.
  `,
  parameters: {
    targetPath: z
      .string()
      .min(1)
      .max(200)
      .describe("Path relative to workspace root. Defaults to '.' (entire project)."),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(600)
      .optional()
      .default(300)
      .describe("Maximum profiling time in seconds. Defaults to 300s."),
    topN: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe("Number of top functions to include in the summary. Defaults to 20."),
    includeCallTree: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include a flamegraph-style call tree. Defaults to true."),
    maxCallTreeDepth: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .default(5)
      .describe("Maximum depth of the call tree. Limits explosion. Defaults to 5."),
    explainBottlenecks: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include natural-language explanation of bottlenecks. Defaults to true."),
  },
  implementation: async ({ targetPath, timeoutSeconds, topN, includeCallTree, maxCallTreeDepth, explainBottlenecks }) => {
    const workspaceRoot = getWorkspaceRoot();

    const pythonWorkerScriptPath = path.join(workspaceRoot, ".venv", "bin", "_profiling_worker_main.py");
    let workerScriptContent: string | null = null;

    try {
      workerScriptContent = fs.readFileSync(pythonWorkerScriptPath, "utf-8");
    } catch (err) {
      const error = err as Error;
      return {
        success: false,
        output: "",
        stderr: `Could not load worker script from ${pythonWorkerScriptPath}: ${error.message}`,
        exitCode: -1,
      };
    }

    let result: { success: boolean; output: string; stderr: string; exitCode: number } | null = null;

    try {
      const pythonExecutable = path.join(workspaceRoot, ".venv", "bin", "python3");
      if (!fs.existsSync(pythonExecutable)) {
        result = {
          success: false,
          output: "",
          stderr: `Python executable not found at ${pythonExecutable}. Please run the setup-venv.sh script or pydev_setup_venv tool to set up the environment.`,
          exitCode: -1,
        };
      } else {
        const execResult = spawnSync(pythonExecutable, ["-c", workerScriptContent, "--target-path", targetPath, "--top-n", String(topN), "--max-tree-depth", String(maxCallTreeDepth)], {
          cwd: workspaceRoot,
          timeout: timeoutSeconds * 1000,
          env: process.env,
        });

        if (execResult.error) {
          result = {
            success: false,
            output: "",
            stderr: execResult.error.message || "Unknown error",
            exitCode: -1,
          };
        } else {
          result = {
            success: true,
            output: execResult.stdout.toString(),
            stderr: execResult.stderr.toString(),
            exitCode: execResult.status || 0,
          };
        }
      }
    } catch (err) {
      const error = err as Error;
      result = {
        success: false,
        output: "",
        stderr: `Error executing profiling worker: ${error.message}`,
        exitCode: -1,
      };
    }

    return result!;
  },
});
