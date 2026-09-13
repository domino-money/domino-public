"""Synthetic registry entries exercise real stored-series valuation; no live feeds."""
from fractions import Fraction
from pathlib import Path
import copy
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, ZERO, DataError
import price_history as ph
from chainlink_reference import _ReferenceQualification
import performance_valuation as v

POOL = '0x'+'ab'*32
OTHER_POOL = '0x'+'cd'*32
TOKEN = '0x'+'11'*20
OTHER = '0x'+'22'*20


def qualification(currency=TOKEN, *, decimals=0, max_age=300):
    return ph.PriceQualification(currency, decimals, ph.SOURCE, POOL,
        'synthetic_qualification_only', max_age=max_age)


def rows(currency=TOKEN, points=((0,'1'),), *, source=ph.SOURCE):
    return [{'chainId': CHAIN_ID, 'currency': currency, 'source': source, 'timestamp': at,
             'retrievedAt': 100000, 'priceUsd': price,
             'provenance': {'status': 'external_observation_unqualified'}} for at, price in points]


def connection(samples):
    conn = Mock()
    def execute(sql, params):
        chain, currency, sources, start, end = params
        selected = [copy.deepcopy(row) for row in samples if row['chainId'] == chain and row['currency'] == currency
                    and row['source'] in sources and start <= row['timestamp'] <= end]
        return Mock(fetchall=Mock(return_value=sorted(selected, key=lambda row:row['timestamp'])[:ph.MAX_PRICE_ROWS+1]))
    conn.execute.side_effect = execute
    return conn


class ManagedValuationTests(unittest.TestCase):
    def setUp(self):
        self.registry = {}
        self.patch = patch.dict(ph.PRODUCTION_QUALIFICATIONS, self.registry, clear=True)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def load(self, samples, *, currencies=(TOKEN,), start=0, end=10, qualifications=None):
        if qualifications is None:
            qualifications = [qualification(c) for c in currencies]
        ph.PRODUCTION_QUALIFICATIONS.update({(POOL,q.currency):q for q in qualifications})
        return v.load_managed_valuation(connection(samples), pool_id=POOL,
            currencies=currencies, start=start, end=end)

    def test_no_production_qualification_and_observation_flags_never_create_value(self):
        samples = rows()
        samples[0].update(sourceQualification='qualified', status='qualified', decimals=0)
        samples[0]['provenance'].update(status='qualified', targetPoolIndependenceVerified=True)
        conn = connection(samples)
        result = v.load_managed_valuation(conn, pool_id=POOL, currencies=[TOKEN], start=0, end=10)
        self.assertEqual(result.value_amount(TOKEN, '100', 5).reason, 'price_source_quality_not_qualified')
        capital = result.value_capital_interval({TOKEN:'0'}, 0, 10)
        self.assertIsNone(capital.integral_usd_seconds)
        self.assertEqual(capital.pieces, ())
        self.assertEqual(ph.PRODUCTION_QUALIFICATIONS, {})
        conn.execute.assert_not_called()

    def test_reference_only_and_qualification_shaped_objects_remain_unavailable(self):
        reference = _ReferenceQualification(TOKEN, 0, POOL, 'synthetic_reference', 0, 10, (TOKEN,OTHER))
        for value, reason in ((reference, 'reference_only_price_not_qualified'),
                ({'currency':TOKEN,'decimals':0,'status':'qualified'}, 'price_source_quality_not_qualified')):
            ph.PRODUCTION_QUALIFICATIONS[(POOL,TOKEN)] = value
            conn = connection(rows())
            loaded = v.load_managed_valuation(conn, pool_id=POOL, currencies=[TOKEN], start=0, end=10)
            self.assertEqual(loaded.value_amount(TOKEN,'1',5).reason, reason)
            conn.execute.assert_not_called()

    def test_denomination_decimals_and_actual_market_price_are_source_bound(self):
        result = self.load(rows(TOKEN, ((0,'0.997'),)) + rows(ZERO, ((0,'2001.25'),)),
            currencies=(TOKEN,ZERO), qualifications=[qualification(TOKEN,decimals=6),qualification(ZERO,decimals=9)])
        token = result.value_amount(TOKEN,'1000000',3)
        native = result.value_amount(ZERO,'1000000000',3)
        self.assertEqual(token.value_usd,Fraction(997,1000))
        self.assertEqual(native.value_usd,Fraction('2001.25'))
        self.assertEqual((native.price.denomination.chain_id,native.price.denomination.currency,
                          native.price.denomination.decimals,native.price.denomination.quote), (4663,ZERO,9,'USD'))
        self.assertEqual(token.price.qualification_evidence,'synthetic_qualification_only')

    def test_event_time_is_causal_and_preserves_source_timestamp_not_retrieval(self):
        result = self.load(rows(points=((0,'2'),(5,'7'))))
        before, after = result.value_amount(TOKEN,'3',4), result.value_amount(TOKEN,'3',5)
        self.assertEqual((before.value_usd,after.value_usd),(6,21))
        self.assertEqual((before.price.observed_at,before.price.next_observation_at),(0,5))
        self.assertEqual(after.price.observed_at,5)
        result = self.load(rows(points=((5,'7'),)))
        self.assertEqual(result.value_amount(TOKEN,'3',4).reason,'qualified_price_coverage_gap')

    def test_missing_or_expired_price_blocks_zero_and_positive_amount(self):
        for samples in ([],rows()):
            result = self.load(samples, end=301)
            for raw in ('0','1'):
                valued = result.value_amount(TOKEN,raw,301)
                self.assertEqual(valued.status,'unavailable')
                self.assertIsNone(valued.value_usd)
            if samples:
                self.assertEqual(result.value_amount(TOKEN,'1',300).value_usd,1)

    def test_complete_interval_integrates_every_price_change_and_endpoint_once(self):
        result = self.load(rows(points=((0,'1'),(3,'2'),(7,'4'),(10,'8'))),
            qualifications=[qualification(max_age=5)])
        interval = result.value_capital_interval({TOKEN:'1'},0,10)
        self.assertEqual(interval.status,'qualified')
        self.assertEqual(interval.integral_usd_seconds,23)
        self.assertEqual(interval.end_value_usd,8)
        self.assertEqual([(p.starts_at,p.ends_at,p.value_usd) for p in interval.pieces],
            [(0,3,1),(3,5,2),(5,7,2),(7,8,4),(8,10,4)])
        self.assertEqual(result.boundaries(0,10),(3,5,7,8))

    def test_mid_interval_gap_prevents_partial_integral_but_keeps_known_event(self):
        result = self.load(rows(points=((0,'2'),(301,'3'))),end=301)
        self.assertEqual(result.value_amount(TOKEN,'1',301).value_usd,3)
        interval = result.value_capital_interval({TOKEN:'1'},0,301)
        self.assertEqual(interval.reason,'qualified_price_coverage_gap')
        self.assertEqual(interval.pieces,())
        self.assertIsNone(interval.integral_usd_seconds)
        self.assertIsNone(interval.end_value_usd)

    def test_each_capital_endpoint_is_required_even_with_price_in_every_open_interval(self):
        for samples in (rows(points=((1,'1'),(300,'1'))), rows(points=((0,'1'),))):
            result = self.load(samples,end=301)
            self.assertEqual(result.value_capital_interval({TOKEN:'1'},0,301).status,'unavailable')

    def test_all_declared_assets_including_zero_and_native_residual_need_prices(self):
        result = self.load(rows(TOKEN)+rows(OTHER),currencies=(TOKEN,OTHER,ZERO),
            qualifications=[qualification(TOKEN),qualification(OTHER)])
        self.assertEqual(result.value_capital_interval({TOKEN:'5',OTHER:'7'},0,10).integral_usd_seconds,120)
        for native in ('0','1'):
            interval = result.value_capital_interval({TOKEN:'5',OTHER:'7',ZERO:native},0,10)
            self.assertEqual(interval.status,'unavailable')
        result = self.load(rows(TOKEN)+rows(OTHER)+rows(ZERO,((0,'3'),)), currencies=(TOKEN,OTHER,ZERO))
        self.assertEqual(result.value_capital_interval({TOKEN:'5',OTHER:'7',ZERO:'2'},0,10).integral_usd_seconds,180)

    def test_union_of_balance_membership_and_price_boundaries_can_preserve_exact_components(self):
        result = self.load(rows(points=((0,'2'),(5,'3'))))
        # Caller has independently proved a balance change at4 and membership
        # close at8. Summing these pieces is not an assertion of full epoch data.
        first = result.value_capital_interval({TOKEN:'1'},0,4)
        second = result.value_capital_interval({TOKEN:'2'},4,8)
        self.assertEqual(first.integral_usd_seconds+second.integral_usd_seconds,30)
        self.assertEqual([(p.starts_at,p.ends_at) for p in second.pieces],[(4,5),(5,8)])

    def test_large_raw_and_255_decimals_with_36_place_price_remain_exact(self):
        raw = str(2**256-1)
        result = self.load(rows(points=((0,'0.000000000000000000000000000000000001'),)),
            qualifications=[qualification(decimals=255)])
        amount = result.value_amount(TOKEN,raw,5)
        expected = Fraction(2**256-1,10**291)
        self.assertEqual(amount.value_usd,expected)
        self.assertEqual(Fraction(v.exact_decimal(amount.value_usd)),expected)
        self.assertGreater(len(v.exact_decimal(amount.value_usd).split('.')[1]),18)
        self.assertEqual(result.value_capital_interval({TOKEN:raw},0,10).integral_usd_seconds,expected*10)

    def test_currency_pool_and_qualification_changes_are_not_reused(self):
        for change in ('pool','currency','invalid_age'):
            q = qualification()
            object.__setattr__(q, {'pool':'target_pool','currency':'currency','invalid_age':'max_age'}[change],
                {'pool':OTHER_POOL,'currency':OTHER,'invalid_age':301}[change])
            ph.PRODUCTION_QUALIFICATIONS[(POOL,TOKEN)] = q
            result = v.load_managed_valuation(connection(rows()),pool_id=POOL,currencies=[TOKEN],start=0,end=10)
            self.assertEqual(result.value_amount(TOKEN,'1',5).status,'unavailable')
        ph.PRODUCTION_QUALIFICATIONS.clear()
        result = self.load(rows())
        for changed in (None,qualification(decimals=1)):
            if changed is None: ph.PRODUCTION_QUALIFICATIONS.clear()
            else: ph.PRODUCTION_QUALIFICATIONS[(POOL,TOKEN)] = changed
            self.assertEqual(result.value_amount(TOKEN,'1',5).reason,'performance_price_qualification_changed')

    def test_loading_rechecks_registry_and_refuses_foreign_or_reference_series(self):
        ph.PRODUCTION_QUALIFICATIONS[(POOL,TOKEN)] = qualification()
        q = qualification(OTHER)
        foreign = ph.PriceSeries(q,rows(OTHER))
        with patch.object(ph,'load_price_series',return_value=([foreign],[{}])):
            result = v.load_managed_valuation(Mock(),pool_id=POOL,currencies=[TOKEN],start=0,end=10)
        self.assertEqual(result.value_amount(TOKEN,'1',5).reason,'performance_price_qualification_changed')
        def changed(*args):
            ph.PRODUCTION_QUALIFICATIONS.clear()
            return [ph.PriceSeries(qualification(),rows())],[{}]
        with patch.object(ph,'load_price_series',side_effect=changed):
            result = v.load_managed_valuation(Mock(),pool_id=POOL,currencies=[TOKEN],start=0,end=10)
        self.assertEqual(result.value_amount(TOKEN,'1',5).status,'unavailable')

    def test_loaded_observations_are_immutable_snapshots_and_inputs_stay_unchanged(self):
        samples = rows()
        original = copy.deepcopy(samples)
        result = self.load(samples)
        self.assertEqual(samples,original)
        samples[0]['priceUsd'] = '999'
        self.assertEqual(result.value_amount(TOKEN,'1',5).value_usd,1)
        raw = {TOKEN:'1'}
        result.value_capital_interval(raw,0,10)
        self.assertEqual(raw,{TOKEN:'1'})

    def test_exact_decimal_never_rounds_or_accepts_float_nontermination_or_excess(self):
        for value, text in ((0,'0'),(Fraction(1,8),'0.125'),(Fraction(-1,8),'-0.125'),(Fraction(125,10),'12.5')):
            self.assertEqual(v.exact_decimal(value),text)
        for value, reason in ((0.1,'exact_decimal_required'),(True,'exact_decimal_required'),
                (Fraction(1,3),'nonterminating_decimal'),(Fraction(1,10**401),'capacity_exceeded'),(10**512,'capacity_exceeded')):
            with self.subTest(value_type=type(value)),self.assertRaisesRegex(DataError,reason):
                v.exact_decimal(value)

    def test_strict_bounds_raw_types_and_currency_set_do_not_become_zero(self):
        conn = connection(rows())
        for changes in ({'start':True},{'end':86401},{'currencies':[]},{'currencies':[TOKEN,TOKEN]},
                        {'currencies':[TOKEN]*17},{'pool_id':OTHER_POOL.upper()},{'end':2**53}):
            arguments = {'pool_id':POOL,'currencies':[TOKEN],'start':0,'end':10,**changes}
            with self.subTest(changes=changes),self.assertRaises(DataError): v.load_managed_valuation(conn,**arguments)
        result = self.load(rows())
        for raw in (True,1,1.2,'01','-1','1e2',str(2**256),'1'*79):
            with self.subTest(raw=raw),self.assertRaises(DataError): result.value_amount(TOKEN,raw,5)
        for at in (True,-1,11,Fraction(1,2)):
            with self.subTest(at=at),self.assertRaises(DataError): result.value_amount(TOKEN,'1',at)
        for amounts in ({},{OTHER:'1'},[],{TOKEN:'01'}):
            with self.subTest(amounts=amounts),self.assertRaises(DataError): result.value_capital_interval(amounts,0,10)
        with self.assertRaisesRegex(DataError,'zero_capital_duration'): result.value_capital_interval({TOKEN:'1'},5,5)

    def test_price_row_and_boundary_capacity_fail_without_sampling(self):
        dense = rows(points=tuple((t,'1') for t in range(ph.MAX_PRICE_ROWS+1)))
        ph.PRODUCTION_QUALIFICATIONS[(POOL,TOKEN)] = qualification()
        with self.assertRaisesRegex(DataError,'price_observation_budget_exhausted'):
            v.load_managed_valuation(connection(dense),pool_id=POOL,currencies=[TOKEN],start=0,end=ph.MAX_PRICE_ROWS)
        result = self.load(rows(points=((0,'1'),(3,'2'),(7,'3'))))
        with patch.object(v,'MAX_PIECES',2):
            self.assertEqual(result.value_capital_interval({TOKEN:'1'},0,10).reason,'performance_price_boundary_budget_exhausted')
            with self.assertRaisesRegex(DataError,'boundary_budget_exhausted'): result.boundaries(0,10)

    def test_shared_deadline_propagates_instead_of_becoming_price_unavailability(self):
        result = self.load(rows())
        with patch.object(v,'check_read_deadline',side_effect=[None,DataError('read_deadline_exceeded')]):
            with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
                result.value_capital_interval({TOKEN:'1'},0,10)
        with patch.object(v,'check_read_deadline',side_effect=[None,DataError('read_deadline_exceeded')]):
            with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
                v.load_managed_valuation(connection(rows()),pool_id=POOL,currencies=[TOKEN],start=0,end=10)


if __name__ == '__main__':
    unittest.main()
