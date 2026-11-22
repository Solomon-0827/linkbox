import http.client
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch
from urllib.parse import parse_qs, quote, urlsplit

import clash
import network_check


class ClashAdapterTests(unittest.TestCase):
    def test_only_named_operations_send_fixed_routes(self):
        with patch.object(clash, '_request', side_effect=[
            {'mode': 'global'}, {'proxies': {}}, {}, {}, {'delay': 12}, {'delay': 13}, None,
        ]) as transport:
            self.assertEqual(network_check.local_state()['mode'], 'global')
            clash.providers()
            clash.connections(timeout=4)
            self.assertEqual(clash.entry_delay('a/b?c', 'my/provider'), 12)
            self.assertEqual(clash.entry_delay('a/b?c', None), 13)
            clash.switch_entry('a/b?c')

        self.assertFalse(hasattr(clash, 'api'))
        self.assertEqual(transport.call_args_list[:4], [
            call('GET', '/configs', timeout=4, expected_status=200),
            call('GET', '/proxies', timeout=4, expected_status=200),
            call('GET', '/providers/proxies'), call('GET', '/connections', timeout=4, expected_status=None),
        ])
        for request, expected in zip(transport.call_args_list[4:6], [
            '/providers/proxies/my%2Fprovider/a%2Fb%3Fc/healthcheck', '/proxies/a%2Fb%3Fc/delay',
        ]):
            method, route = request.args
            parsed = urlsplit(route)
            self.assertEqual((method, parsed.path), ('GET', expected))
            self.assertEqual(parse_qs(parsed.query)['timeout'], ['3000'])
        self.assertEqual(transport.call_args_list[-1],
                         call('PUT', '/proxies/' + quote(clash.ENTRY, safe=''), {'name': 'a/b?c'}))

    def test_http_errors_report_status_without_reading_the_body(self):
        connection = http.client.HTTPConnection
        with (patch.object(connection, 'request'),
              patch.object(connection, 'getresponse') as receive):
            receive.return_value.status = 401
            self.assertEqual(network_check.safe(network_check.local_state), {'error': 'Clash API HTTP 401'})
            with self.assertRaisesRegex(clash.ClashHTTPError, '^Clash API 返回 401$'):
                clash.providers()
            receive.return_value.read.assert_not_called()

    def test_diagnostics_report_empty_no_content_status(self):
        connection = http.client.HTTPConnection
        with (patch.object(connection, 'request'),
              patch.object(connection, 'getresponse') as receive,
              patch.object(network_check, 'run', side_effect=['123 claude', ''])):
            receive.return_value.status = 204
            receive.return_value.read.return_value = b''
            for diagnostic in (network_check.local_state, network_check.claude_connections):
                with self.subTest(diagnostic=diagnostic.__name__):
                    self.assertEqual(network_check.safe(diagnostic), {'error': 'Clash API HTTP 204'})
            receive.return_value.read.assert_not_called()

    def test_controller_preserves_ordinary_and_diagnostic_request_headers(self):
        connection = http.client.HTTPConnection
        with (patch.object(connection, 'request') as send,
              patch.object(connection, 'getresponse') as receive,
              patch.object(network_check, 'run', side_effect=['123 claude', ''])):
            receive.return_value.status = 200
            receive.return_value.read.side_effect = [
                b'{}', b'{"proxies": {}}', b'{}',
                b'{}', b'{"proxies": {}}', b'{}', b'{"delay": 12}', b'',
            ]
            network_check.local_state()
            network_check.claude_connections()
            clash.state()
            clash.providers()
            clash.entry_delay('fast', 'fixture')
            clash.switch_entry('fast')

        self.assertEqual(send.call_args_list[:3], [
            call('GET', route) for route in ('/configs', '/proxies', '/connections')
        ])
        headers = {'Content-Type': 'application/json'}
        self.assertEqual(send.call_args_list[3:6], [
            call('GET', route, None, headers) for route in ('/configs', '/proxies', '/providers/proxies')
        ])
        self.assertEqual(send.call_args_list[6].args[2:], (None, headers))
        self.assertEqual(send.call_args, call('PUT', '/proxies/' + quote(clash.ENTRY, safe=''),
                                             b'{"name": "fast"}', headers))

    def test_reload_validates_the_exact_payload_before_guard_and_write(self):
        payload = b'proxies: []'
        events = []

        def validate(args, **options):
            events.append('validate')
            self.assertEqual(args[1:4], ['-t', '-d', str(root)])
            self.assertEqual(Path(args[-1]).read_bytes(), payload)
            self.assertEqual(options, {'capture_output': True, 'timeout': 30, 'check': True})

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (patch.object(clash.subprocess, 'run', side_effect=validate) as validator,
                  patch.object(clash, '_request', side_effect=lambda *_: events.append('send')) as transport):
                clash.reload(root, payload, lambda: events.append('prepare'), lambda: self.fail('rollback'))
                self.assertEqual(events, ['validate', 'prepare', 'send'])
                transport.assert_called_once_with('PUT', '/configs?force=false', {'payload': payload.decode()})
                transport.reset_mock()
                validator.side_effect = subprocess.CalledProcessError(1, 'mihomo', stderr=b'password: fixture-only')
                with self.assertRaisesRegex(RuntimeError, '^配置校验失败，未改动当前代理$'):
                    clash.reload(root, payload, lambda: self.fail('prepare'), lambda: self.fail('rollback'))
                transport.assert_not_called()
                self.assertEqual(list(root.iterdir()), [])

    def test_post_reload_persistence_compares_profiles_before_staging(self):
        original = b'current: active\nitems: [{uid: active}]\n'
        with tempfile.TemporaryDirectory() as directory:
            profiles = Path(directory) / 'profiles.yaml'
            profiles.write_bytes(original)
            mkstemp = tempfile.mkstemp

            def edit_while_staging(*args, **kwargs):
                profiles.write_bytes(original.replace(b'current: active', b'current: other'))
                return mkstemp(*args, **kwargs)

            with patch.object(clash.tempfile, 'mkstemp', side_effect=edit_while_staging):
                clash.persist_selection(profiles, 'new')

            self.assertIn(b'current: active\n', profiles.read_bytes())
            self.assertIn(b'now: new\n', profiles.read_bytes())

    def test_persistence_does_not_replace_a_concurrent_edit(self):
        original = b'current: active\nitems: [{uid: active}]\n'
        concurrent = original + b'# edited by Verge\n'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profiles = root / 'profiles.yaml'
            profiles.write_bytes(original)

            mkstemp = tempfile.mkstemp

            def edit_profiles_before_guard(*args, **kwargs):
                profiles.write_bytes(concurrent)
                return mkstemp(*args, **kwargs)

            with patch.object(clash.tempfile, 'mkstemp', side_effect=edit_profiles_before_guard) as make_temp:
                with self.assertRaisesRegex(RuntimeError, '同时更新'):
                    clash.persist_selection(profiles, 'new', backup_dir=root / 'backups')
                make_temp.assert_called_once_with(prefix='.toolbox-', dir=root)
            self.assertEqual(profiles.read_bytes(), concurrent)
            self.assertEqual([p.read_bytes() for p in (root / 'backups').iterdir()], [original])
            self.assertEqual(list(root.glob('.toolbox-*')), [])
