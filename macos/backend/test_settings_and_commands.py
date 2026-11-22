from io import StringIO
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch

import gui_backend
import runtime
from settings import SettingsError
from subscription_picker import merge_selection_draft

ROOT = Path(__file__).resolve().parents[2]


class Commands(unittest.TestCase):
    def test_every_swift_command_has_a_gui_handler_and_a_caller(self):
        source = (ROOT / 'macos/Toolbox.swift').read_text()
        enum = re.search(r'enum BackendCommand: String \{([^}]+)\}', source)[1]
        names = re.findall(r'case (\w+) = "([\w-]+)"', enum)
        self.assertEqual(len(names), len(set(command for _, command in names)))
        swift_commands = {command for _, command in names}
        direct_commands = {'self-test', 'status', 'latency'}
        self.assertFalse(swift_commands & direct_commands)
        self.assertEqual(swift_commands | direct_commands, set(gui_backend.COMMANDS))
        calls = set(re.findall(r'(?:invoke|runBackend)\(\.(\w+)', source))
        calls.update(re.findall(r'p\.arguments=\[BackendCommand\.(\w+)\.rawValue\]', source))
        self.assertEqual(calls, {name for name, _ in names})


class Settings(unittest.TestCase):
    def test_shared_fixtures(self):
        fixtures = sorted((ROOT / 'fixtures/settings').glob('*.json'))
        self.assertTrue(fixtures)
        for path in fixtures:
            case = json.loads(path.read_text())
            values = case['input']
            with self.subTest(path=path.name), patch('sys.stdin', StringIO(json.dumps(values))):
                if 'error' in case:
                    with self.assertRaises(SettingsError) as error:
                        gui_backend.read_benchmark_settings('--save')
                    self.assertEqual(str(error.exception), case['error'])
                    continue
                actual = gui_backend.read_benchmark_settings()['settings']
                config = {'proxies': [{'name': gui_backend.t.EXIT, 'server': case.get('configuredIP', '')}]}
                with patch.object(runtime, 'read_json', return_value={'expected_ip': values.get('expectedIP')}):
                    actual['expectedIP'] = runtime.expected_ip(config)
                self.assertEqual(actual, case['output'])


class SelectionDraft(unittest.TestCase):
    def test_draft_refresh_preserves_catalog_order_and_explicit_owner(self):
        case = json.loads((ROOT / 'fixtures/selection-draft/refresh.json').read_text())
        before = json.dumps(case['catalog'])
        self.assertEqual(merge_selection_draft(case['catalog'], case['changes']), case['output'])
        self.assertEqual(json.dumps(case['catalog']), before)
