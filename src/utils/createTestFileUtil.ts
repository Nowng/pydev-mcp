/**
 * createTestFileUtil.ts — Generates a pytest test-file skeleton for an existing Python file.
 *
 * Parses the target module with `ast` to discover top-level functions and classes, then writes
 * a runnable pytest skeleton (with fixture imports and basic assertion patterns) into the workspace.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveProjectRootForTarget, resolveSafePath } from "./safePaths";

export type TestStyle = "assert" | "raises";

export interface DiscoveredTargets {
  functions: string[];
  classes: string[];
}

export interface CreateTestFileResult {
  testFilePath: string;
  targetFilePath: string;
  generatedTests: string[];
  functions: string[];
  classes: string[];
  contentLength: number;
}

const AST_EXTRACTOR = `
import ast, sys, json

def main(target):
    source = open(target, "r", encoding="utf8").read()
    tree = ast.parse(source, filename=target)
    functions = []
    classes = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(node.name)
        elif isinstance(node, ast.ClassDef):
            classes.append(node.name)
    print(json.dumps({"functions": functions, "classes": classes}))

main(sys.argv[1])
`;

/** Discover top-level function and class names in a target .py file using the stdlib `ast`. */
export async function discoverTargets(targetFilePath: string): Promise<DiscoveredTargets> {
  const result = await runExtractor(targetFilePath);
  if (result === null) {
    return { functions: [], classes: [] };
  }

  const parsed = JSON.parse(result) as { functions?: unknown; classes?: unknown };
  const functions = Array.isArray(parsed.functions) ? (parsed.functions as string[]).filter((n): n is string => typeof n === "string") : [];
  const classes = Array.isArray(parsed.classes) ? (parsed.classes as string[]).filter((n): n is string => typeof n === "string") : [];
  return { functions, classes };
}

function runExtractor(targetFilePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("node:child_process");
    const child = spawn("python", ["-c", AST_EXTRACTOR, targetFilePath], { shell: false });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.on("error", () => resolve(null));
    child.on("close", (exitCode: number | null) => {
      resolve(exitCode === 0 ? stdout.trim() : null);
    });
  });
}

/**
 * Generates a pytest skeleton string for the discovered targets.
 * `style` controls whether assertions use plain `assert` or `pytest.raises`.
 */
export function generateTestContent(
  targetStem: string,
  moduleName: string,
  targets: DiscoveredTargets,
  style: TestStyle,
  includeFixtures: boolean,
): string {
  const lines: string[] = [];
  lines.push('"""Auto-generated pytest skeleton for ' + targetStem + '.py."""');
  lines.push("");
  lines.push("import pytest");
  if (style === "raises") {
    lines.push("# pytest.raises is used below to assert that calls raise expected errors.");
  }
  // Only emit the multi-line `from <module> import (...)` block when there are actual top-level
  // targets to import. When a target file has no top-level functions/classes (e.g. module-level
  // scripts like `main.py`), an empty `from X import (\n)` is a *syntax error* that makes pytest's
  // collection phase fail (Exit code 2) before any test can run. The no-targets path below instead
  // relies on the `import <module>` smoke test, which needs no top-level import.
  if (targets.functions.length > 0 || targets.classes.length > 0) {
    lines.push(`from ${moduleName} import (`);
    for (const name of [...targets.functions, ...targets.classes]) {
      lines.push(`    ${name},`);
    }
    lines.push(")");
    lines.push("");
  }

  if (includeFixtures) {
    lines.push("# --- Example fixtures (extend as needed) ---");
    lines.push("@pytest.fixture");
    lines.push("def sample_input():");
    lines.push('    """Return a representative input for the functions under test."""');
    lines.push("    return None");
    lines.push("");
  }

  if (targets.functions.length === 0 && targets.classes.length === 0) {
    // No top-level callables found: emit a simple importability smoke test instead.
    lines.push("def test_module_is_importable():");
    lines.push('    """Smoke test: the target module imports without error."""');
    lines.push("    import " + moduleName);
    lines.push("    assert True");
    lines.push("");
    return lines.join("\n") + "\n";
  }

  const generated: string[] = [];

  for (const fn of targets.functions) {
    generated.push(`def test_${fn}_exists():`);
    generated.push(`    """Verify that '${fn}' is importable and callable."""`);
    generated.push(`    assert callable(${fn})`);
    generated.push("");
    generated.push(`def test_${fn}_basic_call():`);
    generated.push(`    """Basic call pattern for '${fn}'. Replace the placeholder with real inputs."""`);
    if (style === "raises") {
      generated.push(`    # with pytest.raises(Exception):`);
      generated.push(`    #     ${fn}(sample_input)`);
    } else {
      generated.push(`    # result = ${fn}(sample_input)`);
      generated.push(`    # assert result is not None  # adjust to the expected value`);
    }
    generated.push("    raise NotImplementedError('Fill in real assertions for ' + '${fn}')");
    generated.push("");
  }

  for (const cls of targets.classes) {
    generated.push(`class Test${cls}:`);
    generated.push(`    """Test suite for the ${cls} class."""`);
    generated.push("");
    generated.push(`    def test_${cls.toLowerCase()}_instantiate(self):`);
    generated.push(`        """Instantiate the class (assume a no-arg constructor)."`);
    generated.push(`        obj = ${cls}()`);
    generated.push(`        assert obj is not None`);
    generated.push("");
  }

  lines.push("# --- Generated test cases ---");
  lines.push(...generated);
  return lines.join("\n") + "\n";
}

/**
 * Generates and writes a pytest skeleton for `targetFilePath` into the workspace.
 * When `testFilePath` is omitted it defaults to `<project #1>/tests/test_<stem>.py`, i.e. a
 * `tests/` directory *inside the same project directory as the target file*. This matches the
 * scaffold layout (each project owns its own `src/` and `tests/`).
 */
export async function createTestFile(
  targetFilePath: string,
  options: {
    testFilePath?: string | undefined;
    style?: TestStyle | undefined;
    includeFixtures?: boolean | undefined;
  } = {},
): Promise<CreateTestFileResult> {
  const resolvedTarget = await resolveSafePath(targetFilePath, "targetFilePath");

  const moduleName = toModuleName(resolvedTarget);
  const targets = await discoverTargets(resolvedTarget);
  const style = options.style ?? "assert";
  const includeFixtures = options.includeFixtures ?? true;

  const defaultName = `test_${path.basename(resolvedTarget, path.extname(resolvedTarget))}.py`;

  // Default test path lives under the project root (project #1), NOT the workspace root —
  // matching the scaffold layout where each project owns its own src/ and tests/ as siblings:
  //   <workspace root>
  //   └── <project #1>   (contains src/ and tests/)
  // resolveProjectRootForTarget() locates the project that contains the target file and returns a
  // workspace-root-relative directory (e.g. "remove_boxes"), so the test file is written to
  // "<project #1>/tests/<stem>.py" regardless of how deep the target sits under src/. This yields
  // a relative path, which resolveSafePath() later resolves against the workspace root while still
  // validating it stays inside workspace.
  const projectRoot = await resolveProjectRootForTarget(targetFilePath);
  const defaultTestPath = path.join(projectRoot, "tests", defaultName);

  const testPathRelative = (options.testFilePath ?? "").trim().length > 0
    ? options.testFilePath!.replace(/\\/g, "/")
    : defaultTestPath;

  const resolvedTestPath = resolveSafePath(testPathRelative, "testFilePath");

  const content = generateTestContent(
    path.basename(resolvedTarget, path.extname(resolvedTarget)),
    moduleName,
    targets,
    style,
    includeFixtures,
  );

  await mkdir(path.dirname(resolvedTestPath), { recursive: true });
  await writeFile(resolvedTestPath, content, "utf8");

  return {
    testFilePath: resolvedTestPath,
    targetFilePath: resolvedTarget,
    generatedTests: generateGeneratedTestNames(targets),
    functions: targets.functions,
    classes: targets.classes,
    contentLength: content.length,
  };
}




function toModuleName(resolvedPath: string): string {
  const stem = path.basename(resolvedPath, path.extname(resolvedPath));
  return stem.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "target";
}

function generateGeneratedTestNames(targets: DiscoveredTargets): string[] {
  const names: string[] = [];
  for (const fn of targets.functions) {
    names.push(`test_${fn}_exists`);
    names.push(`test_${fn}_basic_call`);
  }
  for (const cls of targets.classes) {
    names.push(`Test${cls}::test_${cls.toLowerCase()}_instantiate`);
  }
  if (names.length === 0) {
    names.push("test_module_is_importable");
  }
  return names;
}
