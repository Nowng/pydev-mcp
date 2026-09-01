import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { readTextFile } from "../utils/textFileEditor";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_read_text_file")!;

export const readTextFileTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    filePath: z.string().min(1).max(500).describe("Text file path (any extension) relative to workspace or absolute inside workspace."),
    startLine: z.number().int().min(1).optional().describe("Optional 1-based start line."),
    endLine: z.number().int().min(1).optional().describe("Optional 1-based end line."),
    includeLineNumbers: z.boolean().optional().describe("Whether to prefix each returned line with its line number."),
  },
  implementation: async ({ filePath, startLine, endLine, includeLineNumbers }) => {
    return await readTextFile({
      filePath,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      includeLineNumbers: includeLineNumbers ?? false,
    });
  },
});
