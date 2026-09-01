/* eslint-disable no-console */
/**
 * scripts/smokeNewTools.ts — Functional smoke test for the 6 newly added MCP tools.
 * Run from the plugin root with: ./node_modules/.bin/tsx scripts/smokeNewTools.ts
 * It exercises each new tool's implementation against the real .venv and prints PASS/FAIL.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { inspectEnvironmentTool } from "../src/tools/inspectEnvironmentTool";
import { runWithDebuggerTool } from "../src/tools/runWithDebuggerTool";
import { typeCheckProjectTool } from "../src/tools/typeCheckProjectTool";
import { createTestFileTool } from "../src/tools/createTestFileTool";
import { generateRequirementsTxtTool } from "../src/tools/generateRequirementsTxtTool";

const ROOT = process.cwd();
const SMOKE = path.join(ROOT, "smoke");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`PASS  ${name}`);
    pass += 1;
  } else {
    console.error(`FAIL  ${name}  -- ${detail}`);
    fail += 1;
  }
}

async function write(relPath: string, content: string): Promise<void> {
  await mkdir(SMOKE, { recursive: true });
  await writeFile(path.join(ROOT, relPath), content, "utf8");
}

async function main(): Promise<void> {
  // 1. inspect_environment -------------------------------------------------
  try {
    const r = await (inspectEnvironmentTool as unknown as { implementation: (p?: unknown) => Promise<Record<string, unknown>> }).implementation({});
    console.log(`   [inspect_environment] exe="${String(r.pythonExecutable)}" venv=${r.inVirtualEnv} packages=${r.installedPackagesCount}`);
    check("inspect_environment uses venv python", /\/\.venv|\/venv/.test(String(r.pythonExecutable)), String(r.pythonExecutable));
    check("inspect_environment in_virtual_env true", r.inVirtualEnv === true);
    check("inspect_environment installedPackagesCount>0", (Number(r.installedPackagesCount) || 0) > 0, String(r.installedPackagesCount));
  } catch (e) {
    check("pydev_inspect_environment", false, (e as Error).message);
  }

  await write("smoke/argv_demo.py", "import sys\nprint('argv=', sys.argv)\n");
  await write(
    "smoke/sample_lib.py",
    "def add(a, b):\n    return a + b\n\nclass Calculator:\n    def __init__(self):\n        self.v = 0\n",
  );

  // 2. run_with_debugger (success) -----------------------------------------
  try {
    const r = await (runWithDebuggerTool as unknown as {
      implementation: (p: unknown) => Promise<Record<string, unknown>>;
    }).implementation({ code: "x = 1\ny = 2\nprint(x + y)\n" });
    console.log(`   [run_with_debugger success] ok=${r.success} exit=${r.exitCode}`);
    check("run_with_debugger success path", r.success === true && /DEBUG RUN OK/.test(String(r.output)), String(r.output).slice(0, 300));
  } catch (e) {
    check("run_with_debugger success", false, (e as Error).message);
  }

  // run_with_debugger (failure + per-frame locals) -------------------------
  try {
    const r = await (runWithDebuggerTool as unknown as {
      implementation: (p: unknown) => Promise<Record<string, unknown>>;
    }).implementation({ code: "def f():\n    z = 10\n    raise ValueError('boom')\nf()\n" });
    console.log(`   [run_with_debugger failure] ok=${r.success} exit=${r.exitCode}`);
    check("run_with_debugger failure path", r.success === false && /DEBUG RUN FAILED/.test(String(r.output)), String(r.output).slice(0, 300));
    check("run_with_debugger shows frame locals", /z: 10/.test(String(r.output)), String(r.output).slice(0, 400));
  } catch (e) {
    check("run_with_debugger failure", false, (e as Error).message);
  }

  // 3. type_check_project ---------------------------------------------------
  try {
    const r = await (typeCheckProjectTool as unknown as {
      implementation: (p: unknown) => Promise<Record<string, unknown>>;
    }).implementation({ targetPath: "smoke", checker: "mypy" });
    console.log(`   [type_check_project] available=${r.available} summary="${String(r.summary).slice(0, 80)}"`);
    check("type_check_project returns structured result", typeof r.summary === "string" && r.summary.length > 0);
  } catch (e) {
    check("pydev_type_check", false, (e as Error).message);
  }

  // 4. create_test_file -----------------------------------------------------
  try {
    const r = await (createTestFileTool as unknown as {
      implementation: (p: unknown) => Promise<Record<string, unknown>>;
    }).implementation({ targetFilePath: "smoke/sample_lib.py", testFilePath: "smoke/test_sample_lib.py" });
    console.log(`   [create_test_file] generated=${JSON.stringify(r.generatedTests)} -> ${String(r.testFilePath)}`);
    check("create_test_file generates tests", (Array.isArray(r.generatedTests) && r.generatedTests.length > 0), JSON.stringify(r));
    check("create_test_file writes file", String(r.testFilePath).endsWith("test_sample_lib.py"));
  } catch (e) {
    check("pydev_create_test_file", false, (e as Error).message);
  }

  // 5. generate_requirements_txt (imports mode + freeze) -------------------
  try {
    const r = await (generateRequirementsTxtTool as unknown as {
      implementation: (p: unknown) => Promise<Record<string, unknown>>;
    }).implementation({ sourceCode: "import requests\nfrom flask import Flask\n", outputPath: "smoke/reqs_imports.txt" });
    console.log(`   [generate_requirements imports] mode=${r.mode} lines=${r.lineCount} sample=${JSON.stringify(r.sampleLines)}`);
    check("generate_requirements imports mode", r.mode === "imports" && (r.sampleLines as string[]).includes("requests"), JSON.stringify(r));
  } catch (e) {
    check("generate_requirements imports", false, (e as Error).message);
  }

  try {
    const r = await (generateRequirementsTxtTool as unknown as {
      implementation: (p: unknown) => Promise<Record<string, unknown>>;
    }).implementation({ outputPath: "smoke/reqs_freeze.txt" });
    console.log(`   [generate_requirements freeze] mode=${r.mode} lines=${r.lineCount}`);
    check("generate_requirements freeze mode", r.mode === "freeze" && (Number(r.lineCount) || 0) > 0, JSON.stringify(r).slice(0, 200));
  } catch (e) {
    check("generate_requirements freeze", false, (e as Error).message);
  }

  console.log(`\n=== SUMMARY: Passed=${pass} Failed=${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNHANDLED:", (e as Error).message ?? String(e));
  process.exit(2);
});
