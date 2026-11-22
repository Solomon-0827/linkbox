import json
from pathlib import Path
import unittest

import benchmark_policy as policy


FIXTURES = Path(__file__).resolve().parents[2] / 'fixtures/benchmark-policy'


def cases(name):
    return json.loads((FIXTURES / f'{name}.json').read_text())


class BenchmarkPolicyTests(unittest.TestCase):
    def test_shared_samples(self):
        for case in cases('samples'):
            with self.subTest(case=case['name']):
                samples = [{'ms': ms} for ms in case['probes'] if ms is not None]
                minimum = {'minimum': case['minimumSuccesses']} if 'minimumSuccesses' in case else {}
                self.assertEqual(policy.sample_delay(samples, **minimum), case['expected'])

    def test_shared_candidates(self):
        for case in cases('candidates'):
            with self.subTest(case=case['name']):
                rows = {name: {'chain_delay': row.get('chainDelay'), 'delay': row.get('entranceDelay')}
                        for name, row in case['results'].items()}
                self.assertEqual(policy.auto_candidate(rows, case['current'], case['metric']), case['expected'])

    def test_shared_switch_guards(self):
        for case in cases('switch-guards'):
            with self.subTest(case=case['name']):
                state = {'mode': case['mode'], 'exit': 'exit', 'dialer': 'relay'}
                cancelled, unchanged = case['cancelled'], case['routingUnchanged']
                reason = policy.stop_reason(cancelled, unchanged)
                self.assertEqual(policy.run_complete(reason, unchanged), not cancelled and unchanged)
                allowed = policy.chain_allowed(state, 'exit', 'relay') and policy.switch_allowed(
                    unchanged, cancelled=cancelled)
                self.assertEqual(allowed, case['allowed'])

    def test_median_preserves_half_even_rounding(self):
        self.assertEqual(policy.sample_delay([{'ms': 100}, {'ms': 101}]), 100)
