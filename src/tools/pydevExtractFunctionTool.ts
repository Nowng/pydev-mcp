import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";

import { runAstHelper } from "../utils/astTools";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_extract_function")!;

export const pydevExtractFunctionTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Extract a selected code block from its parent function into its own definition at a specified line — ideal for decomposing large files.`,
  parameters: {
    sourceCode: z
      .string()
      .min(1)
      .max(100_000)
      .describe("The full Python source of the file containing the function to extract (inline)."),
    targetLine: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .describe("1-indexed line number where the extracted function definition should be inserted."),
    newFunctionName: z
      .string()
      .optional()
      .describe("Optional new name for the extracted function (defaults to the original function name)."),
  },
  implementation: async ({ sourceCode, targetLine, newFunctionName }) => {
    // Write the inline source to a temp file; the Python helper reads it and returns the rewritten source.
    const tmpFile = join(tmpdir(), `pydev_extract_${Date.now()}.py`);
    writeFileSync(tmpFile, sourceCode, "utf8");
    try {
      return runAstHelper("extract_function.py", [tmpFile, String(targetLine), newFunctionName ?? ""], {
        timeoutSeconds: 30,
      });
    } finally {
      try { unlinkSync(tmpFile); } catch (_e) { /* ignore */ }
    }
  },
});
