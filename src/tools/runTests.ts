import { tool } from "@lmstudio/sdk"; import { z } from "zod"; 

import { runPytestTests } from "../utils/pythonTestRunner";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_run_tests")!; 

export const runTestsTool = tool({ 
  name: TOOL_DEFINITION.name,  
  description: `${TOOL_DEFINITION.description} Returns pass/fail/skip counts, an actionable summary listing each failing test with its file:line and one-line reason, structured ` + "`failures`" + ` details (assertion message, exception type, full traceback), plus captured stdout/stderr. When tests fail, read the ` + "`failures`" + ` array to find the assertion or error and fix the source.`,
  parameters:{testFilePath:z.string().min(1),timeoutSeconds:z.number().int().min(30).max(600).optional()}, 
  implementation:async({testFilePath,timeoutSeconds})=>{ const result=await runPytestTests({testFileOrPath:testFilePath});return{...result};}
});
