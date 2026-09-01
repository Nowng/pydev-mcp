/**
 * generateRequirementsUtil.ts — Writes a requirements.txt into the workspace.
 *
 * Two modes (chosen automatically):
 *   - freeze (default): runs `pip freeze` in the venv and writes its output verbatim.
 *   - imports: analyzes the given source's third-party imports and writes the missing packages as requirements.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { resolvePythonCommand } from "./pythonResolver";
import { analyzeDependenciesForCode } from "./pythonDependencyAnalyzer";
import { resolveSafePath } from "./safePaths";

export interface GenerateRequirementsResult {
  outputPath: string;
  mode: "freeze" | "imports";
  lineCount: number;
  contentLength: number;
  /** First several non-empty lines of the written file (for quick LLM visibility). */
  sampleLines: string[];
}

const MAX_SAMPLE_LINES = 15;

/**
 * Generates a requirements.txt for the workspace.
 * When `sourceCode` is provided and non-empty, requirements are derived from its analyzed imports;
 * otherwise `pip freeze` output (from the active venv) is written unchanged.
 */
export async function generateRequirements(
  options: {
    outputPath?: string | undefined;
    sourceCode?: string | undefined;
  } = {},
): Promise<GenerateRequirementsResult> {
  const providedOutputPath = options.outputPath?.trim();
  const outputPathArg = providedOutputPath !== undefined && providedOutputPath.length > 0 ? providedOutputPath : "requirements.txt";
  const resolvedOutputPath = resolveSafePath(outputPathArg.split("\\").join("/"), "outputPath");

  const sourceCode = options.sourceCode;

  let lines: string[];
  let mode: "freeze" | "imports";

  if (sourceCode !== undefined && sourceCode.trim().length > 0) {
    mode = "imports";
    const analysis = await analyzeDependenciesForCode(sourceCode);
    // Derive a minimal, de-duplicated requirement list from missing third-party imports.
    const seen = new Set<string>();
    lines = [];
    for (const mod of analysis.missingPackages) {
      const name = mod.split(".")[0] ?? "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      lines.push(name);
    }
    if (lines.length === 0) {
      lines.push("# No missing third-party imports detected for the provided source.");
    }
  } else {
    mode = "freeze";
    lines = await runPipFreeze();
  }

  const content = joinLines(lines);
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, content, "utf8");

  const sampleLines = lines.slice(0, MAX_SAMPLE_LINES).map((l) => l.trim()).filter((l) => l.length > 0);

  return {
    outputPath: resolvedOutputPath,
    mode,
    lineCount: lines.filter((l) => l.trim().length > 0).length,
    contentLength: content.length,
    sampleLines,
  };
}

function joinLines(lines: string[]): string {
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

/** Runs `python -m pip freeze` in the active venv and returns its output as an array of lines. */
async function runPipFreeze(): Promise<string[]> {
  let execPath = "python";

  try {
    const cmd = await resolvePythonCommand();
    if (cmd.pythonExecutableUsed) {
      execPath = cmd.pythonExecutableUsed;
    }
  } catch (_err) {
    /* keep fallback to system python */
  }

  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("node:child_process");
    const child = spawn(execPath, ["-m", "pip", "freeze"], { shell: false, windowsHide: true });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("close", (exitCode: number | null) => {
      clearTimeout(timer);
      if (exitCode === 0 && !timedOut) {
        resolve(stdout.split("\n"));
      } else {
        // Best-effort: surface the error but still return an empty list rather than throwing.
        resolve([`# pip freeze failed (exit=${String(exitCode)}). Install ruff/pytest and ensure a venv exists.`]);
      }
    });
  });
}
