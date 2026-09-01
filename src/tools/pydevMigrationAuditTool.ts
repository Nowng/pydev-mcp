import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { runAstHelper, AstToolRunOptions } from "../utils/astTools";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_migration_audit")!;

export const pydevMigrationAuditTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Scan files for deprecated Python patterns, syntax issues or outdated package imports and return an actionable migration plan with suggested replacements.`,
  parameters: {
    pattern: z
      .array(z.string().min(1).max(200))
      .min(1)
      .describe("Migration pattern names to scan for (e.g. \"deprecated-imports\", \"python2-compatible\")."),
    targetPath: z
      .string()
      .optional()
      .describe("Directory to scan for migration issues (default: the workspace root)."),
  },
  implementation: async ({ pattern, targetPath }) => {
    // migration.py <pattern> <target_path> [output_dir] -- scan targetPath (default ".").
    // No output_dir needed; the report is written to <root>/.pydev_migration.json.
    const opts: AstToolRunOptions = { timeoutSeconds: 60 };
    return runAstHelper("migration.py", [...pattern, targetPath ?? ""], opts);
  },
});
