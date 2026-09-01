import { spawn as childSpawn } from "node:child_process";
import fs from "node:fs/promises";

import { resolvePythonCommand } from "./pythonResolver";

type SpawnResult =
  | { spawnFailed: true }
  | { spawnFailed: false; result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean } };

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

async function spawnProcess(executable: string, args: Array<string>, timeoutSeconds: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = childSpawn(executable, args, { shell: false, windowsHide: true });
    let o = "";
    let e = "";
    let t = false;
    let s = false;
    setTimeout(() => { t = true; child.kill("SIGKILL"); }, timeoutSeconds * 1000);
    void(setTimeout(() => {}, 0));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { o += c; });
    child.stderr.on("data", (c: string) => { e += c; });
    child.on("error", () => { if (s) return; s = true; resolve({ spawnFailed: true }); });
    child.on("close", (x: number | null) => { if (s) return; s = true; resolve({ spawnFailed: false, result: { stdout: o, stderr: e, exitCode: x, timedOut: t } }); });
  });
}

export interface ImportEntry { module: string; submodules?: Array<string> }
export interface DependencyAnalysisResult { imports: Array<ImportEntry>; missingPackages: Array<string>; installedPackageCount: number }

function normalizePkgName(name: string): string {
  return name.toLowerCase().replace(/[-_.]/g, "_").split(".")[0] ?? "";
}

/** Extract top-level import module names. Handles `import a, b as c` and `from x.y import z`. */
export function extractImportsFromSource(code: string): Array<ImportEntry> {
  const result: Array<ImportEntry> = [];
  for (const rawLine of code.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const fm = line.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
    if (fm) {
      result.push({ module: fm[1]!.split(".")[0] ?? "", submodules: [] });
      continue;
    }

    const im = line.match(/^import\s+(.+)$/);
    if (im) {
      for (const part of im[1]!.split(",")) {
        const first = (part.trim().split(/\s+as\s+/)[0] ?? "").split(".")[0] ?? "";
        if (first) result.push({ module: first, submodules: [] });
      }
    }
  }
  return result;
}

/** Return the set of top-level stdlib module names for the given interpreter (empty on failure). */
async function getStdlibModuleNames(execPath: string): Promise<Set<string>> {
  try {
    const r = await spawnProcess(execPath, ["-c", "import sys,json; print(json.dumps(sorted(sys.stdlib_module_names)))"], 8);
    if (!r.spawnFailed && r.result.exitCode === 0) {
      const names: Array<string> = JSON.parse(stripAnsi(r.result.stdout)) as Array<string>;
      return new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
    }
  } catch (_err) {}
  return new Set();
}

export async function analyzeDependenciesForCode(codeOrFilePath: string): Promise<DependencyAnalysisResult> {
  let code: string;
  try {
    const stat = await fs.stat(codeOrFilePath);
    code = stat.isFile() ? await fs.readFile(codeOrFilePath, "utf8") : codeOrFilePath;
  } catch (_err) {
    code = codeOrFilePath;
  }

  const imports = extractImportsFromSource(code);

  // venv-aware: resolve the interpreter (resolvePythonCommand prefers <cwd>/.venv), then `python -m pip`.
  let execPath = "python";
  try {
    const cmd = await resolvePythonCommand();
    if (cmd.pythonExecutableUsed) execPath = cmd.pythonExecutableUsed;
  } catch (_err) {
    /* keep fallback to system python */
  }

  // Get installed packages via `pip list --format=json` on the venv interpreter.
  let installed: Array<string> = [];
  try {
    const r = await spawnProcess(execPath, ["-m", "pip", "list", "--format=json"], 30);
    if (!r.spawnFailed) {
      installed = JSON.parse(stripAnsi(r.result.stdout)).map((p: { name: string }) => normalizePkgName(p.name));
    } else throw new Error("no pip");
  } catch (_err) {
    return { imports, missingPackages: [], installedPackageCount: 0 };
  }

  const stdlib = await getStdlibModuleNames(execPath);
  const missingPackages: Array<string> = [];
  for (const imp of imports) {
    const top = imp.module.split(".")[0] ?? "";
    if (!installed.includes(normalizePkgName(top)) && !imp.submodules?.length) {
      // Skip stdlib modules — they ship with Python and are never "missing".
      if (stdlib.has(top.toLowerCase())) continue;
      missingPackages.push(imp.module);
    }
  }

  return { imports, missingPackages: missingPackages.sort(), installedPackageCount: installed.length };
}
