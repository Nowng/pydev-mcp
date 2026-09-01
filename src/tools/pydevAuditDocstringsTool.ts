import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { runAstHelper, AstToolRunOptions } from "../utils/astTools";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_audit_docstrings")!;

export const pydevAuditDocstringsTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Walk the source tree and generate a report on missing or stale docstrings, providing coverage percentages per file.`,
  parameters: {
    targetPath: z
      .string()
      .optional()
      .describe("Directory to scan for docstring coverage (default: the workspace root)."),
  },
  implementation: async ({ targetPath }) => {
    // docstrings.py <target_path> -- scan exactly this directory (default ".").
    const opts: AstToolRunOptions = { timeoutSeconds: 60 };
    return runAstHelper("docstrings.py", [targetPath ?? ""], opts);
  },
});
