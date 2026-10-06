"""Persistent controller-owned state and atomic event recording."""
from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import time

from .models import Plan

TRANSITIONS = {
    'PENDING': {'READY', 'BLOCKED'},
    'READY': {'RUNNING', 'BLOCKED'},
    'RUNNING': {'CHECKING', 'REPAIR_READY', 'FAILED', 'READY'},
    'CHECKING': {'INTEGRATING', 'REPAIR_READY', 'FAILED', 'READY'},
    'INTEGRATING': {'INTEGRATED', 'REPAIR_READY', 'FAILED', 'READY'},
    'REPAIR_READY': {'READY', 'FAILED', 'BLOCKED'},
    'FAILED': set(), 'BLOCKED': set(), 'INTEGRATED': set(),
}


class StateStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute('PRAGMA journal_mode=WAL')
        self.connection.executescript('''
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                base_sha TEXT, candidate_sha TEXT, accepted_sha TEXT, worktree TEXT,
                feedback TEXT NOT NULL DEFAULT '[]', updated REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, time REAL NOT NULL,
                kind TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL
            );
        ''')
        self.connection.commit()

    def close(self):
        self.connection.close()

    def get(self, key: str, default=None):
        row = self.connection.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return json.loads(row['value']) if row else default

    def set(self, key: str, value):
        with self.connection:
            self.connection.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, json.dumps(value)))

    def event(self, kind: str, task_id: str | None = None, **data):
        with self.connection:
            self._event(kind, task_id, data)

    def _event(self, kind: str, task_id: str | None, data: dict):
        self.connection.execute('INSERT INTO events(time,kind,task_id,data) VALUES (?,?,?,?)',
                                (time.time(), kind, task_id, json.dumps(data)))

    def initialize(self, plan: Plan, config: dict):
        if self.get('plan_id') is not None:
            if self.get('plan_id') != plan.plan_id:
                raise ValueError('Run directory belongs to a different plan')
            return
        with self.connection:
            for key, value in {'plan_id': plan.plan_id, 'config': config, 'started_at': time.time(),
                               'run_status': 'CREATED', 'tokens': 0, 'execution_seconds': 0.0}.items():
                self.connection.execute('INSERT INTO meta VALUES (?,?)', (key, json.dumps(value)))
            for task in plan.tasks:
                self.connection.execute('INSERT INTO tasks(id,status,updated) VALUES (?,?,?)',
                                        (task.id, 'PENDING', time.time()))
            self._event('run_created', None, {'plan_id': plan.plan_id, 'config': config})

    def tasks(self) -> dict[str, dict]:
        result = {}
        for row in self.connection.execute('SELECT * FROM tasks ORDER BY id'):
            item = dict(row)
            item['feedback'] = json.loads(item['feedback'])
            result[item['id']] = item
        return result

    def transition(self, task_id: str, status: str, **fields):
        if set(fields) - {'attempts', 'base_sha', 'candidate_sha', 'accepted_sha', 'worktree', 'feedback'}:
            raise ValueError('Unknown task state fields')
        with self.connection:
            row = self.connection.execute('SELECT status FROM tasks WHERE id=?', (task_id,)).fetchone()
            if row is None or status not in TRANSITIONS[row['status']]:
                raise ValueError(f'Illegal state transition for {task_id}: {row["status"] if row else None} → {status}')
            values = {'status': status, 'updated': time.time(), **fields}
            if 'feedback' in values:
                values['feedback'] = json.dumps(values['feedback'])
            query = ','.join(f'{key}=?' for key in values)
            self.connection.execute(f'UPDATE tasks SET {query} WHERE id=?', (*values.values(), task_id))
            self._event('task_transition', task_id, {'from': row['status'], 'to': status, **fields})

    def recover_integrated(self, task_id: str, sha: str):
        with self.connection:
            self.connection.execute('UPDATE tasks SET status=?,accepted_sha=?,updated=? WHERE id=?',
                                    ('INTEGRATED', sha, time.time(), task_id))
            self._event('recovered_integration', task_id, {'accepted_sha': sha})

    def record_usage(self, task_id: str, usage: dict, **metadata):
        prompt = usage.get('prompt_tokens', 0)
        completion = usage.get('completion_tokens', 0)
        if any(type(v) is not int or v < 0 for v in (prompt, completion)):
            raise ValueError('Invalid provider token counts')
        with self.connection:
            total = self.get('tokens', 0) + prompt + completion
            self.connection.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('tokens', json.dumps(total)))
            self._event('model_usage', task_id, {'usage': usage, **metadata})

    def events(self) -> list[dict]:
        return [dict(id=row['id'], time=row['time'], kind=row['kind'], task_id=row['task_id'],
                     data=json.loads(row['data'])) for row in self.connection.execute('SELECT * FROM events ORDER BY id')]

    def export(self, path: Path):
        path.write_text(''.join(json.dumps(event) + '\n' for event in self.events()))
