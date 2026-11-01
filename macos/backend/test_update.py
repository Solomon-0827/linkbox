import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import ExitStack
import yaml,runtime,subscription_update as u

class UpdateTests(unittest.TestCase):
 def exercise(self,fail_validation=False,fail_reload=False):
  with tempfile.TemporaryDirectory() as tmp,ExitStack() as stack:
   base=Path(tmp);cfg=base/'config';cfg.mkdir();(cfg/'profiles').mkdir()
   pin={'name':'current','type':'ss','server':'example.invalid','port':443}
   conf={'proxies':[pin], 'proxy-groups':[{'name':u.t.ENTRY,'proxies':['current','old']}], 'dns':{}}
   target=cfg/'clash-verge.yaml';original=u.dump(conf);target.write_bytes(original)
   (base/'subscriptions.json').write_text(json.dumps({'sources':[{'name':'kept','url':'https://example.invalid/sub'},{'name':'retired','url':'https://example.invalid/old'}]}))
   (base/'node-policy.json').write_text(json.dumps({'blocked_providers':['retired'],'excluded_nodes':{'kept':['bad']}}))
   state={'entry':'current','exit':u.t.EXIT,'dialer':u.t.ENTRY,'mode':'global','tun':True}
   for obj,key,value in [(runtime,'BASE',base),(u.t,'BASE',base),(u.c,'CONFIG_DIR',cfg)]:stack.enter_context(patch.object(obj,key,value))
   stack.enter_context(patch.object(u.c,'active_state',return_value=(state,[])))
   stack.enter_context(patch.object(u.c,'load_nodes',return_value=({'current':pin},{})))
   validation=stack.enter_context(patch.object(u.subprocess,'run'));validation.return_value.returncode=int(fail_validation)
   api=stack.enter_context(patch.object(u.t,'api',side_effect=RuntimeError('timeout') if fail_reload else None))
   prepared={'kept':{'proxies':[pin,{'name':'fast','type':'ss','server':'example.invalid','port':443}]}}
   if fail_validation or fail_reload:
    with self.assertRaises(RuntimeError):u.run(prepared)
    self.assertEqual(target.read_bytes(),original)
    self.assertFalse((cfg/'providers/linkbox/kept.yaml').exists())
    if fail_validation:api.assert_not_called()
   else:
    u.run(prepared)
    changed=yaml.safe_load(target.read_text());group=changed['proxy-groups'][0]
    self.assertEqual(group['proxies'],['current']);self.assertEqual(group['use'],['kept'])
    self.assertEqual(changed['proxies'],[pin]);self.assertNotIn('retired',changed['proxy-providers'])
    self.assertIn('^bad$',changed['proxy-providers']['kept']['exclude-filter'])
    self.assertEqual(api.call_args.args[:2],('PUT','/configs?force=false'))
    live=yaml.safe_load(api.call_args.args[2]['payload']);self.assertEqual(live['proxy-providers']['kept']['type'],'inline')
    self.assertNotIn('path',live['proxy-providers']['kept'])
 def test_update_retains_current_and_excludes_retired(self):self.exercise()
 def test_invalid_config_never_mutates_live_files_or_api(self):self.exercise(fail_validation=True)
 def test_reload_error_restores_local_files(self):self.exercise(fail_reload=True)
