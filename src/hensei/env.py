"""Load the local DeepSeek credential without executing shell expressions."""
from __future__ import annotations

import os
from pathlib import Path

from .models import HenseiError


def load_env_file(path: Path) -> bool:
    """Load DEEPSEEK_API_KEY if absent from the process environment.

    Supports a single-line value, optional matching quotes, and comment lines.
    Other variables are ignored. Values are never included in errors or logs.
    """
    if 'DEEPSEEK_API_KEY' in os.environ or not path.exists():
        return False
    if not path.is_file() or path.stat().st_size > 65536:
        raise HenseiError('The environment file must be a regular file smaller than 64 KiB')
    for number, raw in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        name, separator, value = line.partition('=')
        if name.strip() != 'DEEPSEEK_API_KEY':
            continue
        if not separator:
            raise HenseiError(f'Invalid API key assignment in environment file at line {number}')
        value = value.strip()
        if value.startswith(('"', "'")):
            if len(value) < 2 or value[-1] != value[0]:
                raise HenseiError(f'Unclosed API key quotes in environment file at line {number}')
            value = value[1:-1]
        if not value:
            return False
        if any(character.isspace() for character in value):
            raise HenseiError(f'API key must be a single value without whitespace (line {number})')
        os.environ['DEEPSEEK_API_KEY'] = value
        return True
    return False
