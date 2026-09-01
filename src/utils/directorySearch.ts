/**
 * directorySearch.ts — powers two LLM-facing tools:
 *   1) `search_directory` : grep-style content search (pattern + path) across a directory tree.
 *   2) `find_files`       : browse files by name substring or extension.
 *
 * Both operate strictly inside the configured workspace root (paths are validated with resolveSafePath).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { getWorkspaceRoot, MAX_DIRECTORY_ITEMS, resolveSafePath } from "./safePaths";

export interface SearchDirectoryInput {
  /** Substring (default) or RegExp to search for inside file contents. */
  pattern: string;
  /** Directory relative to workspace root or absolute inside workspace. Defaults to workspace root. */
  directoryPath?: string;
  /** Include hidden dot-prefixed entries. Default false. */
  includeHidden?: boolean;
  /** Interpret `pattern` as a regular expression. Default false (case-insensitive substring). */
  useRegex?: boolean;
  /** Cap the number of matched lines returned. Default MAX_DIRECTORY_ITEMS. */
  maxResults?: number;
}

export interface SearchResultItem {
  filePath: string;
  lineNumber: number;
  line: string;
}

export interface SearchDirectoryResult {
  query: string;
  useRegex: boolean;
  basePath: string;
  filesScanned: number;
  totalMatches: number;
  results: SearchResultItem[];
  truncated: boolean;
}

export interface FindFilesInput {
  /** Extension (".py", "*.ts") or a name substring to match. */
  pattern: string;
  directoryPath?: string;
  includeHidden?: boolean;
  maxResults?: number;
}

export interface FindFileEntry {
  name: string;
  path: string;
  extension: string;
}

export interface FindFilesResult {
  query: string;
  basePath: string;
  count: number;
  files: FindFileEntry[];
  truncated: boolean;
}

/** Dirs that are noise for code search / browsing and are skipped unless hidden-inclusion is off anyway. */
const DEFAULT_EXCLUDES = new Set(["node_modules", ".venv", "venv", "__pycache__", ".git", ".mypy_cache", ".ruff_cache", "dist"]);

/** Files larger than this are skipped during content search to avoid huge reads. */
const MAX_SCAN_BYTES = 5_000_000;

async function resolveBaseDirectory(directoryPath?: string): Promise<string> {
  const raw = (directoryPath ?? "").trim();
  if (raw.length === 0) {
    return getWorkspaceRoot();
  }
  return resolveSafePath(raw, "directoryPath");
}

export async function searchDirectory(input: SearchDirectoryInput): Promise<SearchDirectoryResult> {
  const query = (input.pattern ?? "").trim();
  if (query.length === 0) {
    return emptySearch("", false);
  }

  const useRegex = input.useRegex ?? false;
  const includeHidden = input.includeHidden ?? false;
  const maxResults = Math.min(input.maxResults ?? MAX_DIRECTORY_ITEMS, MAX_DIRECTORY_ITEMS);
  const baseDir = await resolveBaseDirectory(input.directoryPath);
  const testLine = buildLineTester(query, useRegex);

  const results: SearchResultItem[] = [];
  let filesScanned = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip silently
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;

      if (!includeHidden && (name.startsWith(".") || DEFAULT_EXCLUDES.has(name))) {
        continue;
      }

      const absPath = resolveSafePath(path.join(dir, name), "search path");
      let stats;
      try {
        stats = await stat(absPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;

      if (stats.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!stats.isFile()) continue;

      filesScanned += 1;
      const budget = Math.max(0, maxResults - results.length);
      const matched = await matchFileContent(absPath, testLine, budget);
      for (const item of matched) {
        results.push(item);
        if (results.length >= maxResults) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(baseDir);

  return {
    query,
    useRegex,
    basePath: baseDir,
    filesScanned,
    totalMatches: results.length,
    results: results.slice(0, maxResults),
    truncated,
  };
}

async function matchFileContent(absPath: string, testLine: (line: string) => boolean, budget: number): Promise<SearchResultItem[]> {
  const out: SearchResultItem[] = [];
  if (budget <= 0) return out;

  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    return out;
  }

  if (content.length > MAX_SCAN_BYTES || content.indexOf("\u0000") !== -1) {
    return out; // skip huge / binary files
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (out.length >= budget) break;
    const line = lines[i];
    if (line === undefined) continue;
    if (testLine(line)) {
      out.push({ filePath: absPath, lineNumber: i + 1, line: line.slice(0, 500) });
    }
  }
  return out;
}

function buildLineTester(query: string, useRegex: boolean): (line: string) => boolean {
  if (useRegex) {
    try {
      const re = new RegExp(query);
      return (line: string) => re.test(line);
    } catch {
      // fall through to substring matching when the regex is invalid
    }
  }

  const lower = query.toLowerCase();
  return (line: string) => line.toLowerCase().includes(lower);
}

function emptySearch(query: string, useRegex: boolean): SearchDirectoryResult {
  return {
    query,
    useRegex,
    basePath: getWorkspaceRoot(),
    filesScanned: 0,
    totalMatches: 0,
    results: [],
    truncated: false,
  };
}

export async function findFiles(input: FindFilesInput): Promise<FindFilesResult> {
  const query = (input.pattern ?? "").trim();
  if (query.length === 0) {
    return emptyFind("");
  }

  const includeHidden = input.includeHidden ?? false;
  const maxResults = Math.min(input.maxResults ?? MAX_DIRECTORY_ITEMS, MAX_DIRECTORY_ITEMS);
  const baseDir = await resolveBaseDirectory(input.directoryPath);
  // A leading dot means the user wants an extension match (".py" / "*.ts"). Otherwise it is a name substring.
  const matchExtension = query.startsWith(".");
  const lowerQuery = query.toLowerCase();

  const files: FindFileEntry[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;

      if (!includeHidden && (name.startsWith(".") || DEFAULT_EXCLUDES.has(name))) {
        continue;
      }

      const absPath = resolveSafePath(path.join(dir, name), "find path");
      let stats;
      try {
        stats = await stat(absPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;

      if (stats.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!stats.isFile()) continue;

      const matches = matchExtension
        ? path.extname(name).toLowerCase() === lowerQuery
        : name.toLowerCase().includes(lowerQuery);

      if (matches) {
        files.push({ name, path: absPath, extension: path.extname(name) });
        if (files.length >= maxResults) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(baseDir);

  return {
    query,
    basePath: baseDir,
    count: files.length,
    files: files.slice(0, maxResults),
    truncated,
  };
}

function emptyFind(query: string): FindFilesResult {
  return {
    query,
    basePath: getWorkspaceRoot(),
    count: 0,
    files: [],
    truncated: false,
  };
}
