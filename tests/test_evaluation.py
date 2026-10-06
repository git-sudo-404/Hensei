import asyncio
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from hensei.evaluation import LOG_LIMIT, _equal, _execute, _parse, capture_baseline, evaluate_target
from hensei.models import HenseiError


class EvaluationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'calc.py').write_text('def add(a,b): return a+b\ndef fail(): raise ValueError("bad")\n')
        self.target = self.root / 'target'
        self.target.mkdir()
        (self.target / 'go.mod').write_text('module example\n\ngo 1.20\n')

    async def test_baseline_records_values_and_runtime_errors(self):
        cases = await capture_baseline(self.source, [{'operation': 'calc.add', 'args': [2,3]}, {'operation': 'calc.fail', 'args': []}], runner='local')
        self.assertEqual(cases[0]['expected'], {'value': 5})
        self.assertEqual(cases[1]['expected'], {'error': 'runtime_error'})
        with self.assertRaises(HenseiError):
            await capture_baseline(self.source, [{'operation': 'missing.fn', 'args': []}], runner='local')

    async def test_default_docker_failure_never_uses_local(self):
        with patch('hensei.evaluation._execute', new=AsyncMock(return_value=(1, '', 'no daemon'))) as execute:
            with self.assertRaisesRegex(HenseiError, 'Docker daemon unavailable'):
                await capture_baseline(self.source, [{'operation': 'calc.add', 'args': [1,2]}])
            result = await evaluate_target(self.root, [{'operation':'calc.add', 'args':[1,2], 'expected':{'value':3}}])
            self.assertIn('Docker daemon unavailable', result.infrastructure_error)
            self.assertTrue(all(call.args[0][0] == 'docker' for call in execute.call_args_list))

    async def test_local_runners_do_not_inherit_controller_credentials(self):
        (self.source / 'envcheck.py').write_text('import os\ndef secret(): return os.environ.get("DEEPSEEK_API_KEY")\n')
        with patch.dict(os.environ, {'DEEPSEEK_API_KEY': 'fake-secret', 'UNRELATED_SECRET': 'also-secret'}):
            cases = await capture_baseline(self.source, [{'operation':'envcheck.secret', 'args':[]}], runner='local')
            self.assertEqual(cases[0]['expected'], {'value':None})
            with patch('hensei.evaluation._execute', new=AsyncMock(side_effect=[(0,'',''), (0,'{"value":null}\n','')])) as execute:
                result = await evaluate_target(self.root, cases, runner='local')
                self.assertTrue(result.ok)
                for call in execute.call_args_list:
                    env = call.kwargs['env']
                    self.assertNotIn('DEEPSEEK_API_KEY', env)
                    self.assertNotIn('UNRELATED_SECRET', env)
                    self.assertEqual(env['HOME'], env['TMPDIR'])
                    self.assertEqual(env['GOENV'], 'off')

    async def test_stdout_and_stderr_are_drained_but_bounded(self):
        import sys
        code, stdout, stderr = await _execute([sys.executable, '-c',
            f'import sys; sys.stdout.write("x"*{LOG_LIMIT * 10}); sys.stderr.write("y"*{LOG_LIMIT * 10})'])
        self.assertEqual(code, 0)
        self.assertEqual(stdout, 'x' * LOG_LIMIT)
        self.assertEqual(stderr, 'y' * LOG_LIMIT)

    async def test_process_timeout(self):
        import sys
        with self.assertRaisesRegex(HenseiError, 'timed out'):
            await _execute([sys.executable, '-c', 'import time; time.sleep(5)'], timeout_s=0.05)

    @unittest.skipUnless(shutil.which('go'), 'Go compiler unavailable')
    async def test_build_behavior_and_wrong_migration(self):
        cases = await capture_baseline(self.source, [{'operation': 'calc.add', 'args':[2,3]}], runner='local')
        (self.target / 'main.go').write_text('''package main
import("bufio";"encoding/json";"os")
func main(){s:=bufio.NewScanner(os.Stdin);for s.Scan(){var c struct{Args []float64 `json:"args"`};json.Unmarshal(s.Bytes(),&c);json.NewEncoder(os.Stdout).Encode(map[string]any{"value":c.Args[0]+c.Args[1]})}}
''')
        result = await evaluate_target(self.root, cases, runner='local')
        self.assertTrue(result.ok, result.to_dict())
        original = (self.target / 'main.go').read_text()
        (self.target / 'main.go').write_text(original.replace('c.Args[0]+c.Args[1]', 'c.Args[0]-c.Args[1]'))
        result = await evaluate_target(self.root, cases, runner='local')
        self.assertTrue(result.build_ok)
        self.assertEqual(result.passed, 0)
        self.assertEqual(result.failures[0]['actual'], {'value': -1})
        self.assertEqual(sorted(p.name for p in self.target.iterdir()), ['go.mod', 'main.go'])
        (self.target / 'main.go').write_text('broken Go')
        result = await evaluate_target(self.root, cases, runner='local')
        self.assertFalse(result.build_ok)

    def test_strict_json_comparison(self):
        self.assertFalse(_equal({'value':True}, {'value':1}))
        self.assertTrue(_equal({'value':1}, {'value':1.0}))
        self.assertFalse(_equal(float('nan'), float('nan')))
        with self.assertRaises(HenseiError):
            _parse('{"value":1e999}\n', 1)
        with self.assertRaises(HenseiError):
            _parse('{"value":NaN}\n', 1)
