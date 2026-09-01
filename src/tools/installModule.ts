import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import {
  DEFAULT_INSTALL_TIMEOUT_SECONDS,
  installPythonPackages,
} from "../utils/pythonPackageInstaller";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_install_module")!;

export const installModuleTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    packages: z
      .array(z.string().min(1).max(120))
      .min(1)
      .max(10)
      .describe("Python package specs to install, for example ['requests'] or ['numpy>=2']."),
    upgrade: z.boolean().optional().describe("Whether to pass --upgrade to pip."),
    timeoutSeconds: z
      .number()
      .int()
      .min(10)
      .max(600)
      .optional()
      .describe("Timeout in seconds. Defaults to 120. Maximum is 600."),
  },
  implementation: async ({ packages, upgrade, timeoutSeconds }) => {
    return await installPythonPackages({
      packages,
      upgrade: upgrade ?? false,
      timeoutSeconds: timeoutSeconds ?? DEFAULT_INSTALL_TIMEOUT_SECONDS,
    });
  },
});
