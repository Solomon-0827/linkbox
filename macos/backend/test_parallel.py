import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import chain_test as c
import gui_backend as g

class ParallelTests(unittest.TestCase):
    def exercise(self, mode):
        names=[str(i) for i in range(8)]
        state={'exit':c.t.EXIT,'dialer':c.t.ENTRY}
        active=0;peak=0;calls=[]
        mutex=threading.Lock();gate=threading.Barrier(5)
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            def measure(node,exit,network,cancelled):
                nonlocal active,peak
                with mutex:
                    calls.append(node['name']);active+=1;peak=max(peak,active)
                try:
                    if int(node['name'])<5:gate.wait(timeout=3)
                    if mode=='cancel':(base/'chain-cancel').touch()
                    for _ in range(8):
                        if cancelled():return [],[],{}
                        time.sleep(.01)
                    return [{'ms':100,'ip':c.EXPECTED}]*3,[],{'delay':42}
                finally:
                    with mutex:active-=1
            def read_state():
                return ({**state,'changed':True} if mode=='change' and calls else state),names
            with patch.object(c.t,'BASE',base),patch.object(c,'active_state',side_effect=read_state),patch.object(c,'physical_network',return_value={'interface':'en0'}),patch.object(c,'load_nodes',return_value=({n:{'name':n} for n in names},{})),patch.object(c,'test_node',side_effect=measure):
                c.run()
            record=json.loads((base/'chain-results.json').read_text())
            self.assertEqual(peak,5);self.assertEqual(active,0)
            if mode=='normal':
                self.assertEqual(len(record['results']),8)
                self.assertTrue(all(row['delay']==42 for row in record['results'].values()))
            else:
                self.assertEqual(len(calls),5);self.assertEqual(record['results'],{})
                self.assertTrue(record['reason'])
    def test_parallel_limit(self):self.exercise('normal')
    def test_cancel_cleanup(self):self.exercise('cancel')
    def test_change_discards_pending(self):self.exercise('change')
    def test_entrance_parallel(self):
        active=0;peak=0;lock=threading.Lock();gate=threading.Barrier(5)
        state={'nodes':list('abcdefghij')}
        def api(*args):
            nonlocal active,peak
            with lock:active+=1;peak=max(peak,active)
            try:gate.wait(timeout=3);time.sleep(.02);return {'delay':42}
            finally:
                with lock:active-=1
        with tempfile.TemporaryDirectory() as tmp,patch.object(g.t,'BASE',Path(tmp)),patch.object(g,'snapshot',return_value=state),patch.object(g.t,'state',return_value=({},{})),patch.object(g,'node_inventory',return_value={}),patch.object(g.t,'api',side_effect=api):
            g.latency();g.latency() # the lock must be released for another run
            self.assertEqual(peak,5);self.assertEqual(active,0)
            self.assertEqual(len(json.loads((Path(tmp)/'latency-results.json').read_text())['results']),10)

if __name__=='__main__':unittest.main()
