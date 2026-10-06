"""Independent JSON-lines behavioral checks with explicit execution isolation."""
from __future__ import annotations

import asyncio
import json
import math
import os
from pathlib import Path
import signal
import tempfile
import time
from typing import Any

from .models import Evaluation, HenseiError

LOG_LIMIT = 32_768


def _local_env(temp: Path) -> dict[str, str]:
    # Local mode is explicit; even trusted fixtures do not need controller credentials.
    env = {'PATH': os.environ.get('PATH', os.defpath), 'TMPDIR': str(temp), 'HOME': str(temp)}
    if 'SystemRoot' in os.environ:
        env['SystemRoot'] = os.environ['SystemRoot']
    return env
PYTHON_RUNNER = r'''
import contextlib, importlib, io, json, sys
sys.path.insert(0, sys.argv[1])
class QuietOutput:
    def write(self, value): return len(value)
    def flush(self): pass
for line in sys.stdin:
    try:
        case = json.loads(line)
        module, function = case['operation'].rsplit('.', 1)
        try:
            with contextlib.redirect_stdout(QuietOutput()):
                callable_fn = getattr(importlib.import_module(module), function)
        except Exception as exc:
            print('Source import/interface failure: ' + str(exc), file=sys.stderr)
            sys.exit(2)
        with contextlib.redirect_stdout(QuietOutput()):
            value = callable_fn(*case.get('args', []))
        result = json.dumps({'value': value}, allow_nan=False)
    except Exception:
        result = json.dumps({'error': 'runtime_error'})
    print(result, flush=True)
'''


async def _execute(argv: list[str], *, data: str = '', cwd: Path | None = None,
                   timeout_s: float = 120, env: dict[str, str] | None = None) -> tuple[int, str, str]:
    try:
        proc = await asyncio.create_subprocess_exec(*argv, cwd=cwd, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, start_new_session=True)
    except OSError as exc:
        raise HenseiError(f'Execution infrastructure unavailable: {exc}') from exc

    async def read(stream: asyncio.StreamReader) -> str:
        output = bytearray()
        while chunk := await stream.read(8192):
            if len(output) < LOG_LIMIT:
                output.extend(chunk[:LOG_LIMIT - len(output)])
        return output.decode('utf-8', errors='replace')

    async def write() -> None:
        try:
            proc.stdin.write(data.encode())
            await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            proc.stdin.close()

    async def collect() -> tuple[int, str, str]:
        _, stdout, stderr, code = await asyncio.gather(write(), read(proc.stdout), read(proc.stderr), proc.wait())
        return code, stdout, stderr

    task = asyncio.create_task(collect())
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout_s)
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await task
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise HenseiError(f'Process timed out after {timeout_s} seconds.') from exc


def _cases_input(cases: list[dict]) -> str:
    for case in cases:
        if not isinstance(case.get('operation'), str) or '.' not in case['operation'] or not isinstance(case.get('args', []), list):
            raise HenseiError('Each case requires operation=module.function and an args list.')
    try:
        return ''.join(json.dumps({'operation': c['operation'], 'args': c.get('args', [])}, allow_nan=False) + '\n' for c in cases)
    except (ValueError, TypeError) as exc:
        raise HenseiError(f'Cases must contain finite JSON values: {exc}') from exc


async def _docker_ready(timeout_s: float) -> None:
    code, _, err = await _execute(['docker', 'info', '--format', '{{.ServerVersion}}'], timeout_s=min(timeout_s, 15))
    if code:
        raise HenseiError(f'Docker daemon unavailable: {err[-2000:]}')


def _docker_prefix(source: Path, image: str, *, name: str) -> list[str]:
    return ['docker', 'run', '--rm', '--name', name, '--init', '-i', '--network=none',
        '--user', '65534:65534', '--read-only', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1g', '--cpus=1',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=536870912',
        '--mount', f'type=bind,src={source.resolve()},dst=/src,readonly',
        '--workdir', '/src', image]


async def _container(argv: list[str], name: str, *, data: str, timeout_s: float) -> tuple[int, str, str]:
    try:
        return await _execute(argv, data=data, timeout_s=timeout_s)
    finally:
        # Killing the Docker client does not necessarily stop its container.
        try:
            await _execute(['docker', 'rm', '--force', name], timeout_s=10)
        except HenseiError:
            pass


def _parse(stdout: str, total: int) -> list[Any]:
    lines = stdout.splitlines()
    if len(lines) != total:
        raise HenseiError(f'Expected {total} JSON results, received {len(lines)} (output capped at {LOG_LIMIT} bytes).')
    values = []
    for line in lines:
        try:
            value = json.loads(line, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
        except (ValueError, TypeError) as exc:
            raise HenseiError('Runner returned invalid or nonfinite JSON.') from exc
        if not isinstance(value, dict) or set(value) not in ({'value'}, {'error'}):
            raise HenseiError('Runner must return exactly {value: ...} or {error: ...}.')
        def finite(item: Any) -> bool:
            if isinstance(item, float):
                return math.isfinite(item)
            if isinstance(item, dict):
                return all(finite(v) for v in item.values())
            if isinstance(item, list):
                return all(finite(v) for v in item)
            return True
        if not finite(value):
            raise HenseiError('Runner returned nonfinite JSON numbers.')
        values.append(value)
    return values


def _equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return (not isinstance(left, float) or math.isfinite(left)) and (not isinstance(right, float) or math.isfinite(right)) and left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_equal(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(_equal(a, b) for a, b in zip(left, right))
    return left == right


async def capture_baseline(source_root: Path, cases: list[dict], *, runner: str = 'docker', timeout_s: float = 120) -> list[dict]:
    data = _cases_input(cases)
    if runner == 'docker':
        await _docker_ready(timeout_s)
        import uuid
        name = f'hensei-python-{uuid.uuid4().hex}'
        argv = _docker_prefix(source_root, os.environ.get('HENSEI_PYTHON_IMAGE', 'python:3.11.10-slim'), name=name)
        code, out, err = await _container(argv + ['python', '-B', '-c', PYTHON_RUNNER, '/src'], name, data=data, timeout_s=timeout_s)
    elif runner == 'local':
        import sys
        with tempfile.TemporaryDirectory(prefix='hensei-baseline-') as temp:
            code, out, err = await _execute([sys.executable, '-I', '-B', '-c', PYTHON_RUNNER, str(source_root.resolve())], data=data, timeout_s=timeout_s, env=_local_env(Path(temp)))
    else:
        raise HenseiError('Runner must be docker or local.')
    if code:
        raise HenseiError(f'Source baseline failed ({code}): {err[-4000:]}')
    results = _parse(out, len(cases))
    return [dict(case, expected=result) for case, result in zip(cases, results)]


async def evaluate_target(worktree: Path, cases: list[dict], *, runner: str = 'docker', timeout_s: float = 120) -> Evaluation:
    started = time.monotonic()
    result = Evaluation(False, 0, len(cases))
    phase = 'infrastructure'
    try:
        data = _cases_input(cases)
        if any('expected' not in c for c in cases):
            raise HenseiError('Evaluation cases require captured expected results.')
        target = worktree / 'target'
        if not target.is_dir():
            result.failures.append({'kind': 'build', 'message': 'Missing target directory.'})
            return result
        if runner == 'docker':
            await _docker_ready(timeout_s)
            import uuid
            name = f'hensei-go-{uuid.uuid4().hex}'
            argv = _docker_prefix(target, os.environ.get('HENSEI_GO_IMAGE', 'golang:1.23.2-bookworm'), name=name)
            # Both phases use the same isolated container; the marker is emitted only after a successful build.
            phase = 'build'
            code, out, err = await _container(argv + ['sh', '-c',
                'export GOCACHE=/tmp/cache GOPATH=/tmp/go GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off; go build -o /tmp/hensei-target . && echo HENSEI_BUILD_OK >&2 && exec /tmp/hensei-target'],
                name, data=data, timeout_s=timeout_s)
            result.build_ok = 'HENSEI_BUILD_OK' in err.splitlines()
            if code == 125:
                result.infrastructure_error = f'Docker execution failed: {err[-4000:]}'
                return result
        elif runner == 'local':
            with tempfile.TemporaryDirectory(prefix='hensei-eval-') as temp:
                binary = Path(temp) / 'target'
                env = dict(_local_env(Path(temp)), GOCACHE=str(Path(temp) / 'cache'), GOPATH=str(Path(temp) / 'go'), GOTOOLCHAIN='local', GOPROXY='off', GOSUMDB='off', GOENV='off')
                phase = 'build'
                code, _, err = await _execute(['go', 'build', '-o', str(binary), '.'], cwd=target, env=env, timeout_s=timeout_s)
                if code:
                    result.failures.append({'kind': 'build', 'message': err[-4000:]})
                    return result
                result.build_ok = True
                phase = 'behavior'
                code, out, err = await _execute([str(binary)], data=data, cwd=target, env=env, timeout_s=timeout_s)
        else:
            raise HenseiError('Runner must be docker or local.')
        if not result.build_ok or code:
            result.failures.append({'kind': 'behavior' if result.build_ok else 'build', 'message': f'Process exited {code}: {err[-4000:]}'})
            return result
        phase = 'behavior'
        actual = _parse(out, len(cases))
        for index, (case, value) in enumerate(zip(cases, actual)):
            if _equal(case['expected'], value):
                result.passed += 1
            else:
                result.failures.append({'kind': 'behavior', 'case_index': index, 'operation': case['operation'], 'expected': case['expected'], 'actual': value})
    except HenseiError as exc:
        if phase == 'infrastructure' or 'infrastructure unavailable' in str(exc):
            result.infrastructure_error = str(exc)
        else:
            result.failures.append({'kind': phase, 'message': str(exc)})
    finally:
        result.elapsed_s = time.monotonic() - started
    return result
