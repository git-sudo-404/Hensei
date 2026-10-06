"""Persistent ready-frontier scheduling, verification, and serial integration."""
from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import time
from typing import Callable

from .agents import run_worker
from .budget import TokenBudget
from .demo import DemoProvider
from .evaluation import capture_baseline, evaluate_target
from .models import HenseiError, Plan
from .planning import scaffold
from .providers import DeepSeekProvider
from .state import StateStore
from .workspace import Workspace


@dataclass
class RunConfig:
    workers: int = 3
    build_jobs: int = 1
    max_attempts: int = 3
    max_turns: int = 12
    task_timeout: float = 1200
    command_timeout: float = 120
    max_output_tokens: int = 4096
    max_tokens: int = 1_000_000
    run_timeout: float = 3600
    runner: str = 'docker'
    provider: str = 'deepseek'
    model: str = 'deepseek-flash'
    demo_translations: str | None = None
    inject_failure: bool = False

    def validate(self):
        if self.runner not in {'docker', 'local'} or self.provider not in {'deepseek', 'demo'}:
            raise HenseiError('Invalid runner or provider')
        for key in ('workers', 'build_jobs', 'max_attempts', 'max_turns', 'max_output_tokens', 'max_tokens'):
            value = getattr(self, key)
            if type(value) is not int or value < 1:
                raise HenseiError(f'{key} must be a positive integer')
        for key in ('task_timeout', 'command_timeout', 'run_timeout'):
            value = getattr(self, key)
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise HenseiError(f'{key} must be positive and finite')
        if self.provider == 'demo' and not self.demo_translations:
            raise HenseiError('Demo translations directory is required')


def validate_cases(plan: Plan, cases: list[dict], *, require_coverage=False) -> list[dict]:
    if not isinstance(cases, list) or not cases:
        raise HenseiError('Case files must contain a nonempty JSON array')
    ids = set()
    covered = set()

    def valid(value, kind):
        if kind.startswith('list['):
            return isinstance(value, list) and all(valid(x, kind[5:-1]) for x in value)
        if kind == 'int':
            return type(value) is int and -(2**63) <= value < 2**63
        if kind == 'float':
            try:
                return type(value) in (int, float) and math.isfinite(value)
            except OverflowError:
                return False
        return type(value) is {'str': str, 'bool': bool}.get(kind)

    clean = []
    for case in cases:
        if not isinstance(case, dict) or set(case) - {'id', 'operation', 'args'}:
            raise HenseiError('Cases contain only id, operation, and args; expected results come from the source baseline')
        identifier, operation, args = case.get('id'), case.get('operation'), case.get('args')
        if not isinstance(identifier, str) or not identifier or identifier in ids:
            raise HenseiError('Cases need unique nonempty string IDs')
        ids.add(identifier)
        if operation not in plan.contracts or not isinstance(args, list):
            raise HenseiError(f'Unknown operation or invalid args in case {identifier}')
        contract = plan.contracts[operation]
        if len(args) != len(contract['params']) or not all(valid(v, p['kind']) for v, p in zip(args, contract['params'])):
            raise HenseiError(f'Arguments do not match declared types in {identifier}')
        covered.add(contract['task_id'])
        clean.append({'id': identifier, 'operation': operation, 'args': args})
    if require_coverage:
        required = {task.id for task in plan.tasks if task.functions}
        if not required <= covered:
            raise HenseiError(f'Visible tests must exercise every callable migration unit: {sorted(required - covered)}')
    return clean


class MigrationRun:
    def __init__(self, root: Path, plan: Plan, config: RunConfig, *, progress: Callable[[str], None] | None = None,
                 provider_factory: Callable | None = None):
        self.root, self.plan, self.config = root.resolve(), plan, config
        config.validate()
        plan.validate()
        self.root.mkdir(parents=True, exist_ok=True)
        self.store = StateStore(self.root / 'state.sqlite')
        self.workspace = Workspace(self.root)
        self.worker_slots = asyncio.Semaphore(config.workers)
        self.build_slots = asyncio.Semaphore(config.build_jobs)
        self.integration_lock = asyncio.Lock()
        self.budget = TokenBudget(config.max_tokens, self.store, config.workers)
        self.progress = progress or (lambda message: None)
        self.provider_factory = provider_factory
        self.pause_reason = None
        self.visible = []
        self.heldout = []

    def close(self):
        self.store.close()

    def notify(self, message):
        self.progress(message)

    async def prepare(self, cases: list[dict], holdout: list[dict] | None = None):
        if self.store.get('plan_id') is not None or self.workspace.repo.exists():
            raise HenseiError('Run directory already contains a run; use resume or a new directory')
        visible = validate_cases(self.plan, cases, require_coverage=True)
        hidden = validate_cases(self.plan, holdout) if holdout is not None else []
        self.plan.save(self.root / 'tasks.json')
        self.store.initialize(self.plan, asdict(self.config))
        snapshot = self.root / 'source_snapshot'
        for path, text in self.plan.source_files.items():
            destination = snapshot / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(text)
        started = time.monotonic()
        self.notify('Capturing immutable source behavior...')
        try:
            self.visible = await capture_baseline(snapshot, visible, runner=self.config.runner, timeout_s=self.config.command_timeout)
            self.heldout = await capture_baseline(snapshot, hidden, runner=self.config.runner, timeout_s=self.config.command_timeout) if hidden else []
            (self.root / 'visible_cases.json').write_text(json.dumps(self.visible, indent=2) + '\n')
            (self.root / 'heldout_cases.json').write_text(json.dumps(self.heldout, indent=2) + '\n')
            await self._mutate(self.workspace.initialize, scaffold(self.plan))
            self.store.set('prepared', True)
            self.store.set('preparation_seconds', time.monotonic() - started)
            self.store.event('baseline_captured', visible=len(self.visible), heldout=len(self.heldout), source_fingerprint=self.plan.source_fingerprint)
        except Exception:
            self.store.set('run_status', 'PREPARATION_FAILED')
            self.store.export(self.root / 'events.jsonl')
            raise

    def recover(self):
        if self.store.get('plan_id') != self.plan.plan_id:
            raise HenseiError('Saved plan identity does not match runtime plan')
        if self.store.get('final_heldout') is not None:
            raise HenseiError('Held-out scored runs are frozen and cannot be repaired')
        if not self.store.get('prepared'):
            raise HenseiError('Preparation did not finish; start a new run after resolving the baseline/toolchain error')
        self.workspace._git(self.workspace.repo, 'reset', '--hard', self.workspace.current_head())
        self.visible = json.loads((self.root / 'visible_cases.json').read_text())
        self.heldout = json.loads((self.root / 'heldout_cases.json').read_text())
        # Reconcile commits that reached Git before SQLite was updated.
        log = self.workspace._git(self.workspace.repo, 'log', 'integration', '--format=%H%x00%B%x00')
        chunks = log.split('\0')
        for i in range(0, len(chunks) - 1, 2):
            sha, body = chunks[i].strip(), chunks[i + 1]
            match = re.search(r'^Hensei-Task: ([A-Za-z0-9_-]+)$', body, re.MULTILINE)
            if match and match.group(1) in self.store.tasks():
                row = self.store.tasks()[match.group(1)]
                if row['status'] != 'INTEGRATED':
                    self.store.recover_integrated(match.group(1), sha)
        for task_id, row in self.store.tasks().items():
            if row['status'] in {'RUNNING', 'CHECKING', 'INTEGRATING'}:
                self.store.transition(task_id, 'READY', feedback=[{'kind': 'interrupted', 'message': 'Restarting interrupted attempt from recorded source and current accepted dependencies'}])
                if row['worktree'] and Path(row['worktree']).exists():
                    self.workspace.discard(Path(row['worktree']))
        self.store.event('run_resumed')

    async def _mutate(self, function, *args):
        operation = asyncio.create_task(asyncio.to_thread(function, *args))
        try:
            return await asyncio.shield(operation)
        except asyncio.CancelledError:
            outcome = await operation
            if function.__name__ in {'create_attempt', 'prepare_integration'} and isinstance(outcome, Path) and outcome.exists():
                await asyncio.to_thread(self.workspace.discard, outcome)
            raise

    def _save_repair(self, task, worktree):
        content = {}
        for path in task.target_paths:
            node = worktree / path
            if node.is_file() and not node.is_symlink() and node.stat().st_size <= 131072:
                content[path] = node.read_text()
        if content:
            self.store.set('repair_' + task.id, content)
            directory = self.root / 'repairs'
            directory.mkdir(exist_ok=True)
            (directory / (task.id + '.json')).write_text(json.dumps(content, indent=2) + '\n')

    def _cases_for(self, task_ids):
        return [case for case in self.visible if self.plan.contracts[case['operation']]['task_id'] in task_ids]

    def _provider(self, task, attempt):
        if self.provider_factory:
            return self.provider_factory(task, attempt)
        if self.config.provider == 'demo':
            first_int = next((t.id for t in self.plan.tasks if t.functions and t.functions[0]['returns'] == 'int'), None)
            return DemoProvider(task, Path(self.config.demo_translations),
                                inject_failure=self.config.inject_failure and task.id == first_int and attempt == 1)
        return DeepSeekProvider(model=self.config.model)

    async def _evaluate(self, path, cases):
        async with self.build_slots:
            return await evaluate_target(path, cases, runner=self.config.runner, timeout_s=self.config.command_timeout)

    def _reject(self, task, feedback):
        row = self.store.tasks()[task.id]
        status = 'REPAIR_READY' if row['attempts'] < self.config.max_attempts else 'FAILED'
        self.store.transition(task.id, status, feedback=feedback)
        self.notify(f'{task.id}: {"repair queued" if status == "REPAIR_READY" else "failed"}')

    async def _task(self, task):
        worktree = None
        prospective = None
        try:
            async with self.worker_slots:
                row = self.store.tasks()[task.id]
                attempt = row['attempts'] + 1
                if attempt > self.config.max_attempts:
                    self.store.transition(task.id, 'RUNNING')
                    self.store.transition(task.id, 'FAILED', feedback=[{'kind': 'attempt_limit'}])
                    return
                async with self.integration_lock:
                    base = await asyncio.to_thread(self.workspace.current_head)
                    accepted_at_start = {key for key, state in self.store.tasks().items() if state['status'] == 'INTEGRATED'}
                self.store.transition(task.id, 'RUNNING', attempts=attempt, base_sha=base, candidate_sha=None)
                worktree = await self._mutate(self.workspace.create_attempt, task.id, attempt, base)
                for path, content in self.store.get('repair_' + task.id, {}).items():
                    if path in task.target_paths:
                        (worktree / path).write_text(content)
                self.store.connection.execute('UPDATE tasks SET worktree=? WHERE id=?', (str(worktree), task.id))
                self.store.connection.commit()
                self.store.event('worker_started', task.id, attempt=attempt, base_sha=base)
                self.notify(f'{task.id}: worker started (attempt {attempt})')

                async def checks():
                    return (await self._evaluate(worktree, self._cases_for(accepted_at_start | {task.id}))).to_dict()

                provider = self.budget.wrap(self._provider(task, attempt), task.id)
                result = await run_worker(plan=self.plan, task=task, worktree=worktree, provider=provider,
                    feedback=row['feedback'], limits={'max_turns': self.config.max_turns,
                    'timeout_s': self.config.task_timeout, 'max_output_tokens': self.config.max_output_tokens},
                    trace_path=self.root / 'traces' / f'{task.id}-attempt-{attempt}.jsonl', run_checks=checks)
                self.store.event('worker_finished', task.id, attempt=attempt, result=result.to_dict())
            if self.budget.exhausted:
                self.pause_reason = 'PAUSED_BUDGET'
            if result.failure_kind == 'authentication':
                self.pause_reason = 'PAUSED_AUTH'
            elif result.failure_kind == 'provider_error' and not self.budget.exhausted:
                self.pause_reason = 'PAUSED_INFRASTRUCTURE'
            if not result.submitted:
                self._reject(task, [{'kind': result.failure_kind or 'worker', 'message': result.summary}])
                return
            if any('HENSEI_UNIMPLEMENTED' in (worktree / path).read_text() for path in task.target_paths):
                self._reject(task, [{'kind': 'placeholder', 'message': 'Implementation still contains a placeholder'}])
                return
            candidate = await self._mutate(self.workspace.commit_candidate, worktree, task.id, attempt, task.target_paths)
            self.store.transition(task.id, 'CHECKING', candidate_sha=candidate)
            evaluation = await self._evaluate(worktree, self._cases_for(accepted_at_start | {task.id}))
            self.store.event('candidate_evaluated', task.id, evaluation=evaluation.to_dict(), candidate_sha=candidate)
            if evaluation.infrastructure_error:
                self.pause_reason = 'PAUSED_INFRASTRUCTURE'
            if not evaluation.ok:
                self._reject(task, evaluation.failures or [{'kind': 'infrastructure', 'message': evaluation.infrastructure_error}])
                return
            async with self.integration_lock:
                head = await asyncio.to_thread(self.workspace.current_head)
                self.store.transition(task.id, 'INTEGRATING')
                self.store.event('integration_intent', task.id, candidate_sha=candidate, expected_head=head)
                prospective = await self._mutate(self.workspace.prepare_integration, candidate)
                accepted = {key for key, state in self.store.tasks().items() if state['status'] == 'INTEGRATED'}
                evaluation = await self._evaluate(prospective, self._cases_for(accepted | {task.id}))
                self.store.event('integration_evaluated', task.id, evaluation=evaluation.to_dict(), expected_head=head)
                if not evaluation.ok:
                    if evaluation.infrastructure_error:
                        self.pause_reason = 'PAUSED_INFRASTRUCTURE'
                    self._reject(task, evaluation.failures or [{'kind': 'infrastructure', 'message': evaluation.infrastructure_error}])
                    return
                sha = await self._mutate(self.workspace.promote, prospective, head)
                self.store.transition(task.id, 'INTEGRATED', accepted_sha=sha, feedback=[])
                self.notify(f'{task.id}: integrated {sha[:10]}')
        except asyncio.CancelledError:
            self.store.event('attempt_interrupted', task.id)
            raise
        except Exception as exc:
            row = self.store.tasks()[task.id]
            self.store.event('task_error', task.id, error=str(exc)[:2000], error_type=type(exc).__name__)
            if row['status'] in {'RUNNING', 'CHECKING', 'INTEGRATING'}:
                self._reject(task, [{'kind': 'harness', 'message': str(exc)[:2000]}])
            elif row['status'] == 'READY':
                self.store.transition(task.id, 'RUNNING')
                self.store.transition(task.id, 'FAILED', feedback=[{'kind': 'harness', 'message': str(exc)[:2000]}])
        finally:
            if worktree is not None and worktree.exists() and self.store.tasks()[task.id]['status'] != 'INTEGRATED':
                self._save_repair(task, worktree)
            for path in (prospective, worktree):
                if path is not None and path.exists():
                    try:
                        await self._mutate(self.workspace.discard, path)
                    except Exception as exc:
                        self.store.event('cleanup_error', task.id, error=str(exc)[:1000])

    async def execute(self, *, resume=False):
        if resume:
            self.recover()
        elif not self.store.get('prepared'):
            raise HenseiError('Prepare the run before executing')
        if self.config.provider == 'deepseek':
            # Fail clearly before claiming work if credentials are missing.
            DeepSeekProvider(model=self.config.model)
        self.store.set('run_status', 'RUNNING')
        self.store.event('execution_started', workers=self.config.workers)
        started = time.monotonic()
        active = {}
        specs = {task.id: task for task in self.plan.tasks}
        try:
            while True:
                if time.monotonic() - started > self.config.run_timeout:
                    self.pause_reason = 'PAUSED_TIMEOUT'
                    for job in active:
                        job.cancel()
                    await asyncio.gather(*active, return_exceptions=True)
                    break
                rows = self.store.tasks()
                for task_id, row in rows.items():
                    if row['status'] not in {'PENDING', 'REPAIR_READY', 'READY'}:
                        continue
                    task = specs[task_id]
                    states = [rows[dep]['status'] for dep in task.depends_on]
                    if any(state in {'FAILED', 'BLOCKED'} for state in states):
                        self.store.transition(task_id, 'BLOCKED', feedback=[{'kind': 'dependency', 'message': 'A required migration unit failed'}])
                    elif row['status'] != 'READY' and all(state == 'INTEGRATED' for state in states):
                        self.store.transition(task_id, 'READY')
                if not self.pause_reason:
                    scheduled = set(active.values())
                    for task_id, row in self.store.tasks().items():
                        if row['status'] == 'READY' and task_id not in scheduled and len(active) < 2 * self.config.workers:
                            active[asyncio.create_task(self._task(specs[task_id]))] = task_id
                if not active:
                    break
                done, _ = await asyncio.wait(active, timeout=0.25, return_when=asyncio.FIRST_COMPLETED)
                for job in done:
                    active.pop(job)
                    await job
            if self.pause_reason:
                status = self.pause_reason
            else:
                statuses = {row['status'] for row in self.store.tasks().values()}
                status = 'COMPLETED' if statuses == {'INTEGRATED'} else 'FAILED'
            self.store.set('run_status', status)
        except (asyncio.CancelledError, KeyboardInterrupt):
            for job in active:
                job.cancel()
            await asyncio.gather(*active, return_exceptions=True)
            self.store.set('run_status', 'INTERRUPTED')
            raise
        finally:
            self.store.set('execution_seconds', self.store.get('execution_seconds', 0.0) + time.monotonic() - started)
            self.store.export(self.root / 'events.jsonl')
        return await self.finish()

    async def finish(self):
        # Holdout is terminal evaluation only, and never enters a worker feedback packet.
        visible = await self._evaluate(self.workspace.repo, self.visible)
        frozen = self.store.get('run_status') in {'COMPLETED', 'FAILED'}
        hidden = await self._evaluate(self.workspace.repo, self.heldout) if self.heldout and frozen else None
        self.store.set('final_visible', visible.to_dict())
        self.store.set('final_heldout', hidden.to_dict() if hidden else None)
        self.store.event('terminal_evaluated', visible=visible.to_dict(), heldout=hidden.to_dict() if hidden else None)
        destination = self.root / 'output'
        shutil.copytree(self.workspace.repo / 'target', destination / 'target', dirs_exist_ok=True)
        from .reporting import write_report
        report = write_report(self.root, self.store)
        self.store.export(self.root / 'events.jsonl')
        return report
