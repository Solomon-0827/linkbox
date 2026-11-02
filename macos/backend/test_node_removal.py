import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import gui_backend as g
import runtime

class RemovalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name)
        self.state={'entry':'active','nodes':['active','one','two']}
        for target,value in [('gui_backend.t.BASE',self.base),('runtime.BASE',self.base)]:
            p=patch(target,value);p.start();self.addCleanup(p.stop)
        p=patch.object(g,'snapshot',return_value=self.state);p.start();self.addCleanup(p.stop)
        p=patch.object(g.t,'state',return_value=({}, {g.t.ENTRY:{'now':'active'}}));p.start();self.addCleanup(p.stop)
        p=patch.object(g.t,'api',side_effect=AssertionError('Must not touch live Clash'));p.start();self.addCleanup(p.stop)
    def test_remove_selected_and_old_pin(self):
        (self.base/'node-policy.json').write_text(json.dumps({'selected_nodes':{'a':['active','one','two']},'node_providers':{'active':'a','one':'a','two':'a'},'pinned_entry':'one'}))
        g.remove_list_nodes({'names':['one','two'],'entry':'active'})
        self.assertFalse(runtime.allowed('one'));self.assertFalse(runtime.allowed('two'));self.assertTrue(runtime.allowed('active'))
    def test_remove_legacy(self):
        g.remove_list_nodes({'names':['one'],'entry':'active'})
        self.assertFalse(runtime.allowed('one'));self.assertTrue(runtime.allowed('active'))
    def test_reject_current_stale_unknown(self):
        for req in [{'names':['active'],'entry':'active'},{'names':['one'],'entry':'old'},{'names':['unknown'],'entry':'active'}]:
            with self.assertRaises(RuntimeError):g.remove_list_nodes(req)
        self.assertFalse((self.base/'node-policy.json').exists())
