"""Persistent state must never claim a transition whose audit event was lost."""
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from hensei.planning import analyze
from hensei.state import StateStore

EXAMPLE = Path(__file__).resolve().parents[1] / 'examples' / 'shop'


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state.sqlite'
        self.store = StateStore(self.path)
        self.addCleanup(self.store.close)
        self.plan = analyze(EXAMPLE / 'source')
        self.store.initialize(self.plan, {'provider': 'demo'})
        self.task = self.plan.tasks[0].id

    def test_transition_and_evidence_survive_restart(self):
        self.store.transition(self.task, 'READY')
        self.store.transition(self.task, 'RUNNING', attempts=1, base_sha='base')
        self.store.transition(self.task, 'REPAIR_READY', feedback=[{'kind':'behavior', 'case_index':0}])
        reopened = StateStore(self.path)
        self.addCleanup(reopened.close)
        row = reopened.tasks()[self.task]
        self.assertEqual(row['status'], 'REPAIR_READY')
        self.assertEqual(row['attempts'], 1)
        self.assertEqual(row['feedback'], [{'kind':'behavior', 'case_index':0}])
        transitions = [e for e in reopened.events() if e['kind'] == 'task_transition']
        self.assertEqual([e['data']['to'] for e in transitions], ['READY', 'RUNNING', 'REPAIR_READY'])
        self.assertEqual(transitions[-1]['data']['feedback'], row['feedback'])

    def test_event_failure_rolls_back_task_update(self):
        before = self.store.tasks()[self.task]
        events = self.store.events()
        with patch.object(self.store, '_event', side_effect=sqlite3.OperationalError('disk full')):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.transition(self.task, 'READY', attempts=99)
        self.assertEqual(self.store.tasks()[self.task], before)
        self.assertEqual(self.store.events(), events)

    def test_event_failure_rolls_back_usage_total(self):
        self.store.record_usage(self.task, {'prompt_tokens':5, 'completion_tokens':3})
        before = self.store.events()
        with patch.object(self.store, '_event', side_effect=sqlite3.OperationalError('disk full')):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.record_usage(self.task, {'prompt_tokens':10, 'completion_tokens':20})
        self.assertEqual(self.store.get('tokens'), 8)
        self.assertEqual(self.store.events(), before)
        with self.assertRaises(ValueError):
            self.store.record_usage(self.task, {'prompt_tokens':True, 'completion_tokens':2})
        self.assertEqual(self.store.get('tokens'), 8)

    def test_illegal_transition_and_fields_leave_state_unchanged(self):
        before = self.store.tasks()
        events = self.store.events()
        with self.assertRaises(ValueError):
            self.store.transition(self.task, 'INTEGRATED', accepted_sha='unverified')
        with self.assertRaises(ValueError):
            self.store.transition(self.task, 'READY', invented_field=1)
        self.assertEqual(self.store.tasks(), before)
        self.assertEqual(self.store.events(), events)

    def test_failed_initialization_does_not_leave_partial_plan(self):
        store = StateStore(Path(self.temp.name) / 'new.sqlite')
        self.addCleanup(store.close)
        with patch.object(store, '_event', side_effect=sqlite3.OperationalError('disk full')):
            with self.assertRaises(sqlite3.OperationalError):
                store.initialize(self.plan, {})
        self.assertIsNone(store.get('plan_id'))
        self.assertEqual(store.tasks(), {})
        self.assertEqual(store.events(), [])
