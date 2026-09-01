import { tool } from "@lmstudio/sdk"; 
import { z } from "zod";

import { analyzePythonFileForLint } from "../utils/pythonLintRunner";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_run_linter_and_formatter")!; 

export const runLinterAndFormatterTool = tool({ 
  name: TOOL_DEFINITION.name,  
  description: `${TOOL_DEFINITION.description} This runs ruff lint on the provided Python code.`,
  parameters: { pythonCode: z.string().min(1).max(50000), autoFix: z.boolean().optional() },
  implementation: async ({ pythonCode }) => await analyzePythonFileForLint(pythonCode)  
}); 
