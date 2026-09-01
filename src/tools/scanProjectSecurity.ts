import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { scanProjectSecurity } from "../utils/scanSecurity";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_scan_security")!;

export const scanProjectSecurityTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Runs bandit and returns issues grouped by severity.`,
  parameters: {
    targetPath: z.string().min(1).max(500).optional().describe("Directory / file to scan. Defaults to the workspace root."),
    extraArgs: z.array(z.string().min(1).max(500)).max(20).optional().describe("Extra bandit arguments appended after `-r <target> -f json`."),
    timeoutSeconds: z.number().int().min(30).max(1800).optional().describe("Overall timeout in seconds. Defaults to 300."),
  },
  implementation: async ({ targetPath, extraArgs, timeoutSeconds }) => {
    return await scanProjectSecurity({
      ...(targetPath !== undefined ? { targetPath } : {}),
      ...(extraArgs !== undefined ? { extraArgs } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    });
  },
});
