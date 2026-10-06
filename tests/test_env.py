import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from hensei.env import load_env_file
from hensei.models import HenseiError


class EnvTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / '.env'
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_plain_and_quoted_key(self):
        for value in ('test-key', '"test-key"', "'test-key'"):
            with self.subTest(value=value):
                os.environ.pop('DEEPSEEK_API_KEY', None)
                self.path.write_text('# comment\nOTHER=ignored\nDEEPSEEK_API_KEY=' + value + '\n')
                self.assertTrue(load_env_file(self.path))
                self.assertEqual(os.environ['DEEPSEEK_API_KEY'], 'test-key')
                self.assertNotIn('OTHER', os.environ)

    def test_existing_environment_takes_precedence(self):
        self.path.write_text('DEEPSEEK_API_KEY=file-value\n')
        os.environ['DEEPSEEK_API_KEY'] = 'environment-value'
        self.assertFalse(load_env_file(self.path))
        self.assertEqual(os.environ['DEEPSEEK_API_KEY'], 'environment-value')

    def test_empty_or_missing_is_not_loaded(self):
        self.assertFalse(load_env_file(self.path))
        self.path.write_text('DEEPSEEK_API_KEY=\n')
        self.assertFalse(load_env_file(self.path))
        self.assertNotIn('DEEPSEEK_API_KEY', os.environ)

    def test_invalid_value_error_does_not_expose_value(self):
        self.path.write_text('DEEPSEEK_API_KEY="private-value\n')
        with self.assertRaises(HenseiError) as error:
            load_env_file(self.path)
        self.assertNotIn('private-value', str(error.exception))
        self.assertNotIn('DEEPSEEK_API_KEY', os.environ)
