import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import yaml
import chain_test as c
import gui_backend as g

class ParallelTests(unittest.TestCase):
    def exercise(self, mode, concurrency=5):
        names=[str(i) for i in range(8)]
        state={'mode':'global','exit':c.t.EXIT,'dialer':c.t.ENTRY}
        active=0;peak=0;calls=[]
        mutex=threading.Lock();gate=threading.Barrier(concurrency)
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            def measure(node,exit,network,cancelled,expected):
                nonlocal active,peak
                with mutex:
                    calls.append(node['name']);active+=1;peak=max(peak,active)
                try:
                    if int(node['name'])<concurrency:gate.wait(timeout=3)
                    if mode=='cancel':(base/'chain-cancel').touch()
                    for _ in range(8):
                        if cancelled():return [],[],{}
                        time.sleep(.01)
                    return [{'ms':100,'ip':'203.0.113.10'}]*3,[],{'delay':42}
                finally:
                    with mutex:active-=1
            def read_state():
                return ({**state,'changed':True} if mode=='change' and calls else state),names
            with patch.object(c.t,'BASE',base),patch.object(c,'active_state',side_effect=read_state),patch.object(c,'physical_network',return_value={'interface':'en0'}),patch.object(c,'load_nodes',return_value=({n:{'name':n} for n in names},{},'203.0.113.10')),patch.object(c,'test_node',side_effect=measure):
                c.run(concurrency)
            record=json.loads((base/'chain-results.json').read_text())
            self.assertEqual(peak,concurrency);self.assertEqual(active,0)
            if mode=='normal':
                self.assertEqual(len(record['results']),8)
                self.assertTrue(all(row['delay']==42 for row in record['results'].values()))
            else:
                self.assertEqual(len(calls),concurrency);self.assertEqual(record['results'],{})
                self.assertTrue(record['reason'])
    def test_parallel_limit(self):self.exercise('normal',3)
    def test_cancel_cleanup(self):self.exercise('cancel')
    def test_change_discards_pending(self):self.exercise('change')

    def test_benchmark_handles_malformed_provider_cache_per_relay(self):
        state = {'mode': 'global', 'exit': c.t.EXIT, 'dialer': c.t.ENTRY, 'entry': 'healthy'}
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / 'clash-verge.yaml').write_text(yaml.safe_dump({
                'proxies': [{'name': c.t.EXIT, 'server': '203.0.113.10', 'dialer-proxy': c.t.ENTRY}],
                'proxy-providers': {'a': {'path': 'a.yaml'}, 'b': {'path': 'b.yaml'}},
                'proxy-groups': [{'name': c.t.ENTRY, 'use': ['a']}, {'name': 'secondary', 'use': ['b']}],
            }))
            (base / 'a.yaml').write_text('proxies: [{name: healthy, server: example.invalid}]')
            (base / 'b.yaml').write_text('proxies: [')
            with (patch.object(c.t, 'BASE', base), patch.object(c.runtime, 'BASE', base),
                  patch.object(c, 'CONFIG_DIR', base), patch.object(c.t, 'relay_state', return_value=state),
                  patch.object(c, 'physical_network', return_value={'interface': 'en0'}),
                  patch.object(c, 'test_node', return_value=([{'ms': 100, 'ip': '203.0.113.10'}] * 3, [], {})) as probe):
                for selection in ({'a': ['healthy']}, {'a': ['healthy'], 'b': ['broken']}):
                    (base / 'node-policy.json').write_text(json.dumps({'selected_nodes': selection}))
                    c.run(1)
                    record = json.loads((base / 'chain-results.json').read_text())['results']
                    self.assertEqual(record['healthy']['chain_delay'], 100)
                    if 'b' in selection:
                        self.assertIsNone(record['broken']['chain_delay'])
                        self.assertIn('本地缓存缺少', record['broken']['chain_error'])
                    else:
                        self.assertEqual(list(record), ['healthy'])
            self.assertEqual([call.args[0]['name'] for call in probe.call_args_list], ['healthy', 'healthy'])

    def test_automatic_candidate_uses_metric_and_requires_verified_exit(self):
        record={'before':{'entry':'current'},'reason':'','selection_unchanged':True,'results':{
            'current':{'delay':200,'chain_delay':400},'entrance':{'delay':80,'chain_delay':260},
            'chain':{'delay':90,'chain_delay':190},'failed':{'delay':5,'chain_delay':None}}}
        self.assertEqual(c.auto_candidate(record,'entrance'),'entrance')
        self.assertEqual(c.auto_candidate(record,'chain'),'chain')
        record['results']['current']['chain_delay']=202
        self.assertIsNone(c.auto_candidate(record,'chain'))
        record['results']['current']['chain_delay']=None
        self.assertEqual(c.auto_candidate(record,'chain'),'chain')
        record['reason']='cancelled'
        self.assertIsNone(c.auto_candidate(record,'chain'))

    def test_auto_switch_guard_blocks_live_write_after_network_or_node_change(self):
        state={'mode':'global','exit':g.t.EXIT,'dialer':g.t.ENTRY,'entry':'a','nodes':['a','b'],'live':['a','b']}
        original={'a':{'server':'current.invalid'},'b':{'server':'old.invalid'}}
        exit_node={'server':'203.0.113.10'}
        network={'interface':'en0'}
        guard={'network':network,'before':state,'routing_fingerprint':c.routing_fingerprint(original,exit_node,'203.0.113.10',c.DNS_POLICY,'a','b')}
        for fresh,physical in [(original,{'interface':'en1'}),({**original,'b':{'server':'new.invalid'}},network)]:
            with patch.object(g,'snapshot',return_value=state),patch.object(c,'load_nodes',return_value=(fresh,exit_node,'203.0.113.10')),patch.object(c,'physical_network',return_value=physical),patch.object(c,'active_state',return_value=(state,state['nodes'])),patch.object(g.t,'api') as api:
                with self.assertRaisesRegex(RuntimeError,'未自动切换'):
                    g.change('b','a',guard)
                api.assert_not_called()

    def test_manual_and_auto_switch_verify_owners_before_and_after_put(self):
        state = {'mode': 'global', 'exit': g.t.EXIT, 'dialer': g.t.ENTRY, 'entry': 'current',
                 'nodes': ['current', 'same'], 'live': ['current', 'same']}
        nodes = {'current': {'server': 'current.invalid'}, 'same': {'server': 'a.invalid'}}
        exit_node = {'server': '203.0.113.10'}
        network = {'interface': 'en0'}
        guard = {'network': network, 'before': state, 'routing_fingerprint': c.routing_fingerprint(
            nodes, exit_node, '203.0.113.10', c.DNS_POLICY, 'current', 'same')}
        selection = {'selected_nodes': {'a': ['current', 'same']}}
        for mode in (None, guard):
            for changed_after_put in (False, True):
                with self.subTest(automatic=mode is not None, changed_after_put=changed_after_put):
                    active = state.copy()
                    saved = selection if changed_after_put else {'selected_nodes': {'a': ['current', 'same', 'external']}}
                    writes = []

                    def api(method, route, payload=None):
                        self.assertEqual(method, 'PUT')
                        writes.append(payload['name'])
                        active.update(entry=payload['name'], live=['current', 'same', 'external'])

                    with (patch.object(g, 'snapshot', side_effect=lambda: active.copy()),
                          patch.object(c, 'load_nodes', return_value=(nodes, exit_node, '203.0.113.10')),
                          patch.object(c, 'physical_network', return_value=network),
                          patch.object(c, 'active_state', return_value=(state, state['nodes'])),
                          patch.object(g.runtime, 'read_json', return_value=saved),
                          patch.object(g.t, 'api', side_effect=api),
                          patch.object(g.t, 'persist_selection') as persist):
                        with self.assertRaisesRegex(RuntimeError, '归属'):
                            g.change('same', 'current', mode)
                        persist.assert_not_called()
                    self.assertEqual(writes, ['same'] if changed_after_put else [])

    def test_entrance_parallel(self):
        active=0;peak=0;lock=threading.Lock();gate=threading.Barrier(5)
        state={'nodes':list('abcdefghij')}
        def api(*args):
            nonlocal active,peak
            with lock:active+=1;peak=max(peak,active)
            try:gate.wait(timeout=3);time.sleep(.02);return {'delay':42}
            finally:
                with lock:active-=1
        with tempfile.TemporaryDirectory() as tmp,patch.object(g.t,'BASE',Path(tmp)),patch.object(g,'snapshot',return_value=state),patch.object(g.t,'state',return_value=({},{})),patch.object(g.t,'node_inventory',return_value={}),patch.object(g.t,'api',side_effect=api):
            g.latency();g.latency() # the lock must be released for another run
            self.assertEqual(peak,5);self.assertEqual(active,0)
            self.assertEqual(len(json.loads((Path(tmp)/'latency-results.json').read_text())['results']),10)

if __name__=='__main__':unittest.main()
