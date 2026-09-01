import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import {
  getActivePythonStatus,
  listPythonInterpreters,
  PythonVersionResolutionError,
  resolvePythonVersion,
  setPythonExecutablePath,
  validatePythonVersion,
} from "../utils/pythonResolver";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_switch_python_version")!;

export const switchPythonVersionTool = tool({
  name: TOOL_DEFINITION.name,
  description: TOOL_DEFINITION.description,
  parameters: {
    version: z
      .string()
      .regex(/^3(\.\d{1,2})?$/)
      .optional()
      .describe("Python minor version to select, for example '3.12' or '3.14'."),
    executablePath: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Absolute path to a Python executable to use."),
    listOnly: z
      .boolean()
      .optional()
      .describe("If true, only list available Python interpreters and do not switch."),
  },
  implementation: async ({ version, executablePath, listOnly }) => {
    if (listOnly === true) {
      const [activeStatus, available] = await Promise.all([
        getActivePythonStatus(),
        listPythonInterpreters(),
      ]);

      return {
        changed: false,
        activePython: activeStatus.activePython,
        available,
        warnings: activeStatus.warnings,
        message: "Listed available Python interpreters.",
      };
    }

    if (executablePath !== undefined && version !== undefined) {
      throw new Error("Provide either executablePath or version, not both.");
    }

    if (executablePath !== undefined) {
      const activePython = await setPythonExecutablePath(executablePath);
      const available = await listPythonInterpreters();

      return {
        changed: true,
        activePython,
        available,
        message: "Switched Python interpreter.",
      };
    }

    if (version !== undefined) {
      validatePythonVersion(version);

      if (version === "3") {
        const activeStatus = await getActivePythonStatus();
        return {
          changed: false,
          requestedVersion: version,
          message: "Please specify a minor version like 3.12, 3.13, or 3.14.",
          directPathCandidates: [],
          attempted: [],
          activePython: activeStatus.activePython,
        };
      }

      const resolvedPython = await resolvePythonVersion(version).catch((error: unknown) => {
        if (error instanceof PythonVersionResolutionError) {
          return {
            resolutionError: error,
          };
        }

        throw error;
      });

      if ("resolutionError" in resolvedPython) {
        return {
          changed: false,
          requestedVersion: resolvedPython.resolutionError.requestedVersion,
          message: resolvedPython.resolutionError.message,
          directPathCandidates: resolvedPython.resolutionError.directPathCandidates,
          attempted: resolvedPython.resolutionError.attempted,
          pythonLauncherOutput: resolvedPython.resolutionError.pythonLauncherOutput,
          available: resolvedPython.resolutionError.available,
          noMatchReason: resolvedPython.resolutionError.noMatchReason,
          activePython: resolvedPython.resolutionError.activePython,
        };
      }

      const activePython = await setPythonExecutablePath(resolvedPython.executablePath);
      const available = await listPythonInterpreters();

      return {
        changed: true,
        activePython,
        available,
        message: "Switched Python interpreter.",
      };
    }

    const [activeStatus, available] = await Promise.all([
      getActivePythonStatus(),
      listPythonInterpreters(),
    ]);

    return {
      changed: false,
      activePython: activeStatus.activePython,
      available,
      warnings: activeStatus.warnings,
      message: "Returned active Python interpreter and available Python interpreters.",
    };
  },
});
