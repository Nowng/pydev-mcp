import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { checkPythonFileForBugs } from "../utils/pythonBugChecker";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_check_for_bugs_in_file")!;

export const checkForBugsInFileTool = tool({
  name: TOOL_DEFINITION.name,
  description:
    `${TOOL_DEFINITION.description} This does not execute the file normally.`,
  parameters: {
    filePath: z.string().min(1).max(500).describe("Python file path relative to workspace or absolute inside workspace."),
    maxIssues: z.number().optional().describe("Maximum number of issues to return. Defaults to 20 and is clamped between 1 and 100."),
    includeRawOutput: z.boolean().optional().describe("Include capped raw analyzer stdout/stderr. Defaults to false."),
    runSmokeTest: z.boolean().optional().describe("Run a short runtime smoke test after syntax/static checks. Defaults to true."),
    smokeTestTimeoutMs: z.number().optional().describe("Smoke test timeout in milliseconds. Clamped between 500 and 10000. Defaults to 3000."),
    smokeTestArgs: z.array(z.string()).optional().describe("Optional argv passed to the smoke test run."),
  },
  implementation: async ({ filePath, maxIssues, includeRawOutput, runSmokeTest, smokeTestTimeoutMs, smokeTestArgs }) => {
    return await checkPythonFileForBugs(filePath, {
      maxIssues,
      includeRawOutput,
      runSmokeTest,
      smokeTestTimeoutMs,
      smokeTestArgs,
    });
  },
});
