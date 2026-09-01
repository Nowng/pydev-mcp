import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { runPythonFileInBackground } from "../utils/pythonFileRunner";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_run_file")!;

export const runPythonFileTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    filePath: z.string().min(1).max(500).describe("Path to a Python .py file to run."),
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
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(600)
      .optional()
      .describe("Timeout in seconds. Defaults to 30. Maximum is 600."),
  },
  implementation: async ({ filePath, args, cwd, timeoutSeconds }) => {
    const request = {
      filePath,
      ...(args !== undefined ? { args } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    };

    return await runPythonFileInBackground(request);
  },
});
