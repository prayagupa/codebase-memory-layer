#!/usr/bin/env python3
"""
py_chunker.py — reads source file path from argv[1] and file content from
stdin, then prints a JSON array of chunk metadata to stdout.

Each element: { "type": str, "name": str, "start_line": int, "end_line": int }
"""
import ast
import json
import sys


def extract_nodes(source: str) -> list[dict]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []

    nodes: list[dict] = []
    source_lines = source.splitlines()

    # Module-level docstring
    if (
        tree.body
        and isinstance(tree.body[0], ast.Expr)
        and isinstance(tree.body[0].value, ast.Constant)
        and isinstance(tree.body[0].value.value, str)
    ):
        docstring_node = tree.body[0]
        nodes.append(
            {
                "type": "module_docstring",
                "name": "",
                "start_line": docstring_node.lineno,
                "end_line": docstring_node.end_lineno or docstring_node.lineno,
            }
        )

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            nodes.append(
                {
                    "type": "function",
                    "name": node.name,
                    "start_line": node.lineno,
                    "end_line": node.end_lineno or node.lineno,
                }
            )
        elif isinstance(node, ast.ClassDef):
            nodes.append(
                {
                    "type": "class",
                    "name": node.name,
                    "start_line": node.lineno,
                    "end_line": node.end_lineno or node.lineno,
                }
            )

    # Sort by start line so the TypeScript caller gets an ordered array.
    nodes.sort(key=lambda n: n["start_line"])
    return nodes


if __name__ == "__main__":
    content = sys.stdin.read()
    result = extract_nodes(content)
    print(json.dumps(result))
