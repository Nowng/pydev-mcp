import { tool } from "@lmstudio/sdk";

import { getToolDefinition } from "../utils/toolRegistry";
import { getWorkspaceRoot } from "../utils/safePaths";

const TOOL_DEFINITION = getToolDefinition("pydev_get_workspace_root")!;

export const getWorkspaceRootTool = tool({
  name: TOOL_DEFINITION!.name,
  description: TOOL_DEFINITION!.description,
  parameters: {}, // No params — reports the single workspace root all tools operate inside.
  implementation: async () => {
    // Resolve and return the current workspace root (user-set → persisted default → env var → cwd)
    // as an absolute path so the LLM always knows where relative paths resolve.
    return { workspaceRoot: getWorkspaceRoot() };
  },
});
