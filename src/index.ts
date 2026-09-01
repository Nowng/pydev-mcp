import { type PluginContext } from "@lmstudio/sdk";

import { configSchematics, resolveWorkspaceRoot } from "./config";

import { getWorkspaceRoot } from "./utils/safePaths";

import { checkForBugsTool } from "./tools/checkForBugs";
import { checkForBugsInFileTool } from "./tools/checkForBugsInFile";
import { editTextFileTool } from "./tools/editTextFile";
import { editTextFileByLineTool } from "./tools/editTextFileByLine";
import { installModuleTool } from "./tools/installModule";
import { listDirectoryTool } from "./tools/listDirectory";
import { listToolsTool } from "./tools/listTools";
import { readTextFileTool } from "./tools/readTextFile";
import { runPythonTool } from "./tools/runPython";
import { runPythonFileTool } from "./tools/runPythonFile";
import { runPythonFileInteractiveTool } from "./tools/runPythonFileInteractive";
import { runPythonInteractiveTool } from "./tools/runPythonInteractive";
import { runReplTool } from "./tools/runRepl";
import { saveTextFileTool } from "./tools/saveTextFile";
import { switchPythonVersionTool } from "./tools/switchPythonVersion";
import { uninstallModuleTool } from "./tools/uninstallModule";
import { setupVenvTool } from "./tools/setupVenvTool";
import { getSetupStatusTool } from "./tools/getSetupStatusTool";
import { runLinterAndFormatterTool } from "./tools/runLinterAndFormatter";
import { runLinterAndFormatterInFileTool } from "./tools/runLinterAndFormatterInFile";
import { runTestsTool } from "./tools/runTests";
import { analyzeImportsAndDependenciesTool } from "./tools/analyzeImportsAndDependencies";
import { createProjectStructureTool } from "./tools/createProjectStructure";
import { inspectEnvironmentTool } from "./tools/inspectEnvironmentTool";
import { runWithDebuggerTool } from "./tools/runWithDebuggerTool";
import { typeCheckProjectTool } from "./tools/typeCheckProjectTool";
import { createTestFileTool } from "./tools/createTestFileTool";
import { generateRequirementsTxtTool } from "./tools/generateRequirementsTxtTool";
import { searchDirectoryTool } from "./tools/searchDirectory";
import { findFilesTool } from "./tools/findFiles";
import { getWorkspaceRootTool } from "./tools/getWorkspaceRootTool";
import { runProjectCoverageTool } from "./tools/runProjectCoverage";
import { scanProjectSecurityTool } from "./tools/scanProjectSecurity";
import { buildPythonPackageTool } from "./tools/buildPythonPackage";
import { profileProjectTool } from "./tools/profileProject";
import { pydevSafeRenameTool } from "./tools/pydevSafeRenameTool";
import { pydevExtractFunctionTool } from "./tools/pydevExtractFunctionTool";
import { pydevAuditDocstringsTool } from "./tools/pydevAuditDocstringsTool";
import { pydevGenerateReferenceTool } from "./tools/pydevGenerateReferenceTool";
import { pydevMigrationAuditTool } from "./tools/pydevMigrationAuditTool";
import { pydevDescribeWorkspaceTool } from "./tools/pydevDescribeWorkspaceTool";

/** Venv setup — imported lazily to avoid a circular import at module load time. */
let _setupVenv: (() => Promise<void>) | null = null;

function getSetupVenv(): () => Promise<void> {
  if (_setupVenv !== null) return _setupVenv;

  // Dynamic-import the venv-setup helper once we need it, so that a missing .venv/ does not block plugin load.
  void import("./utils/pythonVenv").then((mod) => {
    const setup = mod.setupVenv.bind(mod);
    if (typeof setup !== "function") throw new Error("pythonVenv.setupVenv is expected to be callable.");

    _setupVenv = async () => {
      try {
        await setup(getWorkspaceRoot());
      } catch (_err) {
        // Best-effort — never block plugin load. The first MCP tool call will surface a clear error if Python itself can't run.
      }
    };
  });

  return _setupVenv ?? (() => Promise.resolve());
}

export async function main(context: PluginContext): Promise<void> {
  // Register the UI schema FIRST so LM Studio shows "Workspace Folder Path" in chat settings sidebar as soon as a conversation starts.
  context.withConfigSchematics(configSchematics);

  // Prime the workspace root with the persisted default (install-time Workspace) so the on-demand
  // venv setup targets the correct location (<workspaceRoot>/.venv) instead of process.cwd().
  try { await resolveWorkspaceRoot(undefined); } catch (_err) { /* non-fatal — proceed */ }

  const ensureSetup = getSetupVenv();
  try { await ensureSetup(); } catch (_err) { /* non-fatal — proceed */ }

  // Resolve workspace root once per toolsProvider invocation using user value from LM Studio chat config.
  context.withToolsProvider(async (ctl) => {
    const userWorkspace = ctl.getPluginConfig(configSchematics).get("workspacePath") ?? "";
    await resolveWorkspaceRoot(userWorkspace);

    return [
      runPythonTool,
      runPythonFileTool,
      runPythonInteractiveTool,
      runPythonFileInteractiveTool,
      runReplTool,
      installModuleTool,
      uninstallModuleTool,
      switchPythonVersionTool,
      saveTextFileTool,
      readTextFileTool,
      listDirectoryTool,
      editTextFileTool,
      editTextFileByLineTool,
      searchDirectoryTool,
      findFilesTool,
      runProjectCoverageTool,
      scanProjectSecurityTool,
      buildPythonPackageTool,
      profileProjectTool,    // ← NEW: cProfile-based profiling with structured JSON output
      checkForBugsTool,
      checkForBugsInFileTool,
      setupVenvTool,       // ← NEW: ensure venv exists on demand (e.g. after Hub download)
      getSetupStatusTool,  // ← NEW: report current .venv state without modifying anything
      runLinterAndFormatterInFileTool,
      runLinterAndFormatterTool,       // ← NEW: ruff lint + format on Python code
      runTestsTool,                  // ← NEW: pytest pass/fail counts with summary
      analyzeImportsAndDependenciesTool,   // ← NEW: parse imports vs installed packages
      createProjectStructureTool,        // ← NEW: pyproject.toml + README.md scaffold
      inspectEnvironmentTool,            // ← NEW: report Python version / venv / packages / env vars
      runWithDebuggerTool,               // ← NEW: run code with full traceback + per-frame variable inspection
      typeCheckProjectTool,              // ← NEW: mypy/pyright project-wide static type check
      createTestFileTool,                // ← NEW: generate a pytest test-file skeleton
      generateRequirementsTxtTool,       // ← NEW: write requirements.txt (pip freeze or from imports)
      listToolsTool,
      getWorkspaceRootTool,
      pydevSafeRenameTool,        // ← NEW: safe AST-based rename across call sites
      pydevExtractFunctionTool,   // ← NEW: extract a code block into its own function
      pydevAuditDocstringsTool,   // ← NEW: docstring coverage report per file
      pydevGenerateReferenceTool, // ← NEW: auto-generate API reference from type hints/docstrings
      pydevMigrationAuditTool,    // ← NEW: detect deprecated patterns & suggest replacements
      pydevDescribeWorkspaceTool, // ← NEW: instant high-level repo context overview
    ];
  });
}
