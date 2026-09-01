export interface ToolDefinition {
  name: string;
  description: string;
  /** Logical group used for discoverability (e.g. "run", "files", "quality"). */
  group: string;
  /** A one-line, copy-pasteable usage example of the tool with parameters. */
  example?: string;
}

/** A flattened, list-friendly view of a tool (used by pydev_list_tools). */
export interface ToolListItem {
  name: string;
  group: string;
  description?: string;
  example?: string;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "pydev_run_code",
    description: "Runs short Python code locally and returns stdout, stderr, exit code, timeout status, and selected interpreter. This is not a secure sandbox and is intended only for trusted local use.",
    group: "run",
    example: 'pydev_run_code(code="print(1 + 1)")',
  },
  {
    name: "pydev_run_file",
    description: "Runs an existing Python .py file in the background and returns stdout, stderr, exit code, timeout status, and selected interpreter. This is not a secure sandbox and is intended only for trusted local use.",
    group: "run",
    example: 'pydev_run_file(filePath="src/app.py", args=["--flag"])',
  },
  {
    name: "pydev_run_code_interactive",
    description: "Saves provided Python code to a temporary .py file, opens a visible terminal window, runs it with the selected Python interpreter, keeps the terminal open, and returns immediately. This is not a secure sandbox and is intended only for trusted local use.",
    group: "run",
    example: 'pydev_run_code_interactive(code="import myproj; myproj.main()")',
  },
  {
    name: "pydev_run_file_interactive",
    description: "Opens a visible terminal window, runs an existing workspace Python .py file with the selected Python interpreter and optional args, keeps the terminal open, and returns immediately. This is not a secure sandbox and is intended only for trusted local use.",
    group: "run",
    example: 'pydev_run_file_interactive(filePath="src/app.py", args=["serve"])',
  },
  {
    name: "pydev_run_repl",
    description: "Opens a persistent Python REPL session in the terminal, allowing the LLM to execute commands one at a time and receive immediate output (a Jupyter-like interactive experience). This is not a secure sandbox and is intended only for trusted local use.",
    group: "run",
    example: 'pydev_run_repl(cwd="myproj")',
  },
  {
    name: "pydev_install_module",
    description: "Installs Python packages into the selected Python interpreter using pip install.",
    group: "packages",
    example: 'pydev_install_module(packages=["requests"])',
  },
  {
    name: "pydev_uninstall_module",
    description: "Uninstalls Python packages from the selected Python interpreter using non-interactive pip uninstall -y.",
    group: "packages",
    example: 'pydev_uninstall_module(packages=["requests"])',
  },
  {
    name: "pydev_switch_python_version",
    description: "Lists or switches the Python interpreter used by Python execution and package tools.",
    group: "packages",
    example: 'pydev_switch_python_version(listOnly=true)',
  },
  {
    name: "pydev_save_text_file",
    description: "Creates or overwrites ANY text file (any extension) inside the configured workspace root.",
    group: "files",
    example: 'pydev_save_text_file(filePath="src/app.py", content="print(1)", overwrite=true)',
  },
  {
    name: "pydev_read_text_file",
    description: "Reads ANY text file from the configured workspace root, optionally with line ranges and line numbers.",
    group: "files",
    example: 'pydev_read_text_file(filePath="README.md", startLine=1, endLine=10)',
  },
  {
    name: "pydev_list_directory",
    description: "Lists files and folders inside the configured workspace root with optional recursion and filtering.",
    group: "files",
    example: 'pydev_list_directory(directoryPath="src", recursive=true)',
  },
  {
    name: "pydev_edit_text_file",
    description: "Edits ANY text file by exact string replacement (not regex) with optional backup creation.",
    group: "files",
    example: 'pydev_edit_text_file(filePath="src/app.py", find="print(1)", replace="print(2)")',
  },
  {
    name: "pydev_edit_text_file_by_line",
    description: "Edits ANY text file by line number using replace, insert, or delete operations with optional backup creation.",
    group: "files",
    example: 'pydev_edit_text_file_by_line(filePath="src/app.py", operation="insert_after", startLine=3, content="x = 1")',
  },
  {
    name: "pydev_search_directory",
    description: "Grep-style content search across a directory tree: returns file paths and matching line numbers for a substring or regex pattern. Use it to locate symbols, subroutines, and usages quickly.",
    group: "search",
    example: 'pydev_search_directory(pattern="def main", directoryPath=".", useRegex=false)',
  },
  {
    name: "pydev_find_files",
    description: "Browses files by filename substring or extension (e.g. '.py', '*.ts') across a directory tree, returning names, paths, and extensions.",
    group: "search",
    example: 'pydev_find_files(pattern="*.py", directoryPath=".")',
  },
  {
    name: "pydev_coverage",
    description: "Runs pytest with pytest-cov to report per-file and project-wide code coverage (total percent, covered/total statements, and a coverage table).",
    group: "quality",
    example: 'pydev_coverage(sourcePath="src", testPath="tests")',
  },
  {
    name: "pydev_scan_security",
    description: "Runs bandit static security analysis over a directory tree and returns issues grouped by severity (high/medium/low/info) plus a sample of findings.",
    group: "quality",
    example: 'pydev_scan_security(targetPath=".")',
  },
  {
    name: "pydev_build_python_package",
    description: "Builds Python packaging artifacts (sdist + wheel via python -m build) and/or editable-installs the project (pip install -e .). Supports modes editable, build, or both.",
    group: "quality",
    example: 'pydev_build_python_package(projectPath="myproj", mode="build")',
  },
  {
    name: "pydev_check_for_bugs",
    description: "Checks provided Python source with py_compile, ruff when available, and a fallback AST checker without running the code normally.",
    group: "quality",
    example: 'pydev_check_for_bugs(code="x = 1", maxIssues=10)',
  },
  {
    name: "pydev_check_for_bugs_in_file",
    description: "Checks an existing Python .py file with py_compile, ruff when available, and a fallback AST checker without running the file normally.",
    group: "quality",
    example: 'pydev_check_for_bugs_in_file(filePath="src/app.py")',
  },
  {
    name: "pydev_run_linter_and_formatter",
    description: "Run ruff lint + format on Python code to auto-fix style issues and type annotations.",
    group: "quality",
    example: 'pydev_run_linter_and_formatter(pythonCode="x = 1", autoFix=true)',
  },
  {
    name: "pydev_run_linter_and_formatter_in_file",
    description: "Run ruff lint + format on an existing Python .py file to detect style issues and type annotations, returning per-line diagnostics.",
    group: "quality",
    example: 'pydev_run_linter_and_formatter_in_file(filePath="src/app.py", autoFix=true)',
  },
  {
    name: "pydev_run_tests",
    description: "Run pytest on a test file or module. Returns pass/fail/skip counts, an actionable summary that lists each failing test with its file:line and one-line reason, structured `failures` details (assertion message with Expected/Actual, exception type, full traceback), and captured stdout/stderr. When tests fail, inspect the `failures` array to locate the exact assertion or error and fix the source.",
    group: "testing",
    example: 'pydev_run_tests(testFilePath="tests/test_app.py")',
  },
  {
    name: "pydev_analyze_imports_and_dependencies",
    description: "Parse Python imports from source code and check which packages are missing vs installed. Suggest pip install commands for missing ones.",
    group: "quality",
    example: 'pydev_analyze_imports_and_dependencies(code="import requests")',
  },
  {
    name: "pydev_create_project_structure",
    description: "Create common Python project scaffolding including pyproject.toml, __init__.py file, and README.md with optional test skeleton directory.",
    group: "scaffold",
    example: 'pydev_create_project_structure(projectName="myproj")',
  },
  {
    name: "pydev_setup_venv",
    description: "Ensures a shared Python virtual environment (.venv) exists at the workspace root's .venv directory. Creates it if needed using system Python, then upgrades pip/setuptools/wheel inside. All projects scaffolded by pydev_create_project_structure share this one venv. Returns venv status including path.",
    group: "environment",
    example: 'pydev_setup_venv()',
  },
  {
    name: "pydev_get_setup_status",
    description: "Reports whether a .venv directory with an executable python is present in the workspace folder. Useful for checking setup state before running Python tools that depend on the venv's packages.",
    group: "environment",
    example: 'pydev_get_setup_status()',
  },
  {
    name: "pydev_list_tools",
    description: "Lists the plugin's available tools and descriptions.",
    group: "meta",
    example: 'pydev_list_tools(includeDetails=true)',
  },
  {
    name: "pydev_run_with_debugger",
    description: "Runs Python code or a .py file and prints a full traceback with per-frame variable inspection for debugging.",
    group: "dev",
    example: 'pydev_run_with_debugger(code="x = 1 / 0")',
  },
  {
    name: "pydev_type_check",
    description: "Runs a project-wide static type check (mypy or pyright) across a directory tree and returns error/warning/note counts plus a summary.",
    group: "dev",
    example: 'pydev_type_check(targetPath=".")',
  },
  {
    name: "pydev_inspect_environment",
    description: "Shows the active Python executable, version, venv status, installed package count, and key environment variables to confirm runtime state.",
    group: "environment",
    example: 'pydev_inspect_environment()',
  },
  {
    name: "pydev_create_test_file",
    description: "Generates a pytest test-file skeleton with fixture imports and basic assertion patterns for an existing .py file.",
    group: "testing",
    example: 'pydev_create_test_file(targetFilePath="src/app.py", style="assert")',
  },
  {
    name: "pydev_generate_requirements_txt",
    description: "Writes a requirements.txt into the workspace from pip freeze or analyzed missing third-party imports.",
    group: "scaffold",
    example: 'pydev_generate_requirements_txt(outputPath="requirements.txt")',
  },
  {
    name: "pydev_get_workspace_root",
    description: "Returns the current workspace root — the single, top-level directory that all tools are allowed to operate inside (an absolute path). It resolves from user-set path → persisted default (.pydev-mcp-config.json) → PYDEV_MCP_WORKSPACE env var → process.cwd(). The workspace root defaults to <pluginDir>/Workspace after first install and can be changed via the LM Studio chat settings.",
    group: "meta",
    example: 'pydev_get_workspace_root()',
  },
  {
    name: "pydev_profile",
    description: "Runs cProfile on a Python project and returns a structured JSON summary of performance bottlenecks (top-N functions by cumulative/self time, call counts, flamegraph-style call tree, and natural-language explanations). Returns structured data suitable for LLM consumption rather than raw verbose cProfile output.",
    group: "quality",
    example: 'pydev_profile(targetPath=".", topN=20, includeCallTree=true, explainBottlenecks=true)',
  },


// ────────────────────────────────────────────────────────────────────────────────────────────────
// Refactoring, Documentation & Context Tools (NEW)
// ────────────────────────────────────────────────────────────────────────────────────────────────

  {
    name: "pydev_safe_rename",
    description: "Safely rename a function, class or variable across the entire project by updating all call sites via AST rebase — safer than string replacement.",
    group: "refactoring",
    example: "pydev_safe_rename(oldName=\"legacy_handler\", newName=\"modernHandler\")",
  },
  {
    name: "pydev_extract_function",
    description: "Extract a selected code block from its parent function into its own definition at a specified line — ideal for decomposing large files.",
    group: "refactoring",
    example: "pydev_extract_function(sourceCode=\"def do_work(): ...\", targetLine=25)",
  },
  {
    name: "pydev_audit_docstrings",
    description: "Walk the source tree and generate a report on missing or stale docstrings, providing coverage percentages per file.",
    group: "documentation",
    example: "pydev_audit_docstrings(targetPath=\"src\")",
  },
  {
    name: "pydev_generate_reference",
    description: "Build and write an external reference summary (e.g. in Markdown) directly from the code's type hints and docstrings — no manual drafting required.",
    group: "documentation",
    example: "pydev_generate_reference(outputPath=\".docs/API.md\", targetPath=\"src\")",
  },
  {
    name: "pydev_migration_audit",
    description: "Scan files for deprecated Python patterns, syntax issues or outdated package imports and return an actionable migration plan with suggested replacements.",
    group: "migration",
    example: "pydev_migration_audit(pattern=[\"python2-compatible\", \"deprecated-imports\"])",
  },
  {
    name: "pydev_describe_workspace",
    description: "Returns a high-level overview of the project including file purposes (from README/docstrings), dependency direction, and top imports — instant repo context without reading every line.",
    group: "context",
    example: "pydev_describe_workspace(includeOverview=true)",
  },

];

export function getToolDefinition(toolName: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === toolName);
}

/** Returns a structured, grouped list of all registered tools with optional descriptions/examples. */
export function getToolList(includeDetails = false): ToolListItem[] {
  return TOOL_DEFINITIONS.map((d) => ({
    name: d.name,
    group: d.group,
    ...(includeDetails ? { description: d.description } : {}),
    ...(d.example ? { example: d.example } : {}),
  }));
}

/** Returns the distinct tool groups in registration order. */
export function getToolGroups(): string[] {
  const seen = new Set<string>();
  const groups: string[] = [];
  for (const def of TOOL_DEFINITIONS) {
    if (!seen.has(def.group)) {
      seen.add(def.group);
      groups.push(def.group);
    }
  }
  return groups;
}

/** Returns the total number of registered tools. */
export const TOOLS_COUNT = TOOL_DEFINITIONS.length;
