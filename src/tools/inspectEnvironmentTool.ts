import { tool } from "@lmstudio/sdk";

import { getEnvironmentInfo } from "../utils/pythonEnvironmentInfo";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_inspect_environment")!;

export const inspectEnvironmentTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Returns the active Python executable path, version, venv status, installed package count, and key environment variables.`,
  parameters: {},
  implementation: async () => {
    const info = await getEnvironmentInfo();

    return {
      pythonExecutable: info.pythonExecutable,
      pythonVersion: info.pythonVersion,
      pythonFullVersion: info.pythonFullVersion,
      inVirtualEnv: info.inVirtualEnv,
      venvPath: info.venvPath ?? null,
      installedPackagesCount: info.installedPackagesCount,
      keyEnvironmentVariables: info.keyEnvironmentVariables,
    };
  },
});
