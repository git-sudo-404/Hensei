import tempfile
import unittest
from pathlib import Path

from hensei.models import HenseiError
from hensei.workspace import Workspace


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ws = Workspace(Path(self.temp.name))
        self.ws.initialize({'target/a.go': 'a', 'target/b.go': 'b'})

    def candidate(self, task, filename, content):
        path = self.ws.create_attempt(task, 1, self.ws.current_head())
        (path / filename).write_text(content)
        sha = self.ws.commit_candidate(path, task, 1, [filename])
        self.addCleanup(lambda: self.ws.discard(path) if path.exists() else None)
        return sha

    def test_integrates_parallel_candidates_against_current_head(self):
        a = self.candidate('a', 'target/a.go', 'new a')
        b = self.candidate('b', 'target/b.go', 'new b')
        for sha in (a, b):
            head = self.ws.current_head()
            path = self.ws.prepare_integration(sha)
            self.ws.promote(path, head)
            self.ws.discard(path)
        self.assertEqual((self.ws.repo / 'target/a.go').read_text(), 'new a')
        self.assertEqual((self.ws.repo / 'target/b.go').read_text(), 'new b')
        log = self.ws._git(self.ws.repo, 'log', '--format=%B')
        self.assertIn('Hensei-Task: a', log)
        self.assertIn('Hensei-Attempt: 1', log)

    def test_rejects_scope_violation_and_symlink(self):
        path = self.ws.create_attempt('a', 1, self.ws.current_head())
        (path / 'unexpected').write_text('bad')
        with self.assertRaises(HenseiError):
            self.ws.commit_candidate(path, 'a', 1, ['target/a.go'])
        (path / 'unexpected').unlink()
        (path / 'target/a.go').unlink()
        (path / 'target/a.go').symlink_to('/etc/passwd')
        with self.assertRaises(HenseiError):
            self.ws.commit_candidate(path, 'a', 1, ['target/a.go'])
        self.ws.discard(path)

    def test_rejects_stale_promotion(self):
        a = self.candidate('a', 'target/a.go', 'new a')
        b = self.candidate('b', 'target/b.go', 'new b')
        old = self.ws.current_head()
        pa = self.ws.prepare_integration(a)
        pb = self.ws.prepare_integration(b)
        self.ws.promote(pa, old)
        with self.assertRaises(HenseiError):
            self.ws.promote(pb, old)
        self.ws.discard(pa)
        self.ws.discard(pb)

    def test_conflicting_candidate_does_not_change_head(self):
        a = self.candidate('a', 'target/a.go', 'new a')
        b = self.candidate('b', 'target/a.go', 'new b')
        p = self.ws.prepare_integration(a)
        self.ws.promote(p, self.ws.current_head())
        self.ws.discard(p)
        head = self.ws.current_head()
        with self.assertRaises(HenseiError):
            self.ws.prepare_integration(b)
        self.assertEqual(head, self.ws.current_head())
        self.assertFalse(any(p.name.startswith('integrate-') for p in self.ws.worktrees.iterdir()))

    def test_discard_cannot_remove_foreign_directory(self):
        with self.assertRaises(HenseiError):
            self.ws.discard(self.ws.repo)
