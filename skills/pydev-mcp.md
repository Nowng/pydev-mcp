# pydev-mcp — LLM Skill Guide (Single Workspace Root)

> **Target Audience:** Gemma 3/4 2B/4B and resource-constrained small LLMs.
> **Execution Principle:** Strict Single-Threaded Execution. One phase → One step → One tool. Stop on error → Fix → Re-verify → Advance.
> **Architecture:** Single Workspace Root — all tools operate directly against the configured workspace root. No project root / effective root concept, *unless a specific project has been initialized via `pydev_create_project_structure`.*

---

## 0. Critical Operational Rules

## 0. Critical Operational Rules

**RULE 1: Real Local Environment Execution**
All operations execute directly on the user's local machine via real Python runtime and `pip`. Never run dangerous or destructive scripts. Always verify before execution.

**RULE 2: Single Workspace Root Isolation**
- All file operations (read, write, search, list) are scoped within the **single workspace root**.
- The `.venv` at `<pluginDir>/Workspace/.venv/` is **shared** by every project scaffolded under `<pluginDir>/Workspace`.
- **[NEW] PROJECT CONTEXT AWARENESS:** When a project is created using `pydev_create_project_structure`, the LLM MUST establish and maintain the context of that new project directory (e.g., if the project name is `myproj`, all subsequent file operations must target paths like `myproj/src/main.py` instead of just `src/main.py`).

**RULE 3: Strict Relative Path Rule & Context Enforcement**
All file paths **MUST** be relative to the **workspace root**. If a project context has been established, the path must include the project directory (e.g., `project_name/path/to/file.py`). Never use absolute paths.

**RULE 4: Safe File Handling (Read Before Write)**
Never edit or overwrite any existing file without first reading its full contents using `pydev_read_text_file`. When editing, set `backup: true` if available.

> **Important note on venv location:** The shared virtual environment is created at `<pluginDir>/Workspace/.venv/` (not at `<workspaceRoot>/.venv`). If you use a custom workspace root via the LM Studio chat settings sidebar, the venv still lives at `<pluginDir>/Workspace/.venv/`. All tools share this one venv regardless of which workspace root you configure.

**RULE 5: Config File Persistence Limitations**
The `.pydev-mcp-config.json` file (created by `scripts/setupVenv.mjs`) persists only the `workspaceRoot` field. It does **NOT** persist a `pythonExecutablePath`. The Python interpreter used is always resolved from `<pluginDir>/Workspace/.venv/bin/python`. If you need to use a different Python interpreter, you must set the `PYDEV_MCP_WORKSPACE` environment variable before running `scripts/setupVenv.mjs`, or manually create a venv at a custom path and configure the plugin accordingly.

---

## 1. Tool Call Protocol & Payload Standard

Every tool call MUST strictly follow this exact JSON structure:

```jsonc
{
  "name": "<tool_name>",
  "input": {
    "<parameter_name>": <parameter_value>
  }
}
```

**Execution Mode Selection:**
- **Synchronous Execution** (`pydev_run_code`, `pydev_run_file`): Use when you need immediate `stdout`, `stderr`, or `exit_code` to decide the next step.
- **Interactive Terminal** (`*_interactive`): Use ONLY when launching long-running processes that require interactive standard user input.

---

## 2. Tool Reference Index (41 Tools Total)

All parameters are required unless marked with `?` (Optional). All file paths are relative to the **workspace root**.

### A. Code Execution (5 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_run_code` | `code: string`, `timeoutSeconds?: number` | Run inline Python string synchronously. Returns `stdout`, `stderr`, `exit_code`. **NOT a sandbox** — runs on local machine. |
| `pydev_run_file` | `filePath: string`, `args?: string[]`, `cwd?: string`, `timeoutSeconds?: number` | Run an existing `.py` file in the background. Returns `stdout`, `stderr`, `exit_code`, `timeoutStatus`. **NOT a sandbox**. ⚠️ `cwd` is **optional**. If omitted, the process runs in the directory containing `filePath`. |
| `pydev_run_code_interactive` | `code: string`, `windowTitle?: string`, `path?: string`, `keepFile?: boolean` | Spawn a visible terminal window, write code to a temp `.py`, run it, keep the terminal open. Returns immediately with no output logs. **NOT a sandbox**. ⚠️ `path` is **optional**. If omitted, the REPL runs in the workspace root. |
| `pydev_run_file_interactive` | `filePath: string`, `args?: string[]`, `cwd?: string`, `windowTitle?: string` | Spawn a visible terminal window running an existing `.py` file. Can pass command-line args (visible as `sys.argv[1:]`). Returns immediately. **NOT a sandbox**. ⚠️ `cwd` is **optional**. If omitted, the process runs in the directory containing `filePath`. |
| `pydev_run_repl` | `cwd?: string`, `timeoutSeconds?: number` | Open a persistent Python REPL session in the terminal for step-by-step interactive execution (a Jupyter-like experience). Runs on the local machine. **NOT a sandbox** — returns immediately. ⚠️ `cwd` is **optional**. If omitted, the REPL runs in the workspace root. **Important:** `cwd` must be a path **relative to the workspace root** (e.g., `
`myproj/src/`), NOT an absolute path like `/home/user/project/myproj/src/`. |


### B. Dependency & Interpreter Management (3 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_install_module` | `packages: string[]`, `upgrade?: boolean`, `timeoutSeconds?: number` | Execute `pip install` into the target active `.venv`. Install 1–10 packages per call. |
| `pydev_uninstall_module` | `packages: string[]`, `timeoutSeconds?: number` | Execute `pip uninstall -y` from the active `.venv`. |
| `pydev_switch_python_version` | `version?: string`, `executablePath?: string`, `listOnly?: boolean` | List system Python installations or switch the active interpreter. Use to set a custom Python path. |

### C. File System Operations (5 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_save_text_file` | `filePath: string`, `content: string`, `overwrite?: boolean`, `createDirectories?: boolean` | Create or overwrite ANY text file (any extension) inside the workspace root. UTF-8 encoded. ⚠️ **`createDirectories` defaults to `true`** — parent directories are automatically created if they don't exist, preventing the "Parent directory does not exist" error on first save. |
| `pydev_read_text_file` | `filePath: string`, `startLine?: number`, `endLine?: number`, `includeLineNumbers?: boolean` | Read ANY text file from the workspace root, optionally with partial range and line numbers. |
| `pydev_list_directory` | `directoryPath?: string`, `recursive?: boolean`, `maxDepth?: number`, `includeHidden?: boolean`, `pattern?: string` | List files and folders inside the workspace root. Supports recursion, depth limit, hidden file toggle, and pattern filter. |
| `pydev_edit_text_file` | `filePath: string`, `find: string`, `replace: string`, `replaceAll?: boolean`, `backup?: boolean` | Literal string search and replace (exact match, NOT regex) on any text file. Optional backup copy. |
| `pydev_edit_text_file_by_line` | `filePath: string`, `operation: "replace"|"insert_before"|"insert_after"|"delete"`, `startLine: number`, `endLine?: number`, `content?: string`, `backup?: boolean` | Direct line-number based modification. Supports replace, insert before/after lines, and delete lines. Optional backup. |

### D. Static Quality & Inspection (6 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_check_for_bugs` | `code: string`, `maxIssues?: number` | Static AST syntax & error check on a code string. **Does not execute** the code. Reports type hints, unused variables, and common errors. |
| `pydev_check_for_bugs_in_file` | `filePath: string`, `maxIssues?: number` | Same static check as above, but for an existing `.py` file (path relative to workspace root). |
| `pydev_run_linter_and_formatter` | `pythonCode: string`, `autoFix?: boolean` | Run Ruff linter/formatter on a **code string**. Returns diagnostics and optionally auto-fixes style issues. |
| `pydev_run_linter_and_formatter_in_file` | `filePath: string`, `autoFix?: boolean` | Run Ruff lint + format on an existing `.py` file (accepts a file path). Returns per-line diagnostics. |
| `pydev_run_tests` | `testFilePath: string`, `timeoutSeconds?: number` | Execute Pytest suite on a test file. Returns `passed`, `failed`, `skipped` counts, an actionable summary listing each failing test with file:line + one-line reason, structured `failures[]` details (assertion message with Expected/Actual, exception type, full traceback), and captured stdout/stderr. On collection/import errors returns a clear reason instead of an opaque 'Exit code: 2'. |
| `pydev_analyze_imports_and_dependencies` | `code: string` | Parse Python imports from source code and check which third-party packages are missing vs installed. Suggests `pip install` commands for missing ones. Skips stdlib modules. |

### E. Project Scaffold (1 Tool)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_create_project_structure` | `projectName: string` | Create a standard Python project scaffold at `<workspaceRoot>/<projectName>/` containing `pyproject.toml`, `README.md`, `src/__init__.py`, and optionally a `<workspaceRoot>/<projectName>/tests/` directory. This does **not** change the workspace root; all projects share the one `.venv` at `<pluginDir>/Workspace/.venv/`. |

### F. Environment & Status (3 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_setup_venv` | `{}` | Initialize the shared `.venv` at `<pluginDir>/Workspace/.venv/`, upgrade pip/setuptools/wheel, and install baseline tooling (`ruff`, `pytest`, `mypy`, `coverage`, `pytest-cov`, `bandit`, `build`). This venv is shared by every project created with `pydev_create_project_structure`. |
| `pydev_get_setup_status` | `{}` | Report the `.venv` status at the resolved workspace root (user-set → persisted default → env var → cwd): `exists`, `pythonPath`, `version`, `usable`. Run this before Python tools to confirm the environment is ready; if `usable == false`, call `pydev_setup_venv`. |
| `pydev_inspect_environment` | `{}` | Inspect active Python executable, version, venv status, installed package count, and key environment variables. Use to confirm runtime state. |

### G. Debugging & Type Checking (3 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_run_with_debugger` | `code?: string`, `filePath?: string`, `args?: string[]`, `cwd?: string`, `timeoutSeconds?: number` | Run Python code or a `.py` file and print a full traceback with per-frame variable inspection. Use when runtime errors occur to inspect local frame variables. |
| `pydev_type_check` | `targetPath: string`, `checker?: string`, `extraArgs?: string[]`, `timeoutSeconds?: number` | Run project-wide static type checking (mypy or pyright) across a directory tree. Returns error/warning/note counts plus a summary. |
| `pydev_create_test_file` | `targetFilePath: string`, `testFilePath?: string`, `style?: "assert"|"raises"`, `includeFixtures?: boolean` | Generate a pytest test-file skeleton at `<projectName>/tests/test_<name>.py` with fixture imports and basic assertion patterns for an existing `.py` file. |

### H. Documentation & Packaging (3 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_generate_requirements_txt` | `outputPath?: string`, `sourceCode?: string` | Write a `requirements.txt` into the workspace from `pip freeze` or from analyzed missing third-party imports. |
| `pydev_build_python_package` | `projectPath: string`, `mode: "build"|"editable"|"both"`, `extraArgs?: string[]`, `timeoutSeconds?: number` | Build Python distribution packages (`sdist` + `wheel` via `python -m build`) and/or perform editable installation (`pip install -e .`). Artifacts go to `<projectPath>/dist/`. |
| `pydev_profile` | `targetPath: string`, `timeoutSeconds?: number`, `topN?: number`, `includeCallTree?: boolean`, `maxCallTreeDepth?: number`, `explainBottlenecks?: boolean` | Run cProfile on a Python project and return a structured summary. Returns top-N functions by total/cumulative time, call counts, flamegraph-style call tree, and optional natural-language explanation of bottlenecks. Use this to find slow functions, expensive imports, or inefficient algorithms. |

### I. Code Discovery & Search (2 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_search_directory` | `searchTerm: string`, `directoryPath?: string`, `useRegex?: boolean`, `includeHidden?: boolean`, `maxResults?: number` | Grep-style content search across a directory tree. Returns file paths and matching line numbers for a substring or regex pattern. Great for locating symbols, subroutines, and usages. |
| `pydev_find_files` | `pattern: string`, `directoryPath?: string`, `includeHidden?: boolean`, `maxResults?: number` | Browse files by filename substring or extension (e.g., `.py`, `*.ts`) across a directory tree. Returns names, paths, and extensions. |

### J. Quality, Security & Coverage (2 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_coverage` | `sourcePath: string`, `testPath: string`, `extraArgs?: string[]`, `timeoutSeconds?: number` | Run pytest with `pytest-cov` to report per-file and project-wide code coverage (total percent, covered/total statements, coverage table). |
| `pydev_scan_security` | `targetPath: string`, `extraArgs?: string[]`, `timeoutSeconds?: number` | Run `bandit` static security analysis over a directory tree. Returns issues grouped by severity (`high`, `medium`, `low`, `info`) plus a sample of findings. |

### K. Utility Tools (2 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_list_tools` | `includeDetails?: boolean` | List all available MCP tool names and descriptions. Call with `includeDetails: true` to get full descriptions. |
| `pydev_get_workspace_root` | `{}` | Return the current **workspace root** (absolute path) — the single top-level directory all tools operate inside. Use at session start to confirm the active environment. |

### L. Refactoring, Documentation, Migration & Context (6 Tools)

| Tool Name | Input Parameters | Primary Purpose |
| --- | --- | --- |
| `pydev_safe_rename` | `oldName: string`, `newName: string`, `targetPath?: string` | Safely rename a function/class/variable across the entire project by updating all call sites via AST rebase — safer than naive string replacement. |
| `pydev_extract_function` | `sourceCode: string`, `targetLine: number`, `newFunctionName?: string` | Extract a selected code block from its parent function into its own definition at a specified line — ideal for decomposing large files. |
| `pydev_audit_docstrings` | `targetPath?: string` | Walk the source tree and generate a report on missing or stale docstrings, providing coverage percentages per file. |
| `pydev_generate_reference` | `outputPath?: string`, `targetPath?: string` | Build and write an external reference summary (e.g. Markdown API docs) directly from type hints and docstrings — no manual drafting required. |
| `pydev_migration_audit` | `pattern: string[]`, `targetPath?: string` | Scan files for deprecated Python patterns, syntax issues or outdated package imports and return an actionable migration plan with suggested replacements. |
| `pydev_describe_workspace` | `includeOverview?: boolean` | Return a high-level overview of the project including file purposes (from README/docstrings), dependency direction, and top imports — instant repo context without reading every line. |


---

## 3. Mandatory Self-Check Protocol (Enhanced)

Run this diagnostic **before** performing any engineering task to confirm the environment and project state.

```jsonc
// Step 1: Confirm workspace root and tool availability
{ "name": "pydev_get_workspace_root", "input": {} }
{ "name": "pydev_list_tools", "input": { "includeDetails": true } }

// Step 2: Verify venv status
{ "name": "pydev_get_setup_status", "input": {} }
// If usable == false, run: { "name": "pydev_setup_venv", "input": {} }

// Step 3: Confirm active Python interpreter
{ "name": "pydev_run_code", "input": { "code": "import sys; print(sys.executable)" } }

// Step 4 & 5: Environment and Dependency Check (Standard)
...

// [NEW] Step 6: Establish Project Context (If applicable)
{ "name": "pydev_get_workspace_root", "input": {} } // Verify root again
```

---

## 4. Software Engineering Lifecycle Pipeline

Execute stages sequentially. **Do not advance to the next stage if the current stage fails.**

```
[Stage 0: Setup]      → [Stage 1: Discovery]    → [Stage 2: Dependency Sync]
     ↓                    ↓                          ↓
[Stage 3: Implementation] → [Stage 4: Static Quality] → [Stage 5: Debug & Type Check]
     ↓                    ↓                          ↓
[Stage 6: Unit Testing] → [Stage 7: Coverage Audit] → [Stage 8: Security Audit]
     ↓                    ↓                          ↓
[Stage 9: Documentation] → [Stage 10: Packaging]
```
### Stage 0: Project Initialization (Enhanced)
1. Initialize environment (`pydev_setup_venv`).
2. Create project scaffold using `pydev_create_project_structure(projectName="<PROJECT_NAME>")`. **[CRITICAL] This action establishes the context for all future file operations.**

---

## 5. Stage Execution Procedures

**Context Enforcement Rule:** All subsequent code creation and modification calls MUST use the full project-relative path, e.g., `myproj/src/app.py`.

1. Always call `pydev_read_text_file` before editing.
2. For full file generation: use **`pydev_save_text_file(filePath="<PROJECT_NAME>/src/main.py", ...)`**.
3. For block modifications: use **`pydev_edit_text_file(filePath="<PROJECT_NAME>/src/app.py", ...)`**.

**Exit Criteria:** Code changes saved cleanly using the correct project-relative path without execution syntax errors.

### Stage 0: Project Initialization

```jsonc
{ "name": "pydev_setup_venv", "input": {} }
{ "name": "pydev_get_setup_status", "input": {} }
// If usable == false, call pydev_setup_venv again until usable == true
```

**Exit Criteria:** `usable == true` and `pythonPath` points to a valid Python executable.

### Stage 1: Code Base Discovery

```jsonc
{ "name": "pydev_list_directory", "input": { "directoryPath": ".", "recursive": true } }
{ "name": "pydev_find_files", "input": { "pattern": "*.py", "directoryPath": "." } }
{ "name": "pydev_search_directory", "input": { "searchTerm": "def ", "directoryPath": ".", "useRegex": false } }
{ "name": "pydev_inspect_environment", "input": {} }
```

**Exit Criteria:** File layout, entry points, and dependency requirements are clearly documented.

### Stage 2: Dependency Synchronization

```jsonc
// Read existing manifest
{ "name": "pydev_read_text_file", "input": { "filePath": "pyproject.toml" } }
// Analyze imports in source files
{ "name": "pydev_analyze_imports_and_dependencies", "input": { "code": "<file_content>" } }
// Install missing packages
{ "name": "pydev_install_module", "input": { "packages": ["<missing_package>"] } }
// Generate requirements.txt
{ "name": "pydev_generate_requirements_txt", "input": { "outputPath": "requirements.txt", "mode": "freeze" } }
```

**Exit Criteria:** Missing dependencies array is empty; `requirements.txt` is up-to-date.

### Stage 3: Code Implementation

1. Always call `pydev_read_text_file` before editing.
2. For full file generation: use `pydev_save_text_file`.
3. For block modifications: use `pydev_edit_text_file` or `pydev_edit_text_file_by_line`.

**Exit Criteria:** Code changes saved cleanly without execution syntax errors.

### Stage 4: Static Quality Analysis

> ⚠️ **CRITICAL WARNING FOR GEMMA LLM:**
> The string-based tools `pydev_run_linter_and_formatter` and `pydev_check_for_bugs` require raw **Python Code Strings**, NOT file paths (read the file first). For direct file-path linting, prefer the `_in_file` variants.

```jsonc
// Step 1: File-based AST Check
{ "name": "pydev_check_for_bugs_in_file", "input": { "filePath": "src/app.py" } }

// Step 2: Lint and Format (Code String Protocol)
{ "name": "pydev_read_text_file", "input": { "filePath": "src/app.py" } }
{ "name": "pydev_run_linter_and_formatter", "input": { "pythonCode": "<file_content>", "autoFix": true } }

// Step 3: Write Auto-Fixed Code Back
{ "name": "pydev_save_text_file", "input": { "filePath": "src/app.py", "content": "<formatted_code>", "overwrite": true } }
```

**Exit Criteria:** Zero AST bug errors; Linter issues resolved or explicitly logged.

### Stage 5: Debugging & Static Type Analysis

```jsonc
// Standard Execution
{ "name": "pydev_run_file", "input": { "filePath": "myproj/src/app.py" } }

// On Failure → Invoke Debugger
{ "name": "pydev_run_with_debugger", "input": { "filePath": "myproj/src/app.py" } }
// Action: Analyze stack frames, inspect variables in innermost frame, repair code, re-verify.

// Project-Wide Type Verification
{ "name": "pydev_type_check", "input": { "targetPath": "src/." } }
```

**Exit Criteria:** Clean runtime execution (exit code 0); Zero mypy/pyright type errors.

### Stage 6: Unit Test Construction & Verification (Crucial Update)
1. Design Test Plan...
2. Generate Test Skeleton & Implement Tests:
```jsonc
// [NEW] Target filePath MUST be inside the project context
{ "name": "pydev_create_test_file", "input": { "targetFilePath": "myproj/src/app.py", "style": "assert" } } 
// Read and Edit using full path
{ "name": "pydev_read_text_file", "input": { "filePath": "myproj/tests/test_app.py" } }
...
```

> **NOTE — Targets with no top-level functions/classes:** `pydev_create_test_file` inspects the target `.py` for top-level `def`/`class` via the stdlib `ast`. If it finds **none** (e.g. a module-level script like `main.py`), it emits a single `test_module_is_importable()` smoke test (`import <module>` + `assert True`) instead of per-function skeletons. This is valid, runnable Python — run it with `pydev_run_tests`. In the tool output this branch shows `functions: []`, `classes: []`, and `generatedTests: ["test_module_is_importable"]`.

**Exit Criteria:** `failed == 0`, `skipped == 0`.

### Stage 7: Code Coverage Audit

```jsonc
{ "name": "pydev_coverage", "input": { "sourcePath": "src", "testPath": "tests" } }
```

**Exit Criteria:** Total line coverage meets project target (Default: `>= 80%`). Add tests for uncovered lines if needed.

### Stage 8: Security Vulnerability Scan

```jsonc
{ "name": "pydev_scan_security", "input": { "targetPath": "." } }
```

**Triage Matrix:**
- `HIGH`: Mandatory fix required prior to proceeding.
- `MEDIUM`: Resolve or document justification in engineering report.
- `LOW / INFO`: Log in maintenance documentation.

### Stage 9: Comprehensive Technical Documentation

Generate two standardized documentation files:

1. **`doc/MAINTENANCE.md`**: Internal architecture guide containing File Structure, Module Responsibilities, Function Inventories, Global Configurations, Dependencies, and Build Flags.
2. **`doc/PROJECT-REPORT.md`**: Concrete execution log featuring raw output quotes from tests, linting, coverage metrics, security scans, and build status.

### Stage 10: Artifact Packaging

```jsonc
{ "name": "pydev_build_python_package", "input": { "projectPath": ".", "mode": "build" } }
```

**Exit Criteria:** Distribution packages successfully generated at `<workspaceRoot>/dist/*.whl` and `<workspaceRoot>/dist/*.tar.gz`.

---

## 6. End-to-End Execution Scenarios

### Scenario A: Greenfield Project Development

### Scenario A: Greenfield Project Development (Revised Workflow)

1. `{ "name": "pydev_setup_venv", "input": {} }`
2. **[NEW] Establish Context:** `{ "name": "pydev_create_project_structure", "input": { "projectName": "myproj" } }`
3. Write source code, **using the full context path**: `pydev_save_text_file("myproj/src/main.py", content="...", overwrite: true)`
4. Sync dependencies (Analyze imports from the new file): `pydev_analyze_imports_and_dependencies(code="...")` → `pydev_install_module(...)` → `pydev_generate_requirements_txt(...)`
5. Quality checks, **using full context path**: `pydev_check_for_bugs_in_file("myproj/src/main.py")` → `pydev_run_linter_and_formatter_in_file("myproj/src/main.py", autoFix: true)`
6. Verification, **using full context path**: `pydev_type_check(targetPath="myproj")` → `pydev_create_test_file(targetFilePath="myproj/src/main.py")` → `pydev_run_tests(...)`

### Scenario B: Refactoring & Architecture Modernization

1. **Discover:** Analyze structure with `pydev_list_directory(directoryPath=".", recursive=true)` and `pydev_search_directory(searchTerm="def ", directoryPath=".")`.
2. **Baseline:** Run `pydev_run_tests(testFilePath="tests/test_app.py")`, `pydev_coverage(sourcePath="src", testPath="tests")`, and `pydev_scan_security(targetPath=".")`. **Ensure tests pass before editing.**
3. **Incremental Refactor:** Apply localized modifications using `pydev_edit_text_file(filePath="src/app.py", find="...", replace="...")`.
4. **Continuous Regression Check:** Run `pydev_run_tests(testFilePath="tests/test_app.py")` immediately after every edit.
5. **Validation:** Verify coverage has not degraded and type checking remains clean.

### Scenario C: Automated Bug Resolution (Hotfix)

1. **Reproduce:** Create a reproduction script at `tests/test_repro_issue.py` confirming the bug.
2. **Diagnose:** Execute `pydev_run_with_debugger(filePath="src/app.py")` to inspect frame variables and root causes.
3. **Repair:** Apply precise code fix using `pydev_edit_text_file(filePath="src/app.py", find="...", replace="...")`.
4. **Validate:** Execute `pydev_run_tests(testFilePath="tests/test_app.py")` to confirm regression resolution.
5. **Document:** Record defect cause and resolution in `doc/PROJECT-REPORT.md`.

### Scenario D: Feature Enhancement Integration

1. Search entry points using `pydev_search_directory(searchTerm="def ", directoryPath=".")`.
2. Ensure baseline suite passes (`pydev_run_tests`).
3. Implement feature & resolve missing packages via `pydev_analyze_imports_and_dependencies` → `pydev_install_module`.
4. Create dedicated tests (`pydev_create_test_file`) and confirm execution.
5. Run coverage and security audits.

### Scenario E: Dependency & Environment Migration

1. Snapshot current setup using `pydev_inspect_environment` and `pydev_generate_requirements_txt(outputPath="requirements.txt", mode="freeze")`.
2. Upgrade dependency via `pydev_install_module(packages=["<new_version>"])` or switch runtime via `pydev_switch_python_version`.
3. Check compatibility via `pydev_analyze_imports_and_dependencies` and `pydev_type_check`.
4. Fix breaking changes, execute full test suite, and regenerate `requirements.txt`.

### Scenario F: Read-Only Codebase Audit

1. Inventory source files via `pydev_find_files(pattern="*.py", directoryPath=".")`.
2. Run non-destructive tools: `pydev_check_for_bugs_in_file`, `pydev_type_check`, `pydev_scan_security`, and `pydev_coverage`.
3. Output findings to `doc/AUDIT-REPORT.md`. **Do not modify source code.**

### Scenario G: Legacy Project Onboarding

1. Initialize environment: `pydev_setup_venv()`.
2. Discover dependencies via `pydev_read_text_file(filePath="pyproject.toml")` or `pydev_analyze_imports_and_dependencies`.
3. Install missing modules iteratively until application entry runs cleanly.
4. Establish baseline tests and construct `doc/MAINTENANCE.md`.

### Scenario H: Performance Optimization & Profiling (New)

1. **Benchmark:** Profile execution runtime using inline timing scripts:
   ```jsonc
   { "name": "pydev_run_code", "input": { "code": "import cProfile, myproj.src.app; cProfile.run('myproj.src.app.main()')" } }
   ```
2. **Isolate:** Identify bottleneck functions from profile output logs.
3. **Optimize:** Apply algorithmic or data structure optimizations via `pydev_edit_text_file`.
4. **Regression Check:** Execute `pydev_run_tests` and re-run benchmark to confirm performance gains without breaking functional behavior.

### Scenario I: CI/CD & Production Release Readiness (New)

1. **Clean Venv Audit:** Re-verify virtual environment in isolated mode: `pydev_setup_venv()`.
2. **Full Pipeline Sweep:** Run `pydev_run_tests`, `pydev_coverage`, `pydev_scan_security`, and `pydev_type_check`.
3. **Lock Dependencies:** Generate production pin file: `pydev_generate_requirements_txt(outputPath="requirements.txt", mode="freeze")`.
4. **Package & Validate Build:** `pydev_build_python_package(projectPath=".", mode="build")`.
5. Confirm distribution artifacts exist in `<workspaceRoot>/dist/`.

---

## 7. Pre-Delivery Verification Checklist

Verify all checks before marking task completed:

- [ ] **Environment:** `pydev_get_setup_status` returns `usable == true`.
- [ ] **Dependencies:** `pydev_analyze_imports_and_dependencies` reports 0 missing packages; `requirements.txt` generated.
- [ ] **Static Quality:** Zero syntax errors via `pydev_check_for_bugs_in_file`; Linter auto-fix applied.
- [ ] **Runtime Debugging:** Zero unhandled exceptions; `pydev_type_check` reports 0 type errors.
- [ ] **Test Suite:** `pydev_run_tests` reports `failed == 0`.
- [ ] **Coverage Audit:** `pydev_coverage` achieves target percentage.
- [ ] **Security Audit:** `pydev_scan_security` reports 0 `HIGH` severity vulnerabilities.
- [ ] **Documentation:** `doc/MAINTENANCE.md` and `doc/PROJECT-REPORT.md` created with actual output data.
- [ ] **Packaging:** Artifacts generated via `pydev_build_python_package` (when required).

---

## 8. Small LLM Anti-Patterns (Strict Rules)

1. **NEVER multi-task within a single turn:** Issue one tool call per response. Wait for the tool output before issuing the next tool call.
2. **NEVER edit without reading:** Calling `pydev_edit_text_file` or `pydev_save_text_file` without first reading the file with `pydev_read_text_file` is strictly prohibited.
3. **NEVER bypass MCP tools:** Do not attempt to invoke system shell `python` or `pip` directly. Use `pydev_*` tools exclusively.
4. **NEVER supply file paths to string-based analysis tools:** `pydev_run_linter_and_formatter`, `pydev_check_for_bugs`, and `pydev_analyze_imports_and_dependencies` expect raw code strings, NOT file paths. When you want to lint/check a file by path instead, use the `_in_file` variants (`pydev_run_linter_and_formatter_in_file` / `pydev_check_for_bugs_in_file`).
5. **NEVER ignore failed tests:** If `pydev_run_tests` indicates failures, you MUST resolve the failure before attempting coverage, security, or build steps.
6. **NEVER hallucinate tool parameters:** If unsure of input signatures, call `pydev_list_tools(includeDetails=true)` to inspect actual schemas.
7. **NEVER assume the workspace root:** Always call `pydev_get_workspace_root` at the start of a task to confirm the active environment before running file/code tools.
8. **NEVER use absolute paths in tool parameters:** All paths must be relative to the workspace root (e.g., `"src/app.py"` not `"/home/user/project/src/app.py"`).

---

## 9. Quick Reference: Tool Selection Guide

| Goal | Recommended Tool(s) |
|------|---------------------|
| Run a quick Python snippet | `pydev_run_code(code="...")` |
| Run an existing script | `pydev_run_file(filePath="src/main.py")` |
| Open a persistent Python REPL (step-by-step, Jupyter-like) | `pydev_run_repl(cwd?, timeoutSeconds?)` |
| Debug a failing script | `pydev_run_with_debugger(filePath="src/main.py")` |
| Install a package | `pydev_install_module(packages=["requests"])` |
| Read a file | `pydev_read_text_file(filePath="README.md")` |
| Write/overwrite a file | `pydev_save_text_file(filePath="new.py", content="...")` |
| Edit an existing file | `pydev_edit_text_file(filePath="src/app.py", find="old", replace="new")` |
| Search for code | `pydev_search_directory(searchTerm="def ", directoryPath="src")` |
| Lint a code string | `pydev_run_linter_and_formatter(pythonCode="...", autoFix=true)` |
| Lint a file | `pydev_run_linter_and_formatter_in_file(filePath="src/app.py", autoFix=true)` |
| Run tests | `pydev_run_tests(testFilePath="tests/test_app.py")` |
| Generate tests | `pydev_create_test_file(targetFilePath="src/app.py")` |
| Check types | `pydev_type_check(targetPath=".")` |
| Build a package | `pydev_build_python_package(projectPath=".", mode="build")` |

---

**End of Guide.**
