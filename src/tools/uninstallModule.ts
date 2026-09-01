import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import {
  DEFAULT_INSTALL_TIMEOUT_SECONDS,
  uninstallPythonPackages,
} from "../utils/pythonPackageInstaller";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_uninstall_module")!;

export const uninstallModuleTool = tool({
  name: TOOL_DEFINITION.name,
  description:
    `${TOOL_DEFINITION.description} This operation is non-interactive and always uses pip uninstall -y.`,
  parameters: {
    packages: z
      .array(z.string().min(1).max(120))
      .min(1)
      .max(10)
      .describe("Python package names to uninstall, for example ['colorama']."),
    yes: z
      .boolean()
      .optional()
      .describe("Reserved for compatibility. Uninstall always runs non-interactively with -y."),
    timeoutSeconds: z
      .number()
      .int()
      .min(10)
      .max(600)
      .optional()
      .describe("Timeout in seconds. Defaults to 120. Maximum is 600."),
  },
  implementation: async ({ packages, yes, timeoutSeconds }) => {
    return await uninstallPythonPackages({
      packages,
      yes: yes ?? true,
      timeoutSeconds: timeoutSeconds ?? DEFAULT_INSTALL_TIMEOUT_SECONDS,
    });
  },
});
