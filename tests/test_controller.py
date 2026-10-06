import asyncio
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock

from hensei.cli import controller_lock, main
from hensei.models import HenseiError
from hensei.runtime import MigrationRun


class ControllerTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_git_creation_finishes_and_cleans_before_return(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            created = root / 'owned-worktree'
            finished = []
            run = object.__new__(MigrationRun)
            run.workspace = Mock()

            def discard(path):
                self.assertTrue(finished)
                path.rmdir()
            run.workspace.discard.side_effect = discard

            def create_attempt():
                time.sleep(0.05)
                created.mkdir()
                finished.append(True)
                return created

            job = asyncio.create_task(run._mutate(create_attempt))
            await asyncio.sleep(0.01)
            job.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await job
            self.assertTrue(finished)
            self.assertFalse(created.exists())
            run.workspace.discard.assert_called_once_with(created)

    async def test_controller_lock_rejects_second_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with controller_lock(root):
                with self.assertRaisesRegex(HenseiError, 'Another controller'):
                    with controller_lock(root):
                        pass
            with controller_lock(root):
                pass

    async def test_invalid_limits_do_not_execute(self):
        from hensei.runtime import RunConfig
        for kwargs in ({'workers': 0}, {'task_timeout': float('nan')}, {'max_tokens': -1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(HenseiError):
                RunConfig(**kwargs).validate()
