import json
import unittest

import yaml

import subscription_picker as picker
import test_update


class PickerTests(test_update.SubscriptionFixture, unittest.TestCase):
    def test_catalog_keeps_both_copies_and_preselects_only_the_owner(self):
        self.write_profile('b', ['current', 'other'])
        catalog = picker.catalog()
        self.assertNotIn('example.invalid', json.dumps(catalog))
        self.assertEqual([(s['id'], [(n['name'], n['selected']) for n in s['nodes']]) for s in catalog['sources']],
                         [('a', [('current', True), ('fast', True), ('quick', False)]),
                          ('b', [('current', False), ('other', False)])])
        self.apply({'a': ['fast'], 'b': ['current']})
        fresh = picker.catalog()
        self.assertTrue(fresh['sources'][1]['nodes'][0]['selected'])
        self.assertTrue(fresh['sources'][1]['nodes'][0]['current'])
        self.assertEqual(self.active['entry'], 'current')

    def test_duplicate_submission_resolves_in_picker_order(self):
        self.write_profile('b', ['current', 'other'])
        self.apply({'a': ['current'], 'b': ['current']})
        self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'a': ['current']})

    def test_stale_catalog_and_unknown_nodes_do_not_reload(self):
        catalog = picker.catalog()
        request = {'fingerprint': catalog['fingerprint'], 'current': 'current', 'selected': {'a': ['unknown'], 'b': []}}
        with self.assertRaisesRegex(RuntimeError, '格式无效'):
            picker.apply(request)
        self.write_profile('a', ['current', 'unknown'])
        with self.assertRaisesRegex(RuntimeError, '变化'):
            picker.apply(request)
        self.api.assert_not_called()

    def test_picker_hides_deleted_sources_and_rejects_missing_index(self):
        self.index.write_text('items: []')
        self.assertEqual(picker.catalog()['sources'], [])
        self.index.unlink()
        with self.assertRaisesRegex(RuntimeError, '完整读取'):
            picker.synchronize()
        self.api.assert_not_called()

    def test_unsupported_source_does_not_hide_usable_subscriptions(self):
        doc = yaml.safe_load(self.index.read_text())
        doc['items'].append({'type': 'remote', 'url': 'http://example.invalid/legacy', 'file': 'legacy.yaml'})
        self.index.write_text(yaml.safe_dump(doc))
        self.assertEqual([s['name'] for s in picker.catalog()['sources']], ['A', 'B'])
        with self.assertRaisesRegex(RuntimeError, 'HTTPS'):
            picker.synchronize()
        self.api.assert_not_called()
