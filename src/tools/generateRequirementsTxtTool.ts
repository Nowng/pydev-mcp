import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { generateRequirements } from "../utils/generateRequirementsUtil";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_generate_requirements_txt")!;

export const generateRequirementsTxtTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Writes a requirements.txt into the workspace (pip freeze output, or derived from analyzed imports).`,
  parameters: {
    outputPath: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Output file path inside the workspace. Defaults to requirements.txt."),
    sourceCode: z
      .string()
      .max(50000)
      .optional()
      .describe("Optional Python source. When provided, requirements are derived from its missing third-party imports; otherwise pip freeze output is written."),
  },
  implementation: async ({ outputPath, sourceCode }) => {
    const result = await generateRequirements({
      outputPath,
      sourceCode,
    });

    return {
      outputPath: result.outputPath,
      mode: result.mode,
      lineCount: result.lineCount,
      contentLength: result.contentLength,
      sampleLines: result.sampleLines,
    };
  },
});
