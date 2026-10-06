"""Real scheduler/Git tests with a deterministic fixture-based evaluation oracle.

Compiler and behavioral protocol checks live in test_evaluation. Here evaluation
accepts only the independently supplied canonical demo implementations, including
all dependencies of each checked operation; placeholders and wrong edits fail.
"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from hensei.demo import DemoProvider
from hensei.models import Evaluation, HenseiError, Plan
from hensei.planning import analyze
from hensei.runtime import MigrationRun, RunConfig

EXAMPLE = Path(__file__).resolve().parents[1] / 'examples' / 'shop'
TRANSLATIONS = EXAMPLE / 'expected_go'
VISIBLE = json.loads((EXAMPLE / 'visible.json').read_text())
HELDOUT = json.loads((EXAMPLE / 'holdout.json').read_text())


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'run'
        self.plan = analyze(EXAMPLE / 'source')
        self.evaluations = []
        self.active_calls = 0
        self.peak_calls = 0
        self.provider_starts = []
        self.runs = []
        self.addCleanup(self.close_runs)
        self.patcher = patch('hensei.runtime.evaluate_target', side_effect=self.oracle)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def close_runs(self):
        for run in self.runs:
            run.close()

    async def oracle(self, path, cases, **kwargs):
        self.evaluations.append([case['id'] for case in cases])
        tasks = {task.id:task for task in self.plan.tasks}

        def complete(task_id):
            task = tasks[task_id]
            for name in task.target_paths:
                node = path / name
                if not node.is_file() or node.read_text() != (TRANSLATIONS / Path(name).name).read_text():
                    return False
            return all(complete(dep) for dep in task.depends_on)

        result = Evaluation(True, 0, len(cases))
        for index, case in enumerate(cases):
            task_id = self.plan.contracts[case['operation']]['task_id']
            if complete(task_id):
                result.passed += 1
            else:
                content = '\n'.join((path / name).read_text() for name in tasks[task_id].target_paths)
                actual = {'value':999999} if 'return 999999' in content else {'error':'unimplemented_or_noncanonical_fixture'}
                result.failures.append({'kind':'behavior', 'case_index':index, 'operation':case['operation'], 'expected':case['expected'], 'actual':actual})
        return result

    def provider_factory(self, *, fail_task=None, delay=0.02):
        owner = self

        class TrackingProvider(DemoProvider):
            async def complete(self, *args, **kwargs):
                owner.active_calls += 1
                owner.peak_calls = max(owner.peak_calls, owner.active_calls)
                try:
                    return await super().complete(*args, **kwargs)
                finally:
                    owner.active_calls -= 1

        def factory(task, attempt):
            self.provider_starts.append((task.id, attempt))
            return TrackingProvider(task, TRANSLATIONS, inject_failure=task.id == fail_task, delay=delay)
        return factory

    def make_run(self, *, plan=None, provider_factory=None, **options):
        config = RunConfig(provider='demo', demo_translations=str(TRANSLATIONS), runner='local',
                           workers=3, max_turns=4, **options)
        run = MigrationRun(self.root, plan or self.plan, config, provider_factory=provider_factory or self.provider_factory())
        self.runs.append(run)
        return run

    async def test_ready_dependencies_and_real_provider_overlap(self):
        run = self.make_run(provider_factory=self.provider_factory(delay=0.10))
        await run.prepare(VISIBLE, HELDOUT)
        report = await run.execute()
        self.assertEqual(report['run_status'], 'COMPLETED')
        self.assertTrue(report['strict_success'])
        self.assertEqual(report['integrated_tasks'], len(self.plan.tasks))
        self.assertGreaterEqual(self.peak_calls, 2)
        integrated = set()
        by_id = {task.id:task for task in self.plan.tasks}
        for event in run.store.events():
            if event['kind'] == 'worker_started':
                self.assertTrue(set(by_id[event['task_id']].depends_on) <= integrated)
            if event['kind'] == 'task_transition' and event['data']['to'] == 'INTEGRATED':
                integrated.add(event['task_id'])
        hidden_ids = {c['id'] for c in HELDOUT}
        scored = [ids for ids in self.evaluations if hidden_ids.intersection(ids)]
        self.assertEqual(scored, [[case['id'] for case in HELDOUT]])
        with self.assertRaisesRegex(HenseiError, 'frozen'):
            run.recover()

    async def test_semantic_failure_repairs_before_dependents_start(self):
        run = self.make_run(inject_failure=True)
        # Use the runtime's injected first-attempt failure, not our custom factory.
        run.provider_factory = None
        await run.prepare(VISIBLE, HELDOUT)
        report = await run.execute()
        base = self.plan.contracts['shop.base.subtotal']['task_id']
        self.assertTrue(report['strict_success'])
        self.assertEqual(run.store.tasks()[base]['attempts'], 2)
        events = run.store.events()
        failed_checks = [event for event in events if event['kind'] == 'candidate_evaluated' and event['task_id'] == base and event['data']['evaluation']['failures']]
        self.assertEqual(len(failed_checks), 1)
        self.assertEqual(failed_checks[0]['data']['evaluation']['failures'][0]['actual'], {'value':999999})
        self.assertTrue(any(event['kind'] == 'task_transition' and event['task_id'] == base and event['data']['to'] == 'REPAIR_READY' for event in events))

    async def test_prerequisite_failure_blocks_descendants(self):
        base = self.plan.contracts['shop.base.subtotal']['task_id']
        run = self.make_run(max_attempts=1, provider_factory=self.provider_factory(fail_task=base))
        await run.prepare(VISIBLE)
        report = await run.execute()
        states = run.store.tasks()
        self.assertEqual(report['run_status'], 'FAILED')
        self.assertEqual(states[base]['status'], 'FAILED')
        descendants = {base}
        for task in self.plan.tasks:
            if descendants.intersection(task.depends_on):
                descendants.add(task.id)
        for task_id in descendants - {base}:
            self.assertEqual(states[task_id]['status'], 'BLOCKED')
            self.assertNotIn(task_id, [task for task, _ in self.provider_starts])
        labels = self.plan.contracts['shop.labels.label']['task_id']
        self.assertEqual(states[labels]['status'], 'INTEGRATED')
        self.assertFalse(report['development_success'])

    async def test_resume_rejects_changed_plan_without_mutating_git(self):
        run = self.make_run()
        await run.prepare(VISIBLE)
        head = run.workspace.current_head()
        data = self.plan.to_dict()
        data['source_files']['shop/base.py'] += '\n# changed source\n'
        changed = Plan.from_dict(data)
        other = self.make_run(plan=changed)
        with self.assertRaisesRegex(HenseiError, 'identity'):
            other.recover()
        self.assertEqual(run.workspace.current_head(), head)
        self.assertTrue(all(row['status'] == 'PENDING' for row in run.store.tasks().values()))

    async def test_resume_reconciles_promotion_before_database_update(self):
        run = self.make_run()
        await run.prepare(VISIBLE)
        task = next(task for task in self.plan.tasks if not task.depends_on)
        head = run.workspace.current_head()
        run.store.transition(task.id, 'READY')
        run.store.transition(task.id, 'RUNNING', attempts=1, base_sha=head)
        candidate_path = run.workspace.create_attempt(task.id, 1, head)
        for name in task.target_paths:
            (candidate_path / name).write_text((TRANSLATIONS / Path(name).name).read_text())
        candidate = run.workspace.commit_candidate(candidate_path, task.id, 1, task.target_paths)
        run.store.transition(task.id, 'CHECKING', candidate_sha=candidate)
        run.store.transition(task.id, 'INTEGRATING')
        prospective = run.workspace.prepare_integration(candidate)
        accepted = run.workspace.promote(prospective, head)
        run.workspace.discard(prospective)
        run.workspace.discard(candidate_path)
        self.assertEqual(run.store.tasks()[task.id]['status'], 'INTEGRATING')
        recovered = self.make_run()
        recovered.recover()
        state = recovered.store.tasks()[task.id]
        self.assertEqual(state['status'], 'INTEGRATED')
        self.assertEqual(state['accepted_sha'], accepted)
        self.assertEqual(state['attempts'], 1)
        self.assertTrue(any(e['kind'] == 'recovered_integration' for e in recovered.store.events()))
        report = await recovered.execute()
        self.assertTrue(report['development_success'])
        self.assertEqual(recovered.store.tasks()[task.id]['attempts'], 1)

    async def test_budget_pause_does_not_score_or_freeze_heldout(self):
        run = self.make_run(max_tokens=1)
        await run.prepare(VISIBLE, HELDOUT)
        report = await run.execute()
        self.assertEqual(report['run_status'], 'PAUSED_BUDGET')
        self.assertIsNone(run.store.get('final_heldout'))
        self.assertFalse(report['strict_success'])
        hidden_ids = {c['id'] for c in HELDOUT}
        self.assertFalse(any(hidden_ids.intersection(ids) for ids in self.evaluations))
        run.recover()  # Still resumable; held-out scores have not frozen this run.
