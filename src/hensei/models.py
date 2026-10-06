"""Small, JSON-serializable contracts shared by the harness components."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import hashlib
import json
import keyword
from pathlib import Path, PurePosixPath
import re
import unicodedata
from typing import Any


class HenseiError(Exception):
    """An actionable user-facing harness error."""


class PlanError(HenseiError):
    pass


def safe_relative_path(value: str) -> bool:
    if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value) or "\\" in value:
        return False
    path = PurePosixPath(value)
    return bool(path.parts) and not path.is_absolute() and path.as_posix() == value and not ({"..", ".git"} & set(path.parts))


def _string_list(value: Any, label: str, *, nonempty: bool = False) -> None:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise PlanError(f"{label} must be an array of nonempty strings.")
    if len(value) != len(set(value)) or (nonempty and not value):
        raise PlanError(f"{label} must contain unique values{' and cannot be empty' if nonempty else ''}.")


def _python_name(value: Any) -> bool:
    return isinstance(value, str) and value.isidentifier() and not keyword.iskeyword(value)


def _contract(value: Any, label: str) -> None:
    fields = {"source_module", "source_name", "target_name", "params", "returns", "source_path", "target_path", "task_id"}
    if not isinstance(value, dict) or set(value) != fields:
        raise PlanError(f"{label} has an invalid contract schema.")
    if not isinstance(value["source_module"], str) or not all(_python_name(part) for part in value["source_module"].split(".")) or not _python_name(value["source_name"]):
        raise PlanError(f"{label} has invalid Python identifiers.")
    # Generated symbols are ASCII identifiers. This also prevents injection into scaffold text.
    if not isinstance(value["target_name"], str) or not re.fullmatch(r"H_[0-9a-f]+", value["target_name"]):
        raise PlanError(f"{label} has an invalid generated Go symbol.")
    kinds = {"str", "int", "float", "bool", "list[str]", "list[int]", "list[float]", "list[bool]"}
    if not isinstance(value["returns"], str) or value["returns"] not in kinds or not isinstance(value["params"], list):
        raise PlanError(f"{label} has unsupported types or parameters.")
    names = []
    for parameter in value["params"]:
        if not isinstance(parameter, dict) or set(parameter) != {"name", "kind"} or not _python_name(parameter["name"]) or not isinstance(parameter["kind"], str) or parameter["kind"] not in kinds:
            raise PlanError(f"{label} has an invalid parameter.")
        names.append(parameter["name"])
    if len(names) != len(set(names)):
        raise PlanError(f"{label} has duplicate parameter names.")
    if not safe_relative_path(value["source_path"]) or not safe_relative_path(value["target_path"]) or not isinstance(value["task_id"], str):
        raise PlanError(f"{label} has invalid ownership fields.")


def content_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass
class TaskSpec:
    id: str
    source_paths: list[str]
    target_paths: list[str]
    depends_on: list[str]
    functions: list[dict[str, Any]] = field(default_factory=list)
    instruction: str = "Preserve source behavior and implement the declared Go interfaces."

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> TaskSpec:
        if not isinstance(value, dict):
            raise PlanError("Each task must be a JSON object.")
        try:
            task = cls(**value)
        except TypeError as exc:
            raise PlanError(f"Invalid task fields: {exc}") from None
        task.validate()
        return task

    def validate(self) -> None:
        if not isinstance(self.id, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", self.id):
            raise PlanError("Task IDs must contain letters, numbers, underscores, or hyphens.")
        _string_list(self.source_paths, f"{self.id}.source_paths", nonempty=True)
        _string_list(self.target_paths, f"{self.id}.target_paths", nonempty=True)
        _string_list(self.depends_on, f"{self.id}.depends_on")
        if not isinstance(self.instruction, str) or not self.instruction:
            raise PlanError(f"{self.id}.instruction must be a nonempty string.")
        if not isinstance(self.functions, list):
            raise PlanError(f"{self.id}.functions must be an array of contracts.")
        for function in self.functions:
            _contract(function, f"{self.id}.functions")


@dataclass
class Plan:
    source_root: str
    source_files: dict[str, str]
    tasks: list[TaskSpec]
    contracts: dict[str, dict[str, Any]]
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    schema_version: int = 1
    source_language: str = "python"
    target_language: str = "go"

    @property
    def source_fingerprint(self) -> str:
        return content_hash(self.source_files)

    @property
    def plan_id(self) -> str:
        data = self.to_dict()
        data.pop("source_root", None)
        return content_hash(data)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Plan:
        if not isinstance(value, dict) or not isinstance(value.get("tasks"), list):
            raise PlanError("A plan must be an object with a tasks array.")
        data = dict(value)
        data["tasks"] = [TaskSpec.from_dict(item) for item in data["tasks"]]
        try:
            plan = cls(**data)
        except TypeError as exc:
            raise PlanError(f"Invalid plan fields: {exc}") from None
        plan.validate()
        return plan

    @classmethod
    def load(cls, path: Path) -> Plan:
        try:
            return cls.from_dict(json.loads(path.read_text()))
        except json.JSONDecodeError as exc:
            raise PlanError(f"Invalid plan JSON: {exc.msg}") from None

    def save(self, path: Path) -> None:
        self.validate()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2) + "\n")

    def validate(self) -> None:
        if type(self.schema_version) is not int or self.schema_version != 1 or self.source_language != "python" or self.target_language != "go":
            raise PlanError("Only schema 1 Python → Go plans are supported.")
        if not isinstance(self.source_root, str) or not self.source_root or not isinstance(self.source_files, dict) or not self.source_files:
            raise PlanError("A plan needs a source root and a nonempty source snapshot object.")
        if not isinstance(self.tasks, list) or any(not isinstance(task, TaskSpec) for task in self.tasks):
            raise PlanError("Plan tasks must be TaskSpec objects.")
        if not isinstance(self.contracts, dict) or not isinstance(self.diagnostics, list) or any(not isinstance(item, dict) for item in self.diagnostics):
            raise PlanError("Contracts must be an object and diagnostics an array of objects.")
        for task in self.tasks:
            task.validate()
        ids = [task.id for task in self.tasks]
        if not ids or len(ids) != len(set(ids)):
            raise PlanError("A plan needs unique, nonempty tasks.")
        source_keys = [unicodedata.normalize("NFC", p).casefold() for p in self.source_files if isinstance(p, str)]
        if len(source_keys) != len(set(source_keys)):
            raise PlanError("Source paths collide on case-insensitive or Unicode-normalizing filesystems.")
        target_keys: set[str] = {"target/main.go", "target/go.mod"}
        owners: dict[str, str] = {}
        covered: set[str] = set()
        for path, text in self.source_files.items():
            if not safe_relative_path(path) or not path.endswith(".py") or not isinstance(text, str):
                raise PlanError(f"Unsafe source path: {path}")
        for task in self.tasks:
            if not task.id or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in task.id):
                raise PlanError(f"Unsafe task ID: {task.id}")
            if not task.source_paths or not task.target_paths:
                raise PlanError(f"Task {task.id} has no source or target paths.")
            for path in task.source_paths:
                if path not in self.source_files or path in covered:
                    raise PlanError(f"Missing or multiply owned source path: {path}")
                covered.add(path)
            for path in task.target_paths:
                normalized = unicodedata.normalize("NFC", path).casefold()
                if normalized in target_keys:
                    raise PlanError(f"Reserved or colliding target path: {path}")
                target_keys.add(normalized)
                if not safe_relative_path(path) or not path.startswith("target/") or not path.endswith(".go") or path in {"target/main.go", "target/go.mod"} or path in owners:
                    raise PlanError(f"Unsafe or multiply owned target path: {path}")
                owners[path] = task.id
            if any(dep not in ids or dep == task.id for dep in task.depends_on):
                raise PlanError(f"Invalid dependencies for {task.id}")
        expected = {p for p in self.source_files if PurePosixPath(p).name != "__init__.py"}
        if covered != expected:
            raise PlanError("Every source module must belong to exactly one task.")
        source_owners = {path: task.id for task in self.tasks for path in task.source_paths}
        for operation, contract in self.contracts.items():
            _contract(contract, f"Contract {operation}")
            module, name = contract["source_module"], contract["source_name"]
            expected_module = str(PurePosixPath(contract["source_path"]).with_suffix("")).replace("/", ".")
            if operation != f"{module}.{name}" or module != expected_module:
                raise PlanError(f"Contract {operation} does not match its source operation.")
            if contract["target_name"] != "H_" + operation.encode("utf-8").hex():
                raise PlanError(f"Contract {operation} has an inconsistent target symbol.")
            if source_owners.get(contract["source_path"]) != contract["task_id"] or owners.get(contract["target_path"]) != contract["task_id"]:
                raise PlanError(f"Contract {operation} does not match task source/target ownership.")
        for task in self.tasks:
            subset = [contract for contract in self.contracts.values() if contract["task_id"] == task.id]
            if sorted(map(content_hash, task.functions)) != sorted(map(content_hash, subset)):
                raise PlanError(f"Task {task.id}.functions must exactly match its contracts.")
        remaining = {t.id: set(t.depends_on) for t in self.tasks}
        resolved: set[str] = set()
        while remaining:
            ready = {key for key, deps in remaining.items() if deps <= resolved}
            if not ready:
                raise PlanError("Task dependencies contain a cycle.")
            resolved.update(ready)
            for key in ready:
                del remaining[key]


@dataclass
class Evaluation:
    build_ok: bool
    passed: int
    total: int
    failures: list[dict[str, Any]] = field(default_factory=list)
    elapsed_s: float = 0.0
    infrastructure_error: str | None = None

    @property
    def ok(self) -> bool:
        return self.build_ok and self.passed == self.total and not self.failures and not self.infrastructure_error

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class WorkerResult:
    submitted: bool
    summary: str
    input_tokens: int = 0
    output_tokens: int = 0
    calls: int = 0
    failure_kind: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
