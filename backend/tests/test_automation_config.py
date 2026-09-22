"""The private automation configuration: explicit, versioned, refused when incomplete."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from automation_config import gas_price_estimate, parse_config, price_bounds, validate_config
from automation_fixtures import sample_config
from v4_math import MIN_SQRT, MAX_SQRT


class ConfigTests(unittest.TestCase):
    def test_complete_configuration_parses_and_carries_the_planner_settings(self):
        config = parse_config(json.dumps(sample_config()).encode())
        self.assertEqual(config.configVersion, 'test-1')
        self.assertEqual(config.planner_settings().minimumSamples, 3)
        self.assertEqual(config.deployment.serviceFeeBps, 200)

    def test_every_field_is_explicit_and_unknown_fields_are_refused(self):
        for section, field in (('gas', 'publishGasUnits'), ('scheduling', 'maxSourceBlockAge'), ('references', 'maxDivergenceBps'),
                               ('plan', 'priceBandSqrtBps'), ('destinations', 'quoteSlippageBps'), ('finality', 'publicationConfirmations')):
            with self.subTest(section=section, field=field):
                raw = sample_config()
                del raw[section][field]
                with self.assertRaises(ValueError):
                    validate_config(raw)
        with self.assertRaises(ValueError):
            validate_config({**sample_config(), 'extra': 1})
        with self.assertRaises(ValueError):
            validate_config(sample_config(gas={'l1DataComponent': 'zero'}))

    def test_duplicate_keys_and_non_objects_are_refused_at_ingress(self):
        with self.assertRaises(Exception):
            parse_config(b'{"schemaVersion":1,"schemaVersion":1}')
        with self.assertRaises(ValueError):
            parse_config(b'[]')

    def test_role_separation_and_planner_numbers_are_checked(self):
        with self.assertRaises(ValueError):
            validate_config(sample_config(publisher={'keyFile': '/private/operator.key'}))
        with self.assertRaises(ValueError):
            validate_config(sample_config(planner={'minimumSamples': 1}))
        raw = sample_config()
        raw['deployment']['operator'] = raw['deployment']['pricePublisher']
        with self.assertRaises(ValueError):
            validate_config(raw)
        raw = sample_config()
        raw['sequences'].append(dict(raw['sequences'][0]))
        with self.assertRaises(ValueError):
            validate_config(raw)

    def test_price_band_never_exceeds_half_the_impact_bound_and_contains_the_spot(self):
        spot = 2**96
        lower, upper = price_bounds(spot, 25, 100)
        self.assertEqual((lower, upper), (spot * 9975 // 10000, -(-spot * 10025 // 10000)))
        lower, upper = price_bounds(spot, 500, 100)
        self.assertEqual((lower, upper), (spot * 9950 // 10000, -(-spot * 10050 // 10000)))
        self.assertEqual(price_bounds(MIN_SQRT, 25, 100)[0], MIN_SQRT)
        self.assertEqual(price_bounds(MAX_SQRT - 1, 25, 100)[1], MAX_SQRT - 1)
        with self.assertRaises(ValueError):
            price_bounds(MAX_SQRT, 25, 100)

    def test_gas_price_estimate_is_buffered_base_plus_priority(self):
        config = validate_config(sample_config(gas={'basePriceBufferBps': 2500, 'priorityFeePerGasWei': 3}))
        self.assertEqual(gas_price_estimate(1000, config.gas), 1253)
        with self.assertRaises(ValueError):
            gas_price_estimate(-1, config.gas)


if __name__ == '__main__':
    unittest.main()
