from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from hensei.models import PlanError
from hensei.planning import analyze, scaffold, target_symbol


class PlanningTests(unittest.TestCase):
    def source(self, files):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for name, content in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        return root

    def test_cycle_condenses_and_prerequisites_are_first(self):
        root = self.source({
            'a.py': 'import b\ndef a(x: int) -> int:\n    return x\n',
            'b.py': 'import a\ndef b(x: int) -> int:\n    return x\n',
            'c.py': 'from a import a\ndef c(x: int) -> int:\n    return a(x)\n',
        })
        plan = analyze(root)
        self.assertEqual(plan.tasks[0].source_paths, ['a.py', 'b.py'])
        self.assertEqual(plan.tasks[1].depends_on, [plan.tasks[0].id])
        self.assertEqual(plan.contracts['a.a']['task_id'], plan.contracts['b.b']['task_id'])
        self.assertEqual(plan.plan_id, analyze(root).plan_id)

    def test_relative_and_package_imports(self):
        root = self.source({
            'pkg/__init__.py': '"""Package."""\n',
            'pkg/a.py': 'def a(x: int) -> int:\n    return x\n',
            'pkg/sub/__init__.py': '',
            'pkg/sub/b.py': 'from ..a import a\ndef b(x: int) -> int:\n    return a(x)\n',
            'pkg/c.py': 'from . import a\ndef c(x: int) -> int:\n    return a.a(x)\n',
        })
        plan = analyze(root)
        owner = {p: t.id for t in plan.tasks for p in t.source_paths}
        for task in plan.tasks:
            if task.source_paths in [['pkg/c.py'], ['pkg/sub/b.py']]:
                self.assertEqual(task.depends_on, [owner['pkg/a.py']])
        self.assertEqual(set(owner), {'pkg/a.py', 'pkg/c.py', 'pkg/sub/b.py'})

    def test_rejects_unsupported_and_import_time_effects(self):
        for source in [
            'print("side effect")\n',
            'class Thing:\n    pass\n',
            'VALUES = [1, 2]\n',
            'import os\n',
            'def f(x) -> int:\n    return x\n',
            'def f(x: list[list[int]]) -> int:\n    return 0\n',
            'def f(x: int = 1) -> int:\n    return x\n',
            'def f(x: int) -> int:\n    return eval("x")\n',
            'N = 1\nN = 2\n',
            'N = 9223372036854775808\n',
        ]:
            with self.subTest(source=source):
                with self.assertRaises(PlanError):
                    analyze(self.source({'a.py': source}))

    def test_init_effect_rejected(self):
        with self.assertRaises(PlanError):
            analyze(self.source({'pkg/__init__.py': 'x = 1\n', 'pkg/a.py': 'def f() -> int:\n    return 1\n'}))

    def test_bridge_and_skeleton_types(self):
        plan = analyze(self.source({'typed.py': 'def f(items: list[int], flag: bool, amount: float, text: str) -> list[str]:\n    return [text]\n'}))
        files = scaffold(plan)
        self.assertIn('arg0 []int64, arg1 bool, arg2 float64, arg3 string', files['target/typed.go'])
        self.assertIn('panic("HENSEI_UNIMPLEMENTED:typed.f")', files['target/typed.go'])
        self.assertIn('case "typed.f":', files['target/main.go'])
        self.assertIn('recover()', files['target/main.go'])
        self.assertNotEqual(target_symbol('a_b.f'), target_symbol('a.b_f'))

    def test_reserved_and_colliding_target_names(self):
        function = 'def f() -> int:\n    return 1\n'
        for files in [
            {'main.py': function},
            {'a__b.py': function, 'a/b.py': function},
            {'class.py': function},
        ]:
            with self.subTest(files=list(files)):
                with self.assertRaises(PlanError):
                    analyze(self.source(files))

    def test_decorators_keyword_parameters_and_introspection_rejected(self):
        for source in [
            '@staticmethod\ndef f(x: int) -> int:\n    return x\n',
            'def f(*, x: int = 1) -> int:\n    return x\n',
            'def f(x: int) -> str:\n    return x.__class__.__name__\n',
            'def f() -> str:\n    return __name__\n',
            '__path__ = "elsewhere"\n',
            'def __getattr__(name: str) -> int:\n    return 1\n',
            'N = 1e999\n',
            'def f() -> float:\n    return 1e999\n',
        ]:
            with self.subTest(source=source):
                with self.assertRaises(PlanError):
                    analyze(self.source({'a.py': source}))

    def test_signed_int64_minimum_literal_is_supported(self):
        plan = analyze(self.source({'a.py': 'MIN = -9223372036854775808\n\ndef f() -> int:\n    return -9223372036854775808\n'}))
        self.assertEqual(plan.contracts['a.f']['returns'], 'int')
        self.assertIn('signed Go int64', plan.diagnostics[0]['message'])

    def test_source_symlinks_are_explicitly_rejected(self):
        source = self.source({'a.py': 'def f() -> int:\n    return 1\n'})
        parent = self.source({})
        root_link = parent / 'linked'
        root_link.symlink_to(source, target_is_directory=True)
        with self.assertRaises(PlanError):
            analyze(root_link)
        (source / 'nested').symlink_to(parent, target_is_directory=True)
        with self.assertRaises(PlanError):
            analyze(source)

    def test_demo_cases_match_runtime_contract_validation(self):
        from hensei.runtime import validate_cases
        demo = Path(__file__).resolve().parents[1] / 'examples/shop'
        plan = analyze(demo / 'source')
        visible = json.loads((demo / 'visible.json').read_text())
        heldout = json.loads((demo / 'holdout.json').read_text())
        self.assertEqual(validate_cases(plan, visible, require_coverage=True), visible)
        self.assertEqual(validate_cases(plan, heldout), heldout)

    @unittest.skipUnless(shutil.which('go'), 'Go toolchain unavailable')
    def test_scaffold_builds_and_stub_panics_become_errors(self):
        plan = analyze(self.source({'a.py': 'def f(x: int) -> int:\n    return x + 1\n'}))
        root = self.source(scaffold(plan)) / 'target'
        proc = subprocess.run(['go', 'run', '.'], cwd=root, input='{"operation":"a.f","args":[2]}\n{"operation":"missing","args":[]}\ninvalid\n', text=True, capture_output=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual([json.loads(line) for line in proc.stdout.splitlines()], [{'error':'runtime_error'}] * 3)

    @unittest.skipUnless(shutil.which('go'), 'Go toolchain unavailable')
    def test_demo_translation_matches_python_for_all_cases(self):
        demo = Path(__file__).resolve().parents[1] / 'examples/shop'
        plan = analyze(demo/'source')
        files = scaffold(plan)
        for path in (demo/'expected_go').glob('*.go'):
            files['target/'+path.name] = path.read_text()
        root = self.source(files) / 'target'
        cases = json.loads((demo/'visible.json').read_text()) + json.loads((demo/'holdout.json').read_text())
        payload = ''.join(json.dumps(case)+'\n' for case in cases)
        proc = subprocess.run(['go','run','.'], cwd=root, input=payload, text=True, capture_output=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # Run Python in a separate process so package imports don't pollute the suite.
        script = '''import json, importlib, sys
for line in sys.stdin:
 c=json.loads(line); m,n=c['operation'].rsplit('.',1)
 print(json.dumps({'value':getattr(importlib.import_module(m),n)(*c['args'])}))
'''
        reference = subprocess.run(['python3', '-c', script], cwd=demo/'source', input=payload, text=True, capture_output=True, timeout=10)
        self.assertEqual(reference.returncode, 0, reference.stderr)
        self.assertEqual([json.loads(x) for x in proc.stdout.splitlines()], [json.loads(x) for x in reference.stdout.splitlines()])


if __name__ == '__main__':
    unittest.main()
