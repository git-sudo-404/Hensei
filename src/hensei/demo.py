"""Scripted, zero-inference demonstration of the orchestration mechanics."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
import re


class DemoProvider:
    model = 'scripted-demo-no-inference'

    def __init__(self, task, translations: Path, *, inject_failure=False, delay=0.15):
        self.task, self.translations = task, translations
        self.inject_failure, self.delay = inject_failure, delay
        self.turn = 0

    async def complete(self, messages, tools, max_output_tokens):
        await asyncio.sleep(self.delay)
        self.turn += 1
        calls = []
        if self.turn == 1:
            for index, path in enumerate(self.task.target_paths):
                content = (self.translations / Path(path).name).read_text()
                if self.inject_failure and index == 0:
                    content, count = re.subn(r'return [^\n]+', 'return 999999', content, count=1)
                    if not count:
                        raise ValueError('Demo failure injection requires an integer return statement')
                calls.append({'id': f'write-{index}', 'type': 'function', 'function': {
                    'name': 'write_target', 'arguments': json.dumps({'path': path, 'content': content})}})
        else:
            calls.append({'id': f'submit-{self.turn}', 'type': 'function', 'function': {
                'name': 'submit', 'arguments': json.dumps({'summary': 'Installed prerecorded demo translation.'})}})
        return {'model': self.model, 'choices': [{'message': {'role': 'assistant', 'content': None, 'tool_calls': calls}}],
                'usage': {'prompt_tokens': 0, 'completion_tokens': 0}}
