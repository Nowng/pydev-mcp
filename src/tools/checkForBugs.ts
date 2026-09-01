import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { checkPythonCodeForBugs } from "../utils/pythonBugChecker";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_check_for_bugs")!;

export const checkForBugsTool = tool({
  name: TOOL_DEFINITION.name,
  description:
    `${TOOL_DEFINITION.description} This does not prove semantic correctness and does not execute your script normally.`,
  parameters: {
    code: z.string().min(1).max(50000).describe("Python source code to check."),
    runPyCompile: z.boolean().optional().describe("Deprecated compatibility option. Syntax checking always runs."),
    maxIssues: z.number().optional().describe("Maximum number of issues to return. Defaults to 20 and is clamped between 1 and 100."),
    includeRawOutput: z.boolean().optional().describe("Include capped raw analyzer stdout/stderr. Defaults to false."),
    runSmokeTest: z.boolean().optional().describe("Run a short runtime smoke test after syntax/static checks. Defaults to true."),
    smokeTestTimeoutMs: z.number().optional().describe("Smoke test timeout in milliseconds. Clamped between 500 and 10000. Defaults to 3000."),
    smokeTestArgs: z.array(z.string()).optional().describe("Optional argv passed to the smoke test run."),
  },
  implementation: async ({ code, runPyCompile, maxIssues, includeRawOutput, runSmokeTest, smokeTestTimeoutMs, smokeTestArgs }) => {
    return await checkPythonCodeForBugs({
      code,
      runPyCompile: runPyCompile ?? true,
      maxIssues,
      includeRawOutput,
      runSmokeTest,
      smokeTestTimeoutMs,
      smokeTestArgs,
    });
  },
});
