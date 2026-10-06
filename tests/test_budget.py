import asyncio
from pathlib import Path
import tempfile
import unittest

from hensei.budget import BudgetExceeded, TokenBudget
from hensei.state import StateStore


class BudgetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self.temporary.name) / 'state.sqlite')
        self.store.set('tokens', 0)

    async def asyncTearDown(self):
        self.store.close()
        self.temporary.cleanup()

    async def test_concurrent_reservations_wait_without_false_exhaustion(self):
        started, release = asyncio.Event(), asyncio.Event()

        class SlowProvider:
            async def complete(self, messages, tools, output):
                started.set()
                await release.wait()
                return {'usage': {'prompt_tokens': 2, 'completion_tokens': 3}}

        budget = TokenBudget(250, self.store, 2)
        wrapped = budget.wrap(SlowProvider(), 'task')
        first = asyncio.create_task(wrapped.complete([], [], 150))
        await started.wait()
        second = asyncio.create_task(wrapped.complete([], [], 150))
        await asyncio.sleep(0.02)
        self.assertFalse(second.done())
        self.assertFalse(budget.exhausted)
        release.set()
        await asyncio.gather(first, second)
        self.assertEqual(self.store.get('tokens'), 10)
        self.assertEqual(budget.reserved, 0)
        self.assertFalse(budget.exhausted)

    async def test_request_too_large_never_reaches_provider(self):
        class MustNotCall:
            async def complete(self, *args):
                raise AssertionError('Oversized request was dispatched')
        budget = TokenBudget(1, self.store, 1)
        with self.assertRaises(BudgetExceeded):
            await budget.wrap(MustNotCall(), 'task').complete([], [], 10)
        self.assertTrue(budget.exhausted)
        self.assertEqual(budget.reserved, 0)

    async def test_cancelled_call_releases_reservation(self):
        started = asyncio.Event()
        class Blocked:
            async def complete(self, *args):
                started.set()
                await asyncio.Event().wait()
        budget = TokenBudget(1000, self.store, 1)
        task = asyncio.create_task(budget.wrap(Blocked(), 'task').complete([], [], 100))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(budget.reserved, 0)
        self.assertEqual(self.store.get('tokens'), 0)
