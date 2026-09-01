import path from "node:path";

import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { launchPythonFileInteractive } from "../utils/pythonInteractiveRunner";
import { validateWorkingDirectory } from "../utils/safePaths";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_run_file_interactive")!;

export const runPythonFileInteractiveTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    filePath: z.string().min(1).max(500).describe("Path to a Python .py file to run interactively."),
    args: z
      .array(z.string().max(500))
      .max(20)
      .optional()
      .describe("Optional command-line arguments passed to the Python file."),
    cwd: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Optional working directory. Defaults to the Python file's directory."),
    windowTitle: z.string().min(1).max(120).optional().describe("Optional terminal window title."),
  },
  implementation: async ({ filePath, args, cwd, windowTitle }) => {
    const resolvedCwd = await validateWorkingDirectory(cwd);
    const request = {
      filePath,
      cwd: resolvedCwd ?? path.dirname(path.resolve(filePath)),
      ...(args !== undefined ? { args } : {}),
      ...(windowTitle !== undefined ? { windowTitle } : {}),
    };

    const launchResult = await launchPythonFileInteractive(request);

    return {
      launched: true as const,
      mode: "interactive-file" as const,
      pythonExecutableUsed: launchResult.pythonExecutableUsed,
      filePath: launchResult.filePath,
      args: launchResult.args,
      cwd: launchResult.cwd,
      message: "Interactive Python file window launched.",
    };
  },
});
