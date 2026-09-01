import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { saveTextFile } from "../utils/textFileEditor";
import { MAX_FILE_WRITE_BYTES } from "../utils/safePaths";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_save_text_file")!;

export const saveTextFileTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    filePath: z.string().min(1).max(500).describe("Text file path (any extension) relative to workspace or absolute inside workspace."),
    content: z.string().max(MAX_FILE_WRITE_BYTES).describe("UTF-8 text / source code to write."),
    overwrite: z.boolean().optional().describe("Whether to overwrite an existing file."),
    createDirectories: z.boolean().optional().describe("Whether to create missing parent directories."),
  },
  implementation: async ({ filePath, content, overwrite, createDirectories }) => {
    return await saveTextFile({
      filePath,
      content,
      overwrite: overwrite ?? false,
      createDirectories: createDirectories ?? true,
    });
  },
});
