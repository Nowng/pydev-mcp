import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { analyzePythonFileForLintFromFile } from "../utils/pythonLintRunner";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_run_linter_and_formatter_in_file")!;

export const runLinterAndFormatterInFileTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} This runs ruff lint on the provided Python file.`,
  parameters: {
    filePath: z.string().min(1).max(500).describe("Python .py file path relative to workspace or absolute inside workspace."),
    autoFix: z.boolean().optional().describe("Auto-fix style issues in place when true. Defaults to false."),
  },
  implementation: async ({ filePath, autoFix }) => await analyzePythonFileForLintFromFile(filePath, autoFix ?? false),
});
