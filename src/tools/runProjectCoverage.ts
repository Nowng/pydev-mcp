import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { runProjectCoverage } from "../utils/runCoverage";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_coverage")!;

export const runProjectCoverageTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Runs pytest with pytest-cov and returns total + per-file coverage.`,
  parameters: {
    sourcePath: z.string().min(1).max(500).optional().describe("Directory / package whose coverage to measure. Defaults to the workspace root."),
    testPath: z.string().min(1).max(500).optional().describe("Directory or test file that holds the tests to run. Defaults to sourcePath."),
    extraArgs: z.array(z.string().min(1).max(500)).max(20).optional().describe("Extra pytest arguments appended after coverage flags."),
    timeoutSeconds: z.number().int().min(30).max(1800).optional().describe("Overall timeout in seconds. Defaults to 300."),
  },
  implementation: async ({ sourcePath, testPath, extraArgs, timeoutSeconds }) => {
    return await runProjectCoverage({
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      ...(testPath !== undefined ? { testPath } : {}),
      ...(extraArgs !== undefined ? { extraArgs } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    });
  },
});
