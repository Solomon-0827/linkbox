import copy
import unittest
from unittest.mock import patch
import chain_test as c

class SafetyTests(unittest.TestCase):
    def test_isolation_and_no_input_mutation(self):
        entry={'name':'sample','type':'ss','server':'example.invalid'}
        exit={'name':'US','server':c.EXPECTED,'dialer-proxy':'live-selector'}
        original=copy.deepcopy((entry,exit))
        config=c.isolated_config(entry,exit,12345,'en9')
        self.assertEqual((entry,exit),original)
        self.assertFalse(config['tun']['enable'])
        self.assertEqual(config['external-controller'],'')
        self.assertEqual(config['bind-address'],'127.0.0.1')
        self.assertEqual(config['proxies'][1]['dialer-proxy'],'TEST_ENTRY')
        self.assertEqual(config['proxies'][0]['interface-name'],'en9')
        self.assertEqual(config['rules'],['DOMAIN,www.gstatic.com,TEST_ENTRY','MATCH,TEST_US_EXIT'])
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
