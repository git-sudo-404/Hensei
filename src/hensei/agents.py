"""A bounded worker loop with capability-scoped tools and compact audit traces."""
from __future__ import annotations

import asyncio
import difflib
import json
from pathlib import Path
import time
from typing import Callable

from .models import Plan, TaskSpec, WorkerResult, safe_relative_path
from .providers import Provider, ProviderError, ProviderError


DEFAULT_LIMITS = {"max_turns": 12, "timeout_s": 1200, "max_output_tokens": 4096, "max_file_bytes": 131072, "max_tool_output_chars": 12000, "max_tool_calls_per_turn": 16}


def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {"type": "function", "function": {"name": name, "description": description, "parameters": {"type": "object", "properties": properties, "required": required, "additionalProperties": False}}}


TOOLS = [
    _tool("read_source", "Read immutable source snapshot", {"path": {"type": "string"}}, ["path"]),
    _tool("read_target", "Read an existing target file", {"path": {"type": "string"}}, ["path"]),
    _tool("write_target", "Write an owned target file", {"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]),
    _tool("list_target", "List target files", {}, []),
    _tool("inspect_diff", "Inspect changes to owned files", {}, []),
    _tool("run_checks", "Run controller-defined development checks", {}, []),
    _tool("submit", "Submit implemented files for authoritative evaluation", {"summary": {"type": "string"}}, ["summary"]),
]


async def run_worker(*, plan: Plan, task: TaskSpec, worktree: Path, provider: Provider, feedback: list[dict], limits: dict, trace_path: Path, run_checks: Callable, usage_callback: Callable | None = None) -> WorkerResult:
    cap = {**DEFAULT_LIMITS, **limits}
    if any(not isinstance(v, (int, float)) or isinstance(v, bool) or v <= 0 for v in cap.values()):
        raise ValueError("Worker limits must be positive numbers")
    for name in DEFAULT_LIMITS:
        if name != "timeout_s" and not isinstance(cap[name], int):
            raise ValueError(f"{name} must be an integer")
    root = worktree.resolve()
    trace_path.parent.mkdir(parents=True, exist_ok=True)
    result = WorkerResult(False, "Worker did not submit")
    start = time.monotonic()

    def trace(event: str, **data) -> None:
        with trace_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"event": event, "task_id": task.id, "elapsed_s": round(time.monotonic() - start, 4), **data}) + "\n")

    def target(path: str, owned: bool = False) -> Path:
        if not safe_relative_path(path) or not path.startswith("target/") or (owned and path not in task.target_paths):
            raise ValueError("Path is outside permitted target scope")
        node = root
        for part in Path(path).parts:
            node = node / part
            if node.is_symlink():
                raise ValueError("Symlink paths are not allowed")
        if not node.resolve().is_relative_to(root / "target"):
            raise ValueError("Path escapes target directory")
        return node

    def read(path: str) -> str:
        node = target(path)
        if node.stat().st_size > cap["max_file_bytes"]:
            raise ValueError("File exceeds size limit")
        return node.read_text(encoding="utf-8")

    initial = {path: read(path) if target(path, True).exists() else None for path in task.target_paths}
    edited: set[str] = set()
    messages = [{"role": "system", "content": "Translate the assigned source to Go using declared interfaces. Use only provided tools. Preserve behavior. Submit implemented owned files; the controller evaluates correctness."}, {"role": "user", "content": json.dumps({"task": task.__dict__, "contracts": plan.contracts, "source_paths": list(plan.source_files), "feedback": feedback})}]

    async def execute(name: str, args: dict):
        spec = next((t["function"]["parameters"] for t in TOOLS if t["function"]["name"] == name), None)
        if spec is None or not isinstance(args, dict) or set(args) != set(spec["required"]) or any(not isinstance(value, str) for value in args.values()):
            raise ValueError("Unknown tool or invalid arguments")
        if name == "read_source":
            if args["path"] not in plan.source_files:
                raise ValueError("Source path is not in the immutable snapshot")
            content = plan.source_files[args["path"]]
            if len(content.encode()) > cap["max_file_bytes"]:
                raise ValueError("Source exceeds size limit")
            return {"content": content}
        if name == "read_target":
            return {"content": read(args["path"])}
        if name == "write_target":
            node = target(args["path"], True)
            if len(args["content"].encode()) > cap["max_file_bytes"]:
                raise ValueError("Content exceeds size limit")
            node.parent.mkdir(parents=True, exist_ok=True)
            node.write_text(args["content"], encoding="utf-8")
            edited.add(args["path"])
            return {"written": args["path"]}
        if name == "list_target":
            directory = target("target/__listing__").parent
            files = []
            if directory.exists():
                for node in directory.rglob("*"):
                    if node.is_file() and not node.is_symlink():
                        relative = node.relative_to(root).as_posix()
                        target(relative)
                        files.append(relative)
            return {"paths": sorted(files)}
        if name == "inspect_diff":
            return {"diff": "".join(line for path in task.target_paths for line in difflib.unified_diff((initial[path] or "").splitlines(True), (read(path) if target(path).exists() else "").splitlines(True), fromfile=path, tofile=path))}
        if name == "run_checks":
            return await run_checks()
        if name == "submit":
            if not edited or not any(initial[p] != read(p) for p in edited):
                raise ValueError("Submission requires changed owned files")
            if any(not target(p, True).exists() or "HENSEI_UNIMPLEMENTED" in read(p) for p in task.target_paths):
                raise ValueError("Submission still contains missing or unimplemented files")
            result.submitted, result.summary = True, args["summary"][:2000]
            return {"submitted": True}

    async def loop():
        for turn in range(cap["max_turns"]):
            result.calls += 1
            try:
                response = await provider.complete(messages, TOOLS, cap["max_output_tokens"])
            except ProviderError as exc:
                result.calls += max(0, exc.attempts - 1)
                raise
            attempts = response.get("_hensei_request_attempts", 1)
            if not isinstance(attempts, int) or attempts < 1:
                raise ValueError("Invalid provider attempt count")
            result.calls += attempts - 1
            raw_usage = response.get("usage", {})
            if not isinstance(raw_usage, dict):
                raise ValueError("Invalid provider usage")
            usage = {key: value for key, value in raw_usage.items() if key in {"prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "prompt_cache_miss_tokens"}}
            if any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in usage.values()):
                raise ValueError("Invalid token usage")
            for field, dest in [("prompt_tokens", "input_tokens"), ("completion_tokens", "output_tokens")]:
                value = usage.get(field, 0)
                if not isinstance(value, int) or value < 0:
                    raise ValueError("Invalid token usage")
                setattr(result, dest, getattr(result, dest) + value)
            trace("usage", turn=turn, usage=usage)
            if usage_callback is not None:
                await usage_callback(usage)
            message = response["choices"][0]["message"]
            if not isinstance(message, dict) or message.get("role", "assistant") != "assistant":
                raise ValueError("Invalid assistant response")
            # Preserve continuation metadata for thinking-mode tool turns. Never trace it.
            messages.append({key: value for key, value in message.items() if key in {"role", "content", "reasoning_content", "tool_calls"}} | {"role": "assistant"})
            calls = message.get("tool_calls", []) or []
            if not isinstance(calls, list) or len(calls) > cap["max_tool_calls_per_turn"]:
                result.failure_kind = "tool_call_limit"
                return
            if not calls:
                messages.append({"role": "user", "content": "Use the tools to implement and submit the task."})
            ids = [call.get("id") for call in calls if isinstance(call, dict)]
            if len(ids) != len(calls) or any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
                raise ValueError("Invalid tool call IDs")
            for index, call in enumerate(calls):
                name = call.get("function", {}).get("name", "")
                try:
                    arguments = call["function"]["arguments"]
                    if not isinstance(arguments, str) or len(arguments) > cap["max_file_bytes"] * 8:
                        raise ValueError("Tool arguments exceed limit")
                    if name == "submit" and index != len(calls) - 1:
                        raise ValueError("Submit must be the final action in a turn")
                    output = await execute(name, json.loads(arguments))
                    trace("tool", name=name, ok=True)
                except (ValueError, KeyError, OSError, TypeError) as exc:
                    output = {"error": str(exc)[:1000]}
                    trace("tool", name=name, ok=False, error=str(exc)[:1000])
                text = json.dumps(output)
                if len(text) > cap["max_tool_output_chars"]:
                    suffix = "\n[tool output truncated]"
                    text = (text[:max(0, cap["max_tool_output_chars"] - len(suffix))] + suffix)[:cap["max_tool_output_chars"]]
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
            if result.submitted:
                return
        result.failure_kind = "turn_limit"

    try:
        await asyncio.wait_for(loop(), timeout=cap["timeout_s"])
    except TimeoutError:
        result.failure_kind, result.summary = "timeout", "Worker exceeded its deadline"
    except Exception as exc:
        result.failure_kind = "authentication" if isinstance(exc, ProviderError) and exc.http_status in {401, 402} else "provider_error"
        result.summary = str(exc) if isinstance(exc, ProviderError) else f"Worker interrupted: {type(exc).__name__}"
    result.metadata = {"edited_paths": sorted(edited), "elapsed_s": time.monotonic() - start}
    trace("finished", submitted=result.submitted, failure_kind=result.failure_kind, calls=result.calls)
    return result
