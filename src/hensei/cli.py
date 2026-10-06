"""Command-line entrypoint for planning, running, inspecting, and resuming."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
from dataclasses import asdict
import fcntl
import json
from pathlib import Path
import sys

from .models import HenseiError, Plan
from .planning import analyze
from .providers import ProviderError
from .runtime import MigrationRun, RunConfig
from .state import StateStore


def _json(path: Path):
    return json.loads(path.read_text())


@contextmanager
def controller_lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.controller.lock').open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HenseiError('Another controller is already operating this run') from None
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def _limits(parser):
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--build-jobs', type=int, default=1)
    parser.add_argument('--max-attempts', type=int, default=3)
    parser.add_argument('--max-turns', type=int, default=12)
    parser.add_argument('--max-tokens', type=int, default=1_000_000)
    parser.add_argument('--max-output-tokens', type=int, default=4096)
    parser.add_argument('--task-timeout', type=float, default=1200, help='Worker deadline per attempt in seconds')
    parser.add_argument('--command-timeout', type=float, default=120)
    parser.add_argument('--run-timeout', type=float, default=3600)


def parser():
    result = argparse.ArgumentParser(prog='hensei', description='Dependency-aware Python → Go migration harness')
    result.add_argument('--env-file', type=Path, default=Path('.env'), help='Local credential file; existing environment variables take precedence')
    commands = result.add_subparsers(dest='command', required=True)
    plan = commands.add_parser('plan', aliases=['analyze'], help='Extract dependencies and write a validated task plan')
    plan.add_argument('source', type=Path)
    plan.add_argument('--output', type=Path, default=Path('tasks.json'))
    run = commands.add_parser('run', help='Execute a plan using DeepSeek')
    run.add_argument('--plan', type=Path, required=True)
    run.add_argument('--cases', type=Path, required=True)
    run.add_argument('--holdout', type=Path)
    run.add_argument('--output', type=Path, required=True)
    run.add_argument('--runner', choices=['docker', 'local'], default='docker', help='Local execution is for explicitly trusted code')
    run.add_argument('--model', default='deepseek-flash')
    _limits(run)
    demo = commands.add_parser('demo', help='Run the trusted prerecorded fixture without an API key')
    demo.add_argument('--output', type=Path, default=Path('runs/demo'))
    demo.add_argument('--inject-failure', action='store_true')
    _limits(demo)
    resume = commands.add_parser('resume', help='Restart interrupted tasks and reconcile integrated commits')
    resume.add_argument('run', type=Path)
    resume.add_argument('--max-tokens', type=int, help='Explicit replacement token ceiling')
    resume.add_argument('--run-timeout', type=float, help='Deadline for this resume session')
    for name in ('status', 'report'):
        item = commands.add_parser(name, help=f'Inspect the saved {name}')
        item.add_argument('run', type=Path)
    return result


def _config(args, **extra):
    fields = ['workers', 'build_jobs', 'max_attempts', 'max_turns', 'max_tokens', 'max_output_tokens',
              'task_timeout', 'command_timeout', 'run_timeout']
    return RunConfig(**{key: getattr(args, key) for key in fields}, **extra)


async def _execute(args):
    if args.command == 'demo':
        example = Path(__file__).resolve().parents[2] / 'examples' / 'shop'
        if not example.exists():
            raise HenseiError('Demo fixtures require the source checkout; run from this repository')
        plan = analyze(example / 'source')
        config = _config(args, runner='local', provider='demo', demo_translations=str(example / 'expected_go'),
                         inject_failure=args.inject_failure)
        cases, hidden, root = _json(example / 'visible.json'), _json(example / 'holdout.json'), args.output
    elif args.command == 'run':
        plan = Plan.load(args.plan)
        config = _config(args, runner=args.runner, provider='deepseek', model=args.model)
        cases, hidden, root = _json(args.cases), _json(args.holdout) if args.holdout else None, args.output
    else:
        root = args.run
        if not (root / 'state.sqlite').exists():
            raise HenseiError('Run state does not exist')
        with StateStoreContext(root / 'state.sqlite') as store:
            if store.get('final_heldout') is not None or store.get('run_status') in {'COMPLETED', 'FAILED'}:
                raise HenseiError('A terminal scored run is frozen; start a new run for further changes')
            config_data = store.get('config')
            if args.max_tokens is not None:
                config_data['max_tokens'] = args.max_tokens
            if args.run_timeout is not None:
                config_data['run_timeout'] = args.run_timeout
            config = RunConfig(**config_data)
            config.validate()
            # Mutation is deferred until the exclusive controller lock is held.
        plan = Plan.load(root / 'tasks.json')
    with controller_lock(root):
        run = MigrationRun(root, plan, config, progress=lambda message: print(message, flush=True))
        try:
            if args.command == 'resume':
                if run.store.get('final_heldout') is not None or run.store.get('run_status') in {'COMPLETED', 'FAILED'}:
                    raise HenseiError('A terminal scored run is frozen; start a new run')
                run.store.set('config', asdict(config))
            if args.command != 'resume':
                if config.provider == 'deepseek':
                    from .providers import DeepSeekProvider
                    DeepSeekProvider(model=config.model)
                await run.prepare(cases, hidden)
            report = await run.execute(resume=args.command == 'resume')
        finally:
            run.close()
    print(json.dumps({key: report[key] for key in ('run_status', 'measurement_kind', 'integrated_tasks',
        'task_count', 'strict_success', 'development_success', 'peak_active_workers', 'repairs_queued')}, indent=2))
    print(f'Report: {(root / "report.md").resolve()}')
    return 0 if report['development_success'] and (report['heldout'] is None or report['strict_success']) else 1


class StateStoreContext:
    def __init__(self, path):
        self.store = StateStore(path)
    def __enter__(self):
        return self.store
    def __exit__(self, *args):
        self.store.close()


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command in {'run', 'resume'}:
            from .env import load_env_file
            load_env_file(args.env_file)
        if args.command in {'plan', 'analyze'}:
            plan = analyze(args.source)
            plan.save(args.output)
            print(f'Planned {len(plan.tasks)} dependency units, {len(plan.contracts)} operations.')
            for task in plan.tasks:
                print(f'{task.id}: {", ".join(task.source_paths)}; depends on {", ".join(task.depends_on) or "none"}')
            print(f'Plan: {args.output.resolve()}')
            return 0
        if args.command in {'status', 'report'}:
            if not (args.run / 'state.sqlite').exists():
                raise HenseiError('Run state does not exist')
            if args.command == 'report':
                print((args.run / 'report.md').read_text())
            else:
                with StateStoreContext(args.run / 'state.sqlite') as store:
                    print(json.dumps({'run_status': store.get('run_status'), 'tokens': store.get('tokens'),
                                      'tasks': list(store.tasks().values())}, indent=2))
            return 0
        return asyncio.run(_execute(args))
    except KeyboardInterrupt:
        print('Interrupted. Saved execution state can be resumed.', file=sys.stderr)
        return 130
    except (HenseiError, ProviderError, ValueError, OSError, KeyError) as exc:
        print(f'hensei: {exc}', file=sys.stderr)
        return 2
