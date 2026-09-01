![professor_headache](https://github.com/Nowng/pydev-mcp/blob/main/professor_headache.jpg)

# pydev-mcp

`pydev-mcp` gives LM Studio local models tools for trusted local Python work: run code, manage files, install packages, and check / lint / test code on your own machine.

## Security Notice

This plugin executes Python code on the local machine. It is **trusted local execution, not a sandbox.**

Code can read and write files and run operations under your operating-system permissions. `pip install` and `pip uninstall` can run package-maintainer code. Only run code and install packages you trust.

## Requirements

- LM Studio with plugin support.
- A local Python 3 installation (the tools auto-detect it).

## Automatic Venv Setup on Install

When installed from LM Studio Hub, this plugin creates a `.venv` virtual environment inside its default Workspace (`<pluginDir>/Workspace/.venv/`). All MCP tool calls (`pydev_run_code`, `pydev_install_module`, …) run inside that venv, so pip-installed packages stay isolated to the project and system Python is untouched. The venv is **shared by every project** scaffolded under the Workspace, so you only need to set it up once. If no usable `.venv` exists, it falls back to system `python3` / `python`.

**Manual setup:**
- Linux/macOS: run `./setup-venv.sh` (or `npm run setup-venv`). It creates `Workspace/.venv/`, upgrades pip/setuptools/wheel, and installs the dev tools these plugins use (`ruff`, `pytest`, `mypy`, `coverage`, `pytest-cov`, `bandit`, `build`). Idempotent.
- Windows: open a terminal in the plugin's Workspace folder and run `python -m venv .venv`.

**Troubleshooting:** If `pydev_install_module` reports "pip not found", ensure Python 3 is installed, then re-run the setup script to recreate `.venv/`. To force a fresh venv, delete `<pluginDir>/Workspace/.venv/` and run LM Studio again.

## Workspace Configuration (Optional)

In any chat where this plugin is enabled, open the **chat settings sidebar** and set **"Workspace Folder Path"** to a custom directory if you want files and venv operations elsewhere. Leave it empty to use the default — which is `<pluginDir>/Workspace` after first install from LM Studio Hub.

> **How the workspace root affects the venv:** `pydev_setup_venv` and `pydev_get_setup_status` always operate on `<pluginDir>/Workspace/.venv`. If you leave it unset, that is `<pluginDir>/Workspace/.venv`; if you set a custom path, the venv still lives at `<pluginDir>/Workspace/.venv/`. Every project created with `pydev_create_project_structure` shares this one venv.

> **Single Workspace Root Model:** All file operations (read, write, search, list) are scoped within this single workspace root. Paths outside it are blocked for safety.
>
> The workspace root defaults to `<pluginDir>/Workspace` after first install and can be changed via the LM Studio chat settings sidebar.

## Python Interpreters

These tools use the currently selected interpreter. `pydev_run_code` reports `pythonExecutableUsed` so you can see which executable ran the code. Use `pydev_switch_python_version` to list or switch interpreters; you may need to ensure Python is installed and discoverable, then optionally select an explicit path.

> **Note:** The shared `.venv` always lives at `<pluginDir>/Workspace/.venv/` regardless of which workspace root you configure. The Python interpreter used is always resolved from that venv's `bin/python` (or `Scripts/python.exe` on Windows). If you need to use a different interpreter, set the `PYDEV_MCP_WORKSPACE` environment variable before running `scripts/setupVenv.mjs`, or manually create a venv at a custom path.


## Working Directory (`cwd`) Behavior

All tools execute Python with a **single, deterministic working directory** — this resolves the earlier
"ran in `/tmp"` and "inconsistent `cwd`" problems. The rule (implemented once in
`src/utils/safePaths.ts`'s `resolveRunCwd`) is, in order:

1. **Explicit `cwd`** — if a tool accepts `cwd` and you pass one, it is validated (must exist and be a
   directory) and used as-is.
2. **Otherwise, the target file's directory** — when a concrete `.py` target exists (`pydev_run_file`,
   `pydev_run_with_debugger` with `filePath`, …), the working directory is that file's directory.
3. **Otherwise, the workspace root** — for tools without a target file (`pydev_run_code`, `pydev_coverage`,
   `pydev_type_check`, …) execution happens at the **workspace root**, never an arbitrary `process.cwd()`.
   This keeps `from solution import Solution`-style imports resolvable no matter where the plugin launched.

**Coverage path guarantee:** `pydev_coverage` runs pytest from the workspace root and reports file paths
**relative to the workspace root** (e.g. `src/foo.py`, not `/mnt/md0/.../Workspace/src/foo.py`). The
returned `sourcePath` / `testPath` fields are also workspace-relative.

**Error-message guarantee:** When you pass a path where a directory is expected (the common mistake of
passing a file to `sourcePath` / `testPath`), the tool now fails with a message that **names the
parameter**, states it is a **file**, and hints at the correct sibling — e.g.
`testPath must be a directory, but it is a file: <path>. Point this at your tests directory or a test file.`

## Installation

Install `pydev-mcp` from LM Studio Hub, then enable or use the plugin in a chat where tools are available. Exact interface wording may vary between LM Studio versions.

## Tools

41 tools, grouped by task. All file paths are relative to the **workspace root** — the single directory all tools operate inside. Params marked `?` are optional.

### Run code
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_run_code` | Run a short Python string; return output, exit code, timeout, interpreter used | `code`, `timeoutSeconds?` |
| `pydev_run_file` | Run an existing `.py` file in the background | `filePath`, `args?`, `cwd?`, `timeoutSeconds?` |
| `pydev_run_code_interactive` | Write a string to a temp `.py`, open a terminal, keep it open (returns immediately) | `code`, `windowTitle?`, `cwd?`, `keepFile?` |
| `pydev_run_file_interactive` | Open an existing `.py` file in a visible terminal; can pass args | `filePath`, `args?`, `cwd?`, `windowTitle?` |
| `pydev_run_repl` | Open a persistent Python REPL session for step-by-step interactive execution (Jupyter-like) | `cwd?`, `timeoutSeconds?` |

### Packages
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_install_module` | `pip install` into the `.venv` | `packages[]` (1–10), `upgrade?`, `timeoutSeconds?` |
| `pydev_uninstall_module` | `pip uninstall -y` from the `.venv` | `packages[]`, `timeoutSeconds?` |
| `pydev_switch_python_version` | List or switch the interpreter used by these tools | `version?`, `executablePath?`, `listOnly?` |

### Files (relative to workspace root)
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_save_text_file` | Create or overwrite ANY text file (any extension) in the workspace | `filePath`, `content`(UTF-8), `overwrite?`, `createDirectories?` |
| `pydev_read_text_file` | Read ANY text file (optional line range) | `filePath`, `startLine?`, `endLine?`, `includeLineNumbers?` |
| `pydev_list_directory` | List files/folders (recursion / filter) | `directoryPath?`, `recursive?`, `maxDepth?(1–5)`, `includeHidden?`, `pattern?` |
| `pydev_edit_text_file` | Exact string replace (**not** regex) on any text file; optional backup | `filePath`, `find`, `replace`, `replaceAll?`, `backup?` |
| `pydev_edit_text_file_by_line` | Edit any text file by line number: replace / insert / delete | `filePath`, `operation`(replace, insert_before, insert_after, delete), `startLine`, `endLine?`, `content?`, `backup?` |

### Quality checks
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_check_for_bugs` | Static syntax/lint check of a string (**does not run it**) | `code`(≤50000), `maxIssues?`, … |
| `pydev_check_for_bugs_in_file` | Same static check for a file (`filePath`) | `filePath`, `maxIssues?`, … |
| `pydev_run_linter_and_formatter` | `ruff` lint + format; can auto-fix style / type annotations | `pythonCode`(≤50000), `autoFix?` |
| `pydev_run_linter_and_formatter_in_file` | `ruff` lint + format on an existing `.py` file; can auto-fix style / type annotations | `filePath`, `autoFix?` |
| `pydev_run_tests` | Run pytest; return pass/fail/skip counts, an actionable summary listing each failing test with file:line + one-line reason, structured `failures[]` (assertion message with Expected/Actual, exception type, full traceback), and captured stdout/stderr. On collection/import errors returns a clear reason instead of an opaque `Exit code: 2`. | `testFilePath`(required), `timeoutSeconds?` |
| `pydev_analyze_imports_and_dependencies` | Compare imports vs installed packages (skips stdlib); suggests install cmd | `pythonCode`(≤50000) |

### Project scaffold
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_create_project_structure` | Create a new project: `pyproject.toml`, `README.md`, `__init__.py` | `projectName`(≤100) → `<workspaceRoot>/<projectName>/` |

### Development & debugging (4)
| Tool | Purpose | Key params |
|---|---|---|
| `pydev_inspect_environment` | Show Python version, active venv path, installed package count, and key environment variables | none |
| `pydev_run_with_debugger` | Run code or a .py file and print a full traceback with per-frame variable inspection | `code?`, `filePath?`, `args?`, `cwd?`, `timeoutSeconds?` |
| `pydev_type_check` | Project-wide static type check (mypy/pyright); deeper than pydev_check_for_bugs | `targetPath?`, `checker?`, `extraArgs?`, `timeoutSeconds?` |
| `pydev_create_test_file` | Generate a pytest test-file skeleton (fixture imports + assertion patterns) for a .py file | `targetFilePath`, `testFilePath?`, `style?`, `includeFixtures?` |
| `pydev_generate_requirements_txt` | Write requirements.txt from pip freeze or from analyzed missing imports | `outputPath?`, `sourceCode?` |

Tip: use `pydev_inspect_environment` to confirm the active interpreter, `pydev_type_check` for project-wide type checking, and `pydev_run_with_debugger` when you need variable values at each traceback frame.

### Code discovery (2)
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_search_directory` | Grep-style content search across a directory tree: returns file paths and matching line numbers for a substring or regex pattern. Great for locating symbols, subroutines, and usages quickly. | `pattern`, `directoryPath?`, `useRegex?`, `includeHidden?`, `maxResults?` |
| `pydev_find_files` | Browse files by filename substring or extension (e.g. `.py`, `*.ts`) across a directory tree; returns names, paths, and extensions. | `pattern`, `directoryPath?`, `includeHidden?`, `maxResults?` |

Both stay inside the workspace root and skip noise such as `.venv/`, `node_modules/`, and `__pycache__/`. Use `pydev_search_directory` to find *where* code lives; use `pydev_find_files` to list files by name or extension.

### Quality (9 tools)
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_coverage` | Runs pytest with `pytest-cov` to report per-file and project-wide coverage (total %, covered/total statements, coverage table). | `sourcePath?`, `testPath?`, `extraArgs?`, `timeoutSeconds?` |
| `pydev_scan_security` | Runs `bandit` static security analysis over a directory tree; returns issues grouped by severity (high/medium/low/info) plus a sample of findings. | `targetPath?`, `extraArgs?`, `timeoutSeconds?` |
| `pydev_build_python_package` | Builds Python packaging artifacts (sdist + wheel via `python -m build`) and/or editable-installs the project (`pip install -e .`). | `projectPath?`, `mode`(editable, build, both), `extraArgs?`, `timeoutSeconds?` |
| `pydev_check_for_bugs` | Static syntax/lint check of a string (**does not run it**) | `code`(≤50000), `maxIssues?` |
| `pydev_check_for_bugs_in_file` | Same static check for a file (`filePath`) | `filePath`, `maxIssues?` |
| `pydev_run_linter_and_formatter` | `ruff` lint + format; can auto-fix style / type annotations | `pythonCode`(≤50000), `autoFix?` |
| `pydev_run_linter_and_formatter_in_file` | `ruff` lint + format on an existing `.py` file; can auto-fix style / type annotations | `filePath`, `autoFix?` |
| `pydev_analyze_imports_and_dependencies` | Compare imports vs installed packages (skips stdlib); suggests install cmd | `pythonCode`(≤50000) |
| `pydev_profile` | Run cProfile on a Python project to identify performance bottlenecks. Returns top-N functions by total time, call counts, flamegraph-style call tree, and optional natural-language explanation of hotspots. | `targetPath?`, `timeoutSeconds?`, `topN?`, `includeCallTree?`, `maxCallTreeDepth?`, `explainBottlenecks?` |

### Environment (3 tools)
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_setup_venv` | Ensure `.venv` exists at the workspace root (uses system Python, upgrades pip/setuptools/wheel) | none |
| `pydev_get_setup_status` | Report `.venv` status: `exists` / `pythonPath` / `version` / `usable` — good to run first | none |
| `pydev_inspect_environment` | Show Python version, active venv path, installed package count, and key environment variables | none |

### Code discovery (2 tools)
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_search_directory` | Grep-style content search across a directory tree: returns file paths and matching line numbers for a substring or regex pattern. Great for locating symbols, subroutines, and usages quickly. | `pattern`, `directoryPath?`, `useRegex?`, `includeHidden?`, `maxResults?` |
| `pydev_find_files` | Browse files by filename substring or extension (e.g. `.py`, `*.ts`) across a directory tree; returns names, paths, and extensions. | `pattern`, `directoryPath?`, `includeHidden?`, `maxResults?` |

Both stay inside the workspace root and skip noise such as `.venv/`, `node_modules/`, and `__pycache__/`. Use `pydev_search_directory` to find *where* code lives; use `pydev_find_files` to list files by name or extension.

### Meta (2 tools)
| Tool | Purpose | Key params |
| --- | --- | --- |
| `pydev_list_tools` | List all tool names and descriptions (confirms pydev_run_repl is registered) | `includeDetails?` |
| `pydev_get_workspace_root` | Return the current **workspace root** (absolute path) — the single top-level directory all tools operate inside. Use at session start to confirm the active environment. | none |

## Tool Catalog with Examples

All tool paths are relative to the **workspace root**. Params marked `?` are optional. This catalog groups the **41 tools** by task and shows a copy-pasteable usage example for each. For full schemas, call `pydev_list_tools(includeDetails=true)` — it now returns `name`, `group`, `description`, and `example` for every tool.

### Run & execute (`run`) — 5 tools
| Tool | Example |
| --- | --- |
| `pydev_run_code` | `pydev_run_code(code="print(1 + 1)")` |
| `pydev_run_file` | `pydev_run_file(filePath="src/app.py", args=["--flag"])` |
| `pydev_run_code_interactive` | `pydev_run_code_interactive(code="import myproj; myproj.main()")` |
| `pydev_run_file_interactive` | `pydev_run_file_interactive(filePath="src/app.py", args=["serve"])` |
| `pydev_run_repl` | `pydev_run_repl(cwd="myproj")` |

### Package management (`packages`) — 3 tools
| Tool | Example |
| --- | --- |
| `pydev_install_module` | `pydev_install_module(packages=["requests"])` |
| `pydev_uninstall_module` | `pydev_uninstall_module(packages=["requests"])` |
| `pydev_switch_python_version` | `pydev_switch_python_version(listOnly=true)` |

### File operations (`files`) — 5 tools
| Tool | Example |
| --- | --- |
| `pydev_save_text_file` | `pydev_save_text_file(filePath="src/app.py", content="print(1)", overwrite=true)` |
| `pydev_read_text_file` | `pydev_read_text_file(filePath="README.md", startLine=1, endLine=10)` |
| `pydev_list_directory` | `pydev_list_directory(directoryPath="src", recursive=true)` |
| `pydev_edit_text_file` | `pydev_edit_text_file(filePath="src/app.py", find="print(1)", replace="print(2)")` |
| `pydev_edit_text_file_by_line` | `pydev_edit_text_file_by_line(filePath="src/app.py", operation="insert_after", startLine=3, content="x = 1")` |

### Search (`search`) — 2 tools
| Tool | Example |
| --- | --- |
| `pydev_search_directory` | `pydev_search_directory(pattern="def main", directoryPath=".", useRegex=false)` |
| `pydev_find_files` | `pydev_find_files(pattern="*.py", directoryPath=".")` |

### Quality (`quality`) — 9 tools
| Tool | Example |
| --- | --- |
| `pydev_coverage` | `pydev_coverage(sourcePath="src", testPath="tests")` |
| `pydev_scan_security` | `pydev_scan_security(targetPath=".")` |
| `pydev_build_python_package` | `pydev_build_python_package(projectPath="myproj", mode="build")` |
| `pydev_check_for_bugs` | `pydev_check_for_bugs(code="x = 1", maxIssues=10)` |
| `pydev_check_for_bugs_in_file` | `pydev_check_for_bugs_in_file(filePath="src/app.py")` |
| `pydev_run_linter_and_formatter` | `pydev_run_linter_and_formatter(pythonCode="x = 1", autoFix=true)` |
| `pydev_run_linter_and_formatter_in_file` | `pydev_run_linter_and_formatter_in_file(filePath="src/app.py", autoFix=true)` |
| `pydev_analyze_imports_and_dependencies` | `pydev_analyze_imports_and_dependencies(code="import requests")` |
| `pydev_profile` | `pydev_profile(targetPath=".", topN=10, explainBottlenecks=true)` |

### Testing (`testing`) — 2 tools
| Tool | Example |
| --- | --- |
| `pydev_run_tests` | `pydev_run_tests(testFilePath="tests/test_app.py")` |
| `pydev_create_test_file` | `pydev_create_test_file(targetFilePath="src/app.py", style="assert")` |

### Scaffold (`scaffold`) — 2 tools
| Tool | Example |
| --- | --- |
| `pydev_create_project_structure` | `pydev_create_project_structure(projectName="myproj")` |
| `pydev_generate_requirements_txt` | `pydev_generate_requirements_txt(outputPath="requirements.txt")` |

### Environment (`environment`) — 3 tools
| Tool | Example |
| --- | --- |
| `pydev_setup_venv` | `pydev_setup_venv()` |
| `pydev_get_setup_status` | `pydev_get_setup_status()` |
| `pydev_inspect_environment` | `pydev_inspect_environment()` |

### Development & debugging (`dev`) — 2 tools
| Tool | Example |
| --- | --- |
| `pydev_run_with_debugger` | `pydev_run_with_debugger(code="x = 1 / 0")` |
| `pydev_type_check` | `pydev_type_check(targetPath=".")` |

### Meta (`meta`) — 2 tools
| Tool | Example |
| --- | --- |
| `pydev_list_tools` | `pydev_list_tools(includeDetails=true)` |
| `pydev_get_workspace_root` | `pydev_get_workspace_root()` |

> **41 tools across 12 sections.** The **Tools** section above gives each tool's purpose and key params; this catalog focuses on quick, copy-paste examples.


## L. Refactoring, Documentation, Migration & Context (6 Tools)

> Newest tools — AST-based refactoring, docstring auditing, reference generation, migration planning, and instant repo context. All paths are workspace-relative.

### A. Refactoring (2 Tools)
| Tool | Example |
| --- | --- |
| `pydev_safe_rename` | `pydev_safe_rename(oldName="legacy_handler", newName="modernHandler")` |
| `pydev_extract_function` | `pydev_extract_function(sourceCode="def do_work(): ...", targetLine=25)` |

### B. Documentation (2 Tools)
| Tool | Example |
| --- | --- |
| `pydev_audit_docstrings` | `pydev_audit_docstrings(targetPath="src")` |
| `pydev_generate_reference` | `pydev_generate_reference(outputPath=".docs/API.md", targetPath="src")` |

### C. Migration (1 Tool)
| Tool | Example |
| --- | --- |
| `pydev_migration_audit` | `pydev_migration_audit(pattern=["python2-compatible", "deprecated-imports"])` |

### D. Context (1 Tool)
| Tool | Example |
| --- | --- |
| `pydev_describe_workspace` | `pydev_describe_workspace(includeOverview=true)` |

## Python Interpreters

These tools use the currently selected interpreter. `pydev_run_code` reports `pythonExecutableUsed` so you can see which executable ran the code. Use `pydev_switch_python_version` to list or switch interpreters; you may need to ensure Python is installed and discoverable, then optionally select an explicit path.

## Interactive Windows

`pydev_run_code_interactive` and `pydev_run_file_interactive` open a visible terminal window where supported and return immediately. The window stays open so you can read output and errors. Windows desktop sessions are best supported; if no window opens, use the non-interactive tools or check platform support.

`pydev_run_repl` opens a persistent Python REPL session for step-by-step interactive execution (a Jupyter-like experience) and also returns immediately — ideal for debugging and exploratory analysis.

## Usage Guide for the Model

For full usage, exact parameters, examples, and an LLM self-check flow, see **`skills/pydev-mcp.md`**.

## Examples (for the model)

- Run this Python code and show stdout.
- Save this script as `hello.py`.
- Run `hello.py` with these arguments.
- Check this code for syntax errors.
- Install `colorama` for the selected interpreter.

## An example for software engineering processes with pydev-mcp

prompt example:

```
Use the `pydev-mcp` MCP tools to solve the programming task described below.

Follow these steps in order:

1. Create a Python project using the appropriate MCP tool.
   - Derive the project name from the programming question.
2. Verify that the project’s virtual environment (`venv`) is configured and working.
3. Implement the solution in Python.
   - Save the source code under `<project>/src/`.
   - Run linting checks.
   - Debug and fix any issues.
   - Execute the code and verify that the output is correct.
   - Save the final corrected implementation.
4. Create and run tests.
   - Use `<project>/tests/` as the test working directory.
   - Ensure the tests pass.
5. Generate code coverage and security scan report. 
6. Create the following documentation under `<project>/doc/`:
   - An implementation document explaining the solution.
   - A project report summarizing the implementation, validation, coverage, security and test results.

Do not skip any step. Confirm the result of each step before proceeding to the next one.
---

Programming task:
(...)
```

## More prompt examples
### Developing a New Python Project (Greenfield Development)
```
prompt_examples/new_project.txt 
```
### Old Python Program Architecture Analysis & Reporting
```
prompt_examples/source_tree_analysis.txt
```

### Old Python Program Function Rework (Hotfix/Feature)
```
prompt_examples/hotfix_rework.txt
```
### Old Python Program Refactoring (Modernization/Optimization)
```
prompt_examples/refactory.txt
```

### Performance Optimization & Bottleneck Analysis
```
prompt_examples/performance_optimization.txt
```

### Dependency & Version Migration
```
prompt_examples/dependency_version_migration.txt 
```

### Security Hardening & Vulnerability Remediation
```
prompt_examples/security_hardening.txt
```

### Test Coverage Expansion (Technical Debt Reduction)
```
prompt_examples/test_coverage_expansion.txt
```


## Troubleshooting

- Python not found: install Python locally and make sure it is discoverable.
- Wrong interpreter selected: use `pydev_switch_python_version` to list and select the intended interpreter, then check `pythonExecutableUsed`.
- Interactive window does not open: use non-interactive tools or check whether visible terminal windows are supported on your platform.
- Package install fails: confirm the selected interpreter can run pip, the package name is valid, and the machine has the required permissions and network access.
- File path rejected: use a path inside the configured workspace.

## License

This plugin is licensed under the Apache License 2.0.

## For Maintainers

Run these from the plugin root:

    npm install
    npm run typecheck
    npm run build
    lms dev
    lms login
    lms push

`postinstall` runs `scripts/setupVenv.mjs`, which creates `<pluginDir>/Workspace/.venv/` and installs the essential dev tools `ruff`, `pytest`, `mypy`, `coverage`, `pytest-cov`, `bandit`, and `build` (then verifies each is importable). If the venv is missing, run `./setup-venv.sh` to fix it.

> **Config file note:** The `.pydev-mcp-config.json` file created by `scripts/setupVenv.mjs` persists only the `workspaceRoot` field. It does **NOT** persist a `pythonExecutablePath`. The Python interpreter used is always resolved from `<pluginDir>/Workspace/.venv/bin/python`. If you need to use a different interpreter, set the `PYDEV_MCP_WORKSPACE` environment variable before running `scripts/setupVenv.mjs`, or manually create a venv at a custom path.

## Revision

- Fork from soumyajit7038/python-tools
- Add macOS/Linux support
- Add Python venv
- Add workspace folder setting
- Add code quality tools
- Add code security tool
- Add more grep-like search for source tree travel
- Add software engineering guideline in skills/pydev-mcp.md
- Add default workspace root under `<pluginDir>/Workspace`, persisted to `.pydev-mcp-config.json` on install
- Refactor: simplify to single workspace root model 
- Refactor: update all file path resolution to use only workspace root
- Refactor: reduce tool count from 36 → 41
- Add `pydev_run_repl` — a persistent interactive Python REPL tool (Jupyter-like, step-by-step execution) with optional `cwd` and `timeoutSeconds`
- Add `pydev_profile` — run cProfile on a Python project to identify performance bottlenecks, returning top-N functions by total time, call counts, flamegraph-style call tree, and optional natural-language explanation of hotspots
- Refactor: unify working-directory (`cwd`) resolution — every run / debug / coverage tool now executes from one deterministic cwd (explicit `cwd` → target file's directory → workspace root) via `resolveRunCwd`; debug & inline-code targets live under `<workspaceRoot>/.pydev-tmp`, never system `/tmp`
- Refactor: `pydev_coverage` reports workspace-relative paths — the coverage table and `sourcePath` / `testPath` result fields are relative to the workspace root, eliminating opaque absolute paths (e.g. `/mnt/md0/.../Workspace/...`)
- Improve: contextual error messages — `ensureDirectory` / `validateWorkingDirectory` now distinguish "not found" from "is a file", name the offending parameter, and add usage guidance
- Docs: add "Working Directory (`cwd`) Behavior" guarantee section documenting the unified cwd rule, the coverage path guarantee, and the error-message guarantee
- Version bump `2.2.0 → 3.0.0` (major release: breaking tool-name simplification + removal of `pydev_run_file_with_args`)
- Add new features required by LLM.
