import { mkdir, lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { readPythonToolsConfigSync, writePythonToolsConfig } from "./pythonConfig";

const WORKSPACE_ENV_VAR = "PYDEV_MCP_WORKSPACE";

export const MAX_PATH_LENGTH = 500;
export const MAX_ARG_LENGTH = 500;
export const MAX_WINDOW_TITLE_LENGTH = 120;
export const MAX_ARG_COUNT = 20;
export const MAX_FILE_READ_BYTES = 300_000;
export const MAX_FILE_WRITE_BYTES = 500_000;
export const MAX_DIRECTORY_ITEMS = 500;
export const MAX_EDIT_REPLACEMENTS = 100;

const FORBIDDEN_WINDOW_TITLE_CHARS = /["&|;<>\`\n\r]/;

export function validateNoNewline(value: string, fieldName: string): void {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${fieldName} must not contain newline characters.`);
  }
}

export function validateNoNewlines(value: string, fieldName: string): void {
  validateNoNewline(value, fieldName);
}

export function validatePathInput(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${fieldName} is required.`);
  }

  if (value.length > MAX_PATH_LENGTH) {
    throw new Error(`${fieldName} must be ${MAX_PATH_LENGTH} characters or fewer.`);
  }

  validateNoNewline(value, fieldName);
}

export async function validateWorkingDirectory(cwd?: string): Promise<string | undefined> {
  if (cwd === undefined) {
    return undefined;
  }

  validatePathInput(cwd, "cwd");
  const absoluteCwd = path.resolve(cwd);

  const cwdStats = await stat(absoluteCwd).catch(() => null);
  if (cwdStats === null) {
    throw new Error(`Working directory does not exist: ${absoluteCwd}`);
  }

  if (!cwdStats.isDirectory()) {
    throw new Error(`cwd must be a directory, but it is a file: ${absoluteCwd}`);
  }

  return absoluteCwd;
}

export function validateArgs(args?: string[]): string[] {
  if (args === undefined) {
    return [];
  }

  if (args.length > MAX_ARG_COUNT) {
    throw new Error(`args must include at most ${MAX_ARG_COUNT} items.`);
  }

  for (const argument of args) {
    if (argument.length > MAX_ARG_LENGTH) {
      throw new Error(`Each arg must be ${MAX_ARG_LENGTH} characters or fewer.`);
    }
    validateNoNewline(argument, "args item");
  }

  return args;
}

export function validateWindowTitle(windowTitle?: string): string {
  const resolvedTitle = windowTitle ?? "Python Tools";

  if (resolvedTitle.trim().length === 0) {
    throw new Error("windowTitle must not be empty.");
  }

  if (resolvedTitle.length > MAX_WINDOW_TITLE_LENGTH) {
    throw new Error(`windowTitle must be ${MAX_WINDOW_TITLE_LENGTH} characters or fewer.`);
  }

  if (FORBIDDEN_WINDOW_TITLE_CHARS.test(resolvedTitle)) {
    throw new Error("windowTitle contains forbidden characters.");
  }

  return resolvedTitle;
}

/**
 * Memoized persisted default workspace root (<pluginDir>/Workspace on first install), read from
 * .pydev-mcp-config.json. `undefined` = not yet loaded; `null` = file absent/empty.
 */
let _persistedWorkspaceRoot: string | null | undefined = undefined;

/**
 * Reads (once, memoized) the persisted default workspace root from .pydev-mcp-config.json.
 * Never throws — returns null when the config is missing or has no workspaceRoot field.
 */
function readPersistedWorkspaceRoot(): string | null {
  if (_persistedWorkspaceRoot === undefined) {
    try {
      const config = readPythonToolsConfigSync();
      const value = config.workspaceRoot?.trim();
      _persistedWorkspaceRoot = value !== undefined && value.length > 0 ? value : null;
    } catch (_err) {
      _persistedWorkspaceRoot = null;
    }
  }
  return _persistedWorkspaceRoot;
}

/**
 * Cache for the user-set workspace root, populated once per toolsProvider setup in index.ts.
 * `null` = not yet resolved via resolveWorkspaceRoot().
 */
let _cachedWorkspaceRoot: string | null = null;

/**
 * Unified workspace-root resolver (single source of truth shared by config.ts and every tool).
 *
 * Precedence:
 *   1. User-set value cached during toolsProvider setup (from the LM Studio chat sidebar)
 *   2. Persisted default written by scripts/setupVenv.mjs on first install
 *      (.pydev-mcp-config.json → <pluginDir>/Workspace)
 *   3. PYDEV_MCP_WORKSPACE environment variable
 *   4. null — caller falls back to process.cwd()
 */
export function getResolvedWorkspaceRoot(): string | null {
  // 1) User-set value cached by resolveWorkspaceRoot() in index.ts.
  if (_cachedWorkspaceRoot !== null && _cachedWorkspaceRoot.length > 0) {
    return _cachedWorkspaceRoot;
  }

  // 2) Persisted default (<pluginDir>/Workspace).
  const persisted = readPersistedWorkspaceRoot();
  if (persisted !== null && persisted.length > 0) {
    try {
      return path.resolve(persisted).replace(/\/+$/, "");
    } catch (_err) {
      /* ignore — fall through to env var */
    }
  }

  // 3) Environment variable.
  const envValue = process.env[WORKSPACE_ENV_VAR]?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    try {
      return path.resolve(envValue).replace(/\/+$/, "");
    } catch (_err) {
      /* ignore — fall through */
    }
  }

  // 4) No root configured.
  return null;
}

/**
 * Public resolver used by index.ts during toolsProvider setup. Applies the full precedence above
 * and caches the result so every subsequent tool call shares the same workspace root.
 *
 * If a user-set value is provided (non-empty), it is persisted to .pydev-mcp-config.json so that
 * the setting survives a restart of LM Studio.
 */
export async function resolveWorkspaceRoot(userValue?: string): Promise<string> {
  const candidate = (userValue ?? "").trim();
  let root: string;
  if (candidate.length > 0) {
    // User-set value via LM Studio UI — persist it so the setting survives a restart.
    await writePythonToolsConfig({ workspaceRoot: candidate });
    // Allow a brand-new path even if the directory does not exist yet.
    root = candidate;
  } else {
    const persisted = readPersistedWorkspaceRoot() ?? "";
    root = persisted.length > 0
      ? persisted
      : (process.env[WORKSPACE_ENV_VAR]?.trim() ?? "");
    if (root.length === 0) {
      root = process.cwd();
    }
  }

  const absoluteRoot = path.resolve(root).replace(/\/+$/, "");
  _cachedWorkspaceRoot = absoluteRoot;
  return absoluteRoot;
}

/**
 * Resolves a path relative to the SINGLE WORKSPACE ROOT.
 * All file operations are scoped within the workspace root for safety.
 */
export function getWorkspaceRoot(): string {
  // Prefer the resolved workspace root (user-set → persisted default → env var).
  const resolved = getResolvedWorkspaceRoot();
  if (resolved !== null) return resolved;

  // Final fallback: the directory the plugin runs in.
  return path.resolve(process.cwd()).replace(/\/+$/, "");
}

/**
 * Resolves the working directory a child Python process should execute in.
 *
 * Precedence (mirrors the workspace-root resolver, but for *execution* cwd):
 *   1. An explicit `requestedCwd` (validated: must exist and be a directory).
 *   2. The directory of `resolvedTargetPath` when a concrete target file is given.
 *   3. The single workspace root — the deterministic default that keeps imports of
 *      workspace modules resolvable instead of failing against an arbitrary process.cwd().
 */
export async function resolveRunCwd(
  requestedCwd: string | undefined,
  resolvedTargetPath?: string,
): Promise<string> {
  if (requestedCwd !== undefined && requestedCwd.trim().length > 0) {
    const resolved = await validateWorkingDirectory(requestedCwd);
    if (resolved === undefined) {
      // Unreachable in practice: requestedCwd is a non-empty string, but keep the type honest.
      throw new Error("Working directory is required.");
    }
    return resolved;
  }

  if (resolvedTargetPath !== undefined && resolvedTargetPath.trim().length > 0) {
    return path.dirname(resolvedTargetPath);
  }

  return getWorkspaceRoot();
}

/**
 * Ensures and returns the workspace-local scratch directory (<workspaceRoot>/.pydev-tmp) used for
 * throwaway target files (the debug harness and the inline-code runner). Keeping it inside the
 * workspace — never system /tmp — makes execution cwd and import resolution deterministic.
 */
export async function ensureTempWorkspaceDir(): Promise<string> {
  const tempDir = path.join(getWorkspaceRoot(), ".pydev-tmp");
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Lists the immediate child directories of the workspace root that look like Python projects
 * (i.e. contain a `pyproject.toml`). Used to map a source file back to the project that owns it,
 * so sibling `tests/` paths resolve under the correct project — not the bare workspace root.
 */
export async function listProjectRoots(): Promise<string[]> {
  const workspaceRoot = getWorkspaceRoot();
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((e) => e.isDirectory() && e.name !== ".git")
    .map((e) => path.join(workspaceRoot, e.name));

  const results: string[] = [];
  for (const candidate of candidates) {
    try {
      await stat(path.join(candidate, "pyproject.toml"));
      results.push(candidate);
    } catch {
      /* not a project — skip */
    }
  }
  return results;
}

/**
 * Resolves the project root that contains `targetSourcePath` (a source file such as
 * "remove_boxes/src/main.py"). Returns the workspace-root-relative project directory, or "" when
 * no matching project is found. Mirrors the shared project-root resolver used by create_test_file() so test- and
 * run-time paths share one resolution rule.
 */
export async function resolveProjectRootForTarget(targetSourcePath: string): Promise<string> {
  // Resolve the target relative to the workspace root (not process.cwd()) so project detection is
  // stable no matter where the plugin happens to run from — matching how create_test_file() resolves
  // its targetFilePath against the workspace root.
  const targetDir = path.dirname(path.resolve(getWorkspaceRoot(), targetSourcePath));
  const projectRoots = await listProjectRoots();
  return [...projectRoots]
    .filter((root) => targetDir === root || targetDir.startsWith(root + path.sep))
    .sort((a, b) => b.length - a.length)[0] ?? "";
}

/**
 * Resolves a test-file path (e.g. "tests/test_main.py") against the project that contains the
 * given source target file (e.g. "remove_boxes/src/main.py"). Returns an absolute path inside the
 * workspace root such as "<workspaceRoot>/remove_boxes/tests/test_main.py".
 *
 * This is the single shared resolver for both pydev_create_test_file() and pydev_run_tests() so
 * that the test file location always matches where it was generated.
 */
export async function resolveTestFilePath(testInputPath: string, targetSourcePath: string): Promise<string> {
  const testInput = testInputPath.trim();
  // Convert the caller's path to a *test* file name. The input may be either a bare source
  // module (e.g. "remove_boxes/src/main.py" → stem "main") or an already-named test file
  // (e.g. "tests/test_main.py"). We only synthesize the "test_" prefix when the basename does
  // NOT already start with "test_", so run_tests() never double-prefixes an existing test file.
  const inputBaseName = path.basename(testInput);
  const testFileName = inputBaseName.startsWith("test_") ? inputBaseName : `test_${inputBaseName}`;
  const projectRoot = await resolveProjectRootForTarget(targetSourcePath);
  if (projectRoot) {
    return path.join(projectRoot, "tests", testFileName);
  }
  // No project found — fall back to the workspace-root tests directory.
  return resolveSafePath(testInput);
}

/**
 * Resolves a file or directory path relative to the workspace root.
 * All paths are resolved against the workspace root — the single operating boundary.
 */
export function resolveSafePath(inputPath: string, fieldName = "path"): string {
  validatePathInput(inputPath, fieldName);

  const workspaceRoot = getWorkspaceRoot();
  const absolutePath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workspaceRoot, inputPath);

  validatePathInput(absolutePath, fieldName);
  ensureInsideWorkspace(absolutePath, workspaceRoot, fieldName);
  return absolutePath;
}

export async function ensurePythonFile(
  filePath: string,
  options: { mustExist?: boolean } = {},
): Promise<string> {
  const resolvedPath = resolveSafePath(filePath, "filePath");
  if (path.extname(resolvedPath).toLowerCase() !== ".py") {
    throw new Error("filePath must point to a .py file.");
  }

  if (options.mustExist === false) {
    return resolvedPath;
  }

  const fileStats = await stat(resolvedPath).catch(() => null);
  if (fileStats === null) {
    throw new Error(`Python file does not exist: ${resolvedPath}`);
  }

  if (!fileStats.isFile()) {
    throw new Error(`filePath is not a file: ${resolvedPath}`);
  }

  const fileLstat = await lstat(resolvedPath).catch(() => null);
  if (fileLstat?.isSymbolicLink()) {
    throw new Error("Symbolic links are not allowed for filePath.");
  }

  await ensureCanonicalPathInsideWorkspace(resolvedPath, "filePath");
  return resolvedPath;
}

/**
 * Optional context for `ensureDirectory` error messages.
 *
 * Passing a contextual `fieldName` (e.g. `sourcePath`, `testPath`, `projectPath`) and an optional
 * `hint` turns the generic "directoryPath is not a directory" message into something actionable,
 * which is exactly what coverage-style tools need when a user passes a file instead of a directory.
 */
export interface EnsureDirectoryOptions {
  /** Semantic field name used in error messages (defaults to "directoryPath"). */
  fieldName?: string;
  /** Optional guidance appended to the "is a file" error (e.g. which sibling parameter to use). */
  hint?: string;
}

/**
 * Ensures `directoryPath` exists and is a directory inside the workspace root, returning its
 * absolute path.
 *
 * Errors are contextual and distinguish the failure modes:
 *   - the path does not exist, or
 *   - the path exists but is a **file** (the common mistake when a directory like `sourcePath` /
 *     `testPath` / `projectPath` / `targetPath` is expected) — here an optional `hint` adds usage
 *     guidance. Symbolic links are rejected for safety.
 */
export async function ensureDirectory(
  directoryPath: string,
  options: EnsureDirectoryOptions = {},
): Promise<string> {
  const fieldName = options.fieldName ?? "directoryPath";
  const hint = options.hint;
  const resolvedPath = resolveSafePath(directoryPath, fieldName);
  const directoryStats = await stat(resolvedPath).catch(() => null);

  if (directoryStats === null) {
    throw new Error(`${fieldName} does not exist: ${resolvedPath}`);
  }

  if (!directoryStats.isDirectory()) {
    const guidance = hint ? ` ${hint}` : "";
    throw new Error(`${fieldName} must be a directory, but it is a file: ${resolvedPath}.${guidance}`);
  }

  const directoryLstat = await lstat(resolvedPath).catch(() => null);
  if (directoryLstat?.isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed for ${fieldName}.`);
  }

  await ensureCanonicalPathInsideWorkspace(resolvedPath, fieldName);
  return resolvedPath;
}

export async function ensureCanonicalPathInsideWorkspace(pathToCheck: string, fieldName: string): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  const canonicalWorkspaceRoot = await resolveCanonicalPath(workspaceRoot);
  const canonicalPathToCheck = await resolveCanonicalPath(pathToCheck);

  ensureInsideWorkspace(canonicalPathToCheck, canonicalWorkspaceRoot, fieldName);
}

function ensureInsideWorkspace(absolutePath: string, workspaceRoot: string, fieldName: string): void {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (relativePath === "") {
    return;
  }

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${fieldName} must stay inside the configured workspace root: ${workspaceRoot}`);
  }
}

async function resolveCanonicalPath(inputPath: string): Promise<string> {
  return await realpath(inputPath).catch(() => path.resolve(inputPath));
}

/**
 * Generalized (extension-agnostic) text-file path resolver.
 *
 * Unlike `ensurePythonFile` (which enforces a `.py` extension), this accepts ANY file
 * inside the workspace so the generic "text" tools can edit .txt, .md, .json, config files, etc.
 */
export async function resolveTextFilePath(
  filePath: string,
  options: { mustExist?: boolean } = {},
): Promise<string> {
  const resolvedPath = resolveSafePath(filePath, "filePath");

  if (options.mustExist === true) {
    const fileStats = await stat(resolvedPath).catch(() => null);
    if (fileStats === null) {
      throw new Error(`File does not exist: ${resolvedPath}`);
    }
    if (!fileStats.isFile()) {
      throw new Error(`filePath is not a file: ${resolvedPath}`);
    }

    const fileLstat = await lstat(resolvedPath).catch(() => null);
    if (fileLstat?.isSymbolicLink()) {
      throw new Error("Symbolic links are not allowed for filePath.");
    }

    await ensureCanonicalPathInsideWorkspace(resolvedPath, "filePath");
  }

  return resolvedPath;
}
