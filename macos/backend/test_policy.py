import tempfile,unittest,json
from pathlib import Path
from unittest.mock import patch
import runtime,chain_test,gui_backend

class PolicyTests(unittest.TestCase):
    def test_blocked_provider_and_removed_nodes(self):
        policy={'blocked_providers':['retired'],'node_providers':{'old':'retired','slow':'kept','fast':'kept'},'excluded_nodes':{'kept':['slow']}}
        with patch.object(runtime,'read_json',return_value=policy):
            self.assertFalse(runtime.allowed('old'))
            self.assertFalse(runtime.allowed('slow'))
            self.assertTrue(runtime.allowed('fast'))
            self.assertTrue(runtime.allowed('new'))
    def test_current_selection_retained_but_excluded_from_test_list(self):
        policy={'node_providers':{'current':'kept'},'excluded_nodes':{'kept':['current']}}
        proxies={'GLOBAL':{'now':'美国静态家宽'},'中转入口':{'now':'current','all':['current','good']},'美国静态家宽':{'dialer-proxy':'中转入口'}}
        with patch.object(runtime,'read_json',return_value=policy),patch.object(chain_test.t,'state',return_value=({'mode':'global'},proxies)):
            state,names=chain_test.active_state()
            self.assertEqual(state['entry'],'current');self.assertEqual(names,['good'])
    def test_provider_labels_are_not_assumed_from_node_name(self):
        with patch.object(gui_backend.t,'api',return_value={'providers':{'Example':{'proxies':[{'name':'node'}]}}}):
            self.assertEqual(gui_backend.node_inventory({'node':{}})['node'][1],'Example')
    def test_expected_exit_comes_from_local_config(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(runtime,'CONFIG_DIR',Path(tmp)),patch.object(runtime,'read_json',return_value={}):
            (Path(tmp)/'clash-verge.yaml').write_text('proxies:\n - name: 美国静态家宽\n   server: 192.0.2.55\n')
            self.assertEqual(runtime.expected_ip(),'192.0.2.55')
    def test_provider_dns_is_carried_into_isolated_core(self):
        policy={'+.example.invalid':['https://dns.example.invalid/dns-query']}
        with patch.object(chain_test,'DNS_POLICY',policy):
            c=chain_test.isolated_config({'name':'a'},{'name':'b'},12345,'en0')
            self.assertEqual(c['dns']['proxy-server-nameserver-policy'],policy)
            self.assertFalse(c['tun']['enable'])
