"""Conservative static planning for the v1 Python-to-Go subset."""
from __future__ import annotations

import ast
import keyword
import math
import os
from pathlib import Path
from typing import Any

from .models import Plan, PlanError, TaskSpec

PRIMITIVES = {"str": "string", "int": "int64", "float": "float64", "bool": "bool"}


def target_symbol(operation: str) -> str:
    """Encode the full qualified operation, without naming collisions."""
    return "H_" + operation.encode("utf-8").hex()


def _kind(node: ast.expr | None) -> str:
    if isinstance(node, ast.Name) and node.id in PRIMITIVES:
        return node.id
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == "list":
        inner = _kind(node.slice)
        if inner in PRIMITIVES:
            return f"list[{inner}]"
    raise PlanError("Annotations must be str, int, float, bool, or one-dimensional list[T].")


def _go_type(kind: str) -> str:
    if kind.startswith("list["):
        return "[]" + PRIMITIVES[kind[5:-1]]
    return PRIMITIVES[kind]


def _scalar(node: ast.expr) -> bool:
    if isinstance(node, ast.Constant):
        return type(node.value) in (str, int, float, bool)
    return isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)) and isinstance(node.operand, ast.Constant) and type(node.operand.value) in (int, float)


def _docstring(node: ast.stmt) -> bool:
    return isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)


def _imports(module: str, tree: ast.Module, modules: set[str], packages: set[str]) -> set[str]:
    dependencies: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in modules and alias.name not in packages:
                    raise PlanError(f"{module}: external or unresolved import {alias.name}")
                if alias.name in modules:
                    dependencies.add(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if any(alias.name == "*" for alias in node.names):
                raise PlanError(f"{module}: wildcard imports are unsupported")
            if node.level:
                parts = module.split(".")[:-1]
                if node.level > len(parts):
                    raise PlanError(f"{module}: relative import escapes source package")
                base = ".".join(parts[:len(parts) - node.level + 1])
                if node.module:
                    base = base + "." + node.module if base else node.module
            else:
                base = node.module or ""
            if base in modules:
                dependencies.add(base)
            elif base in packages:
                for alias in node.names:
                    child = f"{base}.{alias.name}" if base else alias.name
                    if child not in modules and child not in packages:
                        raise PlanError(f"{module}: unresolved package import {child}")
                    if child in modules:
                        dependencies.add(child)
            else:
                raise PlanError(f"{module}: external or unresolved import {base}")
    return dependencies


def _groups(graph: dict[str, set[str]]) -> list[list[str]]:
    # Tarjan SCCs followed by stable, prerequisite-first condensation ordering.
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    stack: list[str] = []
    active: set[str] = set()
    groups: list[list[str]] = []

    def visit(module: str) -> None:
        index[module] = low[module] = len(index)
        stack.append(module)
        active.add(module)
        for dep in sorted(graph[module]):
            if dep not in index:
                visit(dep)
                low[module] = min(low[module], low[dep])
            elif dep in active:
                low[module] = min(low[module], index[dep])
        if low[module] == index[module]:
            group: list[str] = []
            while True:
                item = stack.pop()
                active.remove(item)
                group.append(item)
                if item == module:
                    break
            groups.append(sorted(group))

    for module in sorted(graph):
        if module not in index:
            visit(module)
    ordered: list[list[str]] = []
    resolved: set[str] = set()
    while groups:
        ready = sorted((g for g in groups if all(d in resolved or d in g for m in g for d in graph[m])), key=lambda g: tuple(g))
        for group in ready:
            ordered.append(group)
            resolved.update(group)
            groups.remove(group)
    return ordered


def analyze(source_root: Path) -> Plan:
    if source_root.is_symlink():
        raise PlanError(f"Source root symlinks are unsupported: {source_root}")
    source_root = source_root.resolve()
    if not source_root.is_dir():
        raise PlanError(f"Source directory does not exist: {source_root}")
    # Reject symlink directories explicitly rather than silently omitting a subtree.
    for directory, subdirs, filenames in os.walk(source_root, followlinks=False):
        for name in subdirs + filenames:
            candidate = Path(directory) / name
            if candidate.is_symlink():
                raise PlanError(f"Source symlinks are unsupported: {candidate}")
    source_files: dict[str, str] = {}
    trees: dict[str, ast.Module] = {}
    paths: dict[str, str] = {}
    packages: set[str] = set()
    for path in sorted(source_root.rglob("*.py")):
        if path.is_symlink():
            raise PlanError(f"Source symlinks are unsupported: {path}")
        relative = path.relative_to(source_root).as_posix()
        parts = Path(relative).with_suffix("").parts
        if not all(part.isidentifier() and not keyword.iskeyword(part) for part in parts):
            raise PlanError(f"Invalid Python module path: {relative}")
        try:
            text = path.read_text(encoding="utf-8")
            tree = ast.parse(text, filename=relative)
        except (UnicodeError, SyntaxError) as exc:
            raise PlanError(f"Cannot parse {relative}: {exc}") from exc
        source_files[relative] = text
        if path.name == "__init__.py":
            if any(not _docstring(node) for node in tree.body):
                raise PlanError(f"{relative}: package initializers must be empty or docstring-only")
            packages.add(".".join(parts[:-1]))
            continue
        module = ".".join(parts)
        trees[module] = tree
        paths[module] = relative
        # Namespace packages are valid static import containers too.
        for length in range(1, len(parts)):
            packages.add(".".join(parts[:length]))
    if not trees:
        raise PlanError("Source must contain at least one non-initializer Python module")
    contracts: dict[str, dict[str, Any]] = {}
    targets: dict[str, str] = {}
    for module, tree in trees.items():
        target = "target/" + module.replace(".", "__") + ".go"
        if target in targets.values() or target in {"target/main.go", "target/go.mod"}:
            raise PlanError(f"Target filename collision: {target}")
        targets[module] = target
        names: set[str] = set()
        constants: set[str] = set()
        for node in tree.body:
            if _docstring(node) or isinstance(node, (ast.Import, ast.ImportFrom)):
                continue
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                lhs = node.targets if isinstance(node, ast.Assign) else [node.target]
                if len(lhs) != 1 or not isinstance(lhs[0], ast.Name) or node.value is None or not _scalar(node.value):
                    raise PlanError(f"{module}: only scalar constant assignments are supported")
                name = lhs[0].id
                if name.startswith("__") and name.endswith("__"):
                    raise PlanError(f"{module}: special module binding {name} is unsupported")
                if name in names:
                    raise PlanError(f"{module}: repeated definition {name}")
                names.add(name)
                constants.add(name)
                if isinstance(node, ast.AnnAssign):
                    _kind(node.annotation)
                value = ast.literal_eval(node.value)
                if type(value) is float and not math.isfinite(value):
                    raise PlanError(f"{module}: floating constants must be finite")
                if type(value) is int and not -(2**63) <= value <= 2**63 - 1:
                    raise PlanError(f"{module}: constant is outside Go int64 bounds")
                continue
            if not isinstance(node, ast.FunctionDef):
                raise PlanError(f"{module}: unsupported top-level {type(node).__name__}; import-time effects are forbidden")
            if (node.name.startswith("__") and node.name.endswith("__")) or node.name in names or node.decorator_list or node.args.defaults or node.args.kw_defaults or node.args.kwonlyargs or node.args.vararg or node.args.kwarg or node.args.posonlyargs or getattr(node, "type_params", []):
                raise PlanError(f"{module}.{node.name}: duplicate/decorated/generic/default/variadic functions are unsupported")
            names.add(node.name)
            int64_min_operands = {
                id(item.operand) for item in ast.walk(node)
                if isinstance(item, ast.UnaryOp) and isinstance(item.op, ast.USub)
                and isinstance(item.operand, ast.Constant) and type(item.operand.value) is int
                and item.operand.value == 2**63
            }
            for child in ast.walk(node):
                if child is node:
                    continue
                if isinstance(child, ast.Constant):
                    if type(child.value) is float and not math.isfinite(child.value):
                        raise PlanError(f"{module}.{node.name}: floating constants must be finite")
                    if type(child.value) is int and id(child) not in int64_min_operands and not -(2**63) <= child.value <= 2**63 - 1:
                        raise PlanError(f"{module}.{node.name}: integer literal is outside Go int64 bounds")
                if isinstance(child, ast.Name) and child.id.startswith("__") and child.id.endswith("__"):
                    raise PlanError(f"{module}.{node.name}: runtime introspection {child.id} is unsupported")
                if isinstance(child, ast.Attribute) and child.attr.startswith("__") and child.attr.endswith("__"):
                    raise PlanError(f"{module}.{node.name}: runtime introspection {child.attr} is unsupported")
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda, ast.Import, ast.ImportFrom, ast.Global, ast.Nonlocal, ast.Yield, ast.YieldFrom, ast.Await)):
                    raise PlanError(f"{module}.{node.name}: unsupported dynamic or nested construct {type(child).__name__}")
                if isinstance(child, ast.Call) and isinstance(child.func, ast.Name) and child.func.id in {"eval", "exec", "__import__", "globals", "locals", "getattr", "setattr", "open", "compile", "print", "input"}:
                    raise PlanError(f"{module}.{node.name}: dynamic/runtime effect {child.func.id} is unsupported")
            operation = f"{module}.{node.name}"
            contracts[operation] = {
                "source_module": module, "source_name": node.name,
                "target_name": target_symbol(operation),
                "params": [{"name": arg.arg, "kind": _kind(arg.annotation)} for arg in node.args.args],
                "returns": _kind(node.returns), "source_path": paths[module],
                "target_path": target, "task_id": "",
            }
        # Enforce immutable module constants (including mutations from function bodies).
        for node in tree.body:
            if isinstance(node, ast.FunctionDef):
                for child in ast.walk(node):
                    if isinstance(child, ast.Name) and isinstance(child.ctx, (ast.Store, ast.Del)) and child.id in constants:
                        raise PlanError(f"{module}: constant {child.id} is assigned within a function")
    graph = {module: _imports(module, tree, set(trees), packages) for module, tree in trees.items()}
    groups = _groups(graph)
    ids = {module: f"task_{number:03d}" for number, group in enumerate(groups, 1) for module in group}
    tasks: list[TaskSpec] = []
    for group in groups:
        task_id = ids[group[0]]
        functions = []
        for operation, contract in contracts.items():
            if contract["source_module"] in group:
                contract["task_id"] = task_id
                functions.append(contract)
        tasks.append(TaskSpec(id=task_id, source_paths=[paths[m] for m in group], target_paths=[targets[m] for m in group], depends_on=sorted({ids[d] for m in group for d in graph[m] if d not in group}), functions=functions))
    plan = Plan(str(source_root), source_files, tasks, contracts, diagnostics=[{
        "kind": "supported_domain", "message": "Integers and integer intermediate results must fit signed Go int64 [-9223372036854775808, 9223372036854775807]; floats must be finite. Unicode strings; list[T] is one-dimensional. Dynamic imports and import-time effects are unsupported.",
    }])
    plan.validate()
    return plan


def scaffold(plan: Plan) -> dict[str, str]:
    plan.validate()
    files = {"target/go.mod": "module hensei.local/migration\n\ngo 1.20\n"}
    for task in plan.tasks:
        for path in task.target_paths:
            functions = [c for c in plan.contracts.values() if c["target_path"] == path]
            lines = ["package main", ""]
            for contract in functions:
                params = ", ".join(f"arg{i} {_go_type(p['kind'])}" for i, p in enumerate(contract["params"]))
                lines.extend([f"func {contract['target_name']}({params}) {_go_type(contract['returns'])} {{", f'    panic("HENSEI_UNIMPLEMENTED:{contract["source_module"]}.{contract["source_name"]}")', "}", ""])
            files[path] = "\n".join(lines)
    cases: list[str] = []
    for operation, c in sorted(plan.contracts.items()):
        cases.extend([f'    case "{operation}":', f'        if len(req.Args) != {len(c["params"])} {{ return map[string]any{{"error": "runtime_error"}} }}'])
        for i, param in enumerate(c["params"]):
            cases.extend([f"        var arg{i} {_go_type(param['kind'])}", f'        if string(req.Args[{i}]) == "null" {{ return map[string]any{{"error": "runtime_error"}} }}', f'        if err := json.Unmarshal(req.Args[{i}], &arg{i}); err != nil {{ return map[string]any{{"error": "runtime_error"}} }}'])
        args = ", ".join(f"arg{i}" for i in range(len(c["params"])))
        cases.append(f'        return map[string]any{{"value": {c["target_name"]}({args})}}')
    files["target/main.go"] = '''package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "os"
)

type request struct {
    Operation string `json:"operation"`
    Args []json.RawMessage `json:"args"`
}

func dispatch(req request) (out map[string]any) {
    defer func() {
        if recover() != nil { out = map[string]any{"error": "runtime_error"} }
    }()
    switch req.Operation {
''' + "\n".join(cases) + '''
    default:
        return map[string]any{"error": "runtime_error"}
    }
}

func main() {
    scanner := bufio.NewScanner(os.Stdin)
    scanner.Buffer(make([]byte, 4096), 4 * 1024 * 1024)
    for scanner.Scan() {
        var req request
        out := map[string]any{"error": "runtime_error"}
        if json.Unmarshal(scanner.Bytes(), &req) == nil { out = dispatch(req) }
        encoded, err := json.Marshal(out)
        if err != nil { encoded = []byte(`{"error":"runtime_error"}`) }
        fmt.Println(string(encoded))
    }
    if scanner.Err() != nil { os.Exit(1) }
}
'''
    return files
