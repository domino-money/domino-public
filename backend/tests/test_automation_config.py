"""The private automation configuration: explicit, versioned, refused when incomplete."""
import json
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from automation_config import GasPoolKey, gas_price_estimate, impact_bounds, parse_config, validate_config
from automation_evidence import price_impact_bps
from automation_fixtures import address, gas_pool, sample_config
import execution_models as m
from v4_math import MIN_SQRT, MAX_SQRT


class ConfigTests(unittest.TestCase):
    def test_complete_configuration_parses_and_carries_the_planner_settings(self):
        config = parse_config(json.dumps(sample_config()).encode())
        self.assertEqual(config.configVersion, 'test-1')
        self.assertEqual(config.planner_settings().minimumSamples, 3)
        self.assertEqual(config.deployment.serviceFeeBps, 200)

    def test_every_field_is_explicit_and_unknown_fields_are_refused(self):
        for section, field in (('gas', 'publishGasUnits'), ('scheduling', 'maxSourceBlockAge'), ('pricing', 'gasPriceBufferBps'),
                               ('pricing', 'wrappedNative'), ('pricing', 'valuationBandBps'), ('swapCap', 'depthMultiplierBps'),
                               ('scheduling', 'jitterBps'), ('scheduling', 'latencyTargetSeconds'), ('scheduling', 'failureBackoffAfter'),
                               ('destinations', 'quoteSlippageBps'), ('finality', 'publicationConfirmations')):
            with self.subTest(section=section, field=field):
                raw = sample_config()
                del raw[section][field]
                with self.assertRaises(ValueError):
                    validate_config(raw)
        with self.assertRaises(ValueError):
            validate_config({**sample_config(), 'extra': 1})
        with self.assertRaises(ValueError):
            validate_config(sample_config(gas={'l1DataComponent': 'zero'}))
        # The service keeps no price band of its own, no external reference, and
        # no swap window but the guard's.
        for section, field, value in (('plan', 'priceBandSqrtBps', 25), ('pricing', 'feeds', {}), ('swapCap', 'windowBlocks', 32)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_config(sample_config(**{section: {field: value}}))
        with self.assertRaises(ValueError):
            validate_config(sample_config(pricing={'kind': 'chainlink_usd_feeds'}))
        # A failure's backoff is never shorter than a normal pass.
        with self.assertRaisesRegex(ValueError, 'backoff_below_interval'):
            validate_config(sample_config(scheduling={'evaluationIntervalSeconds': 61, 'maximumBackoffSeconds': 60}))
        self.assertEqual(validate_config(sample_config(scheduling={'evaluationIntervalSeconds': 60, 'maximumBackoffSeconds': 60})).scheduling.maximumBackoffSeconds, 60)

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

    def test_gas_pools_pair_the_native_asset_with_their_quote_currency(self):
        weth, usdg, other = address(0x2000), address(0x3000), address(0x4000)
        admitted = validate_config(sample_config(pricing={'wrappedNative': weth, 'gasPools': {usdg: gas_pool(usdg)}}))
        self.assertEqual(admitted.pricing.gasPools[usdg].currency0, m.ZERO)
        wrapped = {'currency0': weth, 'currency1': usdg, 'fee': 200, 'tickSpacing': 10, 'hooks': m.ZERO}
        self.assertEqual(validate_config(sample_config(pricing={'wrappedNative': weth, 'gasPools': {usdg: wrapped}})).pricing.gasPools[usdg].currency1, usdg)
        for pools in ({other: gas_pool(usdg)},                                          # the key is not the pool's quote
                      {usdg: {**wrapped, 'currency0': address(0x1000)}},                # no native side
                      {weth: gas_pool(weth)},                                           # the wrapper needs no pool
                      {weth: wrapped},                                                  # nor through another currency
                      {usdg: {**wrapped, 'currency0': m.ZERO, 'currency1': weth}}):     # both sides native
            with self.subTest(pools=pools), self.assertRaises(ValueError):
                validate_config(sample_config(pricing={'wrappedNative': weth, 'gasPools': pools}))
        # Priced through, never traded in: a hooked, dynamic-fee pool is admitted,
        # and its id is the one the PoolManager derives from the key.
        hooked = {'currency0': weth, 'currency1': usdg, 'fee': 0x800000, 'tickSpacing': 60, 'hooks': address(0x44)}
        key = validate_config(sample_config(pricing={'wrappedNative': weth, 'gasPools': {usdg: hooked}})).pricing.gasPools[usdg]
        plain = {**wrapped, 'fee': 200}
        self.assertEqual(GasPoolKey(**plain).pool_id(), m.PoolKey(currency0=weth, currency1=usdg, fee_pips=200, tick_spacing=10, hooks=m.ZERO).pool_id())
        self.assertNotEqual(key.pool_id(), GasPoolKey(**{**hooked, 'hooks': m.ZERO}).pool_id())
        for bad in ({**hooked, 'fee': 2**24}, {**hooked, 'currency0': usdg, 'currency1': weth}, {**hooked, 'tickSpacing': 0}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_config(sample_config(pricing={'wrappedNative': weth, 'gasPools': {usdg: bad}}))

    def test_impact_bounds_are_the_widest_band_the_engine_admits(self):
        # DominoRoutingHelperV4.checkSwapPrices: floor(s*s*10000/a/a) >= 10000-I
        # and ceil(s*s*10000/a/a) <= 10000+I. The band's edges pass and one unit
        # beyond each fails, for spots and limits across the range.
        rng = random.Random(11)
        spots = [2**96, 2**96 + 1, 79228162514264337593543950336 * 3 // 7, MIN_SQRT * 1000 + 17, (MAX_SQRT - 1) // 1000]
        spots += [rng.randrange(MIN_SQRT * 100, MAX_SQRT // 100) for _ in range(40)]
        for spot in spots:
            for impact in (0, 1, 50, 100, 250, 1000, 5000, 9999):
                lower, upper = impact_bounds(spot, impact)
                self.assertLessEqual(price_impact_bps(lower, spot), impact, (spot, impact))
                self.assertLessEqual(price_impact_bps(upper, spot), impact, (spot, impact))
                if lower > MIN_SQRT:
                    self.assertGreater(price_impact_bps(lower - 1, spot), impact, (spot, impact))
                if upper < MAX_SQRT - 1:
                    self.assertGreater(price_impact_bps(upper + 1, spot), impact, (spot, impact))
        # One percent of price is about half a percent of the square root:
        # sqrt(0.99) and sqrt(1.01) of the anchor. Half the impact on the root
        # would overshoot above, (1.005)**2 > 1.01, which the engine refuses.
        lower, upper = impact_bounds(2**96, 100)
        self.assertEqual((lower, upper), (78831026366734652303669917532, 79623317895830914510639640423))
        self.assertLess(upper, 2**96 * 10050 // 10000)
        self.assertGreater(price_impact_bps(2**96 * 10050 // 10000, 2**96), 100)
        self.assertEqual(impact_bounds(2**96, 0), (2**96, 2**96))
        self.assertEqual(impact_bounds(MIN_SQRT, 100)[0], MIN_SQRT)
        self.assertEqual(impact_bounds(MAX_SQRT - 1, 100)[1], MAX_SQRT - 1)
        for bad in ((MAX_SQRT, 100), (MIN_SQRT - 1, 100), (2**96, 10000), (2**96, -1), (float(2**96), 100)):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                impact_bounds(*bad)

    def test_gas_price_estimate_is_buffered_base_plus_priority(self):
        config = validate_config(sample_config(gas={'basePriceBufferBps': 2500, 'priorityFeePerGasWei': 3}))
        self.assertEqual(gas_price_estimate(1000, config.gas), 1253)
        with self.assertRaises(ValueError):
            gas_price_estimate(-1, config.gas)


if __name__ == '__main__':
    unittest.main()
