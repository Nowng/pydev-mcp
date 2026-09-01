import path from "node:path";

import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import {
  launchTemporaryPythonFileInteractive,
  writeTemporaryPythonFile,
} from "../utils/pythonInteractiveRunner";
import { validateWorkingDirectory } from "../utils/safePaths";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_run_code_interactive")!;

export const runPythonInteractiveTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    code: z.string().min(1).max(50000).describe("Python source code to run interactively."),
    windowTitle: z.string().min(1).max(120).optional().describe("Optional terminal window title."),
    cwd: z.string().min(1).max(500).optional().describe("Optional working directory path for the Python REPL."),
    keepFile: z.boolean().optional().describe("Whether to keep the generated temporary .py file after launching."),
  },
  implementation: async ({ code, windowTitle, cwd, keepFile }) => {
    const scriptPath = await writeTemporaryPythonFile(code);
    const resolvedCwd = (await validateWorkingDirectory(cwd)) ?? path.dirname(scriptPath);
    const keepGeneratedFile = keepFile ?? true;

    const request = {
      filePath: scriptPath,
      cwd: resolvedCwd,
      ...(windowTitle !== undefined ? { windowTitle } : {}),
    };

    const launchResult = await launchTemporaryPythonFileInteractive(request);

    return {
      launched: true as const,
      mode: "interactive" as const,
      pythonExecutableUsed: launchResult.pythonExecutableUsed,
      scriptPath: launchResult.filePath,
      cwd: launchResult.cwd,
      keepFile: keepGeneratedFile,
      message: keepGeneratedFile
        ? "Interactive Python window launched. Temporary script file was kept."
        : "Interactive Python window launched. keepFile=false was requested, but the generated file is kept to avoid breaking the launched process.",
    };
  },
});
