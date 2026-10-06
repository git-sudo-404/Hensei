import asyncio
import json
from pathlib import Path
import tempfile
import unittest

from hensei.agents import run_worker
from hensei.models import Plan, TaskSpec
from hensei.providers import ScriptedProvider


def response(*actions):
    return {"choices": [{"message": {"role": "assistant", "content": None, "reasoning_content": "private reasoning", "tool_calls": [{"id": f"call-{i}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}} for i, (name, args) in enumerate(actions)]}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "target").mkdir()
        (self.root / "target/a.go").write_text("// HENSEI_UNIMPLEMENTED")
        self.task = TaskSpec("a", ["a.py"], ["target/a.go"], [])
        self.plan = Plan("unused", {"a.py": "def a(): return 1"}, [self.task], {})

    async def worker(self, provider, **limits):
        async def checks():
            return {"build_ok": True}
        return await run_worker(plan=self.plan, task=self.task, worktree=self.root, provider=provider, feedback=[], limits=limits, trace_path=self.root / "trace.jsonl", run_checks=checks)

    async def test_success_and_preserved_continuation(self):
        provider = ScriptedProvider([response(("read_source", {"path": "a.py"}), ("write_target", {"path": "target/a.go", "content": "package target\nfunc A() int { return 1 }"})), response(("run_checks", {})), response(("submit", {"summary": "Implemented A"}))])
        result = await self.worker(provider)
        self.assertTrue(result.submitted)
        self.assertEqual((result.calls, result.input_tokens, result.output_tokens), (3, 30, 15))
        self.assertTrue(any(m.get("reasoning_content") == "private reasoning" for m in provider.requests[1]["messages"]))
        self.assertNotIn("private reasoning", (self.root / "trace.jsonl").read_text())

    async def test_scope_traversal_and_invalid_tools(self):
        provider = ScriptedProvider([response(("write_target", {"path": "target/../escape", "content": "bad"}), ("write_target", {"path": "target/b.go", "content": "bad"}), ("shell", {"command": "bad"})), response(("submit", {"summary": "done"}))])
        result = await self.worker(provider, max_turns=2)
        self.assertFalse(result.submitted)
        self.assertFalse((self.root / "escape").exists())
        self.assertFalse((self.root / "target/b.go").exists())
        errors = [m for m in provider.requests[1]["messages"] if m["role"] == "tool"]
        self.assertEqual(len(errors), 3)
        self.assertTrue(all("error" in json.loads(m["content"]) for m in errors))

    async def test_symlink_rejected(self):
        (self.root / "target/a.go").unlink()
        (self.root / "outside").write_text("original")
        (self.root / "target/a.go").symlink_to(self.root / "outside")
        with self.assertRaisesRegex(ValueError, "Symlink"):
            await self.worker(ScriptedProvider([]))
        self.assertEqual((self.root / "outside").read_text(), "original")

    async def test_marker_and_size_caps(self):
        provider = ScriptedProvider([response(("write_target", {"path": "target/a.go", "content": "x" * 100})), response(("submit", {"summary": "done"}))])
        result = await self.worker(provider, max_turns=2, max_file_bytes=30)
        self.assertFalse(result.submitted)
        self.assertEqual(result.failure_kind, "turn_limit")

    async def test_tool_call_cap(self):
        result = await self.worker(ScriptedProvider([response(("list_target", {}), ("inspect_diff", {}))]), max_tool_calls_per_turn=1)
        self.assertEqual(result.failure_kind, "tool_call_limit")

    async def test_submit_cannot_precede_later_mutations(self):
        provider = ScriptedProvider([response(("write_target", {"path": "target/a.go", "content": "package target"})), response(("submit", {"summary": "done"}), ("write_target", {"path": "target/a.go", "content": "bad"}))])
        result = await self.worker(provider, max_turns=2)
        self.assertFalse(result.submitted)

    async def test_tool_output_is_bounded_and_source_is_immutable(self):
        self.plan.source_files["a.py"] = "snapshot" * 100
        (self.root / "a.py").write_text("disk content")
        provider = ScriptedProvider([response(("read_source", {"path": "a.py"})), response(("submit", {"summary": "done"}))])
        await self.worker(provider, max_turns=2, max_tool_output_chars=80)
        output = next(m["content"] for m in provider.requests[1]["messages"] if m["role"] == "tool")
        self.assertLessEqual(len(output), 80)
        self.assertIn("snapshot", output)
        self.assertNotIn("disk content", output)

    async def test_retry_calls_are_included(self):
        item = response(("list_target", {}))
        item["_hensei_request_attempts"] = 3
        result = await self.worker(ScriptedProvider([item]), max_turns=1)
        self.assertEqual(result.calls, 3)

    async def test_timeout(self):
        class Slow:
            async def complete(self, *args):
                await asyncio.sleep(1)
        result = await self.worker(Slow(), timeout_s=0.01)
        self.assertEqual(result.failure_kind, "timeout")


if __name__ == "__main__":
    unittest.main()
