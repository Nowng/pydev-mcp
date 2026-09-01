import { tool } from "@lmstudio/sdk";
import { z } from "zod";

import { createTestFile, type TestStyle } from "../utils/createTestFileUtil";
import { getToolDefinition } from "../utils/toolRegistry";

const TOOL_DEFINITION = getToolDefinition("pydev_create_test_file")!;

export const createTestFileTool = tool({
  name: TOOL_DEFINITION.name,
  description: `${TOOL_DEFINITION.description} Generates a pytest test-file skeleton (fixture imports + assertion patterns) for an existing .py file.`,
  parameters: {
    targetFilePath: z
      .string()
      .min(1)
      .max(500)
      .describe("Path to the .py file you want tests generated for."),
    testFilePath: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Where to write the generated test file. Defaults to tests/test_<stem>.py."),
    style: z
      .enum(["assert", "raises"])
      .optional()
      .describe("Assertion style for the generated skeleton. Defaults to 'assert'."),
    includeFixtures: z
      .boolean()
      .optional()
      .describe("Include an example pytest fixture in the skeleton. Defaults to true."),
  },
  implementation: async ({ targetFilePath, testFilePath, style, includeFixtures }) => {
    const result = await createTestFile(targetFilePath, {
      testFilePath,
      style: (style ?? "assert") as TestStyle,
      includeFixtures,
    });

    return {
      testFilePath: result.testFilePath,
      targetFilePath: result.targetFilePath,
      functions: result.functions,
      classes: result.classes,
      generatedTests: result.generatedTests,
      contentLength: result.contentLength,
    };
  },
});
