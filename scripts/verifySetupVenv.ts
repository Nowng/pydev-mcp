import { setupVenvTool } from "../src/tools/setupVenvTool";
import { probeVenvStatus } from "../src/utils/pythonVenv";
import { getWorkspaceRoot } from "../src/utils/safePaths";
import path from "node:path";
import fs from "node:fs/promises";

let pass = 0;
let fail = 0;
const ok = (n: string, c: boolean, d = ""): void => {
  if (c) { console.log(`PASS  ${n}`); pass += 1; }
  else { console.error(`FAIL  ${n}  -- ${d}`); fail += 1; }
};

async function main(): Promise<void> {
  const root = getWorkspaceRoot();
  const tool = setupVenvTool as unknown as { implementation: (p?: unknown) => Promise<Record<string, unknown>> };

  // Fresh subproject directory to receive its own .venv.
  const proj = "smokeproj";
  const full = path.join(root, proj);
  await fs.rm(full, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(path.join(full, "pkg"), { recursive: true });

  // (a) projectPath -> venv created INSIDE the subproject.
  const r = await tool.implementation({ projectPath: proj });
  console.log("projectPath result:", JSON.stringify(r));
  ok("setup_venv(projectPath) success", r.success === true, JSON.stringify(r));
  ok("venv placed in subproject", typeof r.venvPath === "string" && (r.venvPath as string).includes(path.join(proj, ".venv").replace(/\\/g, "/")), String(r.venvPath));
  const status = await probeVenvStatus(full);
  ok("subproject venv usable", status.usable === true, JSON.stringify(status));

  // (b) default (no param) -> still succeeds; workspace-root venv usable.
  const r2 = await tool.implementation({});
  console.log("default result:", JSON.stringify(r2));
  ok("setup_venv() default success", r2.success === true, JSON.stringify(r2));
  const rootStatus = await probeVenvStatus(root);
  ok("workspace-root venv usable (default target)", rootStatus.usable === true, JSON.stringify(rootStatus));

  // (c) path escaping the workspace is rejected gracefully (no throw).
  const r3 = await tool.implementation({ projectPath: "../../../../../../etc" });
  console.log("escape result:", JSON.stringify(r3));
  ok("rejects path escaping workspace", r3.success === false && /inside the workspace root/.test(String(r3.error ?? "")), JSON.stringify(r3));

  // (d) blank/whitespace projectPath falls back to the workspace root.
  const r4 = await tool.implementation({ projectPath: "   " });
  ok("blank projectPath falls back to root", r4.success === true, JSON.stringify(r4));

  console.log(`\n=== SUMMARY: Passed=${pass} Failed=${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("UNHANDLED:", e); process.exit(2); });
