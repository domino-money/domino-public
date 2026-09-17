"""Reference prices: explicit mappings, echoed identity, no qualification."""
import os
import psycopg
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, DataError
from price_history import iso
from reference_prices import (ALCHEMY_SOURCE, COINGECKO_SOURCE, MAPPINGS,
                              AlchemyCanonicalReference, coingecko_observations, mapping_for,
                              provenance, store_reference_observations)
from catalogue import PgCatalogue

WETH='0x0bd7d308f8e1639fab988df18a8011f41eacad73'
USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168'
MARLIN='0xab35d04e1ee39c789c4a65d522417b3c7f2e4723'
NOW=1_800_000_000


class MappingTests(unittest.TestCase):
    def test_the_recorded_mappings_resolve_and_carry_their_evidence(self):
        self.assertEqual(len(MAPPINGS),3)
        for currency in (WETH,USDG,MARLIN):
            mapping=mapping_for(currency)
            self.assertEqual(mapping.currency,currency)
            self.assertTrue(mapping.evidence.endswith('.json canonical WETH probe')
                            or 'probe' in mapping.evidence or 'mapping' in mapping.evidence)

    def test_an_unmapped_currency_or_wrong_provider_is_refused(self):
        with self.assertRaisesRegex(DataError,'reference_mapping_required'):
            mapping_for('0x'+'ab'*20)
        with self.assertRaisesRegex(DataError,'reference_provider_not_mapped'):
            mapping_for(WETH,provider='coingecko')

    def test_provenance_names_the_mapping_and_denies_qualification(self):
        record=provenance(mapping_for(WETH))
        self.assertEqual((record['status'],record['provider']),('external_market_reference_unqualified','alchemy'))
        self.assertFalse(record['pointTimestampSemanticsQualified'])
        self.assertFalse(record['targetPoolIndependenceVerified'])
        self.assertEqual(record['robinhoodCurrency'],WETH)


class AlchemyReferenceTests(unittest.TestCase):
    def client(self,response):
        sent=[]
        def transport(url,body):
            sent.append(body)
            return response
        return AlchemyCanonicalReference('https://api.g.alchemy.com/prices/v1/key/tokens/historical',
                                         transport=transport,clock=lambda:NOW),sent

    def response(self,**overrides):
        mapping=mapping_for(WETH)
        value={'network':mapping.reference['network'],'address':mapping.reference['address'],
               'currency':'usd','data':[{'timestamp':iso(NOW-600),'value':'2500.1234567890123456789'}]}
        value.update(overrides)
        return value

    def test_an_exact_echo_becomes_one_unqualified_observation(self):
        client,sent=self.client(self.response())
        rows=client.fetch(mapping_for(WETH),NOW-900,NOW-300)
        self.assertEqual(len(rows),1)
        row=rows[0]
        self.assertEqual((row['chainId'],row['currency'],row['source']),
                         (CHAIN_ID,WETH,ALCHEMY_SOURCE))
        self.assertEqual(row['priceUsd'],'2500.1234567890123456789')
        self.assertEqual(row['provenance']['reference']['address'],
                         '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
        self.assertEqual(sent[0]['network'],'eth-mainnet')
        self.assertEqual(sent[0]['interval'],'5m')

    def test_a_mismatched_identity_is_refused(self):
        for overrides in ({'network':'robinhood-mainnet'},
                          {'address':'0x'+'11'*20},
                          {'currency':'eur'},
                          {'data':[{'timestamp':iso(NOW-600),'value':'0'}]},
                          {'data':[{'timestamp':iso(NOW-600),'value':'1'},{'timestamp':iso(NOW-600),'value':'2'}]},
                          {'data':[{'timestamp':iso(NOW-9000),'value':'1'}]}):
            with self.subTest(overrides=sorted(overrides)), self.assertRaises(DataError):
                self.client(self.response(**overrides))[0].fetch(mapping_for(WETH),NOW-900,NOW-300)

    def test_the_endpoint_must_be_the_prices_api(self):
        for url in ('https://robinhood-mainnet.g.alchemy.com/v2/key','not-a-url'):
            with self.subTest(url=url), self.assertRaises(DataError):
                AlchemyCanonicalReference(url)


class CoinGeckoConversionTests(unittest.TestCase):
    def reference(self,points,coin='jt-marlin'):
        return {'source':COINGECKO_SOURCE,'identity':{'currency':MARLIN,'coinId':coin},'points':points}

    def test_whole_second_points_become_observations(self):
        rows=coingecko_observations(self.reference([{'timestampMs':(NOW-600)*1000,'priceUsd':'0.000101973284'}]),
                                    mapping_for(MARLIN),retrieved_at=NOW)
        self.assertEqual(len(rows),1)
        self.assertEqual((rows[0]['timestamp'],rows[0]['source'],rows[0]['priceUsd']),
                         (NOW-600,COINGECKO_SOURCE,'0.000101973284'))
        self.assertEqual(rows[0]['provenance']['reference'],{'kind':'coingecko_coin_id','coinId':'jt-marlin'})

    def test_a_sub_second_label_or_another_coin_is_refused(self):
        for points,coin in (([{'timestampMs':(NOW-600)*1000+500,'priceUsd':'1'}],'jt-marlin'),
                            ([{'timestampMs':(NOW-600)*1000,'priceUsd':'1'}],'outro-coin'),
                            ([{'timestampMs':(NOW-600)*1000}],'jt-marlin')):
            with self.subTest(points=points,coin=coin), self.assertRaises(DataError):
                coingecko_observations(self.reference(points,coin),mapping_for(MARLIN),retrieved_at=NOW)


class ReferenceRunTests(unittest.TestCase):
    """The timer entry point: per-mapping isolation, hard budget, honest report."""

    def run_pass(self,effects,*,budget=120,ticks=None):
        import collect_reference_prices as module
        from contextlib import redirect_stdout
        import argparse,io
        calls=[]
        def fake_collect(child,*,transport=None,clock=None,emit=True):
            calls.append(child)
            effect=effects[child.currency]
            if isinstance(effect,DataError):raise effect
            return {'observations':effect,'stored':effect,'firstTimestamp':NOW-600,
                    'lastTimestamp':NOW,'maxGapSeconds':300}
        clock_values=list(ticks or [NOW])
        def clock():
            return clock_values.pop(0) if len(clock_values)>1 else clock_values[0]
        args=argparse.Namespace(lookback=3600,budget_seconds=budget,provider_config=None,store=True)
        original=module.collect
        module.collect=fake_collect
        try:
            with redirect_stdout(io.StringIO()) as printed:
                report,failures=module.run_every_mapping(args,clock=clock)
        finally:
            module.collect=original
        return report,failures,calls,printed.getvalue()

    def test_one_provider_refusal_is_that_mappings_own_failure(self):
        report,failures,calls,printed=self.run_pass({WETH:289,USDG:289,
            MARLIN:DataError('reference_rate_limited')})
        self.assertEqual(failures,1)
        by={row['currency']:row for row in report['mappings']}
        self.assertEqual(by[MARLIN],{'currency':MARLIN,'status':'reference_collection_failed',
                                     'reason':'reference_rate_limited'})
        for currency in (WETH,USDG):
            self.assertEqual((by[currency]['status'],by[currency]['stored']),('collected',289))
        self.assertEqual(len(calls),3)
        for child in calls:
            self.assertEqual((child.start,child.end),(NOW-3600,NOW))
            self.assertTrue(child.store)
        self.assertEqual((report['requestedStart'],report['requestedEnd']),(NOW-3600,NOW))
        self.assertFalse(report['productionQualification'])
        self.assertIn('"external_market_reference_collection_run"',printed)

    def test_budget_exhaustion_skips_and_reports_a_decision_point(self):
        # The clock jumps past the budget right after the first mapping starts.
        report,failures,calls,_=self.run_pass({currency:289 for currency in MAPPINGS},
            budget=10,ticks=[NOW,NOW,NOW+11,NOW+11])
        skipped=[row for row in report['mappings'] if row['status']=='reference_collection_skipped']
        self.assertEqual(len(calls),1)
        self.assertEqual(len(skipped),2)
        self.assertTrue(all(row['stoppedBecause']=='budget' for row in skipped))
        self.assertEqual(failures,2)

    def test_reservation_refuses_a_start_that_could_not_finish_inside_the_budget(self):
        # store=True reserves 12+3+5*15=90 s; at budget 120 the threshold is 30.
        report,failures,calls,_=self.run_pass({currency:289 for currency in MAPPINGS},
            budget=120,ticks=[NOW,NOW,NOW+31,NOW+31])
        self.assertEqual(len(calls),1)
        skipped=[row for row in report['mappings'] if row['status']=='reference_collection_skipped']
        self.assertEqual(len(skipped),2)
        self.assertEqual(failures,2)

    def test_a_provider_answering_nothing_in_window_fails_the_pass(self):
        report,failures,calls,_=self.run_pass({WETH:289,USDG:0,MARLIN:289})
        by={row['currency']:row for row in report['mappings']}
        self.assertEqual(by[USDG],{'currency':USDG,'status':'reference_collection_empty',
                                   'observations':0,'stored':0})
        self.assertEqual(failures,1)
        self.assertEqual(len(calls),3)

    def test_the_run_through_the_real_collect_reports_each_mapping_from_its_provider(self):
        import collect_reference_prices as module
        from contextlib import redirect_stdout
        from unittest.mock import patch
        import argparse,io
        from price_history import iso
        alchemy_calls=[]
        def transport(url,body):
            alchemy_calls.append(body['address'])
            return {'network':body['network'],'address':body['address'],'currency':'usd',
                    'data':[{'timestamp':iso(NOW-600),'value':'2500.5'}]}
        def history(self_,currency,*,currency_decimals):
            return {'source':COINGECKO_SOURCE,
                    'identity':{'currency':MARLIN,'coinId':'jt-marlin'},
                    'points':[{'timestampMs':(NOW-300)*1000,'priceUsd':'0.0001'}]}
        args=argparse.Namespace(lookback=3600,budget_seconds=120,provider_config=None,store=False)
        from coingecko_market_reference import CoinGeckoMarketReference
        with patch.object(module,'load_config',lambda *a,**k:{'rpcUrl':'https://x/v2/k'}), \
             patch.object(module,'alchemy_prices_url',lambda url:'https://api.g.alchemy.com/prices/v1/k/tokens/historical'), \
             patch.object(CoinGeckoMarketReference,'history',history), \
             redirect_stdout(io.StringIO()):
            report,failures=module.run_every_mapping(args,transport=transport,clock=lambda:NOW)
        self.assertEqual(failures,0)
        by={row['currency']:row for row in report['mappings']}
        for currency in (WETH,USDG):
            self.assertEqual((by[currency]['status'],by[currency]['observations'],
                              by[currency]['stored']),('collected',1,0))
            self.assertEqual(by[currency]['firstTimestamp'],NOW-600)
        self.assertEqual((by[MARLIN]['status'],by[MARLIN]['observations']),('collected',1))
        self.assertEqual(len(alchemy_calls),2)

    def test_every_mapping_and_single_currency_modes_exclude_each_other(self):
        import collect_reference_prices as module
        from unittest.mock import patch
        for argv,accepted in ((['prog','--every-mapping','--lookback','3600'],True),
                              (['prog','--every-mapping'],False),
                              (['prog','--every-mapping','--lookback','3600','--currency',WETH],False),
                              (['prog','--every-mapping','--lookback','120'],False),
                              (['prog','--every-mapping','--lookback','3600','--budget-seconds','20'],False),
                              (['prog','--currency',WETH,'--budget-seconds','120','--lookback','3600'],False),
                              (['prog','--currency',WETH],False)):
            with patch.object(sys,'argv',argv):
                if accepted:
                    with patch.object(module,'run_every_mapping',return_value=({},0)) as run:
                        self.assertEqual(module.main(),0)
                    self.assertEqual(run.call_args.args[0].lookback,3600)
                    self.assertEqual(run.call_args.args[0].budget_seconds,120)
                else:
                    with self.assertRaises(SystemExit) as raised:
                        module.main()
                    self.assertNotEqual(raised.exception.code,0)

    def test_failures_surface_as_exit_one_and_a_clean_pass_as_zero(self):
        import collect_reference_prices as module
        from unittest.mock import patch
        for failures,expected in ((0,0),(2,1)):
            with patch.object(sys,'argv',['prog','--every-mapping','--lookback','3600']), \
                 patch.object(module,'run_every_mapping',return_value=({},failures)):
                self.assertEqual(module.main(),expected)

    def test_single_currency_lookback_derives_the_window_from_now(self):
        import collect_reference_prices as module
        from unittest.mock import patch
        seen={}
        def fake_collect(child,**kwargs):
            seen['window']=(child.start,child.end)
            return {'observations':1,'stored':0}
        with patch.object(sys,'argv',['prog','--currency',WETH,'--lookback','3600']), \
             patch.object(module,'collect',fake_collect), \
             patch.object(module.time,'time',lambda:NOW):
            self.assertEqual(module.main(),0)
        self.assertEqual(seen['window'],(NOW-3600,NOW))


class StoreValidationTests(unittest.TestCase):
    def test_a_row_must_carry_the_mapped_provenance_before_any_connection(self):
        class NoConnection:
            def connection(self,**kwargs): raise AssertionError('connection attempted')
        good={'chainId':CHAIN_ID,'currency':WETH,'source':ALCHEMY_SOURCE,'timestamp':NOW-600,
              'retrievedAt':NOW,'priceUsd':'2500.0','provenance':provenance(mapping_for(WETH))}
        bad=[{**good,'currency':USDG},{**good,'source':'alchemy_historical'},
             {**good,'priceUsd':'-1'},{**good,'timestamp':NOW+10},
             {**good,'provenance':{**good['provenance'],'status':'qualified'}}]
        for row in bad:
            with self.subTest(row=row['source']), self.assertRaises(DataError):
                store_reference_observations(NoConnection(),[row])



@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1',
                     'set DOMINO_TEST_POSTGRES=1 after dev_postgres.py prepare-tests')
class ReferenceStorageTests(unittest.TestCase):
    """The migration's check admits a mapped reference and refuses a mismatched one."""
    def setUp(self):
        from dev_postgres import PORT, SOCKET
        # The disposable test database: a development catalogue is never wiped.
        self.catalogue=PgCatalogue({'host':str(SOCKET),'port':PORT,
                                    'dbname':'domino_catalogue_tests'})
        with psycopg.connect(**self.catalogue.settings,user='domino_catalogue_admin') as conn:
            conn.execute("DELETE FROM domino_activity.price_observations "
                         "WHERE source IN ('alchemy_canonical_market_reference_v1',"
                         "'coingecko_market_chart_reference_v1')")

    def row(self,**overrides):
        row={'chainId':CHAIN_ID,'currency':WETH,'source':ALCHEMY_SOURCE,'timestamp':NOW-600,
             'retrievedAt':NOW,'priceUsd':'2500.0','provenance':provenance(mapping_for(WETH))}
        row.update(overrides)
        return row

    def test_a_reference_row_is_stored_and_read_back_unchanged(self):
        self.assertEqual(store_reference_observations(self.catalogue,[self.row()]),1)
        with self.catalogue.connection() as conn:
            stored=conn.execute('''SELECT currency,source,observed_at,retrieved_at,price_usd,provenance
              FROM domino_activity.price_observations WHERE currency=%s AND source=%s''',
              (WETH,ALCHEMY_SOURCE)).fetchone()
        self.assertEqual((stored['currency'],stored['source'],stored['price_usd']),
                         (WETH,ALCHEMY_SOURCE,'2500.0'))
        self.assertEqual(stored['provenance']['status'],'external_market_reference_unqualified')

    def test_the_database_refuses_a_mapping_that_does_not_match_the_row(self):
        # The producer validates first; this inserts directly so the constraint
        # itself is what refuses a reference that names another currency.
        mismatched=provenance(mapping_for(USDG))
        with psycopg.connect(**self.catalogue.settings,user='domino_catalogue_admin') as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('''INSERT INTO domino_activity.price_observations
                  (chain_id,currency,source,observed_at,retrieved_at,price_usd,provenance)
                  VALUES (4663,%s,%s,%s,%s,'2500.0',%s)''',
                  (WETH,ALCHEMY_SOURCE,NOW-600,NOW,psycopg.types.json.Jsonb(mismatched)))

    def test_the_reader_role_can_read_but_not_write_the_table(self):
        with psycopg.connect(**self.catalogue.settings,user='domino_catalogue_reader') as conn:
            conn.execute('SELECT count(*) FROM domino_activity.price_observations').fetchone()
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute("INSERT INTO domino_activity.price_observations VALUES "
                             "(4663,'0x"+'aa'*20+"','alchemy_historical',1,1,'1.0','{}'::jsonb)")


if __name__=='__main__':unittest.main()
