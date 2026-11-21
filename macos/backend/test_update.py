import json
import os
from pathlib import Path
from subprocess import run as run_process
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch
from urllib.parse import quote

import yaml

import gui_backend as gui
import runtime
import subscription_picker as picker
import subscription_update as update
import toolbox as t

ENTRY_ROUTE = '/proxies/' + quote(t.ENTRY, safe='')


def node(name, server='relay.example.invalid'):
    return {'name': name, 'type': 'ss', 'server': server, 'port': 443,
            'cipher': 'aes-128-gcm', 'password': 'fixture'}


class SubscriptionFixture:
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.root = self.base / 'verge'
        (self.root / 'profiles').mkdir(parents=True)
        self.config = self.root / 'clash-verge.yaml'
        self.policy = self.base / 'node-policy.json'
        self.index = self.root / 'profiles.yaml'
        self.active = {'mode': 'global', 'tun': True, 'entry': 'current', 'exit': t.EXIT,
                       'dialer': t.ENTRY, 'live': ['current', 'fast']}
        self.config.write_bytes(update.dump({
            'proxies': [node('current'), {**node(t.EXIT, '203.0.113.10'), 'dialer-proxy': t.ENTRY}],
            'proxy-groups': [{'name': t.ENTRY, 'type': 'select', 'proxies': ['current', 'fast']}],
        }))
        self.sources = [
            {'name': 'a', 'display_name': 'A', 'url': 'https://example.invalid/a'},
            {'name': 'b', 'display_name': 'B', 'url': 'https://example.invalid/b'},
        ]
        self.index.write_bytes(update.dump({'current': 'a', 'items': [
            {'uid': s['name'], 'type': 'remote', 'name': s['display_name'], 'url': s['url'],
             'file': s['name'] + '.yaml'} for s in self.sources
        ]}))
        self.write_profile('a', ['current', 'fast', 'quick'])
        self.write_profile('b', ['same', 'other'])
        (self.base / 'subscriptions.json').write_text(json.dumps({'sources': self.sources}))
        stack = ExitStack()
        self.addCleanup(stack.close)
        for obj, key, value in [(runtime, 'BASE', self.base), (t, 'BASE', self.base),
                                (runtime, 'CONFIG_DIR', self.root)]:
            stack.enter_context(patch.object(obj, key, value))
        self.validate = stack.enter_context(patch.object(update.subprocess, 'run'))
        self.requests = []
        self.reload = None
        self.providers = {
            t.ENTRY: {'vehicleType': 'Compatible', 'proxies': [node('current')]},
            'a': {'vehicleType': 'HTTP', 'proxies': [node('fast')]},
        }
        self.at_reload = []
        self.api = stack.enter_context(patch.object(t, 'api', side_effect=self.controller))
        stack.enter_context(patch.object(t, 'relay_state', side_effect=lambda: self.active.copy()))
        self.downloaded = {}
        self.fetch = stack.enter_context(patch.object(update, 'fetch', side_effect=self.download))

    def write_profile(self, owner, names):
        (self.root / 'profiles' / (owner + '.yaml')).write_bytes(update.dump({'proxies': [node(n) for n in names]}))

    def download(self, url):
        owner = url.rsplit('/', 1)[-1]
        return {'proxies': [node(n) for n in self.downloaded[owner]]}

    def controller(self, method, route, body=None):
        if (method, route) == ('GET', '/providers/proxies'):
            return {'providers': self.providers}
        self.assertEqual(method, 'PUT')
        self.requests.append(route)
        if route == '/configs?force=false':
            self.at_reload.append(self.active['entry'])
            self.reload = yaml.safe_load(body['payload'])
            group = self.reload['proxy-groups'][0]
            names = [n['name'] for owner in group['use']
                     for n in self.reload['proxy-providers'][owner]['payload']]
            self.assertEqual(group['proxies'], [])
            self.providers = {owner: {'proxies': p['payload'], 'vehicleType': 'Inline',
                                      'testUrl': p.get('health-check', {}).get('url')}
                              for owner, p in self.reload['proxy-providers'].items()}
            self.active.update(live=names)
            if self.active['entry'] not in names:
                self.active.update(entry=names[0])
        else:
            self.assertEqual(route, ENTRY_ROUTE)
            self.assertIn(body['name'], self.active['live'])
            self.active.update(entry=body['name'])

    def apply(self, selection, metric='chain'):
        catalog = picker.catalog()
        return picker.apply({'fingerprint': catalog['fingerprint'], 'current': catalog['current'],
                             'selected': selection}, metric)

    def files(self):
        return {str(file.relative_to(self.base)): file.read_bytes() for file in self.base.rglob('*')
                if file.is_file() and file.name != 'latency.lock'}

    def legacy(self, policy):
        self.policy.write_text(json.dumps({**policy, 'pinned_entry': 'current'}))
        (self.root / 'profiles/Script.js').write_text(
            'function main(c) { return c; }\n' + update.MARK +
            '\nmain=function(r){const m=' + json.dumps({'pin': node('current')}) +
            ';r["proxy-providers"]={};return r;};\n')


class UpdateTests(SubscriptionFixture, unittest.TestCase):
    def test_sync_uses_saved_selection_and_deletes_vanished_nodes_and_sources(self):
        self.apply({'a': ['current', 'fast', 'quick'], 'b': ['other']})
        index = yaml.safe_load(self.index.read_bytes())
        index['items'].pop()
        self.index.write_bytes(update.dump(index))
        self.active.update(entry='external', live=['external'])
        self.downloaded = {'a': ['fast', 'quick', 'brand-new']}
        picker.synchronize()
        saved = json.loads(self.policy.read_bytes())
        self.assertEqual(saved['selected_nodes'], {'a': ['fast', 'quick']})
        self.assertEqual(self.active['entry'], 'fast')
        self.assertEqual(set(self.reload['proxy-providers']), {'a'})
        self.assertEqual([n['name'] for n in self.reload['proxy-providers']['a']['payload']], ['fast', 'quick'])
        self.assertIn('brand-new', (self.root / 'profiles/a.yaml').read_text())

    def test_absent_benchmark_winner_is_first_at_reload_and_persisted(self):
        result = {'results': {'fast': {'chain_delay': 10, 'delay': 90, 'owner': 'a'},
                              'other': {'chain_delay': 30, 'delay': 20, 'owner': 'b'}}}
        (self.base / 'chain-results.json').write_text(json.dumps(result))
        self.apply({'a': ['fast'], 'b': ['same', 'other']}, 'entrance')
        self.assertEqual(self.requests, ['/configs?force=false'])
        self.assertEqual(self.reload['proxy-groups'][0]['use'], ['b', 'a'])
        self.assertEqual(self.reload['proxy-providers']['b']['payload'][0]['name'], 'other')
        self.assertEqual(self.active['entry'], 'other')
        self.assertEqual(yaml.safe_load(self.index.read_bytes())['items'][0]['selected'],
                         [{'name': t.ENTRY, 'now': 'other'}])
        self.assertTrue(all(p['type'] == 'inline' for p in self.reload['proxy-providers'].values()))
        self.assertTrue(all(p['type'] == 'http' for p in yaml.safe_load(self.config.read_bytes())['proxy-providers'].values()))
        self.fetch.assert_not_called()

    def test_present_owned_winner_switches_before_reload(self):
        self.apply({'a': ['fast', 'quick'], 'b': []})
        self.assertEqual(self.requests, [ENTRY_ROUTE, '/configs?force=false'])
        self.assertEqual(self.at_reload, ['fast'])
        self.assertEqual(self.active['entry'], 'fast')

    def test_empty_selection_refuses_and_all_vanished_can_recover_in_picker(self):
        before = self.files()
        with self.assertRaisesRegex(RuntimeError, '没有你勾选'):
            self.apply({'a': [], 'b': []})
        self.assertEqual(self.files(), before)
        self.apply({'a': ['current'], 'b': []})
        self.downloaded = {'a': ['new'], 'b': ['new']}
        before = self.files()
        self.requests.clear()
        with self.assertRaisesRegex(RuntimeError, '没有你勾选'):
            picker.synchronize()
        self.assertEqual({k: v for k, v in self.files().items() if k != 'subscription-preview.yaml'}, before)
        self.assertEqual(self.requests, [])
        fresh = picker.catalog()
        self.assertEqual([[n['name'] for n in s['nodes']] for s in fresh['sources']], [['new'], ['new']])
        picker.apply({'fingerprint': fresh['fingerprint'], 'current': fresh['current'],
                      'selected': {'a': ['new'], 'b': []}})
        self.assertEqual(self.active['entry'], 'new')
        self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'a': ['new']})
        self.assertEqual(yaml.safe_load((self.root / 'profiles/a.yaml').read_bytes())['proxies'], [node('new')])

    def test_first_run_fetches_before_seeding_and_drops_legacy_data_without_backup(self):
        self.legacy({'blocked_providers': ['a'], 'excluded_nodes': {'*': ['fast']}})
        (self.root / 'profiles/a.yaml').write_text('proxies: [')
        self.downloaded = {'a': ['current', 'fast', 'new'], 'b': ['fast']}
        self.assertTrue(picker.initialize())
        self.assertFalse(picker.initialize())
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(json.loads(self.policy.read_bytes()), {
            'selected_nodes': {'a': ['current', 'fast']}, 'provider_labels': {'a': 'A', 'b': 'B'}})
        self.assertFalse(any((self.base / 'backups').rglob('*node-policy.json')))
        self.assertFalse(any(n['name'] == 'current' for n in self.reload['proxies']))

    def test_startup_retries_after_download_failure(self):
        self.fetch.side_effect = RuntimeError('下载失败')
        with patch('sys.argv', ['gui_backend.py', 'startup', 'chain']), patch.object(
                gui, 'snapshot', return_value={}), patch('builtins.print') as output:
            gui.main()
            failed = json.loads(output.call_args.args[0])
            self.assertFalse(failed['startup_checked'])
            self.assertFalse(self.policy.exists())
            self.fetch.side_effect = self.download
            self.downloaded = {'a': ['current', 'fast'], 'b': ['other']}
            gui.main()
            retried = json.loads(output.call_args.args[0])
        self.assertTrue(retried['startup_checked'])
        self.assertTrue(retried['initialized'])

    def test_upgrade_with_saved_selection_cleans_pin_and_switches_once(self):
        self.legacy({'selected_nodes': {'a': ['fast']}})
        self.assertTrue(picker.initialize())
        self.assertEqual(self.active['entry'], 'fast')
        self.assertFalse(any(n['name'] == 'current' for n in self.reload['proxies']))
        self.assertNotIn('pinned_entry', json.loads(self.policy.read_text()))
        self.assertFalse(picker.initialize())
        self.assertEqual(self.requests.count('/configs?force=false'), 1)
        self.fetch.assert_not_called()

    def test_other_group_keeps_static_reference_and_entry_uses_owner_once(self):
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-groups'][0]['proxies'] = ['current']
        config['proxy-groups'].append({'name': 'secondary', 'type': 'select', 'proxies': ['current']})
        self.config.write_bytes(update.dump(config))
        self.write_profile('a', ['current'])
        if core := os.environ.get('LINKBOX_TEST_CORE'):
            self.validate.side_effect = lambda argv, **kwargs: run_process([core, *argv[1:]], **kwargs)
        self.apply({'a': ['current'], 'b': []})
        self.assertIn(node('current'), self.reload['proxies'])
        self.assertEqual(self.reload['proxy-groups'][1]['proxies'], ['current'])
        self.assertEqual(self.active['live'], ['current'])
        self.assertEqual([n['name'] for n in self.providers['a']['proxies']], ['current'])

    def test_validation_and_external_changes_leave_files_untouched(self):
        before = self.files()
        self.validate.side_effect = update.subprocess.CalledProcessError(1, 'mihomo')
        with self.assertRaisesRegex(RuntimeError, '校验失败'):
            self.apply({'a': ['fast'], 'b': []})
        self.validate.side_effect = lambda *args, **kwargs: self.active.update(entry='external')
        with self.assertRaisesRegex(RuntimeError, '其他操作改变'):
            self.apply({'a': ['fast'], 'b': []})
        self.assertEqual(self.files(), before)
        self.api.assert_not_called()

    def test_failed_reload_restores_files_without_switching(self):
        self.providers = {}
        before = self.files()
        def reject_reload(method, route, body=None):
            if method == 'PUT':
                self.requests.append(route)
                raise RuntimeError('offline')
            return self.controller(method, route, body)
        self.api.side_effect = reject_reload
        with self.assertRaisesRegex(RuntimeError, '文件已回退'):
            self.apply({'a': ['fast'], 'b': []})
        self.assertEqual(self.requests, ['/configs?force=false'])
        self.assertEqual({k: v for k, v in self.files().items() if not k.startswith('backups/')}, before)

    def test_lost_reload_response_keeps_new_files_with_unchanged_group(self):
        self.apply({'a': ['current', 'fast'], 'b': []})
        active_before = self.active.copy()
        self.downloaded = {'a': ['current', 'fast', 'new'], 'b': ['other']}
        def lose_response(method, route, body=None):
            result = self.controller(method, route, body)
            if route == '/configs?force=false':
                raise RuntimeError('response lost')
            return result
        self.api.side_effect = lose_response
        picker.synchronize()
        self.assertEqual(self.active, active_before)
        self.assertIn('new', (self.root / 'profiles/a.yaml').read_text())

    def test_unobservable_reload_keeps_new_files_and_requests_refresh(self):
        def lose_reads(method, route, body=None):
            if self.reload is not None:
                raise RuntimeError('offline')
            result = self.controller(method, route, body)
            if route == '/configs?force=false':
                raise RuntimeError('response lost')
            return result
        self.api.side_effect = lose_reads
        with self.assertRaisesRegex(RuntimeError, '无法确认.*已保留.*请刷新'):
            self.apply({'a': ['quick'], 'b': []})
        self.assertEqual(self.active['entry'], 'quick')
        self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'a': ['quick']})

    def test_switch_retries_once_after_fresh_read_and_keeps_applied_config(self):
        (self.base / 'chain-results.json').write_text(json.dumps({'results': {'quick': {'chain_delay': 20}}}))
        for recover in (True, False):
            with self.subTest(recover=recover):
                self.active.update(entry='current', live=['current', 'fast'])
                self.requests.clear()
                calls = []
                def flaky_switch(method, route, body=None):
                    calls.append((method, route))
                    if method == 'PUT' and route == ENTRY_ROUTE:
                        if not recover or self.requests.count(route) == 0:
                            self.requests.append(route)
                            raise RuntimeError('switch failed')
                    result = self.controller(method, route, body)
                    if route == '/configs?force=false':
                        self.active.update(entry='fast')
                    return result
                self.api.side_effect = flaky_switch
                def observe():
                    calls.append(('GET', 'state'))
                    return self.active.copy()
                with patch.object(t, 'relay_state', side_effect=observe):
                    if recover:
                        self.apply({'a': ['fast', 'quick'], 'b': []})
                    else:
                        with self.assertRaisesRegex(RuntimeError, '配置已更新，但无法切换'):
                            self.apply({'a': ['fast', 'quick'], 'b': []})
                self.assertEqual(self.requests, ['/configs?force=false', ENTRY_ROUTE, ENTRY_ROUTE])
                first = calls.index(('PUT', ENTRY_ROUTE))
                self.assertEqual(calls[first + 1:first + 3], [('GET', 'state'), ('GET', '/providers/proxies')])
                self.assertEqual(self.active['entry'], 'quick' if recover else 'fast')
                self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'a': ['fast', 'quick']})
