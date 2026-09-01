// scripts/verify_testfile_fix.ts — Regression guard for the createTestFile default-path fix.
//
// Verifies that when the LLM OMITS `testFilePath`, pydev_create_test_file() resolves the test file
// into the PROJECT ROOT's tests/ dir (a sibling of src/), NOT the workspace root's tests/.
// When the LLM PROVIDES `testFilePath`, that explicit path is honored unchanged.
//
// Uses tsx so it can import both createTestFile AND getWorkspaceRoot() — so the expected path is
// computed from the ACTUAL resolved workspace root (whatever safePaths resolves to), not a guess.
//
// Run from the plugin root with: ./node_modules/.bin/tsx scripts/verify_testfile_fix.ts

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();

async function main(): Promise<void> {
  const { createTestFile } = await import("../dist/utils/createTestFileUtil.js");
  const { getWorkspaceRoot } = await import("../dist/utils/safePaths.js");

  const WORKSPACE = getWorkspaceRoot(); // real resolved root (from config/env/cwd)
  console.log(`Using resolved workspace root: ${WORKSPACE}`);

  // Independently re-derive the expected project root (src-layout aware).
  function findProjectRoot(resolvedTarget: string): string {
    const immediateParent = path.dirname(resolvedTarget);
    if (path.basename(immediateParent) === "src") {
      return path.dirname(immediateParent);
    }
    return immediateParent;
  }

  const TARGET_REL = "remove_boxes/src/main.py"; // exactly the bug-report argument
  const resolvedTarget = path.join(WORKSPACE, TARGET_REL);

  // Write the target at its RESOLVED location so the ast extractor can read it.
  await mkdir(path.dirname(resolvedTarget), { recursive: true });
  await writeFile(
    resolvedTarget,
    "def main():\n    return 42\n\nclass Widget:\n    pass\n",
    "utf8",
  );

  // 1) BUG SCENARIO: testFilePath omitted -> must land under project root tests/.
  const rDefault = await createTestFile(TARGET_REL, { includeFixtures: true });
  const stem = path.basename(resolvedTarget, path.extname(resolvedTarget));
  const expectedDefault = path.join(findProjectRoot(resolvedTarget), "tests", `test_${stem}.py`);
  console.log(`[default]   got=${rDefault.testFilePath}`);
  console.log(`[default]   exp=${expectedDefault}`);
  const okDefault = rDefault.testFilePath === expectedDefault;
  console.log(`[${okDefault ? "PASS" : "FAIL"}] default path resolves under project root (not workspace root)\n`);

  // 2) EXPLICIT PATH: must be honored unchanged.
  const rExplicit = await createTestFile(TARGET_REL, { testFilePath: "smoke/my_test.py" });
  const okExplicit = rExplicit.testFilePath.endsWith("smoke/my_test.py");
  console.log(`[${okExplicit ? "PASS" : "FAIL"}] explicit testFilePath honored -> ${rExplicit.testFilePath}\n`);

  // Cleanup generated target + test artifacts.
  await writeFile(rDefault.testFilePath, "", "utf8");
  await writeFile(rExplicit.testFilePath, "", "utf8");

  process.exit(okDefault && okExplicit ? 0 : 1);
}

main().catch((e) => {
  console.error("UNHANDLED:", (e as Error).message ?? String(e));
  process.exit(2);
});
