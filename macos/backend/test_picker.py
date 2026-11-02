import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import ExitStack
import yaml
import runtime
import subscription_picker as p

class PickerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.root=self.base/'clash';(self.root/'profiles').mkdir(parents=True)
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(runtime,'BASE',self.base))
        self.stack.enter_context(patch.object(runtime,'CONFIG_DIR',self.root))
        self.stack.enter_context(patch.object(p.t,'state',return_value=({}, {p.t.ENTRY:{'all':['one'], 'now':'one'}})))
        self.url='https://example.invalid/api/v1/client/'+'a'*24
        self.node={'name':'one','type':'ss','server':'secret.example.invalid','port':443,'password':'private-test-value'}
        (self.root/'profiles.yaml').write_text(yaml.safe_dump({'items':[{'uid':'abc','type':'remote','name':'我的订阅','file':'abc.yaml','url':self.url}]}))
        (self.root/'profiles/abc.yaml').write_text(yaml.safe_dump({'proxies':[self.node,{**self.node,'name':'two'}]}))
        (self.base/'subscriptions.json').write_text(json.dumps({'sources':[{'name':'existing','url':self.url.replace('example.invalid','rotated.invalid')}]}))
    def test_catalog_no_credentials_and_existing_identity_survives_rotation(self):
        c=p.catalog();s=c['sources'][0]
        self.assertEqual(s['id'],'existing');self.assertEqual(s['name'],'我的订阅')
        self.assertEqual([x['selected'] for x in s['nodes']],[True,False])
        for secret in [self.url,'private-test-value','secret.example.invalid']:
            self.assertNotIn(secret,json.dumps(c))
    def test_selection_only_applies_on_explicit_save(self):
        with patch.object(p.update,'run',return_value={}) as run:
            c=p.catalog();run.assert_not_called()
            p.apply({'fingerprint':c['fingerprint'],'selected':{'existing':['two']}})
            self.assertEqual(run.call_args.kwargs['selection'],{'existing':['two']})
            self.assertEqual(run.call_args.kwargs['sources_override'][0]['name'],'existing')
    def test_stale_catalog_and_unknown_nodes_do_not_write(self):
        with patch.object(p.update,'run') as run:
            c=p.catalog()
            for payload in [{'fingerprint':'stale','selected':{}},{'fingerprint':c['fingerprint'],'selected':{'existing':['unknown']}}]:
                with self.assertRaises(RuntimeError):p.apply(payload)
            run.assert_not_called()
    def test_empty_selection_is_intentional(self):
        with patch.object(p.update,'run',return_value={}) as run:
            c=p.catalog();p.apply({'fingerprint':c['fingerprint'],'selected':{'existing':[]}})
            self.assertEqual(run.call_args.kwargs['selection'],{})
    def test_selection_policy_keeps_pin_and_replaces_old_exclusions(self):
        (self.base/'node-policy.json').write_text(json.dumps({'selected_nodes':{'existing':['two']},'pinned_entry':'one','blocked_providers':['existing'],'excluded_nodes':{'existing':['two']}}))
        self.assertTrue(runtime.allowed('one','existing'))
        self.assertTrue(runtime.allowed('two','existing'))
        self.assertFalse(runtime.allowed('three','existing'))
    def test_duplicate_selected_names_rejected(self):
        sources,_=p.discover()
        second=({'name':'other','display_name':'另一个订阅','url':'https://other.invalid/sub'},sources[0][1])
        with patch.object(p,'discover',return_value=(sources+[second],'fixed')),patch.object(p.update,'run') as run:
            with self.assertRaises(RuntimeError):p.apply({'fingerprint':'fixed','selected':{'existing':['one'],'other':['one']}})
            run.assert_not_called()

if __name__=='__main__':unittest.main()
