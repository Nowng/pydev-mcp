import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { runAstHelper, AstToolRunOptions } from "../utils/astTools";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_safe_rename")!;

export const pydevSafeRenameTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Safely rename a function, class or variable across the entire project by updating all call sites via AST rebase — safer than string replacement.`,
  parameters: {
    oldName: z
      .string()
      .min(1)
      .max(200)
      .describe("The exact name of the function, class or variable to rename."),
    newName: z
      .string()
      .min(1)
      .max(200)
      .describe("The new name to rename it to."),
    targetPath: z
      .string()
      .optional()
      .describe("Directory to scan for call sites (default: the workspace root)."),
  },
  implementation: async ({ oldName, newName, targetPath }) => {
    // rename.py <source_path> <old_name> <new_name> [kind] [target_path]
    // source_path="." (project root) is the scan root; target_path is passed explicitly
    // as argv[5] so it scans exactly the requested directory. kind="auto" picks the type.
    const opts: AstToolRunOptions = {};
    return runAstHelper("rename.py", [".", oldName, newName, "auto", targetPath ?? ""], opts);
  },
});
