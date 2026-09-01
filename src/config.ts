/**
 * config.ts — LM Studio plugin configuration UI schema + unified workspace-root resolver.
 *
 * SINGLE WORKSPACE ROOT MODE:
 * Only one workspace root is supported. All tools operate directly against this single directory.
 * The workspace root is resolved (single source of truth) from:
 *   1. User-set value via LM Studio chat sidebar (if provided)
 *   2. Persisted default from .pydev-mcp-config.json (workspaceRoot field, set on first install)
 *   3. PYDEV_MCP_WORKSPACE environment variable
 *   4. process.cwd() — fallback
 *
 * The canonical resolver now lives in src/utils/safePaths.ts and is re-exported below so index.ts
 * and every tool share ONE implementation (no duplicated precedence logic).
 */

import { createConfigSchematics } from "@lmstudio/sdk";

/** Re-export the unified workspace-root resolver so callers keep importing from "./config". */
export { resolveWorkspaceRoot, getResolvedWorkspaceRoot } from "./utils/safePaths";

/** Schema definition — exposed via context.withConfigSchematics(). */
export const configSchematics = createConfigSchematics()
  .field(
    "workspacePath",
    "string",
    {
      displayName: "Workspace Folder Path",
      subtitle:   "Single directory used for all file I/O operations. Leave empty to use the plugin's default.",
    },
    "",  // Empty default — resolved at runtime by resolveWorkspaceRoot() in src/utils/safePaths.ts
  )
  .build();
