import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, existsSync as existsSyncSync } from "node:fs";
import path from "node:path";

export interface PythonToolsConfig {
  /** Explicit Python executable path override (from the LM Studio 'Python Executable Path' setting). */
  pythonExecutablePath?: string;
  /**
   * Workspace root persisted by scripts/setupVenv.mjs on first install.
   * When present, config.ts uses it as the default workspace root instead of process.cwd().
   */
  workspaceRoot?: string;
}

const CONFIG_FILE_NAME = ".pydev-mcp-config.json";

/**
 * Tries multiple locations to find the plugin config file:
 *   1. Plugin root directory (development mode)
 *   2. dist/ subdirectory (production / LM Studio deployment)
 *   3. Environment variable override
 *   4. Fallback to process.cwd()
 *
 * This handles the case where LM Studio unpacks the plugin from dist/ into a temp location.
 */
export function getPythonToolsConfigPath(): string {
  // Try plugin root first
  const rootCfgPath = path.join(process.cwd(), CONFIG_FILE_NAME);

  // Try dist/ subdirectory (for production/LM Studio deployments)
  const distDir = path.join(process.cwd(), "dist");
  const distCfgPath = path.join(distDir, CONFIG_FILE_NAME);

  // Try environment variable override
  const envCfgPath = process.env.PYDEV_MCP_WORKSPACE ?? "";

  // Prioritize: env var > dist/ > root > cwd fallback
  if (envCfgPath) {
    return envCfgPath;
  }
  if (existsSyncSync(distCfgPath)) {
    return distCfgPath;
  }
  if (existsSyncSync(rootCfgPath)) {
    return rootCfgPath;
  }

  // Fallback: use cwd (least preferred, but maintains backward compatibility)
  return path.join(process.cwd(), CONFIG_FILE_NAME);
}

export async function readPythonToolsConfig(): Promise<PythonToolsConfig> {
  const cfgPath = getPythonToolsConfigPath();
  try {
    const rawConfig = await readFile(cfgPath, "utf8");
    const parsedConfig: unknown = JSON.parse(rawConfig);
    return parseConfig(parsedConfig);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    return {};
  }
}

/**
 * Synchronous counterpart to {@link readPythonToolsConfig}. Used by the workspace-root resolver
 * (safePaths.ts) so tools can read the persisted default WITHOUT awaiting — keeping path
 * resolution synchronous and consistent across every tool.
 */
export function readPythonToolsConfigSync(): PythonToolsConfig {
  const cfgPath = getPythonToolsConfigPath();
  try {
    const rawConfig = readFileSync(cfgPath, "utf8");
    return parseConfig(JSON.parse(rawConfig));
  } catch (error) {
    if (isNodeError(error) && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    return {};
  }
}

/** Extracts only the known, correctly-typed fields from a parsed config object. */
function parseConfig(parsedConfig: unknown): PythonToolsConfig {
  if (!isConfigObject(parsedConfig)) {
    return {};
  }

  const config: PythonToolsConfig = {};

  if (typeof parsedConfig.pythonExecutablePath === "string") {
    config.pythonExecutablePath = parsedConfig.pythonExecutablePath;
  }

  if (typeof parsedConfig.workspaceRoot === "string") {
    config.workspaceRoot = parsedConfig.workspaceRoot;
  }

  return config;
}

/**
 * Writes config, MERGING with the existing file so that callers which only care about one field
 * (e.g. pydev_switch_python_version writing pythonExecutablePath) never wipe workspaceRoot.
 */
export async function writePythonToolsConfig(config: PythonToolsConfig): Promise<void> {
  const existing = await readPythonToolsConfig();
  const merged: PythonToolsConfig = { ...existing };

  if (config.pythonExecutablePath !== undefined) {
    merged.pythonExecutablePath = config.pythonExecutablePath;
  }

  if (config.workspaceRoot !== undefined) {
    merged.workspaceRoot = config.workspaceRoot;
  }

  const configJson = `${JSON.stringify(merged, null, 2)}\n`;
  await writeFile(getPythonToolsConfigPath(), configJson, "utf8");
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
