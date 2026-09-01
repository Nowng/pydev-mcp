import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { getToolDefinition } from "../utils/toolRegistry";
import { setupVenv, type VenvSetupResult } from "../utils/pythonVenv";
import { getWorkspaceRoot } from "../utils/safePaths";

const TOOL_DEFINITION = getToolDefinition("pydev_setup_venv")!;

export const setupVenvTool = tool({
  name: TOOL_DEFINITION!.name,
  description: TOOL_DEFINITION!.description,
  parameters: {
    projectPath: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Deprecated / ignored. Per the single-workspace model, the venv is always created at the " +
          "workspace root's .venv so that every project scaffolded by pydev_create_project_structure " +
          "shares one environment.",
      ),
  },
  implementation: async () => {
    // The venv is ALWAYS installed at <workspaceRoot>/.venv. getWorkspaceRoot() honors the
    // user-set path → persisted default (.pydev-mcp-config.json) → env var → process.cwd().
    const workspaceRoot = getWorkspaceRoot();

    try {
      return await setupVenv(workspaceRoot);
    } catch (err) {
      const result: VenvSetupResult = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        venvPath: null,
      };
      return result;
    }
  },
});
