import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ensureCanonicalPathInsideWorkspace,
  MAX_EDIT_REPLACEMENTS,
  MAX_FILE_READ_BYTES,
  MAX_FILE_WRITE_BYTES,
  resolveTextFilePath,
} from "./safePaths";

export interface SaveTextFileRequest {
  filePath: string;
  content: string;
  overwrite: boolean;
  createDirectories: boolean;
}

export interface SaveTextFileResult {
  saved: true;
  filePath: string;
  bytesWritten: number;
  overwritten: boolean;
}

export interface ReadTextFileRequest {
  filePath: string;
  startLine?: number;
  endLine?: number;
  includeLineNumbers: boolean;
}

export interface ReadTextFileResult {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export interface EditTextFileRequest {
  filePath: string;
  find: string;
  replace: string;
  replaceAll: boolean;
  backup: boolean;
}

export interface EditTextFileResult {
  changed: boolean;
  filePath: string;
  backupPath?: string;
  replacements: number;
  message: string;
}

export type LineEditOperation = "replace" | "insert_before" | "insert_after" | "delete";

export interface EditTextFileByLineRequest {
  filePath: string;
  operation: LineEditOperation;
  startLine: number;
  endLine?: number;
  content?: string;
  backup: boolean;
}

export interface EditTextFileByLineResult {
  changed: boolean;
  filePath: string;
  backupPath?: string;
  operation: LineEditOperation;
  startLine: number;
  endLine: number;
  totalLinesBefore: number;
  totalLinesAfter: number;
  message: string;
}

/**
 * Create or overwrite ANY text file (not only .py) inside the workspace root.
 */
export async function saveTextFile(request: SaveTextFileRequest): Promise<SaveTextFileResult> {
  if (request.content.length > MAX_FILE_WRITE_BYTES) {
    throw new Error(`content must be ${MAX_FILE_WRITE_BYTES} characters or fewer.`);
  }

  const resolvedFilePath = await resolveTextFilePath(request.filePath, { mustExist: false });
  const parentDirectory = path.dirname(resolvedFilePath);
  const parentDirectoryStats = await stat(parentDirectory).catch(() => null);

  if (parentDirectoryStats === null) {
    if (!request.createDirectories) {
      throw new Error("Parent directory does not exist. Set createDirectories=true to create it.");
    }

    await mkdir(parentDirectory, { recursive: true });
    await ensureCanonicalPathInsideWorkspace(parentDirectory, "parent directory");
  } else if (!parentDirectoryStats.isDirectory()) {
    throw new Error(`Parent path is not a directory: ${parentDirectory}`);
  } else {
    const parentLstat = await lstat(parentDirectory).catch(() => null);
    if (parentLstat?.isSymbolicLink()) {
      throw new Error("Symbolic links are not allowed for parent directory.");
    }
    await ensureCanonicalPathInsideWorkspace(parentDirectory, "parent directory");
  }

  const existingFileStats = await stat(resolvedFilePath).catch(() => null);
  if (existingFileStats !== null && !existingFileStats.isFile()) {
    throw new Error(`filePath is not a file: ${resolvedFilePath}`);
  }

  if (existingFileStats !== null) {
    const existingFileLstat = await lstat(resolvedFilePath).catch(() => null);
    if (existingFileLstat?.isSymbolicLink()) {
      throw new Error("Symbolic links are not allowed for filePath.");
    }
  }

  if (existingFileStats !== null && !request.overwrite) {
    throw new Error("File already exists. Set overwrite=true to replace it.");
  }

  await writeFile(resolvedFilePath, request.content, "utf8");

  return {
    saved: true,
    filePath: resolvedFilePath,
    bytesWritten: Buffer.byteLength(request.content, "utf8"),
    overwritten: existingFileStats !== null,
  };
}

/**
 * Read ANY text file (optional line range) from the workspace root.
 */
export async function readTextFile(request: ReadTextFileRequest): Promise<ReadTextFileResult> {
  const resolvedFilePath = await resolveTextFilePath(request.filePath, { mustExist: true });
  const fileStats = await stat(resolvedFilePath);
  const isLineRangeRequest = request.startLine !== undefined || request.endLine !== undefined;

  if (!isLineRangeRequest && fileStats.size > MAX_FILE_READ_BYTES) {
    throw new Error(`File is too large to read at once (${fileStats.size} bytes). Provide startLine/endLine to read a range.`);
  }

  const rawContent = await readFile(resolvedFilePath, "utf8");
  const lines = toLines(rawContent);
  const totalLines = lines.length;

  const { startLine, endLine } = resolveLineRange(request.startLine, request.endLine, totalLines);
  const lineSlice = totalLines === 0 || startLine === 0
    ? []
    : lines.slice(startLine - 1, endLine);

  const renderedContent = request.includeLineNumbers
    ? lineSlice.map((line, index) => `${startLine + index}: ${line}`).join("\n")
    : lineSlice.join("\n");

  return {
    filePath: resolvedFilePath,
    startLine,
    endLine,
    totalLines,
    content: trimOutputIfNeeded(renderedContent, MAX_FILE_READ_BYTES),
  };
}

/**
 * Exact string replacement (NOT regex) on ANY text file, with optional backup.
 */
export async function editTextFile(request: EditTextFileRequest): Promise<EditTextFileResult> {
  if (request.find.length === 0) {
    throw new Error("find must not be empty.");
  }

  const resolvedFilePath = await resolveTextFilePath(request.filePath, { mustExist: true });
  const originalContent = await readFile(resolvedFilePath, "utf8");
  enforceEditableFileSize(originalContent);

  const firstMatchIndex = originalContent.indexOf(request.find);
  if (firstMatchIndex === -1) {
    return {
      changed: false,
      filePath: resolvedFilePath,
      replacements: 0,
      message: "No matching text was found.",
    };
  }

  let replacements = 1;
  let updatedContent = originalContent;

  if (request.replaceAll) {
    replacements = countOccurrences(originalContent, request.find, MAX_EDIT_REPLACEMENTS + 1);
    if (replacements > MAX_EDIT_REPLACEMENTS) {
      throw new Error(`replaceAll would perform more than ${MAX_EDIT_REPLACEMENTS} replacements.`);
    }

    updatedContent = originalContent.split(request.find).join(request.replace);
  } else {
    updatedContent = `${originalContent.slice(0, firstMatchIndex)}${request.replace}${originalContent.slice(firstMatchIndex + request.find.length)}`;
  }

  if (updatedContent === originalContent) {
    return {
      changed: false,
      filePath: resolvedFilePath,
      replacements: 0,
      message: "Edit produced no changes.",
    };
  }

  const backupPath = request.backup ? await writeBackupFile(resolvedFilePath, originalContent) : undefined;
  await writeFile(resolvedFilePath, updatedContent, "utf8");

  return {
    changed: true,
    filePath: resolvedFilePath,
    ...(backupPath !== undefined ? { backupPath } : {}),
    replacements,
    message: replacements === 1 ? "Replaced one occurrence." : `Replaced ${replacements} occurrences.`,
  };
}

/**
 * Edit ANY text file by line number using replace / insert / delete operations.
 */
export async function editTextFileByLine(
  request: EditTextFileByLineRequest,
): Promise<EditTextFileByLineResult> {
  const resolvedFilePath = await resolveTextFilePath(request.filePath, { mustExist: true });
  const originalContent = await readFile(resolvedFilePath, "utf8");
  enforceEditableFileSize(originalContent);

  const lineSeparator = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = originalContent.endsWith("\n");
  const originalLines = toLines(originalContent);
  const totalLinesBefore = originalLines.length;

  const resolvedEndLine = request.endLine ?? request.startLine;
  validateLineEditRequest(request, totalLinesBefore, resolvedEndLine);

  const updatedLines = [...originalLines];
  const replacementLines = request.content === undefined ? [] : toLines(request.content);

  switch (request.operation) {
    case "replace": {
      updatedLines.splice(request.startLine - 1, resolvedEndLine - request.startLine + 1, ...replacementLines);
      break;
    }
    case "insert_before": {
      const insertionIndex = Math.min(request.startLine - 1, updatedLines.length);
      updatedLines.splice(insertionIndex, 0, ...replacementLines);
      break;
    }
    case "insert_after": {
      const insertionIndex = updatedLines.length === 0 ? 0 : Math.min(request.startLine, updatedLines.length);
      updatedLines.splice(insertionIndex, 0, ...replacementLines);
      break;
    }
    case "delete": {
      updatedLines.splice(request.startLine - 1, resolvedEndLine - request.startLine + 1);
      break;
    }
  }

  let updatedContent = updatedLines.join(lineSeparator);
  if (hadFinalNewline && updatedLines.length > 0) {
    updatedContent += lineSeparator;
  }

  if (hadFinalNewline && updatedLines.length === 0) {
    updatedContent = "";
  }

  if (updatedContent === originalContent) {
    return {
      changed: false,
      filePath: resolvedFilePath,
      operation: request.operation,
      startLine: request.startLine,
      endLine: resolvedEndLine,
      totalLinesBefore,
      totalLinesAfter: updatedLines.length,
      message: "Edit produced no changes.",
    };
  }

  const backupPath = request.backup ? await writeBackupFile(resolvedFilePath, originalContent) : undefined;
  await writeFile(resolvedFilePath, updatedContent, "utf8");

  return {
    changed: true,
    filePath: resolvedFilePath,
    ...(backupPath !== undefined ? { backupPath } : {}),
    operation: request.operation,
    startLine: request.startLine,
    endLine: resolvedEndLine,
    totalLinesBefore,
    totalLinesAfter: updatedLines.length,
    message: `Applied ${request.operation} edit.`,
  };
}

function resolveLineRange(startLine: number | undefined, endLine: number | undefined, totalLines: number): {
  startLine: number;
  endLine: number;
} {
  if (startLine === undefined && endLine === undefined) {
    if (totalLines === 0) {
      return { startLine: 0, endLine: 0 };
    }

    return { startLine: 1, endLine: totalLines };
  }

  const resolvedStartLine = startLine ?? 1;
  const resolvedEndLine = endLine ?? totalLines;

  if (!Number.isInteger(resolvedStartLine) || resolvedStartLine < 1) {
    throw new Error("startLine must be an integer greater than or equal to 1.");
  }

  if (!Number.isInteger(resolvedEndLine) || resolvedEndLine < resolvedStartLine) {
    throw new Error("endLine must be an integer greater than or equal to startLine.");
  }

  if (totalLines === 0) {
    throw new Error("File is empty.");
  }

  if (resolvedStartLine > totalLines || resolvedEndLine > totalLines) {
    throw new Error(`Requested range is outside file bounds (1-${totalLines}).`);
  }

  return { startLine: resolvedStartLine, endLine: resolvedEndLine };
}

function toLines(content: string): string[] {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  if (normalizedContent.length === 0) {
    return [];
  }

  const lines = normalizedContent.split("\n");
  if (normalizedContent.endsWith("\n")) {
    lines.pop();
  }

  return lines;
}

function trimOutputIfNeeded(content: string, maxBytes: number): string {
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes <= maxBytes) {
    return content;
  }

  const maximumCharacters = Math.max(1, Math.floor(maxBytes * 0.8));
  return `${content.slice(0, maximumCharacters)}\n... [truncated output]`;
}

function enforceEditableFileSize(content: string): void {
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > MAX_FILE_WRITE_BYTES) {
    throw new Error(`File is too large to edit (${contentBytes} bytes). Maximum supported size is ${MAX_FILE_WRITE_BYTES} bytes.`);
  }
}

async function writeBackupFile(filePath: string, content: string): Promise<string> {
  const backupPath = `${filePath}.bak`;
  await writeFile(backupPath, content, "utf8");
  return backupPath;
}

function countOccurrences(value: string, target: string, maxNeeded: number): number {
  let count = 0;
  let searchFrom = 0;

  while (searchFrom <= value.length) {
    const index = value.indexOf(target, searchFrom);
    if (index === -1) {
      break;
    }

    count += 1;
    if (count >= maxNeeded) {
      return count;
    }

    searchFrom = index + target.length;
  }

  return count;
}

function validateLineEditRequest(
  request: EditTextFileByLineRequest,
  totalLinesBefore: number,
  resolvedEndLine: number,
): void {
  if (!Number.isInteger(request.startLine) || request.startLine < 1) {
    throw new Error("startLine must be an integer greater than or equal to 1.");
  }

  if (!Number.isInteger(resolvedEndLine) || resolvedEndLine < request.startLine) {
    throw new Error("endLine must be an integer greater than or equal to startLine.");
  }

  switch (request.operation) {
    case "replace":
    case "insert_before":
    case "insert_after": {
      if (request.content === undefined) {
        throw new Error(`content is required for ${request.operation}.`);
      }

      if (Buffer.byteLength(request.content, "utf8") > MAX_FILE_WRITE_BYTES) {
        throw new Error(`content must be ${MAX_FILE_WRITE_BYTES} bytes or fewer.`);
      }

      break;
    }
    case "delete":
      break;
  }

  if (request.operation === "replace" || request.operation === "delete") {
    if (totalLinesBefore === 0) {
      throw new Error("File is empty.");
    }

    if (request.startLine > totalLinesBefore || resolvedEndLine > totalLinesBefore) {
      throw new Error(`Line range is outside file bounds (1-${totalLinesBefore}).`);
    }
  }

  if (request.operation === "insert_before") {
    if (request.startLine > totalLinesBefore + 1) {
      throw new Error(`startLine is outside insertable range (1-${totalLinesBefore + 1}).`);
    }
  }

  if (request.operation === "insert_after") {
    if (totalLinesBefore === 0) {
      if (request.startLine !== 1) {
        throw new Error("startLine must be 1 when inserting into an empty file.");
      }
      return;
    }

    if (request.startLine > totalLinesBefore) {
      throw new Error(`startLine is outside insertable range (1-${totalLinesBefore}).`);
    }
  }
}
