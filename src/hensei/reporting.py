"""Reports derived from immutable case denominators and controller events."""
from __future__ import annotations

import json
from pathlib import Path
import time


def write_report(root: Path, store) -> dict:
    tasks = store.tasks()
    events = store.events()
    visible, hidden = store.get('final_visible'), store.get('final_heldout')
    active_tasks = set()
    peak = 0
    input_tokens = output_tokens = calls = 0
    failures = 0
    for event in events:
        if event['kind'] == 'worker_started':
            active_tasks.add(event['task_id'])
            peak = max(peak, len(active_tasks))
        elif event['kind'] in {'worker_finished', 'attempt_interrupted'}:
            active_tasks.discard(event['task_id'])
        if event['kind'] == 'run_resumed':
            active_tasks.clear()
        if event['kind'] == 'model_usage':
            usage = event['data']['usage']
            input_tokens += usage.get('prompt_tokens', 0)
            output_tokens += usage.get('completion_tokens', 0)
            calls += 1
        if event['kind'] == 'task_transition' and event['data']['to'] == 'REPAIR_READY':
            failures += 1
    placeholders = [str(path.relative_to(root / 'repo')) for path in (root / 'repo' / 'target').glob('*.go')
                    if 'HENSEI_UNIMPLEMENTED' in path.read_text()]
    integrated = sum(item['status'] == 'INTEGRATED' for item in tasks.values())

    def passed(result):
        return bool(result and result['build_ok'] and result['passed'] == result['total']
                    and not result['failures'] and not result['infrastructure_error'])

    completed = integrated == len(tasks) and not placeholders
    report = {
        'schema_version': 1, 'plan_id': store.get('plan_id'), 'run_status': store.get('run_status'),
        'provider': store.get('config')['provider'],
        'measurement_kind': 'scripted_harness_demo' if store.get('config')['provider'] == 'demo' else 'live_agent_run',
        'config': store.get('config'), 'task_count': len(tasks), 'integrated_tasks': integrated,
        'implementation_coverage': integrated / len(tasks) if tasks else 0,
        'development_success': completed and passed(visible),
        'strict_success': completed and passed(visible) and passed(hidden),
        'evaluation_scope': 'held_out' if hidden is not None else 'development_only',
        'visible': visible, 'heldout': hidden, 'remaining_placeholder_files': placeholders,
        'model_calls': calls, 'input_tokens': input_tokens, 'output_tokens': output_tokens,
        'total_tokens': input_tokens + output_tokens,
        'cost_usd': 0.0 if store.get('config')['provider'] == 'demo' else None,
        'cost_note': 'Zero inference for scripted demo; live cost requires the recorded applicable provider tariff.',
        'repairs_queued': failures, 'peak_active_workers': peak,
        'preparation_seconds': store.get('preparation_seconds', 0),
        'execution_seconds': store.get('execution_seconds', 0),
        'elapsed_wall_seconds': time.time() - store.get('started_at', time.time()),
        'tasks': list(tasks.values()),
    }
    (root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    lines = ['# Hensei migration run', '', f"Status: **{report['run_status']}**",
             f"Measurement: **{report['measurement_kind']}**", '',
             '| Metric | Result |', '|---|---|',
             f'| Integrated units | {integrated}/{len(tasks)} |',
             f"| Development success | {report['development_success']} |",
             f"| Held-out strict success | {report['strict_success']} |",
             f'| Peak active workers | {peak} |', f'| Repairs queued | {failures} |',
             f'| Recorded tokens | {input_tokens + output_tokens} |',
             f"| Execution seconds | {report['execution_seconds']:.3f} |", '',
             'Buildability includes the target scaffold; behavior and implementation coverage are separate metrics.', '',
             '| Task | State | Attempts |', '|---|---|---|']
    lines.extend(f"| {row['id']} | {row['status']} | {row['attempts']} |" for row in tasks.values())
    if report['measurement_kind'] == 'scripted_harness_demo':
        lines += ['', 'The demo uses prerecorded translations and synthetic provider delay. Its timings and correctness do not measure LLM translation capability.']
    (root / 'report.md').write_text('\n'.join(lines) + '\n')
    return report
