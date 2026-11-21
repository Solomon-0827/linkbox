import errno
import io
import json
import os
from pathlib import Path
import re
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
            'proxies': [node('current'), node('fast'), {**node(t.EXIT, '203.0.113.10'), 'dialer-proxy': t.ENTRY}],
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
        self.keep_stale_entry = False
        self.real_api = t.api
        self.api = stack.enter_context(patch.object(t, 'api', side_effect=self.controller))
        stack.enter_context(patch.object(t, 'relay_state', side_effect=lambda **_: self.active.copy()))
        self.downloaded = {}
        self.fetch = stack.enter_context(patch.object(update, 'fetch', wraps=update.fetch, side_effect=self.download))

    def write_profile(self, owner, names):
        (self.root / 'profiles' / (owner + '.yaml')).write_bytes(update.dump({'proxies': [node(n) for n in names]}))

    def download(self, url):
        owner = url.rsplit('/', 1)[-1]
        return {'proxies': [node(n) for n in self.downloaded[owner]]}

    def controller(self, method, route, body=None, **_):
        if (method, route) == ('GET', '/providers/proxies'):
            return {'providers': self.providers}
        if (method, route) == ('GET', '/configs'):
            return {'mode': self.active['mode'], 'tun': {'enable': self.active['tun']}}
        if (method, route) == ('GET', '/proxies'):
            return {'proxies': {'GLOBAL': {'now': self.active['exit']}, t.EXIT: {'dialer-proxy': self.active['dialer']},
                                t.ENTRY: {'now': self.active['entry'], 'all': self.active['live']}}}
        self.assertEqual(method, 'PUT')
        self.requests.append(route)
        if route == '/configs?force=false':
            self.at_reload.append(self.active['entry'])
            self.reload = yaml.safe_load(body['payload'])
            group = self.reload['proxy-groups'][0]
            names = list(group['proxies'])
            for owner in group['use']:
                provider = self.reload['proxy-providers'][owner]
                names.extend(n['name'] for n in provider['payload']
                             if re.search(provider.get('filter') or '.', n['name'])
                             and not re.search(provider.get('exclude-filter') or '(?!)', n['name']))
            self.assertEqual(group['proxies'], [])
            self.providers = {owner: {'proxies': p.get('payload', []), 'vehicleType': 'Inline'}
                              for owner, p in self.reload['proxy-providers'].items()}
            self.active.update(live=names)
            if not self.keep_stale_entry and self.active['entry'] not in names:
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
    def test_switch_unmanaged_entry_with_implicit_members(self):
        for flag in ('include-all-providers', 'include-all-proxies', 'include-all'):
            with self.subTest(flag=flag):
                self.active['entry'] = 'current'
                config = {
                    'proxies': [node('current'), node('static-fast'), node('static-slow'), node('static-drop')],
                    'proxy-providers': {'a': {'type': 'inline',
                        'payload': [node('provider-fast'), node('provider-slow'), node('provider-drop'),
                                    node('provider-hidden')], 'exclude-filter': 'hidden'}},
                    'proxy-groups': [{'name': t.ENTRY, 'type': 'select', 'proxies': ['current'],
                                      flag: True, 'filter': 'fast|drop|hidden', 'exclude-filter': 'drop'}],
                }
                self.config.write_bytes(update.dump(config))
                self.active['live'] = ['current']
                if flag != 'include-all-providers':
                    self.active['live'].append('static-fast')
                if flag != 'include-all-proxies':
                    self.active['live'].append('provider-fast')
                target = self.active['live'][-1]
                with patch.object(t, 'persist_selection'):
                    self.assertEqual(gui.change(target, 'current')['state']['entry'], target)

    def test_unmanaged_switch_with_unsupported_group_filter_uses_live_names(self):
        config = yaml.safe_load(self.config.read_bytes())
        config['proxies'][:2] = [node('入口甲'), node('入口乙')]
        config['proxy-groups'][0] = {'name': t.ENTRY, 'type': 'select',
                                     'include-all-proxies': True, 'filter': r'\p{Han}'}
        self.config.write_bytes(update.dump(config))
        if core := os.environ.get('LINKBOX_TEST_CORE'):
            run_process([core, '-t', '-d', str(self.root), '-f', str(self.config)],
                        capture_output=True, timeout=10, check=True)
        self.active.update(entry='入口甲', live=['入口甲', '入口乙'])
        with patch.object(t, 'persist_selection'):
            with self.assertRaisesRegex(RuntimeError, '节点状态已变化'):
                gui.change(t.EXIT, '入口甲')
            self.assertEqual(gui.change('入口乙', '入口甲')['state']['entry'], '入口乙')
        self.assertEqual(self.requests, [ENTRY_ROUTE])

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

    def test_benchmark_winner_switches_after_reload_in_subscription_order(self):
        self.keep_stale_entry = True
        result = {'results': {'fast': {'chain_delay': 10, 'delay': 90, 'owner': 'a'},
                              'other': {'chain_delay': 30, 'delay': 20, 'owner': 'b'}}}
        (self.base / 'chain-results.json').write_text(json.dumps(result))
        self.apply({'a': ['fast'], 'b': ['same', 'other']}, 'entrance')
        self.assertEqual(self.requests, ['/configs?force=false', ENTRY_ROUTE])
        self.assertEqual(self.reload['proxy-groups'][0]['use'], ['a', 'b'])
        self.assertEqual(self.reload['proxy-providers']['b']['payload'][0]['name'], 'same')
        self.assertEqual(self.active['entry'], 'other')
        self.assertEqual(yaml.safe_load(self.index.read_bytes())['items'][0]['selected'],
                         [{'name': t.ENTRY, 'now': 'other'}])
        self.assertTrue(all(p['type'] == 'inline' for p in self.reload['proxy-providers'].values()))
        self.assertTrue(all(p['type'] == 'http' for p in yaml.safe_load(self.config.read_bytes())['proxy-providers'].values()))
        self.fetch.assert_not_called()

    def test_present_winner_is_loaded_before_switching(self):
        self.keep_stale_entry = True
        (self.base / 'chain-results.json').write_text(json.dumps({'results': {'fast': {'chain_delay': 20}}}))
        self.write_profile('a', ['quick', 'fast'])
        def switch_only_after_replacement(method, route, body=None, **_):
            if route == ENTRY_ROUTE:
                self.assertIsNotNone(self.reload)
            return self.controller(method, route, body)
        self.api.side_effect = switch_only_after_replacement
        self.apply({'a': ['fast', 'quick'], 'b': []})
        self.assertEqual(self.requests, ['/configs?force=false', ENTRY_ROUTE])
        self.assertEqual(self.at_reload, ['current'])
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

    def assert_verge_profile_keeps_downloaded_chain(self, apply_download):
        example = Path(__file__).resolve().parents[2] / 'examples/chain.example.yaml'
        chain = yaml.safe_load(example.read_bytes())
        chain['proxies'][0]['name'] = 'current'
        chain['proxies'].append(node('剩余流量'))
        chain['proxy-groups'][1]['proxies'] = ['current']
        other = {'proxies': [node(name) for name in (t.ENTRY, 'DIRECT', 'REJECT', 'other')]}
        downloads = {self.sources[0]['url']: chain, self.sources[1]['url']: other}
        self.fetch.side_effect = None
        with patch.object(update.urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = lambda req, **_: io.BytesIO(update.dump(downloads[req.full_url]))
            apply_download()

        cached = yaml.safe_load((self.root / 'profiles/a.yaml').read_bytes())
        self.assertEqual(cached, chain)
        self.assertEqual(yaml.safe_load((self.root / 'profiles/b.yaml').read_bytes()), other)
        provider = yaml.safe_load((self.root / 'providers/linkbox/a.yaml').read_bytes())
        self.assertEqual([n['name'] for n in provider['proxies']], ['current'])
        self.assertEqual([n['name'] for n in picker.catalog()['sources'][0]['nodes']], ['current'])
        if core := os.environ.get('LINKBOX_TEST_CORE'):
            script = self.root / 'profiles/Script.js'
            regenerated = run_process(['node', '-e',
                'const fs = require("node:fs"), vm = require("node:vm");'
                'const context = {profile: JSON.parse(fs.readFileSync(0, "utf8"))};'
                'const script = fs.readFileSync(process.argv[1], "utf8");'
                'console.log(JSON.stringify(vm.runInNewContext(script + "\\nmain(profile)", context)));',
                str(script)], input=json.dumps(cached), text=True, capture_output=True, check=True)
            config = self.root / 'regenerated.yaml'
            config.write_text(regenerated.stdout)
            run_process([core, '-t', '-d', str(self.root), '-f', str(config)], capture_output=True, check=True)

    def test_first_run_keeps_downloaded_verge_chain(self):
        self.assert_verge_profile_keeps_downloaded_chain(lambda: self.assertTrue(picker.initialize()))

    def test_save_from_sync_preview_keeps_downloaded_verge_chain(self):
        self.policy.write_text(json.dumps({'selected_nodes': {'a': ['fast']}}))

        def apply_download():
            with self.assertRaisesRegex(RuntimeError, '管理节点'):
                picker.synchronize()
            self.apply({'a': ['current'], 'b': []})

        self.assert_verge_profile_keeps_downloaded_chain(apply_download)

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

    def test_first_run_seeds_in_live_provider_order_with_picker_fallback(self):
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-groups'][0].update(use=['b', 'a'], proxies=['quick'])
        config['proxy-providers'] = {
            'a': {'type': 'inline', 'payload': [node('current'), node('fast')]},
            'b': {'type': 'inline', 'payload': [node('current'), node('fast')], 'exclude-filter': '^fast$'},
        }
        self.config.write_bytes(update.dump(config))
        self.active['live'].append('quick')
        self.providers = {'a': {'proxies': [node('current'), node('fast')]},
                          'b': {'proxies': [node('current')]}}
        self.downloaded = {'a': ['current', 'fast', 'quick'], 'b': ['current', 'fast', 'quick']}
        self.assertTrue(picker.initialize())
        self.assertEqual(json.loads(self.policy.read_bytes())['selected_nodes'],
                         {'a': ['fast', 'quick'], 'b': ['current']})

    def test_first_run_keeps_live_owner_for_http_providers_without_paths(self):
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-groups'][0].update(use=['live-a', 'live-b'], proxies=[])
        config['proxy-providers'] = {
            'live-a': {'type': 'http', 'url': self.sources[0]['url']},
            'live-b': {'type': 'http', 'url': self.sources[1]['url']},
        }
        self.config.write_bytes(update.dump(config))
        self.providers = {'live-a': {'proxies': [node('fast')]},
                          'live-b': {'proxies': [node('current'), node('fast')]}}
        self.downloaded = {'a': ['current', 'fast'], 'b': ['current', 'fast']}

        self.assertTrue(picker.initialize())
        self.assertEqual(json.loads(self.policy.read_bytes())['selected_nodes'], {'a': ['fast'], 'b': ['current']})
        self.assertEqual([n['name'] for n in self.reload['proxy-providers']['b']['payload']], ['current'])
        self.assertEqual(self.active['entry'], 'current')

    def test_first_run_falls_back_for_named_file_provider(self):
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-groups'][0].update(use=['Verge cache'], proxies=[])
        config['proxy-providers'] = {'Verge cache': {'type': 'file', 'path': 'profiles/a.yaml'}}
        self.config.write_bytes(update.dump(config))
        self.active['live'] = ['current']
        self.providers = {'Verge cache': {'vehicleType': 'File', 'proxies': [node('current')]}}
        self.downloaded = {'a': ['current'], 'b': ['current']}

        self.assertTrue(picker.initialize())
        self.assertEqual(json.loads(self.policy.read_bytes())['selected_nodes'], {'a': ['current']})

    def test_first_run_falls_back_when_live_provider_endpoint_fails(self):
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-groups'][0]['use'] = ['b', 'a']
        self.config.write_bytes(update.dump(config))
        self.downloaded = {'a': ['current', 'fast'], 'b': ['current', 'fast']}

        def unavailable(method, route, body=None, **kwargs):
            if (method, route) == ('GET', '/providers/proxies'):
                raise t.ClashHTTPError(404)
            return self.controller(method, route, body, **kwargs)

        self.api.side_effect = unavailable
        self.assertTrue(picker.initialize())
        self.assertEqual(json.loads(self.policy.read_bytes())['selected_nodes'], {'a': ['current', 'fast']})

    def test_startup_seeds_with_malformed_live_provider_data(self):
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-groups'][0]['use'] = ['a', 'odd', 'b']
        self.config.write_bytes(update.dump(config))
        self.downloaded = {'a': ['current', 'fast'], 'b': ['current', 'fast']}
        self.providers = {'a': None, 'odd': {'proxies': {'name': 'current'}},
                          'b': {'proxies': [None, {}, node('fast')]}}
        with (patch('sys.argv', ['gui_backend.py', 'startup', 'chain']), patch('builtins.print') as output):
            gui.main()
            result = json.loads(output.call_args.args[0])
        self.assertTrue(result['initialized'])
        self.assertNotIn('node_rows_error', result['state'])
        self.assertEqual(json.loads(self.policy.read_bytes())['selected_nodes'], {'a': ['current'], 'b': ['fast']})

    def test_first_run_falls_back_for_null_proxies_without_losing_other_owners(self):
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-groups'][0]['use'] = ['a', 'b']
        self.config.write_bytes(update.dump(config))
        self.downloaded = {'a': ['current', 'fast'], 'b': ['current', 'fast']}
        self.providers = {'a': {'proxies': None}, 'b': {'proxies': [node('fast')]}}

        self.assertTrue(picker.initialize())
        self.assertEqual(json.loads(self.policy.read_bytes())['selected_nodes'], {'a': ['current'], 'b': ['fast']})

    def test_sync_after_upgrade_with_saved_selection_cleans_pin_and_switches_once(self):
        self.legacy({'selected_nodes': {'a': ['fast'], 'b': ['other']}})
        (self.root / 'profiles/a.yaml').write_text('proxies: [')
        self.downloaded = {'a': ['fast'], 'b': ['other']}
        self.assertFalse(picker.initialize())
        self.assertEqual(self.fetch.call_count, 0)
        picker.synchronize()
        self.assertEqual(self.active['entry'], 'fast')
        self.assertFalse(any(n['name'] == 'current' for n in self.reload['proxies']))
        self.assertNotIn('pinned_entry', json.loads(self.policy.read_text()))
        self.assertFalse(picker.initialize())
        self.assertEqual(self.requests.count('/configs?force=false'), 1)
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'a': ['fast'], 'b': ['other']})

    def test_upgrade_saving_b_switches_off_pin_excluded_by_unreadable_a(self):
        self.legacy({'selected_nodes': {'a': ['current', 'fast']}})
        config = yaml.safe_load(self.config.read_bytes())
        cache = self.root / 'providers/linkbox/a.yaml'
        cache.parent.mkdir(parents=True)
        cache.write_bytes(update.dump({'proxies': [node('current'), node('fast')]}))
        config['proxy-providers'] = {'a': {
            'type': 'http', 'url': 'https://example.invalid/a', 'path': str(cache),
            'filter': '^current$|^fast$', 'exclude-filter': '^current$'}}
        config['proxy-groups'][0].update(proxies=['current'], use=['a'])
        self.config.write_bytes(update.dump(config))
        (self.root / 'profiles/a.yaml').write_text('proxies: [')
        self.downloaded = {'b': ['other']}
        before = self.files()
        with self.assertRaisesRegex(RuntimeError, '下载或解析失败'):
            picker.synchronize()
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(self.files(), before)
        (self.base / 'chain-results.json').write_text(json.dumps(
            {'results': {'other': {'chain_delay': 10, 'owner': 'b'}}}))
        if core := os.environ.get('LINKBOX_TEST_CORE'):
            self.validate.side_effect = lambda argv, **kwargs: run_process([core, *argv[1:]], **kwargs)
        self.apply({'a': [], 'b': ['other']})
        self.assertEqual(self.active['live'], ['fast', 'other'])
        self.assertEqual(self.active['entry'], 'other')
        self.assertEqual(self.requests, ['/configs?force=false', ENTRY_ROUTE])
        self.assertFalse(any(n['name'] == 'current' for n in self.reload['proxies']))
        self.assertEqual(yaml.safe_load(self.index.read_bytes())['items'][0]['selected'],
                         [{'name': t.ENTRY, 'now': 'other'}])
        saved = json.loads(self.policy.read_bytes())
        self.assertEqual(saved['selected_nodes'], {'a': ['current', 'fast'], 'b': ['other']})
        self.downloaded = {'a': ['current', 'fast'], 'b': ['other']}
        picker.synchronize()
        self.assertEqual(json.loads(self.policy.read_bytes())['selected_nodes'], saved['selected_nodes'])
        self.assertEqual([n['name'] for n in picker.catalog()['sources'][0]['nodes'] if n['selected']],
                         ['current', 'fast'])

    def test_save_ranks_selected_relays_using_legacy_benchmark(self):
        (self.base / 'chain-results.json').write_text(json.dumps({'results': {
            'fast': {'chain_delay': 80}, 'quick': {'chain_delay': 20},
        }}))
        self.apply({'a': ['fast', 'quick'], 'b': []})
        self.assertEqual(self.active['entry'], 'quick')

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

    def test_legacy_pin_kept_by_filtered_include_all_groups(self):
        original = yaml.safe_load(self.config.read_bytes())
        for flag in ('include-all-proxies', 'include-all'):
            for accepts_pin in (True, False):
                with self.subTest(flag=flag, accepts_pin=accepts_pin):
                    self.legacy({'selected_nodes': {'a': ['current', 'fast']}})
                    secondary = {'name': 'secondary', 'type': 'select', flag: True,
                                 'filter': '(?i)^CURRENT$',
                                 'exclude-filter': '^other$' if accepts_pin else '^current$'}
                    self.config.write_bytes(update.dump({
                        **original, 'proxy-groups': original['proxy-groups'] + [secondary]}))
                    self.active.update(live=['current', 'fast'], entry='current')
                    self.apply({'a': ['fast'], 'b': []})
                    self.assertEqual(self.reload['proxy-groups'][1], secondary)
                    self.assertEqual('current' in [n['name'] for n in self.reload['proxies']], accepts_pin)
                    self.assertEqual(self.active['live'], ['fast'])

    def test_other_groups_keep_retired_provider_in_config_and_script(self):
        self.apply({'a': ['current'], 'b': ['other']})
        config = yaml.safe_load(self.config.read_bytes())
        old = config['proxy-providers']['b']
        config['proxy-groups'].extend([
            {'name': 'explicit', 'type': 'select', 'use': ['b']},
            {'name': 'all', 'type': 'select', 'include-all': True},
            {'name': 'all-providers', 'type': 'select', 'include-all-providers': True},
        ])
        self.config.write_bytes(update.dump(config))
        if core := os.environ.get('LINKBOX_TEST_CORE'):
            self.validate.side_effect = lambda argv, **kwargs: run_process([core, *argv[1:]], **kwargs)
        self.apply({'a': ['current'], 'b': []})
        self.assertEqual(self.reload['proxy-groups'][0]['use'], ['a'])
        self.assertEqual(self.reload['proxy-providers']['b']['filter'], '^other$')
        self.assertEqual(yaml.safe_load(self.config.read_bytes())['proxy-providers']['b'], old)
        self.assertIn(json.dumps(old, ensure_ascii=False), (self.root / 'profiles/Script.js').read_text())

    def test_partial_deselection_filters_a_provider_shared_with_other_groups(self):
        self.write_profile('a', ['fast`relay', 'fast extra', 'slow'])
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-groups'].append({'name': 'secondary', 'type': 'select', 'use': ['a'], 'filter': '^slow$'})
        self.config.write_bytes(update.dump(config))
        self.apply({'a': ['fast`relay', 'slow'], 'b': []})
        self.apply({'a': ['fast`relay'], 'b': []})
        self.assertEqual(self.reload['proxy-groups'][1], config['proxy-groups'][1])
        self.assertEqual(self.reload['proxy-providers']['a']['filter'], r'^fast\x60relay$')
        self.assertEqual([row['name'] for row in self.reload['proxy-providers']['a']['payload']], ['fast`relay'])

    def test_include_all_alone_retains_retired_provider(self):
        for field in ('include-all', 'include-all-providers'):
            with self.subTest(field=field):
                self.apply({'a': ['current'], 'b': ['other']})
                config = yaml.safe_load(self.config.read_bytes())
                config['proxy-groups'] = config['proxy-groups'][:1] + [
                    {'name': 'all', 'type': 'select', field: True, 'filter': '^other$'}]
                self.config.write_bytes(update.dump(config))
                if core := os.environ.get('LINKBOX_TEST_CORE'):
                    self.validate.side_effect = lambda argv, **kwargs: run_process([core, *argv[1:]], **kwargs)
                self.apply({'a': ['current'], 'b': []})
                self.assertIn('b', self.reload['proxy-providers'])

    def test_manual_and_auto_switch_ignore_duplicate_loaded_by_other_group(self):
        self.policy.write_text(json.dumps({'selected_nodes': {'a': ['current', 'same']}}))
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-groups'][0] = {'name': t.ENTRY, 'type': 'select', 'use': ['a']}
        config['proxy-groups'].append({'name': 'secondary', 'type': 'select', 'use': ['b']})
        config['proxy-providers'] = {'a': {'payload': [node('current'), node('same')]}}
        self.config.write_bytes(update.dump(config))
        self.providers = {'a': {'proxies': [node('current'), node('same')]},
                          'b': {'proxies': [node('same', 'other.example.invalid')]}}
        state = {**self.active, 'live': ['same', 'current'], 'nodes': ['current', 'same']}
        nodes = {'current': node('current'), 'same': node('same')}
        exit_node = config['proxies'][-1]
        network = {'interface': 'fixture'}
        guard = {'network': network, 'before': state, 'routing_fingerprint': update.c.routing_fingerprint(
            nodes, exit_node, '203.0.113.10', update.c.DNS_POLICY, 'current', 'same')}
        with (patch.object(gui, 'snapshot', side_effect=lambda: {**state, 'entry': self.active['entry']}),
              patch.object(update.c, 'load_nodes', return_value=(nodes, exit_node, '203.0.113.10')),
              patch.object(update.c, 'physical_network', return_value=network),
              patch.object(update.c, 'active_state', return_value=(state, state['nodes'])),
              patch.object(t, 'persist_selection')):
            for mode in (None, guard):
                self.active.update(entry='current', live=state['live'])
                self.assertEqual(gui.change('same', 'current', mode)['state']['entry'], 'same')
        self.assertEqual(self.requests, [ENTRY_ROUTE, ENTRY_ROUTE])

    def test_save_and_switch_with_identical_names_loaded_by_include_all(self):
        config = yaml.safe_load(self.config.read_bytes())
        config['proxy-providers'] = {'b': {'type': 'inline', 'payload': [node('current'), node('fast')]}}
        config['proxy-groups'].append({'name': 'secondary', 'type': 'select', 'include-all': True})
        self.config.write_bytes(update.dump(config))
        self.apply({'a': ['current', 'fast'], 'b': []})
        with (patch.object(gui, 'snapshot', side_effect=lambda: {**self.active, 'nodes': self.active['live']}),
              patch.object(t, 'persist_selection')):
            self.assertEqual(gui.change('fast', 'current')['state']['entry'], 'fast')
        self.assertEqual(self.requests, ['/configs?force=false', ENTRY_ROUTE])

    def test_routine_refresh_sends_no_reload(self):
        self.apply({'a': ['current', 'fast'], 'b': []})
        self.requests.clear()
        with patch.object(gui, 'snapshot', return_value=self.active), \
                patch.object(gui.sys, 'argv', ['gui_backend.py', 'startup', 'chain', '--refresh']), \
                patch('builtins.print'):
            gui.main()
        self.assertEqual(self.requests, [])

    def test_reload_preserves_unrelated_http_provider_in_include_all(self):
        config = yaml.safe_load(self.config.read_bytes())
        definition = {'type': 'http', 'url': 'https://example.invalid/native', 'path': 'native.yaml',
                      'interval': 3600, 'health-check': {'enable': False}}
        config['proxy-providers'] = {'native': definition}
        config['proxy-groups'].append({'name': 'secondary', 'type': 'select', 'include-all': True})
        (self.root / 'native.yaml').write_bytes(update.dump({'proxies': [node('native-relay')]}))
        self.config.write_bytes(update.dump(config))
        self.apply({'a': ['current', 'fast'], 'b': []})
        self.assertEqual(self.reload['proxy-providers']['native'], definition)
        self.assertEqual(self.reload['proxy-providers']['a']['type'], 'inline')

    def test_same_name_owner_move_with_connection_refused_rolls_back(self):
        self.write_profile('b', ['current', 'fast'])
        self.apply({'a': ['current', 'fast'], 'b': []})
        before = {k: v for k, v in self.files().items() if not k.startswith('backups/')}
        active = self.active.copy()
        with (patch.object(t, 'api', self.real_api),
              patch.object(t.socket, 'socket') as socket_factory):
            connect = socket_factory.return_value.connect
            for error in (ConnectionRefusedError(errno.ECONNREFUSED, 'refused'),
                          FileNotFoundError(errno.ENOENT, 'socket missing'), TimeoutError('connect timed out')):
                with self.subTest(error=error):
                    connect.side_effect = error
                    with self.assertRaisesRegex(RuntimeError, '未发送重载请求.*文件已回退'):
                        self.apply({'a': [], 'b': ['current', 'fast']})
                    self.assertEqual({k: v for k, v in self.files().items() if not k.startswith('backups/')}, before)
            self.assertEqual(connect.call_count, 3)
        self.assertEqual(self.active, active)
        self.assertEqual(self.reload['proxy-groups'][0]['use'], ['a'])

    def test_switch_accepts_same_names_from_another_live_provider(self):
        self.write_profile('a', ['current', 'same'])
        self.write_profile('b', ['current', 'same'])
        self.apply({'a': [], 'b': ['current', 'same']})
        live_b = self.active.copy(), self.providers
        self.apply({'a': ['current', 'same'], 'b': []})
        providers_a = self.providers
        self.active, self.providers = live_b
        self.providers.update(providers_a)
        state = {**self.active, 'nodes': ['current', 'same']}
        nodes = {name: node(name) for name in state['nodes']}
        network = {'interface': 'fixture'}
        guard = {'network': network, 'before': self.active.copy(), 'routing_fingerprint':
                 update.c.routing_fingerprint(nodes, {}, '203.0.113.10', update.c.DNS_POLICY, 'current', 'same')}
        self.requests.clear()
        with (patch.object(gui, 'snapshot', side_effect=lambda: {**state, 'entry': self.active['entry']}),
              patch.object(update.c, 'load_nodes', return_value=(nodes, {}, '203.0.113.10')),
              patch.object(update.c, 'physical_network', return_value=network),
              patch.object(t, 'persist_selection')):
            for mode in (None, guard):
                with self.subTest(automatic=mode is not None):
                    self.active['entry'] = 'current'
                    self.assertEqual(gui.change('same', 'current', mode)['state']['entry'], 'same')
        self.assertEqual(self.requests, [ENTRY_ROUTE, ENTRY_ROUTE])

    def test_failed_benchmark_start_preserves_display_history_and_invalidates_ranking(self):
        history = {'results': {'fast': {'owner': 'a', 'delay': 10, 'chain_delay': 20}},
                   'finished_at': '2026-11-20T00:00:00+00:00'}
        for start in (update.c.run, gui.latency):
            with self.subTest(benchmark=start.__module__):
                for name in ('chain-results.json', 'latency-results.json'):
                    (self.base / name).write_text(json.dumps(history))
                with (patch.object(update.c, 'active_state', side_effect=RuntimeError('controller read failed')),
                      patch.object(gui, 'snapshot', side_effect=RuntimeError('controller read failed'))):
                    with self.assertRaisesRegex(RuntimeError, 'controller read failed'):
                        start()
                self.assertEqual(update.benchmark_results(), {})
                for name in ('chain-results.json', 'latency-results.json'):
                    self.assertEqual(json.loads((self.base / name).read_text()), history)

    def test_completed_entrance_benchmark_updates_history_and_ranking(self):
        self.apply({'a': ['current'], 'b': []})
        (self.base / 'chain-results.json').write_text(json.dumps({
            'finished_at': '2026-11-20T00:00:00+00:00',
            'results': {'current': {'owner': 'a', 'delay': 10, 'chain_delay': 20}},
        }))
        with (patch.object(gui, 'snapshot', return_value={**self.active, 'nodes': ['current']}),
              patch.object(t, 'state', return_value=({}, {})),
              patch.object(t, 'node_inventory', return_value={}),
              patch.object(t, 'api', return_value={'delay': 5})):
            gui.latency()
            row, = gui.node_rows({}, {'current': 'a'})
        self.assertEqual((row['delay'], row['chain_delay']), (5, 20))
        self.assertEqual(update.benchmark_results(), {'current': {'chain': None, 'entrance': 5, 'owner': 'a'}})

    def test_interrupted_benchmark_cannot_rank_the_next_reconciliation(self):
        self.apply({'a': ['current', 'fast', 'quick'], 'b': []})
        results = self.base / 'chain-results.json'
        results.write_text(json.dumps({'results': {'quick': {'chain_delay': 10, 'owner': 'a'}}}))
        probed = []
        def read_chain():
            if probed:
                raise RuntimeError('controller read failed')
            return self.active.copy(), ['current', 'fast', 'quick']
        def probe(*_):
            probed.append(True)
            return [], [], {}
        with (patch.object(update.c, 'active_state', side_effect=read_chain),
              patch.object(update.c, 'load_nodes', return_value=({'current': node('current')}, {}, '203.0.113.10')),
              patch.object(update.c, 'physical_network', return_value={'interface': 'fixture'}),
              patch.object(update.c, 'test_node', side_effect=probe)):
            with self.assertRaisesRegex(RuntimeError, 'controller read failed'):
                update.c.run(1)
        self.assertTrue(probed)
        self.downloaded = {'a': ['fast', 'quick'], 'b': ['other']}
        picker.synchronize()
        self.assertEqual(self.active['entry'], 'fast')

    def test_interrupted_entrance_benchmark_invalidates_previous_chain_results(self):
        self.apply({'a': ['current', 'fast', 'quick'], 'b': []})
        (self.base / 'chain-results.json').write_text(json.dumps({
            'results': {'quick': {'chain_delay': 10, 'owner': 'a'}}}))
        probed = []
        def snapshot(include_nodes=False):
            if probed:
                raise RuntimeError('controller read failed')
            return {**self.active, 'nodes': ['current', 'fast', 'quick']}
        def probe(*_):
            probed.append(True)
            return {'delay': 100}
        with (patch.object(gui, 'snapshot', side_effect=snapshot),
              patch.object(t, 'state', return_value=({}, {})),
              patch.object(t, 'node_inventory', return_value={}), patch.object(t, 'api', side_effect=probe)):
            with self.assertRaisesRegex(RuntimeError, 'controller read failed'):
                gui.latency()
        self.assertTrue(probed)
        self.downloaded = {'a': ['fast', 'quick'], 'b': ['other']}
        picker.synchronize()
        self.assertEqual(self.active['entry'], 'fast')

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

    def test_successful_reload_reports_an_external_change_between_selected_entries(self):
        def reload_and_change_entry(method, route, body=None, **_):
            self.controller(method, route, body)
            self.active['entry'] = 'fast'

        self.api.side_effect = reload_and_change_entry
        with self.assertRaisesRegex(RuntimeError, update.POST_RELOAD_CHANGE):
            self.apply({'a': ['current', 'fast'], 'b': []})
        self.assertEqual(self.requests, ['/configs?force=false'])
        self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'a': ['current', 'fast']})

    def test_explicit_reload_rejection_restores_files_even_when_readback_is_unavailable(self):
        before = self.files()
        def reject_reload(method, route, body=None, **_):
            self.requests.append(route)
            if method == 'PUT':
                raise t.ClashHTTPError(400)
            raise OSError('offline')
        self.api.side_effect = reject_reload
        with self.assertRaisesRegex(RuntimeError, '400.*文件已回退'):
            self.apply({'a': ['fast'], 'b': []})
        self.assertEqual(self.requests, ['/configs?force=false'])
        self.assertEqual({k: v for k, v in self.files().items() if not k.startswith('backups/')}, before)

    def test_transport_rejects_an_http_error_without_reading_the_body(self):
        with (patch('toolbox.http.client.HTTPConnection.request'),
              patch('toolbox.http.client.HTTPConnection.getresponse') as response):
            response.return_value.status = 400
            with self.assertRaises(t.ClashHTTPError) as rejected:
                self.real_api('PUT', '/configs?force=false')
            self.assertTrue(rejected.exception.rejected)
            response.return_value.read.assert_not_called()

    def test_lost_reload_response_keeps_new_files_with_unchanged_group(self):
        self.apply({'a': ['current', 'fast'], 'b': []})
        active_before = self.active.copy()
        self.downloaded = {'a': ['current', 'fast', 'new'], 'b': ['other']}
        def lose_response(method, route, body=None, **_):
            result = self.controller(method, route, body)
            if route == '/configs?force=false':
                raise RuntimeError('response lost')
            return result
        self.api.side_effect = lose_response
        self.requests.clear()
        with self.assertRaisesRegex(RuntimeError, '已写入新配置，Clash 未确认，请刷新状态核对'):
            picker.synchronize()
        self.assertEqual(self.requests, ['/configs?force=false'])
        self.assertEqual(self.active['live'], active_before['live'])
        self.assertEqual(self.active['entry'], active_before['entry'])
        self.assertIn('new', (self.root / 'profiles/a.yaml').read_text())

    def test_lost_save_response_keeps_new_owner_and_allows_a_fresh_update(self):
        self.apply({'a': ['current', 'fast'], 'b': []})
        self.write_profile('b', ['fast', 'other'])
        self.requests.clear()
        def lose_response(method, route, body=None, **_):
            self.assertEqual(route, '/configs?force=false')
            self.requests.append(route)
            raise TimeoutError()

        def observe(**_):
            self.assertEqual(self.requests, [])
            return self.active.copy()

        self.api.side_effect = lose_response
        with patch.object(t, 'relay_state', side_effect=observe):
            with self.assertRaisesRegex(RuntimeError, '已写入新配置，Clash 未确认，请刷新状态核对'):
                self.apply({'a': [], 'b': ['fast', 'other']})
        self.assertEqual(self.requests, ['/configs?force=false'])
        self.assertEqual(json.loads(self.policy.read_text()),
                         {'selected_nodes': {'b': ['fast', 'other']}, 'provider_labels': {'a': 'A', 'b': 'B'}})
        self.assertEqual(yaml.safe_load(self.config.read_text())['proxy-groups'][0]['use'], ['b'])
        self.assertEqual(self.active['entry'], 'current')

        self.api.side_effect = self.controller
        self.requests.clear()
        self.assertFalse(picker.initialize())
        self.assertEqual(self.requests, [])
        self.downloaded = {'a': ['current', 'fast'], 'b': ['other']}
        picker.synchronize()
        self.assertEqual(self.requests, ['/configs?force=false'])
        self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'b': ['other']})
        self.apply({'a': ['current'], 'b': []})
        self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'a': ['current']})

    def test_switch_retries_once_after_fresh_read_and_keeps_applied_config(self):
        self.keep_stale_entry = True
        (self.base / 'chain-results.json').write_text(json.dumps({'results': {'quick': {'chain_delay': 20}}}))
        for recover in (True, False):
            with self.subTest(recover=recover):
                self.active.update(entry='current', live=['current', 'fast'])
                self.requests.clear()
                calls = []
                def flaky_switch(method, route, body=None, **_):
                    calls.append((method, route))
                    if method == 'PUT' and route == ENTRY_ROUTE:
                        if not recover or self.requests.count(route) == 0:
                            self.requests.append(route)
                            raise RuntimeError('switch failed')
                    return self.controller(method, route, body)
                self.api.side_effect = flaky_switch
                def observe(**_):
                    calls.append(('GET', 'state'))
                    if recover and calls[-2:] == [('PUT', ENTRY_ROUTE), ('GET', 'state')] and self.requests.count(ENTRY_ROUTE) == 1:
                        raise TimeoutError('first switch read-back lost')
                    return self.active.copy()
                with patch.object(t, 'relay_state', side_effect=observe):
                    if recover:
                        self.apply({'a': ['fast', 'quick'], 'b': []})
                    else:
                        with self.assertRaisesRegex(RuntimeError, '配置已更新，但无法切换'):
                            self.apply({'a': ['fast', 'quick'], 'b': []})
                self.assertEqual(self.requests, ['/configs?force=false', ENTRY_ROUTE, ENTRY_ROUTE])
                first = calls.index(('PUT', ENTRY_ROUTE))
                self.assertEqual(calls[first + 1], ('GET', 'state'))
                self.assertEqual(self.active['entry'], 'quick' if recover else 'current')
                policy = json.loads(self.policy.read_text())
                self.assertEqual(policy['selected_nodes'], {'a': ['fast', 'quick']})

    def test_no_live_match_offers_the_picker_and_retries_until_a_selection_exists(self):
        self.downloaded = {'a': ['new'], 'b': ['other']}
        with self.assertRaisesRegex(RuntimeError, '管理节点'):
            picker.initialize()
        with patch('sys.argv', ['gui_backend.py', 'status']), patch.object(
                gui, 'snapshot', return_value={}), patch('builtins.print'):
            gui.main()
        with self.assertRaisesRegex(RuntimeError, '管理节点'):
            picker.initialize()
        self.assertEqual(self.fetch.call_count, 4)
        self.assertEqual(self.requests, [])
        self.assertFalse(self.policy.exists())
        self.apply({'a': ['new'], 'b': []})
        self.assertFalse(picker.initialize())

    def test_reconciliation_ignores_entrance_delay_from_failed_latest_chain_row(self):
        self.keep_stale_entry = True
        fixture = Path(__file__).resolve().parents[2] / 'fixtures/reconcile/latest-benchmark-only.json'
        data = json.loads(fixture.read_text())
        inputs = data['inputs']
        self.active.update(entry=inputs['current'], live=inputs['live'])
        self.policy.write_text(json.dumps({'selected_nodes': inputs['selection']}))
        (self.base / 'chain-results.json').write_text(json.dumps({'results': {
            'stale': {'owner': 'a', 'delay': 10, 'chain_delay': None},
            'fresh': {'owner': 'a', 'delay': 50, 'chain_delay': 120},
        }}))
        self.downloaded = {'a': inputs['sources'][0]['nodes'], 'b': ['other']}
        picker.synchronize(inputs['metric'])
        self.assertEqual(self.active['entry'], data['expected']['entry'])
