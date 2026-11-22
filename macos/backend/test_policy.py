import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

import clash
import chain_test
import gui_backend
import runtime
import toolbox as t


class PolicyTests(unittest.TestCase):
    def test_benchmark_includes_every_selected_node_with_current_as_baseline(self):
        policy = {'selected_nodes': {'keep': ['current', 'selected']}}
        proxies = {'GLOBAL': {'now': t.EXIT},
                   t.ENTRY: {'now': 'current', 'all': ['current', 'outside']},
                   t.EXIT: {'dialer-proxy': t.ENTRY}}
        with patch.object(runtime, 'read_json', return_value=policy), patch.object(t, 'state', return_value=({'mode': 'global'}, proxies)):
            self.assertEqual(chain_test.active_state()[1], ['current', 'selected'])
            self.assertEqual(gui_backend.snapshot(False)['nodes'], ['current', 'selected'])

    def test_loads_only_the_owner_of_a_duplicate(self):
        def relay(address):
            return {'name': 'same', 'server': address}

        with tempfile.TemporaryDirectory() as tmp, patch.object(clash, 'CONFIG_DIR', Path(tmp)):
            (Path(tmp) / 'a.yaml').write_text(yaml.safe_dump({'proxies': [relay('a.example.invalid')]}))
            config = {'proxies': [relay('local.example.invalid'),
                                   {'name': t.EXIT, 'server': '203.0.113.10', 'dialer-proxy': t.ENTRY}],
                      'proxy-providers': {'a': {'path': 'a.yaml'}, 'b': {'payload': [relay('b.example.invalid')]}}}
            (Path(tmp) / 'clash-verge.yaml').write_text(yaml.safe_dump(config))
            for owner in ('a', 'b'):
                with patch.object(runtime, 'read_json', return_value={'selected_nodes': {owner: ['same']}}):
                    nodes, _, _ = chain_test.load_nodes()
                    self.assertEqual(nodes['same']['server'], owner + '.example.invalid')

    def test_provider_labels_are_not_assumed_from_node_name(self):
        providers = {'providers': {owner: {'proxies': [{'name': 'node'}]} for owner in ['A', 'B']}}
        with patch.object(clash, '_request', return_value=providers):
            self.assertEqual(t.node_inventory({'node': {}}, {'node': 'B'})['node'][1], 'B')

    def test_expected_exit_comes_from_local_config(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(clash, 'CONFIG_DIR', Path(tmp)), patch.object(runtime, 'read_json', return_value={}):
            (Path(tmp) / 'clash-verge.yaml').write_text('proxies:\n - name: 美国静态家宽\n   server: 192.0.2.55\n')
            self.assertEqual(runtime.expected_ip(), '192.0.2.55')

    def test_provider_dns_is_carried_into_isolated_core(self):
        policy = {'+.example.invalid': ['https://dns.example.invalid/dns-query']}
        with patch.object(chain_test, 'DNS_POLICY', policy):
            config = chain_test.isolated_config({'name': 'a'}, {'name': 'b'}, 12345, 'en0')
            self.assertEqual(config['dns']['proxy-server-nameserver-policy'], policy)
            self.assertFalse(config['tun']['enable'])
