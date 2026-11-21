import copy
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory
import yaml
import chain_test as c

class SafetyTests(unittest.TestCase):
    def test_isolation_and_no_input_mutation(self):
        entry={'name':'sample','type':'ss','server':'example.invalid'}
        exit={'name':'US','server':'203.0.113.10','dialer-proxy':'live-selector'}
        original=copy.deepcopy((entry,exit))
        config=c.isolated_config(entry,exit,12345,'en9')
        self.assertEqual((entry,exit),original)
        self.assertFalse(config['tun']['enable'])
        self.assertEqual(config['external-controller'],'')
        self.assertEqual(config['bind-address'],'127.0.0.1')
        self.assertEqual(config['proxies'][1]['dialer-proxy'],'TEST_ENTRY')
        self.assertEqual(config['proxies'][0]['interface-name'],'en9')
        self.assertEqual(config['rules'],['DOMAIN,www.gstatic.com,TEST_ENTRY','MATCH,TEST_US_EXIT'])
    def test_expected_ip_override_with_hostname_and_different_server_ip(self):
        with TemporaryDirectory() as tmp, patch.object(c, 'CONFIG_DIR', Path(tmp)), \
                patch.object(c.runtime, 'read_json', return_value={'expected_ip': '203.0.113.10'}):
            path = Path(tmp) / 'clash-verge.yaml'
            for server in ['exit.example.invalid', '203.0.113.11']:
                exit_node = {'name': c.t.EXIT, 'server': server, 'dialer-proxy': c.t.ENTRY}
                path.write_text(yaml.safe_dump({'proxies': [exit_node]}))
                _, loaded, expected = c.load_nodes()
                self.assertEqual(loaded, exit_node)
                self.assertEqual(expected, '203.0.113.10')
                with patch.object(c.subprocess, 'Popen') as popen:
                    process = popen.return_value
                    process.poll.return_value = 0
                    process.returncode = 0
                    process.communicate.return_value = (b'ip=203.0.113.10\n__TIMING__200 0.1 0.07', b'')
                    self.assertEqual(c.trace(1234, lambda: False, expected)['ip'], expected)
                    process.communicate.return_value = (b'ip=203.0.113.12\n__TIMING__200 0.1 0.07', b'')
                    with self.assertRaisesRegex(RuntimeError, '出口不符'):
                        c.trace(1234, lambda: False, expected)
            exit_node['dialer-proxy'] = 'other'
            path.write_text(yaml.safe_dump({'proxies': [exit_node]}))
            with self.assertRaisesRegex(RuntimeError, '上游已变化'):
                c.load_nodes()

    def test_reject_nested_entry(self):
        with self.assertRaises(RuntimeError):
            c.isolated_config({'dialer-proxy':'other'},{},12345,'en9')
    def test_read_only_live_state(self):
        with patch.object(c.t,'api',side_effect=lambda method,path: self.assertEqual(method,'GET') or {'proxies':{}}) as api:
            c.active_state()
            self.assertGreater(api.call_count,0)
    def test_unknown_interface_refused(self):
        with patch.object(c.subprocess,'run') as run:
            run.return_value.stdout='PrimaryInterface : utun8'
            with self.assertRaises(RuntimeError):c.physical_network()

if __name__=='__main__':unittest.main()
