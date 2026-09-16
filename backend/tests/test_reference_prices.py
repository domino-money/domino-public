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
from catalogue import configured_catalogue

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
        self.catalogue=configured_catalogue()
        assert self.catalogue.settings['dbname']=='domino_catalogue'
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
              FROM domino_activity.price_observations''').fetchone()
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
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_activity.price_observations')
                             .fetchone()[0],0)
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute("INSERT INTO domino_activity.price_observations VALUES "
                             "(4663,'0x"+'aa'*20+"','alchemy_historical',1,1,'1.0','{}'::jsonb)")


if __name__=='__main__':unittest.main()
