import { resolvePythonCommand, runResolvedPythonCommand } from "./pythonResolver";

export interface PythonPackageInstallRequest {
  packages: string[];
  upgrade: boolean;
  timeoutSeconds: number;
}

export interface PythonPackageInstallResult {
  pythonExecutableUsed: string;
  packages: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  success: boolean;
}

export interface PythonPackageUninstallRequest {
  packages: string[];
  yes: boolean;
  timeoutSeconds: number;
}

export interface PythonPackageUninstallResult {
  pythonExecutableUsed: string;
  packages: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  success: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_PACKAGES = 10;
const MAX_PACKAGE_SPEC_LENGTH = 120;
const DISALLOWED_PACKAGE_SPEC_CHARACTERS = /[;&|`$\r\n\\]/;
const DISALLOWED_UNINSTALL_PACKAGE_SPEC_CHARACTERS = /[;&|`$\r\n\\/]/;

export async function installPythonPackages(
  request: PythonPackageInstallRequest,
): Promise<PythonPackageInstallResult> {
  const packages = validateInstallRequest(request.packages, request.timeoutSeconds);
  const pythonCommand = await resolvePythonCommand();

  const args = ["-m", "pip", "install"];
  if (request.upgrade) {
    args.push("--upgrade");
  }
  args.push(...packages);

  const result = await runResolvedPythonCommand(pythonCommand, args, request.timeoutSeconds);

  return {
    pythonExecutableUsed: pythonCommand.pythonExecutableUsed,
    packages,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    success: !result.timedOut && result.exitCode === 0,
  };
}

export async function uninstallPythonPackages(
  request: PythonPackageUninstallRequest,
): Promise<PythonPackageUninstallResult> {
  const packages = validateUninstallRequest(request.packages, request.timeoutSeconds);
  const pythonCommand = await resolvePythonCommand();

  // pip uninstall is forced to non-interactive mode because LM Studio tools cannot answer prompts.
  const args = ["-m", "pip", "uninstall", "-y", ...packages];
  const result = await runResolvedPythonCommand(pythonCommand, args, request.timeoutSeconds);

  return {
    pythonExecutableUsed: pythonCommand.pythonExecutableUsed,
    packages,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    success: !result.timedOut && result.exitCode === 0,
  };
}

export function validatePackageSpec(spec: string): void {
  validatePackageSpecForPattern(spec, DISALLOWED_PACKAGE_SPEC_CHARACTERS);
}

export function validateUninstallPackageSpec(spec: string): void {
  validatePackageSpecForPattern(spec, DISALLOWED_UNINSTALL_PACKAGE_SPEC_CHARACTERS);
}

function validatePackageSpecForPattern(spec: string, disallowedPattern: RegExp): void {
  const trimmedSpec = spec.trim();

  if (trimmedSpec.length === 0) {
    throw new Error("Package specs must not be blank.");
  }

  if (trimmedSpec.length > MAX_PACKAGE_SPEC_LENGTH) {
    throw new Error(`Package specs must be ${MAX_PACKAGE_SPEC_LENGTH} characters or fewer.`);
  }

  if (trimmedSpec.startsWith("-")) {
    throw new Error("Package specs must not start with `-`.");
  }

  const disallowedCharacter = trimmedSpec.match(disallowedPattern)?.[0];
  if (disallowedCharacter !== undefined) {
    throw new Error(`Package spec contains unsupported character: ${JSON.stringify(disallowedCharacter)}.`);
  }
}

function validateInstallRequest(packages: string[], timeoutSeconds: number): string[] {
  if (packages.length === 0) {
    throw new Error("At least one package spec is required.");
  }

  if (packages.length > MAX_PACKAGES) {
    throw new Error(`No more than ${MAX_PACKAGES} package specs can be installed at once.`);
  }

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < MIN_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be at least ${MIN_TIMEOUT_SECONDS} seconds.`);
  }

  if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be ${MAX_TIMEOUT_SECONDS} seconds or fewer.`);
  }

  return packages.map((spec) => {
    validatePackageSpec(spec);
    return spec.trim();
  });
}

function validateUninstallRequest(packages: string[], timeoutSeconds: number): string[] {
  validateTimeout(timeoutSeconds);

  if (packages.length === 0) {
    throw new Error("At least one package name is required.");
  }

  if (packages.length > MAX_PACKAGES) {
    throw new Error(`No more than ${MAX_PACKAGES} package names can be uninstalled at once.`);
  }

  return packages.map((spec) => {
    validateUninstallPackageSpec(spec);
    return spec.trim();
  });
}

function validateTimeout(timeoutSeconds: number): void {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < MIN_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be at least ${MIN_TIMEOUT_SECONDS} seconds.`);
  }

  if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be ${MAX_TIMEOUT_SECONDS} seconds or fewer.`);
  }
}

export const DEFAULT_INSTALL_TIMEOUT_SECONDS = DEFAULT_TIMEOUT_SECONDS;
export const MAX_INSTALL_TIMEOUT_SECONDS = MAX_TIMEOUT_SECONDS;
