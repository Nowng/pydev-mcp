import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { createPythonProjectStructure } from "../utils/pythonProjectScaffolder";
import { getToolDefinition } from "../utils/toolRegistry";
import { getWorkspaceRoot } from "../utils/safePaths";

const TOOL_DEFINITION = getToolDefinition("pydev_create_project_structure")!;

export const createProjectStructureTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} This generates pyproject.toml and README.md in a new project directory under the workspace root.`,
  parameters: {
    projectName: z.string().min(1).max(100).describe("Name of the new project, created under the workspace root."),
  },
  implementation: async ({ projectName }) => {
    const workspaceRoot = getWorkspaceRoot();

    // Create the project directory under the workspace root WITHOUT changing the workspace root.
    // All tools (and the shared venv) keep operating against <workspaceRoot>.
    const result = await createPythonProjectStructure(projectName, workspaceRoot);

    return {
      ...result,
      message: `${result.message} Created "${projectName}" under the current workspace root (${workspaceRoot}). ` +
        "The workspace root is unchanged; all tools and the shared .venv keep operating here.",
    };
  },
});
