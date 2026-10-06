"""Git workspaces owned exclusively by one migration run."""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import uuid

from .models import HenseiError, safe_relative_path


class Workspace:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.repo = self.root / 'repo'
        self.worktrees = self.root / 'worktrees'

    def _git(self, path: Path, *args: str) -> str:
        result = subprocess.run(['git', '-c', 'user.name=Hensei', '-c',
            'user.email=hensei@localhost', '-c', 'core.hooksPath=/dev/null',
            '-C', str(path), *args], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise HenseiError(f'Git {args[0]} failed: {result.stderr[-4000:]}')
        return result.stdout.strip() if '\0' not in result.stdout else result.stdout

    def initialize(self, files: dict[str, str]) -> None:
        if self.repo.exists():
            raise HenseiError('Run repository already exists; resume it instead.')
        for name in files:
            if not safe_relative_path(name):
                raise HenseiError(f'Unsafe generated path: {name}')
        self.repo.mkdir(parents=True)
        self.worktrees.mkdir(parents=True, exist_ok=True)
        self._git(self.repo, 'init', '-b', 'integration')
        for name, content in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self._git(self.repo, 'add', '--all')
        self._git(self.repo, 'commit', '--allow-empty', '-m', 'Hensei initial target scaffold')

    def current_head(self) -> str:
        return self._git(self.repo, 'rev-parse', 'refs/heads/integration')

    def _validate_id(self, task_id: str, attempt: int) -> None:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', task_id) or not isinstance(attempt, int) or attempt < 1:
            raise HenseiError('Invalid task ID or attempt number.')

    def _owned(self, path: Path) -> Path:
        path = path.resolve()
        if path.parent != self.worktrees or not path.exists():
            raise HenseiError('Worktree does not belong to this run.')
        return path

    def create_attempt(self, task_id: str, attempt: int, base_sha: str) -> Path:
        self._validate_id(task_id, attempt)
        base = self._git(self.repo, 'rev-parse', '--verify', f'{base_sha}^{{commit}}')
        name = f'{task_id}-{attempt}-{uuid.uuid4().hex[:12]}'
        path = self.worktrees / name
        self._git(self.repo, 'worktree', 'add', '-b', f'attempt/{name}', str(path), base)
        return path

    def commit_candidate(self, path: Path, task_id: str, attempt: int, allowed_paths: list[str]) -> str:
        self._validate_id(task_id, attempt)
        path = self._owned(path)
        if not allowed_paths or any(not safe_relative_path(p) for p in allowed_paths):
            raise HenseiError('Invalid candidate write scope.')
        changed = set(filter(None, self._git(path, 'diff', 'HEAD', '--name-only', '-z').split('\0')))
        changed.update(filter(None, self._git(path, 'ls-files', '--others', '-z').split('\0')))
        outside = changed - set(allowed_paths)
        if outside:
            raise HenseiError(f'Candidate changed files outside scope: {sorted(outside)}')
        for name in changed:
            if (path / name).is_symlink() or any(parent.is_symlink() for parent in (path / name).parents if parent != path):
                raise HenseiError(f'Symlinks are unsupported candidate files: {name}')
        self._git(path, 'add', '--all')
        self._git(path, 'commit', '--allow-empty', '-m',
                  f'Hensei task {task_id} attempt {attempt}\n\nHensei-Task: {task_id}\nHensei-Attempt: {attempt}')
        return self._git(path, 'rev-parse', 'HEAD')

    def prepare_integration(self, candidate_sha: str) -> Path:
        candidate = self._git(self.repo, 'rev-parse', '--verify', f'{candidate_sha}^{{commit}}')
        path = self.worktrees / f'integrate-{uuid.uuid4().hex}'
        self._git(self.repo, 'worktree', 'add', '--detach', str(path), self.current_head())
        try:
            self._git(path, 'cherry-pick', '--allow-empty', candidate)
        except HenseiError:
            self.discard(path)
            raise
        return path

    def promote(self, path: Path, expected_head: str) -> str:
        path = self._owned(path)
        if self._git(path, 'status', '--porcelain'):
            raise HenseiError('Integration worktree must be clean before promotion.')
        new_head = self._git(path, 'rev-parse', 'HEAD')
        parent = self._git(path, 'rev-parse', 'HEAD^')
        if parent != expected_head:
            raise HenseiError('Integration candidate was built against a different HEAD.')
        self._git(self.repo, 'update-ref', 'refs/heads/integration', new_head, expected_head)
        self._git(self.repo, 'reset', '--hard', new_head)
        return new_head

    def discard(self, path: Path) -> None:
        path = self._owned(path)
        branch = self._git(path, 'symbolic-ref', '--quiet', '--short', 'HEAD') if not path.name.startswith('integrate-') else None
        self._git(self.repo, 'worktree', 'remove', '--force', str(path))
        if branch and branch.startswith('attempt/'):
            self._git(self.repo, 'branch', '-D', branch)
