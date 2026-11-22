from io import StringIO
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory
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
    def test_expected_ip_loads_v130_values_from_disk(self):
        with TemporaryDirectory() as folder, patch.object(runtime, 'BASE', Path(folder)):
            settings_file = Path(folder) / 'settings.json'
            for value, expected in [(3405803786, '203.0.113.10'), (4294967296, '::1:0:0'),
                                    (True, '0.0.0.1'), (False, '192.0.2.1'),
                                    ('2001:0DB8::1', '2001:db8::1'), ('exit.example.invalid', ''),
                                    (3405803786.0, '')]:
                with self.subTest(value=value):
                    contents = json.dumps({'expected_ip': value})
                    settings_file.write_text(contents)
                    config = {'proxies': [{'name': gui_backend.t.EXIT, 'server': '192.0.2.1'}]}
                    self.assertEqual(runtime.expected_ip(config), expected)
                    self.assertEqual(settings_file.read_text(), contents)

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
    def check_draft_fixture(self, name):
        case = json.loads((ROOT / 'fixtures/selection-draft' / name).read_text())
        before = json.dumps(case['catalog'])
        self.assertEqual(merge_selection_draft(case['catalog'], case['changes']), case['output'])
        self.assertEqual(json.dumps(case['catalog']), before)

    def test_draft_refresh_preserves_catalog_order_and_explicit_owner(self):
        self.check_draft_fixture('refresh.json')

    def test_draft_refresh_keeps_distinct_relay_names_selected(self):
        self.check_draft_fixture('exact-relay-names.json')
