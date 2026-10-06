import copy
from pathlib import Path
import tempfile
import unittest

from hensei.models import Plan, PlanError, TaskSpec, safe_relative_path


def example():
    operation = "a.value"
    contract = {"source_module": "a", "source_name": "value", "target_name": "H_" + operation.encode().hex(), "params": [{"name": "x", "kind": "int"}], "returns": "int", "source_path": "a.py", "target_path": "target/a.go", "task_id": "a"}
    return Plan("/snapshot", {"a.py": "def value(x: int) -> int: return x", "pkg/__init__.py": ""}, [TaskSpec("a", ["a.py"], ["target/a.go"], [], [copy.deepcopy(contract)])], {operation: contract})


class ModelTests(unittest.TestCase):
    def test_canonical_paths(self):
        for value in ["", ".", "./", "./a", "/a", "../a", "a/../b", "a//b", "a/./b", "a/", "a\\b", ".git/x", "a/.git/x", "a\x00b", None, 1]:
            with self.subTest(value=value):
                self.assertFalse(safe_relative_path(value))
        self.assertTrue(safe_relative_path("target/a.go"))

    def test_round_trip_and_constants_only(self):
        plan = example()
        restored = Plan.from_dict(plan.to_dict())
        self.assertEqual(plan.plan_id, restored.plan_id)
        constant = Plan("x", {"a.py": "VALUE = 1"}, [TaskSpec("a", ["a.py"], ["target/a.go"], [])], {})
        constant.validate()

    def test_target_alias_cannot_bypass_ownership(self):
        plan = example()
        plan.source_files["b.py"] = "VALUE = 1"
        plan.tasks.append(TaskSpec("b", ["b.py"], ["target/./a.go"], []))
        with self.assertRaises(PlanError):
            plan.validate()

    def test_case_insensitive_and_unicode_collisions_rejected(self):
        plan = example()
        plan.source_files['A.py'] = 'VALUE = 1'
        plan.tasks.append(TaskSpec('b', ['A.py'], ['target/A.go'], []))
        with self.assertRaisesRegex(PlanError, 'collide'):
            plan.validate()
        plan = example()
        plan.tasks[0].target_paths = ['target/Main.go']
        with self.assertRaisesRegex(PlanError, 'Reserved'):
            plan.validate()

    def test_contract_mapping_and_schema(self):
        mutations = [("task_id", "missing"), ("source_path", "missing.py"), ("target_path", "target/missing.go"), ("source_module", "wrong"), ("target_name", "H_deadbeef"), ("returns", "list[list[int]]"), ("params", [{"name": "x", "kind": 1}])]
        for key, value in mutations:
            with self.subTest(key=key):
                plan = example()
                plan.contracts["a.value"][key] = value
                plan.tasks[0].functions = [copy.deepcopy(plan.contracts["a.value"])]
                with self.assertRaises(PlanError):
                    plan.validate()
        plan = example()
        del plan.contracts["a.value"]["params"]
        with self.assertRaises(PlanError):
            plan.validate()

    def test_functions_must_match_exactly(self):
        for functions in [[], [example().tasks[0].functions[0]] * 2]:
            plan = example()
            plan.tasks[0].functions = functions
            with self.assertRaises(PlanError):
                plan.validate()

    def test_malformed_json_structures_are_plan_errors(self):
        malformed = [[], None, {}, {"tasks": None}, {"tasks": [None]}, {"tasks": [{}]}]
        base = example().to_dict()
        for key, value in [("schema_version", True), ("source_files", []), ("source_files", {"a.py": 1}), ("contracts", []), ("diagnostics", [None]), ("unknown", 1)]:
            item = copy.deepcopy(base)
            item[key] = value
            malformed.append(item)
        for key, value in [("depends_on", "a"), ("source_paths", [1]), ("target_paths", []), ("functions", {}), ("id", []), ("depends_on", ["x", "x"])]:
            item = copy.deepcopy(base)
            item["tasks"][0][key] = value
            malformed.append(item)
        for value in malformed:
            with self.subTest(value=value):
                with self.assertRaises(PlanError):
                    Plan.from_dict(value)

    def test_unknown_dependencies_and_cycles(self):
        plan = example()
        plan.tasks[0].depends_on = ["missing"]
        with self.assertRaises(PlanError):
            plan.validate()
        plan = example()
        plan.source_files["b.py"] = "VALUE = 1"
        plan.tasks.append(TaskSpec("b", ["b.py"], ["target/b.go"], ["a"]))
        plan.tasks[0].depends_on = ["b"]
        with self.assertRaisesRegex(PlanError, "cycle"):
            plan.validate()

    def test_reserved_files_and_init_name_suffix(self):
        plan = example()
        plan.tasks[0].target_paths = ["target/main.go"]
        with self.assertRaises(PlanError):
            plan.validate()
        plan = Plan("x", {"my__init__.py": "VALUE = 1"}, [TaskSpec("a", ["my__init__.py"], ["target/a.go"], [])], {})
        plan.validate()

    def test_invalid_json_syntax(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "bad.json"
            path.write_text("{not json}")
            with self.assertRaises(PlanError):
                Plan.load(path)


if __name__ == "__main__":
    unittest.main()
