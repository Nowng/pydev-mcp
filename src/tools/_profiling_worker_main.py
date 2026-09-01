#!/usr/bin/env python3
"""
pydev_profile worker script — standalone cProfile analyzer.

This script is spawned as a child process by the TypeScript tool `pydev_profile`.
It receives command-line arguments and outputs a structured JSON profile summary to stdout.

Usage:
    python _profiling_worker_main.py --target-path <path> [--top-n N] [--max-tree-depth N] [--explain]

Arguments:
    --target-path   Directory to profile (relative to the workspace root).
                    If '.', profiles the entire project.
    --top-n         Number of top functions to include in the summary (default: 20).
    --max-tree-depth Maximum depth of the flamegraph-style call tree (default: 5).
    --explain       Include natural-language explanation of bottlenecks (default: true).

Output: JSON object written to stdout.
"""

import sys
import json
import cProfile
import pstats
import io
import os
import time
import importlib.util


def parse_args(args: list[str]) -> dict:
    """Parse command-line arguments."""
    parsed = {
        "targetPath": ".",
        "topN": 20,
        "maxTreeDepth": 5,
        "explainBottlenecks": True,
    }

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--target-path" and i + 1 < len(args):
            parsed["targetPath"] = args[i + 1]
            i += 2
        elif arg == "--top-n" and i + 1 < len(args):
            parsed["topN"] = int(args[i + 1])
            i += 2
        elif arg == "--max-tree-depth" and i + 1 < len(args):
            parsed["maxTreeDepth"] = int(args[i + 1])
            i += 2
        elif arg == "--explain":
            parsed["explainBottlenecks"] = True
            i += 1
        else:
            i += 1

    return parsed


def normalize_paths(result: dict) -> dict:
    """
    Normalize file paths in the profiling result.
    
    cProfile records absolute paths. If the target path was given as a relative
    path (e.g., "./src/solution.py"), we need to convert the recorded absolute
    paths back to the relative path that was passed by the user.
    
    This avoids returning paths like "/mnt/md0/raid0_home/sensei/Workspace/src"
    when the user requested "./src/solution.py".
    """
    target_path = result.get("targetPath", "")
    if not target_path:
        return result

    # If the recorded path starts with the target path, replace it
    target_path_normalized = os.path.normpath(target_path)
    
    for func in result.get("functions", []):
        filename = func.get("filename", "")
        if filename and target_path_normalized:
            try:
                file_abspath = os.path.normpath(filename)
                if file_abspath.startswith(target_path_normalized):
                    rel_path = os.path.relpath(file_abspath, target_path_normalized)
                    func["filename"] = rel_path
            except (ValueError, OSError):
                pass

    for call_node in result.get("callTree", {}).values():
        filename = call_node.get("filename", "")
        if filename and target_path_normalized:
            try:
                file_abspath = os.path.normpath(filename)
                if file_abspath.startswith(target_path_normalized):
                    rel_path = os.path.relpath(file_abspath, target_path_normalized)
                    call_node["filename"] = rel_path
            except (ValueError, OSError):
                pass

    return result


def get_sorted_stats(stats, sort_key="cumulative", top_n=20):
    """
    Get the top N functions sorted by the given key.
    
    Returns a list of dicts with keys: filename, lineno, name, numcalls, tottime, cumtime.
    
    Handles both old (7-element) and new (5-element) stat tuple formats.
    """
    all_stats = stats.stats  # This is a dict keyed by (filename, lineno, name) tuples
    
    sorted_funcs = sorted(
        all_stats.items(),
        key=lambda x: x[1][2] if len(x[1]) > 2 else 0.0,
        reverse=True
    )[:top_n]
    
    result = []
    for (filename, lineno, funcname), stat_tuple in sorted_funcs:
        # Handle both old format (7 elements) and new format (5 elements)
        if len(stat_tuple) >= 3:
            numcalls = stat_tuple[0]
            tottime = stat_tuple[1]
            cumtime = stat_tuple[2]
        else:
            numcalls, tottime, cumtime = 0, 0, 0
        
        result.append({
            "filename": filename,
            "lineno": lineno,
            "name": funcname,
            "numcalls": int(numcalls) if numcalls is not None else 0,
            "tottime": float(tottime),
            "cumtime": float(cumtime),
        })
    
    return result


def build_call_tree(stats, max_depth=5):
    """
    Build a flamegraph-style call tree from cProfile stats.

    Returns a nested dictionary representing the call hierarchy,
    limited to `max_depth` levels deep.
    """
    # Try using pstats.Stats._dict() if available (Python 3.12+)
    try:
        tree = stats._dict(limit=max_depth)
        return tree
    except (AttributeError, TypeError):
        # Fallback: build from stats.stats dict
        tree = {}
        all_stats = stats.stats
        
        for (filename, lineno, funcname), stat_tuple in all_stats.items():
            key = f"{filename}:{lineno}:{funcname}"
            
            if key not in tree:
                tree[key] = {
                    "name": funcname,
                    "filename": filename,
                    "lineno": lineno,
                    "tottime": float(stat_tuple[1]) if len(stat_tuple) > 1 else 0.0,
                    "cumtime": float(stat_tuple[2]) if len(stat_tuple) > 2 else 0.0,
                    "calls": int(stat_tuple[0]) if len(stat_tuple) > 0 and stat_tuple[0] is not None else 0,
                    "children": {}
                }
        
        return tree


def analyze_bottlenecks(stats, target_path, top_n=20):
    """
    Analyze the cProfile stats and identify bottlenecks.

    Returns a list of bottleneck functions with explanations.
    """
    sorted_funcs = get_sorted_stats(stats, "cumulative", top_n)
    bottlenecks = []

    for entry in sorted_funcs:
        name = entry["name"]
        filename = entry["filename"]
        lineno = entry["lineno"]
        numcalls = entry["numcalls"]
        tottime = entry["tottime"]
        cumtime = entry["cumtime"]

        # Only include functions that spent significant time
        if tottime < 0.001:  # 1ms threshold
            continue

        # Determine the type of bottleneck
        explanation = ""

        if numcalls == 0:
            explanation = f"Function `{name}` took {tottime:.4f}s total (no calls recorded). This may be a module-level import or a top-level function."
        elif tottime / cumtime > 0.95:
            explanation = (
                f"Function `{name}` is the bottleneck — it spends most of its time "
                f"in itself (not in callees). Consider optimizing the function body, using "
                f"Cython/numba, or reducing computational complexity."
            )
        elif numcalls > 0:
            avg_time = tottime / numcalls
            if avg_time > 0.001:  # > 1ms average call time
                explanation = (
                    f"Function `{name}` is called {numcalls} times with an average "
                    f"call time of {avg_time*1000:.2f}ms. Consider caching, memoization, or "
                    f"reducing the work done per call."
                )
            else:
                explanation = (
                    f"Function `{name}` is called frequently ({numcalls} times) with "
                    f"a small average time of {avg_time*1000:.2f}ms. Consider batching calls "
                    f"or reducing call overhead."
                )
        else:
            explanation = (
                f"Function `{name}` has cumulative time of {cumtime:.4f}s but no direct "
                f"calls recorded. This may be a module-level variable or imported function."
            )

        bottlenecks.append({
            "function": name,
            "filename": filename,
            "lineno": lineno,
            "total_time_seconds": round(tottime, 4),
            "cumulative_time_seconds": round(cumtime, 4),
            "call_count": int(numcalls) if numcalls is not None else 0,
            "avg_call_time_ms": round((tottime / numcalls * 1000) if numcalls and numcalls > 0 else 0, 2),
            "explanation": explanation,
        })

    return bottlenecks


def main(args=None):
    """Main entry point — reads args from sys.argv and outputs JSON to stdout."""
    if args is None:
        args = sys.argv[1:]

    parsed_args = parse_args(args)
    target_path = parsed_args["targetPath"]
    top_n = parsed_args["topN"]
    max_tree_depth = parsed_args["maxTreeDepth"]
    explain_bottlenecks = parsed_args["explainBottlenecks"]

    # Resolve the target path relative to the directory where the worker script is located.
    # The child process spawned by Node.js will have cwd set to the workspace root,
    # so we resolve relative paths against the current working directory.
    current_dir = os.getcwd()

    if target_path == ".":
        target_path = current_dir
    elif target_path.startswith("./") or target_path.startswith("../"):
        target_path = os.path.normpath(os.path.join(current_dir, target_path))
    else:
        # Assume it's already an absolute path or a simple relative path
        target_path = os.path.abspath(target_path)

    # Ensure the target path exists and determine what to profile
    if os.path.isfile(target_path) and target_path.endswith(".py"):
        # Single file to profile
        filepath = target_path
    elif os.path.isdir(target_path):
        # Directory to profile — walk all .py files
        filepath = None
    else:
        print(
            json.dumps({
                "success": False,
                "error": f"Target path does not exist or is not a file/directory: {target_path}",
            })
        )
        sys.exit(1)

    # Profile the target directory (or single file if it ends with .py)
    profiler = cProfile.Profile()
    start_time = time.perf_counter()

    with profiler:
        if filepath is not None:
            # Profile a single file by importing and executing it
            spec = importlib.util.spec_from_file_location("__profiled_module__", filepath)
            if spec is None:
                # Fallback: just run a dummy statement
                x = 1 + 1
            else:
                module = importlib.util.module_from_spec(spec)
                sys.modules["__profiled_module__"] = module
                spec.loader.exec_module(module)
        else:
            # Walk the directory and import/run Python files to profile them
            for root, dirs, files in os.walk(target_path):
                dirs[:] = [d for d in dirs if d not in (".venv", "node_modules", "__pycache__", ".git")]
                for filename in files:
                    if filename.endswith(".py") and not filename.startswith("_"):
                        filepath = os.path.join(root, filename)
                        spec = importlib.util.spec_from_file_location(f"__profiled_{filename}", filepath)
                        if spec is not None:
                            module = importlib.util.module_from_spec(spec)
                            sys.modules[f"__profiled_{filename}"] = module
                            spec.loader.exec_module(module)

    end_time = time.perf_counter()
    total_profile_time = end_time - start_time

    end_time = time.perf_counter()
    total_profile_time = end_time - start_time

    # Generate stats
    stats = pstats.Stats(profiler)

    # Build the result
    result = {
        "success": True,
        "targetPath": target_path,
        "profileTimeSeconds": round(total_profile_time, 3),
        "functions": [],
    }

    # Collect top functions by total time (cumulative)
    sorted_funcs = get_sorted_stats(stats, "cumulative", top_n)
    for entry in sorted_funcs:
        result["functions"].append({
            "name": entry["name"],
            "filename": entry["filename"],
            "lineno": entry["lineno"],
            "total_time_seconds": round(entry["tottime"], 4),
            "cumulative_time_seconds": round(entry["cumtime"], 4),
            "call_count": entry["numcalls"],
            "avg_call_time_ms": round((entry["tottime"] / entry["numcalls"] * 1000) if entry["numcalls"] and entry["numcalls"] > 0 else 0, 2),
        })

    # Build flamegraph-style call tree
    if max_tree_depth > 0:
        result["callTree"] = build_call_tree(stats, max_tree_depth)

    # Generate natural-language explanation of bottlenecks
    if explain_bottlenecks:
        bottlenecks = analyze_bottlenecks(stats, target_path, top_n)
        result["bottlenecks"] = bottlenecks

        # Add a summary
        if bottlenecks:
            result["summary"] = (
                f"Profiled {target_path} for {round(total_profile_time, 2)}s. "
                f"Found {len(bottlenecks)} bottleneck functions."
            )
        else:
            result["summary"] = f"Profiled {target_path} for {round(total_profile_time, 2)}s. No significant bottlenecks found."

    # Normalize paths to make them relative to the target path
    result = normalize_paths(result)

    # Output as JSON
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
