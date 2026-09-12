import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('metrics_examples', ROOT / 'scripts/export-metrics-examples.py')
examples = importlib.util.module_from_spec(spec)
spec.loader.exec_module(examples)


class MetricsExamplesTests(unittest.TestCase):
    def test_review_examples_are_reproducible_and_digests_match(self):
        for name, value in examples.build().items():
            with self.subTest(file=name):
                self.assertEqual((examples.DEST / name).read_text(), value)

    def test_sequence_example_does_not_double_count_redirect_or_operator_gas(self):
        files = examples.build()
        report = json.loads(files['managed.output.json'])
        self.assertEqual(report['status'], 'available')
        self.assertEqual(report['newTradingFeesUsd'], '110.000000000000000000')
        self.assertEqual(report['netFeeIncomeUsd'], '108.000000000000000000')
        self.assertEqual(report['operatorCostsUsd'], '0.250000000000000000')
        # 12h × $1,000 + 12h × $1,098 = a $1,049 day average.
        self.assertEqual(report['timeWeightedCapitalUsd'], '1049.000000000000000000')
        self.assertFalse(report['liveCollectorImplemented'])


if __name__ == '__main__':
    unittest.main()
