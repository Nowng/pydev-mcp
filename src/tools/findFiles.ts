import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { findFiles } from "../utils/directorySearch";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_find_files")!;

export const findFilesTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    pattern: z.string().min(1).max(200).describe("Extension (e.g. '.py', '*.ts') or a filename substring to match."),
    directoryPath: z.string().min(1).max(500).optional().describe("Directory relative to workspace root or absolute inside workspace. Defaults to workspace root."),
    includeHidden: z.boolean().optional().describe("Whether to include hidden dot-prefixed files and folders."),
    maxResults: z.number().int().min(1).max(500).optional().describe("Cap the number of files returned. Defaults to 500."),
  },
  implementation: async ({ pattern, directoryPath, includeHidden, maxResults }) => {
    return await findFiles({
      pattern,
      ...(directoryPath !== undefined ? { directoryPath } : {}),
      ...(includeHidden !== undefined ? { includeHidden } : {}),
      ...(maxResults !== undefined ? { maxResults } : {}),
    });
  },
});
