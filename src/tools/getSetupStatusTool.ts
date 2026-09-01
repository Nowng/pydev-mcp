import { tool } from "@lmstudio/sdk";

import { getToolDefinition } from "../utils/toolRegistry";
import { probeVenvStatus, type VenvStatus } from "../utils/pythonVenv";
import { getWorkspaceRoot } from "../utils/safePaths";

const TOOL_DEFINITION = getToolDefinition("pydev_get_setup_status")!;

export const getSetupStatusTool = tool({
  name: TOOL_DEFINITION!.name,
  description: TOOL_DEFINITION!.description,
  parameters: {}, // No required params — just reports current venv state.
  implementation: async () => {
    // Report the venv at the resolved workspace root (user-set → persisted default → env var → cwd).
    const cwd = getWorkspaceRoot();

    try {
      const status: VenvStatus = await probeVenvStatus(cwd);
      return {
        exists: status.exists,
        pythonPath: status.pythonPath,
        version: status.version,
        usable: status.usable,
      };
    } catch (err) {
      return {
        exists: false,
        pythonPath: null,
        version: null,
        usable: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
