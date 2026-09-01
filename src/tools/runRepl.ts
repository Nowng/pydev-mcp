import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { launchPythonRepl } from "../utils/pythonReplRunner";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_run_repl")!;

export const runReplTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    cwd: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Optional working directory for the REPL session. Must be inside the workspace root; defaults to the workspace root."),
    timeoutSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional number of seconds to keep the interactive session alive before it is auto-terminated (best-effort; guaranteed only when tmux is available). Omit for an indefinitely persistent session."),
  },
  implementation: async ({ cwd, timeoutSeconds }) => {
    const result = await launchPythonRepl({
      ...(cwd !== undefined ? { cwd } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    });

    return {
      launched: true as const,
      mode: "repl" as const,
      pythonExecutableUsed: result.pythonExecutableUsed,
      cwd: result.cwd,
      sessionId: result.sessionId,
      sessionManager: result.sessionManager,
      message: result.message,
    };
  },
});
