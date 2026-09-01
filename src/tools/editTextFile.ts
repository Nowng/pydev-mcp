import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { editTextFile } from "../utils/textFileEditor";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_edit_text_file")!;

export const editTextFileTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} This performs exact string replacement and does not use regex.`,
  parameters: {
    filePath: z.string().min(1).max(500).describe("Text file path (any extension) relative to workspace or absolute inside workspace."),
    find: z.string().min(1).describe("Exact text to find."),
    replace: z.string().describe("Replacement text."),
    replaceAll: z.boolean().optional().describe("Whether to replace all matches (up to the configured safety limit)."),
    backup: z.boolean().optional().describe("Whether to create a .bak backup file before editing. Defaults to true."),
  },
  implementation: async ({ filePath, find, replace, replaceAll, backup }) => {
    return await editTextFile({
      filePath,
      find,
      replace,
      replaceAll: replaceAll ?? false,
      backup: backup ?? true,
    });
  },
});
