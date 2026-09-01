/* eslint-disable no-console */
/**
 * scripts/smokeNew6Tools.ts — Functional smoke test for the 6 NEW MCP tools.
 * Run from plugin root: ./node_modules/.bin/tsx scripts/smokeNew6Tools.ts
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { pydevSafeRenameTool } from "../src/tools/pydevSafeRenameTool";
import { pydevExtractFunctionTool } from "../src/tools/pydevExtractFunctionTool";
import { pydevAuditDocstringsTool } from "../src/tools/pydevAuditDocstringsTool";
import { pydevGenerateReferenceTool } from "../src/tools/pydevGenerateReferenceTool";
import { pydevMigrationAuditTool } from "../src/tools/pydevMigrationAuditTool";
import { pydevDescribeWorkspaceTool } from "../src/tools/pydevDescribeWorkspaceTool";

const ROOT = process.cwd();
const SMOKE = path.join(ROOT, "smoke");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`PASS  ${name}`); pass += 1; }
  else { console.error(`FAIL  ${name}  -- ${detail}`); fail += 1; }
}

async function call<T extends Record<string, unknown>>(tool: T, args: Record<string, unknown>): Promise<Awaited<T["implementation"] extends (...a: any) => infer R ? R : never>> {
  return (tool as unknown as { implementation: (p?: unknown) => Promise<{ ok: boolean; stdout: string; raw: Record<string, unknown> }> }).implementation(args);
}

async function write(relPath: string, content: string): Promise<void> {
  await mkdir(SMOKE, { recursive: true });
  await writeFile(path.join(ROOT, relPath), content, "utf8");
}
async function read(relPath: string): Promise<string> {
  return readFile(path.join(ROOT, relPath), "utf8");
}

async function main(): Promise<void> {
  // shared sample project ---------------------------------------------------
  await write("smoke/app.py",
    'def legacy_handler(data):\n' +
    '    """Legacy handler docstring."""\n' +
    '    return data.upper()\n\n' +
    'print(legacy_handler("hi"))\n\n' +
    'def build_report(items):\n' +
    '    total = 0\n' +
    '    for it in items:\n' +
    '        total += it\n' +
    '    return total\n',
  );

  // 1. pydev_safe_rename ---------------------------------------------------
  try {
    const r = await call(pydevSafeRenameTool, { oldName: "legacy_handler", newName: "modernHandler" });
    check("pydev_safe_rename ok", r.ok === true, r.error ?? JSON.stringify(r).slice(0, 200));
    const raw = r.raw as Record<string, unknown>;
    check("pydev_safe_rename renamed def line", Array.isArray(raw.renamedLines) && raw.renamedLines.length > 0, JSON.stringify(raw).slice(0, 300));
    check("pydev_safe_rename reports occurrences", (Number(raw.totalOccurrences) || 0) >= 1, JSON.stringify(raw).slice(0, 300));
  } catch (e) { check("pydev_safe_rename", false, (e as Error).message); }

  // 2. pydev_extract_function ----------------------------------------------
  await write("smoke/big.py",
    'def compute(values):\n' +
    '    total = 0\n' +
    '    for v in values:\n' +
    '        total += v * 2\n' +
    '    return total\n',
  );
  try {
    const r = await call({ sourceCode: await read("smoke/big.py"), targetLine: 3, newFunctionName: "double_values" });
    check("pydev_extract_function ok", r.ok === true, r.error ?? JSON.stringify(r).slice(0, 200));
    const raw = r.raw as Record<string, unknown>;
    check("pydev_extract_function produced output", (raw.source !== undefined || raw.extracted !== undefined || r.stdout.length > 0), JSON.stringify(raw).slice(0, 300));
  } catch (e) { check("pydev_extract_function", false, (e as Error).message); }

  // 3. pydev_audit_docstrings ----------------------------------------------
  try {
    const r = await call(pydevAuditDocstringsTool, { targetPath: "smoke" });
    const raw = JSON.stringify(r.raw);
    check("pydev_audit_docstrings ok", r.ok === true, r.error ?? JSON.stringify(r).slice(0, 200));
    check("pydev_audit_docstrings reports per-file coverage", /perFile/.test(raw) && /pct/.test(raw), raw.slice(0, 400));
  } catch (e) { check("pydev_audit_docstrings", false, (e as Error).message); }

  // 4. pydev_generate_reference --------------------------------------------
  try {
    const r = await call(pydevGenerateReferenceTool, { outputPath: "smoke/API.md", targetPath: "smoke" });
    check("pydev_generate_reference ok", r.ok === true, r.error ?? JSON.stringify(r).slice(0, 200));
    const md = await read("smoke/API.md");
    check("pydev_generate_reference wrote API.md", md.includes("#") && (md.includes("legacy_handler") || md.includes("modernHandler") || md.includes("compute")), md.slice(0, 400));
  } catch (e) { check("pydev_generate_reference", false, (e as Error).message); }

  // 5. pydev_migration_audit ----------------------------------------------
  try {
    const r = await call(pydevMigrationAuditTool, { pattern: ["deprecated-imports"] });
    const raw = JSON.stringify(r.raw);
    check("pydev_migration_audit ok", r.ok === true, r.error ?? JSON.stringify(r).slice(0, 200));
    const mRaw = r.raw as Record<string, unknown>;
    check("pydev_migration_audit returns a plan", Array.isArray(mRaw.findings) && (mRaw.summary as Record<string, unknown>).total !== undefined, raw.slice(0, 300));
  } catch (e) { check("pydev_migration_audit", false, (e as Error).message); }

  // 6. pydev_describe_workspace --------------------------------------------
  try {
    const r = await call(pydevDescribeWorkspaceTool, { includeOverview: true });
    const raw = JSON.stringify(r.raw);
    check("pydev_describe_workspace ok", r.ok === true, r.error ?? JSON.stringify(r).slice(0, 200));
    check("pydev_describe_workspace overview present", /overview/i.test(raw) || /app\.py/.test(raw), raw.slice(0, 300));
  } catch (e) { check("pydev_describe_workspace", false, (e as Error).message); }

  console.log(`\n=== SUMMARY: Passed=${pass} Failed=${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("UNHANDLED:", (e as Error).message ?? String(e)); process.exit(2); });
