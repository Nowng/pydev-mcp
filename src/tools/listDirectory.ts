import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import {
  ensureDirectory,
  MAX_DIRECTORY_ITEMS,
  resolveSafePath,
} from "../utils/safePaths";
import { getResolvedWorkspaceRoot } from "../utils/safePaths";
import { getToolDefinition } from "../utils/toolRegistry";

interface DirectoryItem {
  name: string;
  path: string;
  type: "file" | "directory";
  sizeBytes?: number;
  modifiedAt: string;
}

const TOOL_DEFINITION = getToolDefinition("pydev_list_directory")!;

export const listDirectoryTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    directoryPath: z.string().min(1).max(500).optional().describe("Target directory path relative to workspace or absolute inside workspace. Defaults to workspace root."),
    recursive: z.boolean().optional().describe("Whether to recurse into subdirectories."),
    maxDepth: z.number().int().min(1).max(5).optional().describe("Maximum recursion depth when recursive=true. Defaults to 1."),
    includeHidden: z.boolean().optional().describe("Whether to include hidden dot-prefixed files and folders."),
    pattern: z.string().min(1).max(200).optional().describe("Optional name filter using substring or simple wildcard pattern (* and ?)."),
  },
  implementation: async ({ directoryPath, recursive, maxDepth, includeHidden, pattern }) => {
    const recursiveMode = recursive ?? false;
    const resolvedMaxDepth = maxDepth ?? 1;
    const includeHiddenItems = includeHidden ?? false;

    // Handle null workspace root by falling back to process.cwd()
    let workspaceRoot = getResolvedWorkspaceRoot();
    if (workspaceRoot === null) {
      workspaceRoot = process.cwd();
    }

    const resolvedDirectoryPath = await ensureDirectory(directoryPath ?? workspaceRoot);

    const { items, truncated } = await collectDirectoryItems({
      rootDirectory: resolvedDirectoryPath,
      recursive: recursiveMode,
      maxDepth: resolvedMaxDepth,
      includeHidden: includeHiddenItems,
      ...(pattern !== undefined ? { pattern } : {}),
    });

    return {
      directoryPath: resolvedDirectoryPath,
      recursive: recursiveMode,
      count: items.length,
      truncated,
      items,
    };
  },
});

async function collectDirectoryItems(input: {
  rootDirectory: string;
  recursive: boolean;
  maxDepth: number;
  includeHidden: boolean;
  pattern?: string;
}): Promise<{ items: DirectoryItem[]; truncated: boolean }> {
  const items: DirectoryItem[] = [];
  let truncated = false;
  const matcher = createPatternMatcher(input.pattern);

  async function walkDirectory(currentDirectory: string, currentDepth: number): Promise<void> {
    if (truncated) {
      return;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (truncated) {
        return;
      }

      if (!input.includeHidden && isHiddenEntry(entry.name)) {
        continue;
      }

      const entryPath = resolveSafePath(path.join(currentDirectory, entry.name), "directory item path");
      const entryStats = await stat(entryPath).catch(() => null);

      if (entryStats === null) {
        continue;
      }

      const entryType = entryStats.isDirectory() ? "directory" : entryStats.isFile() ? "file" : null;
      if (entryType === null) {
        continue;
      }

      const relativePath = path.relative(input.rootDirectory, entryPath);
      if (matchesPattern(matcher, entry.name, relativePath, entryPath)) {
        const item: DirectoryItem = {
          name: entry.name,
          path: entryPath,
          type: entryType,
          modifiedAt: entryStats.mtime.toISOString(),
          ...(entryType === "file" ? { sizeBytes: entryStats.size } : {}),
        };

        items.push(item);
        if (items.length >= MAX_DIRECTORY_ITEMS) {
          truncated = true;
          return;
        }
      }

      if (input.recursive && entryType === "directory" && currentDepth < input.maxDepth) {
        await walkDirectory(entryPath, currentDepth + 1);
      }
    }
  }

  await walkDirectory(input.rootDirectory, 1);
  return { items, truncated };
}

function isHiddenEntry(entryName: string): boolean {
  return entryName.startsWith(".");
}

function createPatternMatcher(pattern: string | undefined): ((value: string) => boolean) | null {
  if (pattern === undefined) {
    return null;
  }

  const trimmedPattern = pattern.trim();
  if (trimmedPattern.length === 0) {
    return null;
  }

  if (trimmedPattern.includes("*") || trimmedPattern.includes("?")) {
    // Escape regex special characters: . ^ $ * + ? ( ) [ ] { } | \
    const escapedPattern = trimmedPattern.replace(/[.+^${}()|[\\]]/g, "\\$&");
    const regularExpression = new RegExp(`^${escapedPattern}$`, "i");
    return (value: string) => regularExpression.test(value);
  }

  const lowerPattern = trimmedPattern.toLowerCase();
  return (value: string) => value.toLowerCase().includes(lowerPattern);
}

function matchesPattern(
  matcher: ((value: string) => boolean) | null,
  entryName: string,
  relativePath: string,
  absolutePath: string,
): boolean {
  if (matcher === null) {
    return true;
  }

  return matcher(entryName) || matcher(relativePath) || matcher(absolutePath);
}
