import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { runWithDebugger, type RunWithDebuggerOptions } from "../utils/pythonDebugger";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_run_with_debugger")!;

export const runWithDebuggerTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Runs Python code and prints a full traceback with variable inspection at each frame.`,
  parameters: {
    code: z
      .string()
      .max(50000)
      .optional()
      .describe("Inline Python source to run under the debugger (use this OR filePath)."),
    filePath: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Path to an existing .py file to debug."),
    args: z
      .array(z.string().max(500))
      .max(20)
      .optional()
      .describe("Command-line arguments passed to the target as sys.argv[1:]."),
    cwd: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Working directory. Defaults to the target file's directory."),
    timeoutSeconds: z
      .number()
      .int()
      .min(5)
      .max(300)
      .optional()
      .describe("Timeout in seconds. Defaults to 60."),
  },
  implementation: async ({ code, filePath, args, cwd, timeoutSeconds }) => {
    const options: RunWithDebuggerOptions = {
      code,
      filePath,
      args,
      cwd,
      timeoutSeconds,
    };

    return await runWithDebugger(options);
  },
});
