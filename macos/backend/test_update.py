import json
from pathlib import Path
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import yaml

import runtime
import subscription_picker as picker
import subscription_update as update
import toolbox as t


def node(name, server='relay.example.invalid'):
    return {'name': name, 'type': 'ss', 'server': server, 'port': 443}


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
        self.api = stack.enter_context(patch.object(t, 'api', side_effect=self.controller))
        stack.enter_context(patch.object(t, 'relay_state', side_effect=lambda: self.active.copy()))
        self.downloaded = {}
        self.fetch = stack.enter_context(patch.object(update, 'fetch', side_effect=self.download))

    def write_profile(self, owner, names):
        (self.root / 'profiles' / (owner + '.yaml')).write_bytes(update.dump({'proxies': [node(n) for n in names]}))

    def download(self, url):
        owner = url.rsplit('/', 1)[-1]
        return {'proxies': [node(n) for n in self.downloaded[owner]]}

    def controller(self, method, route, body):
        self.assertEqual(method, 'PUT')
        self.requests.append(route)
        if route == '/configs?force=false':
            self.reload = yaml.safe_load(body['payload'])
            group = self.reload['proxy-groups'][0]
            names = [n['name'] for owner in group['use']
                     for n in self.reload['proxy-providers'][owner]['payload']]
            self.assertEqual(group['proxies'], [])
            self.active.update(live=names)
            if self.active['entry'] not in names:
                self.active.update(entry=names[0])
        else:
            self.assertEqual(route, '/proxies/' + update.urllib.parse.quote(t.ENTRY, safe=''))
            self.assertIn(body['name'], self.active['live'])
            self.active.update(entry=body['name'])

    def apply(self, selection, metric='chain'):
        catalog = picker.catalog()
        return picker.apply({'fingerprint': catalog['fingerprint'], 'current': catalog['current'],
                             'selected': selection}, metric)

    def files(self):
        return {str(file.relative_to(self.base)): file.read_bytes() for file in self.base.rglob('*')
                if file.is_file() and file.name != 'latency.lock'}


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

    def test_save_switches_after_reload_by_configured_metric_and_persists(self):
        result = {'results': {'fast': {'chain_delay': 10, 'delay': 90, 'owner': 'a'},
                              'quick': {'chain_delay': 30, 'delay': 20, 'owner': 'a'}}}
        (self.base / 'chain-results.json').write_text(json.dumps(result))
        self.apply({'a': ['fast', 'quick'], 'b': []}, 'entrance')
        self.assertEqual(self.requests[0], '/configs?force=false')
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.active['entry'], 'quick')
        self.assertEqual(yaml.safe_load(self.index.read_bytes())['items'][0]['selected'],
                         [{'name': t.ENTRY, 'now': 'quick'}])
        self.assertTrue(all(p['type'] == 'inline' for p in self.reload['proxy-providers'].values()))
        self.assertTrue(all(p['type'] == 'http' for p in yaml.safe_load(self.config.read_bytes())['proxy-providers'].values()))
        self.fetch.assert_not_called()

    def test_empty_or_vanished_selection_leaves_files_and_controller_untouched(self):
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
        self.assertEqual(self.files(), before)
        self.assertEqual(self.requests, [])

    def test_first_run_fetches_before_seeding_and_drops_legacy_data_without_backup(self):
        self.policy.write_text(json.dumps({'blocked_providers': ['a'], 'excluded_nodes': {'*': ['fast']},
                                           'pinned_entry': 'current'}))
        (self.root / 'profiles/Script.js').write_text('function main(c) { return c; }\n' + update.MARK)
        self.downloaded = {'a': ['current', 'fast', 'new'], 'b': ['fast']}
        self.assertTrue(picker.initialize())
        self.assertFalse(picker.initialize())
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(json.loads(self.policy.read_bytes()), {
            'selected_nodes': {'a': ['current', 'fast']}, 'provider_labels': {'a': 'A', 'b': 'B'}})
        self.assertFalse(any((self.base / 'backups').rglob('*node-policy.json')))
        self.assertFalse(any(n['name'] == 'current' for n in self.reload['proxies']))

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
        before = self.files()
        self.api.side_effect = RuntimeError('offline')
        with self.assertRaisesRegex(RuntimeError, '文件已回退'):
            self.apply({'a': ['fast'], 'b': []})
        self.api.assert_called_once()
        self.assertEqual(self.api.call_args.args[1], '/configs?force=false')
        self.assertEqual({k: v for k, v in self.files().items() if not k.startswith('backups/')}, before)

    def test_confirmed_reload_with_unconfirmed_switch_reports_failure(self):
        (self.base / 'chain-results.json').write_text(json.dumps({'results': {'quick': {'chain_delay': 20}}}))
        def ignore_switch(method, route, body):
            if route == '/configs?force=false':
                self.controller(method, route, body)
        self.api.side_effect = ignore_switch
        with self.assertRaisesRegex(RuntimeError, '切换后的状态待核对'):
            self.apply({'a': ['fast', 'quick'], 'b': []})
        self.assertEqual(self.api.call_count, 2)
        self.assertEqual(self.active['entry'], 'fast')
        self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'a': ['fast', 'quick']})
