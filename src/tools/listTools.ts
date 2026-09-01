import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import {
  getToolDefinition,
  getToolGroups,
  getToolList,
  TOOL_DEFINITIONS,
} from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_list_tools")!;

export const listToolsTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Returns a structured, grouped catalog: the total count, the list of groups, and every tool with its group and (when includeDetails is true) description + usage example.`,
  parameters: {
    includeDetails: z
      .boolean()
      .optional()
      .describe("Whether to include each tool's full description and usage example in the result."),
  },
  implementation: async ({ includeDetails }) => {
    const include = includeDetails ?? false;
    return {
      count: TOOL_DEFINITIONS.length,
      groups: getToolGroups(),
      includeDetails: include,
      tools: getToolList(include),
    };
  },
});
