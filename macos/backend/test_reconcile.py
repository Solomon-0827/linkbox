import json
from pathlib import Path
import unittest

from reconcile import reconcile


def fixture_test(path):
    def check(self):
        fixture = json.loads(path.read_text())
        self.assertEqual(reconcile(**fixture['inputs']), fixture['expected'])
    return check


class ReconciliationTests(unittest.TestCase):
    pass


for path in sorted((Path(__file__).resolve().parents[2] / 'fixtures/reconcile').glob('*.json')):
    setattr(ReconciliationTests, 'test_' + path.stem.replace('-', '_'), fixture_test(path))
