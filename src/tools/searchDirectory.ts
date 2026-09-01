import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { searchDirectory } from "../utils/directorySearch";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_search_directory")!;

export const searchDirectoryTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    pattern: z.string().min(1).max(200).describe("Substring (default) or RegExp to find inside file contents."),
    directoryPath: z.string().min(1).max(500).optional().describe("Directory relative to workspace root or absolute inside workspace. Defaults to workspace root."),
    includeHidden: z.boolean().optional().describe("Whether to include hidden dot-prefixed files and folders."),
    useRegex: z.boolean().optional().describe("Interpret `pattern` as a regular expression (case-sensitive). Default is case-insensitive substring."),
    maxResults: z.number().int().min(1).max(500).optional().describe("Cap the number of matched lines returned. Defaults to 500."),
  },
  implementation: async ({ pattern, directoryPath, includeHidden, useRegex, maxResults }) => {
    return await searchDirectory({
      pattern,
      ...(directoryPath !== undefined ? { directoryPath } : {}),
      ...(includeHidden !== undefined ? { includeHidden } : {}),
      ...(useRegex !== undefined ? { useRegex } : {}),
      ...(maxResults !== undefined ? { maxResults } : {}),
    });
  },
});
