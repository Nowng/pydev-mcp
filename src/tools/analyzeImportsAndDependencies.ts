import { tool } from "@lmstudio/sdk"; import { z } from "zod"; 

import { analyzeDependenciesForCode } from "../utils/pythonDependencyAnalyzer"; 
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_analyze_imports_and_dependencies")!; 

export const analyzeImportsAndDependenciesTool = tool({
  name:TOOL_DEFINITION.name,  
  description:`${TOOL_DEFINITION.description} This parses Python imports and compares them against installed packages.`, 
  parameters:{pythonCode:z.string().min(1).max(50000)}, 
  implementation:async({pythonCode})=>await analyzeDependenciesForCode(pythonCode)
});
