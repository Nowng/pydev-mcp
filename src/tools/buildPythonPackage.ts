import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { buildPythonPackage, type BuildMode } from "../utils/buildPythonPackage";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_build_python_package")!;

export const buildPythonPackageTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Builds sdist/wheel and/or editable-installs the project.`,
  parameters: {
    projectPath: z.string().min(1).max(500).optional().describe("Project directory containing pyproject.toml/setup.py. Defaults to the workspace root."),
    mode: z.enum(["editable", "build", "both"]).optional().describe("Editable install, build artifacts, or both. Defaults to 'both'."),
    extraArgs: z.array(z.string().min(1).max(500)).max(20).optional().describe("Extra arguments for the underlying pip / build command."),
    timeoutSeconds: z.number().int().min(30).max(3600).optional().describe("Overall timeout in seconds. Defaults to 600."),
  },
  implementation: async ({ projectPath, mode, extraArgs, timeoutSeconds }) => {
    return await buildPythonPackage({
      ...(projectPath !== undefined ? { projectPath } : {}),
      ...(mode !== undefined ? { mode: mode as BuildMode } : {}),
      ...(extraArgs !== undefined ? { extraArgs } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    });
  },
});
