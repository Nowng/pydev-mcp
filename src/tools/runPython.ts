import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { runPythonCode } from "../utils/pythonRunner";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_run_code")!;

export const runPythonTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    code: z.string().min(1).max(100000).describe("Python source code to execute."),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(120)
      .optional()
      .describe("Optional timeout in seconds. Defaults to 5. Maximum is 120."),
  },
  implementation: async ({ code, timeoutSeconds }) => {
    return await runPythonCode(code, timeoutSeconds ?? 5);
  },
});
