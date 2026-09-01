import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { runAstHelper } from "../utils/astTools";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_generate_reference")!;

export const pydevGenerateReferenceTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Build and write an external reference summary (e.g. in Markdown) directly from the code's type hints and docstrings — no manual drafting required.`,
  parameters: {
    outputPath: z
      .string()
      .optional()
      .describe("Output file/directory for the reference document (default: .docs/API.md)."),
    targetPath: z
      .string()
      .optional()
      .describe("Source path or directory to generate the reference from (default: src)."),
  },
  implementation: async ({ outputPath, targetPath }) => {
    const outDir = outputPath && outputPath.trim().length > 0 ? outputPath : ".docs";
    const cwd = targetPath && targetPath.trim().length > 0 ? targetPath : "src";
    return runAstHelper("reference.py", [cwd, outDir], { timeoutSeconds: 60 });
  },
});
