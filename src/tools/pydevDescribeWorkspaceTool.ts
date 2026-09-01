import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { runAstHelper } from "../utils/astTools";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_describe_workspace")!;

export const pydevDescribeWorkspaceTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Returns a high-level overview of the project including file purposes (from README/docstrings), dependency direction, and top imports — instant repo context without reading every line.`,
  parameters: {
    includeOverview: z
      .boolean()
      .optional()
      .describe("Whether to include the high-level README/docstring overview (default: true)."),
  },
  implementation: async ({ includeOverview }) => {
    // describe.py always writes a JSON report to <root>/.pydev_workspace.json; the helper
    // reads it back and returns it. includeOverview is accepted for API symmetry but the report
    // includes the overview by default.
    // describe.py <target_path> -- scan the workspace root (".") so README.md and top-level
    // imports are found relative to the project root.
    return runAstHelper("describe.py", [process.cwd()], { timeoutSeconds: 60 });
  },
});
