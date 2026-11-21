import json
import unittest

import gui_backend
import subscription_update
import test_update


class RemovalTests(test_update.SubscriptionFixture, unittest.TestCase):
    def test_removal_updates_selection_and_live_group_using_same_plan(self):
        self.apply({'a': ['current', 'fast'], 'b': ['other']})
        self.requests.clear()
        subscription_update.run(removal={'names': ['fast'], 'entry': 'current'})
        self.assertEqual(json.loads(self.policy.read_text())['selected_nodes'], {'a': ['current'], 'b': ['other']})
        self.assertEqual(self.active['live'], ['current', 'other'])
        self.assertEqual(self.requests, ['/configs?force=false'])

    def test_reject_current_stale_or_unknown(self):
        self.apply({'a': ['current', 'fast'], 'b': []})
        self.requests.clear()
        for req in [{'names': ['current'], 'entry': 'current'}, {'names': ['fast'], 'entry': 'stale'},
                    {'names': ['unknown'], 'entry': 'current'}]:
            with self.assertRaises(RuntimeError):
                gui_backend.remove_list_nodes(req)
        self.assertEqual(self.requests, [])
