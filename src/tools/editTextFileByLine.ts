import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { editTextFileByLine } from "../utils/textFileEditor";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_edit_text_file_by_line")!;

export const editTextFileByLineTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    filePath: z.string().min(1).max(500).describe("Text file path (any extension) relative to workspace or absolute inside workspace."),
    operation: z
      .enum(["replace", "insert_before", "insert_after", "delete"])
      .describe("Line-based edit operation."),
    startLine: z.number().int().min(1).describe("1-based start line."),
    endLine: z.number().int().min(1).optional().describe("Optional 1-based end line. Defaults to startLine."),
    content: z.string().optional().describe("New content used by replace and insert operations."),
    backup: z.boolean().optional().describe("Whether to create a .bak backup file before editing. Defaults to true."),
  },
  implementation: async ({ filePath, operation, startLine, endLine, content, backup }) => {
    return await editTextFileByLine({
      filePath,
      operation,
      startLine,
      ...(endLine !== undefined ? { endLine } : {}),
      ...(content !== undefined ? { content } : {}),
      backup: backup ?? true,
    });
  },
});
