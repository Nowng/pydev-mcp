/**
 * scanSecurity.ts — runs `bandit` (a static application security tester) over a project tree and
 * returns a structured summary of issues grouped by severity, plus a sample of individual findings.
 *
 * Compatible with both modern bandit JSON (`results` + `metrics._totals`) and legacy
 * (`_results` + `metadata.severity_counts`). The tool is venv-aware and always returns a
 * structured result rather than throwing.
 */

import { spawnChild } from "./childProcessHelper";
import { getWorkspaceRoot, ensureDirectory } from "./safePaths";
import { resolvePythonCommand } from "./pythonResolver";

export interface ScanSecurityInput {
  /** Directory / file to scan (default: workspace root). */
  targetPath?: string;
  /** Extra bandit arguments appended after `-r <target> -f json`. */
  extraArgs?: string[];
  /** Overall timeout in seconds. Default 300. */
  timeoutSeconds?: number;
}

export interface SecurityIssue {
  file: string;
  line: number;
  severity: string;
  confidence: string;
  code: string;
  text: string;
}

export interface ScanSecurityResult {
  targetPath: string;
  exitCode: number | null;
  timedOut: boolean;
  issueCount: number;
  severityCounts: { high: number; medium: number; low: number; info: number };
  scannedFiles: number;
  issues: SecurityIssue[];
  summary: string;
}

interface BanditResultRow {
  filename?: string;
  line_number?: number;
  test_id?: string;
  issue_severity?: string;
  issue_confidence?: string;
  issue_text?: string;
  description?: string;
}

type Totals = Record<string, number | undefined>;

interface BanditOutput {
  results?: BanditResultRow[];
  _results?: BanditResultRow[]; // legacy bandit schema
  errors?: Array<{ message?: string; locations?: unknown }>;
  metadata?: { scans?: number; severity_counts?: Record<string, number>; notification?: string };
  metrics?: { _totals?: Totals };
}

export async function scanProjectSecurity(input: ScanSecurityInput = {}): Promise<ScanSecurityResult> {
  const targetPath = input.targetPath && input.targetPath.trim().length > 0
    ? await ensureDirectory(input.targetPath)
    : getWorkspaceRoot();

  let pythonExecutableUsed = "python";
  try {
    const cmd = await resolvePythonCommand();
    pythonExecutableUsed = cmd.pythonExecutableUsed || pythonExecutableUsed;
  } catch (_err) {
    // fall back to a bare `python` invocation
  }

  const timeoutSeconds = Math.max(60, input.timeoutSeconds ?? 300);
  const args = ["-m", "bandit", "-r", targetPath, "-f", "json", ...(input.extraArgs ?? [])];

  const outcome = await spawnChild(pythonExecutableUsed, args, timeoutSeconds * 1000, undefined);
  if (outcome.spawnFailed) {
    return buildResult(
      targetPath,
      null,
      false,
      `bandit could not be started. Ensure it is installed: pip install bandit.`,
    );
  }

  const payload = outcome.result;
  const stdout = stripAnsi(payload.stdout).trim();

  let parsed: BanditOutput | undefined;
  if (stdout.length > 0) {
    try {
      parsed = JSON.parse(stdout) as BanditOutput;
    } catch {
      return buildResult(
        targetPath,
        payload.exitCode,
        payload.timedOut,
        `bandit produced unparseable output. Raw tail: ${stdout.slice(-2000)}`,
      );
    }
  }

  // Support both modern (`results`) and legacy (`_results`) schema keys.
  const rows = ((parsed && (parsed.results ?? parsed._results)) as BanditResultRow[] | undefined) ?? [];
  const cleanRows = rows.filter((r): r is BanditResultRow => Boolean(r));

  const severityCounts = mapSeverityCounts(parsed?.metrics?._totals, parsed?.metadata?.severity_counts);
  const scannedFiles = uniqueFileCount(cleanRows, parsed?.metadata?.scans);

  const issues: SecurityIssue[] = cleanRows.slice(0, 50).map((r) => ({
    file: r.filename ?? "",
    line: typeof r.line_number === "number" ? r.line_number : 0,
    severity: (r.issue_severity ?? "").toLowerCase(),
    confidence: (r.issue_confidence ?? "").toLowerCase(),
    code: r.test_id ?? "",
    text: (r.issue_text ?? r.description ?? "").trim(),
  }));

  const totalIssues = cleanRows.length;
  let summary = `Scanned ${scannedFiles} file(s); found ${totalIssues} issue(s) — HIGH=${severityCounts.high}, MEDIUM=${severityCounts.medium}, LOW=${severityCounts.low}, INFO=${severityCounts.info}.`;
  const notification = parsed?.metadata?.notification ?? "";
  if (typeof notification === "string" && notification.trim().length > 0) {
    summary += ` bandit: ${notification.trim()}`;
  }

  return buildResult(targetPath, payload.exitCode, payload.timedOut, summary, {
    severityCounts,
    issues,
    totalIssues,
    scannedFiles,
  });
}

function buildResult(
  targetPath: string,
  exitCode: number | null,
  timedOut: boolean,
  summary: string,
  extra?: { severityCounts?: ScanSecurityResult["severityCounts"]; issues?: SecurityIssue[]; totalIssues?: number; scannedFiles?: number },
): ScanSecurityResult {
  return {
    targetPath,
    exitCode,
    timedOut,
    issueCount: extra?.totalIssues ?? (extra?.issues ? extra.issues.length : 0),
    severityCounts: extra?.severityCounts ?? { high: 0, medium: 0, low: 0, info: 0 },
    scannedFiles: extra?.scannedFiles ?? 0,
    issues: extra?.issues ?? [],
    summary,
  };
}

function toNum(value: number | undefined): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Maps severity counts from the modern `metrics._totals` schema (SEVERITY.HIGH/LOW/MEDIUM) and
 * falls back to legacy `metadata.severity_counts` (HIGH/MEDIUM/LOW/INFO).
 */
function mapSeverityCounts(
  totals: Totals | undefined,
  legacyCounts: Record<string, number> | undefined,
): ScanSecurityResult["severityCounts"] {
  if (totals && ("SEVERITY.HIGH" in totals || "SEVERITY.LOW" in totals)) {
    return {
      high: toNum(totals["SEVERITY.HIGH"]),
      medium: toNum(totals["SEVERITY.MEDIUM"]),
      low: toNum(totals["SEVERITY.LOW"]),
      info: toNum(totals["SEVERITY.UNDEFINED"]) ?? 0,
    };
  }

  const out = { high: 0, medium: 0, low: 0, info: 0 };
  if (!legacyCounts) return out;
  for (const [key, value] of Object.entries(legacyCounts)) {
    switch (key.toUpperCase()) {
      case "HIGH": out.high += typeof value === "number" ? value : 0; break;
      case "MEDIUM": out.medium += typeof value === "number" ? value : 0; break;
      case "LOW": out.low += typeof value === "number" ? value : 0; break;
      case "INFORMATIONAL":
      case "INFO": out.info += typeof value === "number" ? value : 0; break;
      default: break;
    }
  }
  return out;
}

function uniqueFileCount(rows: BanditResultRow[], scans?: number): number {
  if (typeof scans === "number" && Number.isFinite(scans) && scans > 0) {
    return scans;
  }
  const files = new Set<string>();
  for (const r of rows) {
    if (r.filename) files.add(r.filename);
  }
  return files.size;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}
