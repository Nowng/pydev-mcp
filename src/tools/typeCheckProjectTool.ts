import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { typeCheckProject, type TypeCheckResult } from "../utils/pythonTypeChecker";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_type_check")!;

export const typeCheckProjectTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Scans a project directory with mypy/pyright and returns error/warning/note counts plus a summary.`,
  parameters: {
    targetPath: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Directory (relative to the workspace root) or path to type-check. Defaults to the workspace root."),
    checker: z
      .enum(["mypy", "pyright"])
      .optional()
      .describe("Static type checker to run. Defaults to mypy."),
    extraArgs: z
      .array(z.string().max(500))
      .max(20)
      .optional()
      .describe("Extra arguments forwarded to the checker (e.g. '--follow-imports=skip')."),
    timeoutSeconds: z
      .number()
      .int()
      .min(30)
      .max(600)
      .optional()
      .describe("Timeout in seconds. Defaults to 180."),
  },
  implementation: async ({ targetPath, checker, extraArgs, timeoutSeconds }) => {
    const result: TypeCheckResult = await typeCheckProject(targetPath ?? ".", {
      checker,
      extraArgs,
      timeoutSeconds,
    });

    return {
      checker: result.checker,
      available: result.available,
      targetPath: result.targetPath,
      exitCode: result.exitCode,
      errorCount: result.errorCount,
      warningCount: result.warningCount,
      noteCount: result.noteCount,
      summary: result.summary,
      rawOutputTruncated: result.rawOutputTruncated,
    };
  },
});
