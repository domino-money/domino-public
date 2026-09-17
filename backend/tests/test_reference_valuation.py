"""The labelled reference path answers when the strict registry cannot."""
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.types.json import Jsonb

from catalogue import PgCatalogue
from dev_postgres import PORT, SOCKET
from discovery import CHAIN_ID, DataError
from metrics_service import reference_valuation
from price_history import PriceSeries
from reference_prices import (ALCHEMY_SOURCE, ReferenceQualification, mapping_for, provenance,
                              stored_reference_series)
from test_discovery import POOL
from test_valuation import sample_window
from valuation import value_window

WETH='0x0bd7d308f8e1639fab988df18a8011f41eacad73'
USDG='0x5fc5360d0400a0fd4f2af552add042d716f1d168'
END=86_400


def reference_rows(currency,*,decimals,price,end=END,step=300):
    mapping=mapping_for(currency)
    record=provenance(mapping)
    record['decimals']=decimals
    return [{'chainId':CHAIN_ID,'currency':currency,'source':ALCHEMY_SOURCE,'timestamp':at,
             'retrievedAt':end+step,'priceUsd':price,'provenance':record}
            for at in range(0,end+step,step)]


def reference_series(currency,price,decimals,end=END,pair=(WETH,USDG)):
    mapping=mapping_for(currency)
    qualification=ReferenceQualification(currency=currency,decimals=decimals,target_pool=POOL,
                                         evidence=mapping.evidence,start=0,end=end,
                                         currencies=tuple(pair),source=ALCHEMY_SOURCE)
    return PriceSeries(qualification,reference_rows(currency,decimals=decimals,price=price,end=end))


def pair_window(pair=(WETH,USDG)):
    window=sample_window()
    window['currencies']=list(pair)
    return window


class ReferenceValuationTests(unittest.TestCase):
    def test_a_mapped_reference_pair_values_the_window_and_says_so(self):
        result=value_window(pair_window(),
                            [reference_series(WETH,'2500.5',18),reference_series(USDG,'1.0001',6)],
                            POOL)
        self.assertEqual(result['status'],'reference_analytics_only')
        self.assertEqual(result['priceConvention'],
                         'publication_plus_one_second_and_answer_age_reference_policy')
        self.assertIsNotNone(result['tvlUsd'])
        self.assertFalse(result['executionAvailable'])

    def test_an_unmapped_pool_currency_stops_the_reference_path(self):
        other='0x'+'11'*20
        series=reference_series(WETH,'2500.5',18,pair=(WETH,other))
        with self.assertRaisesRegex(DataError,'reference_price_pool_currencies_mismatch'):
            value_window(pair_window((WETH,other)),[series,series],POOL)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1',
                     'set DOMINO_TEST_POSTGRES=1 after dev_postgres.py prepare-tests')
class StoredReferenceSeriesTests(unittest.TestCase):
    """A DB-only reader uses the stored rows, their mapping and their decimals."""
    def setUp(self):
        self.catalogue=PgCatalogue({'host':str(SOCKET),'port':PORT,
                                    'dbname':'domino_catalogue_tests'})
        with psycopg.connect(**self.catalogue.settings,user='domino_catalogue_admin') as conn:
            conn.execute("DELETE FROM domino_activity.price_observations "
                         "WHERE source='alchemy_canonical_market_reference_v1'")
            for row in reference_rows(WETH,decimals=18,price='2500.5'):
                conn.execute('''INSERT INTO domino_activity.price_observations
                  (chain_id,currency,source,observed_at,retrieved_at,price_usd,provenance)
                  VALUES (%s,%s,%s,%s,%s,%s,%s)''',
                  (CHAIN_ID,row['currency'],row['source'],row['timestamp'],row['retrievedAt'],
                   row['priceUsd'],Jsonb(row['provenance'])))

    def test_the_stored_series_reports_its_mapping_cadence_and_decimals(self):
        with self.catalogue.connection() as conn:
            series,evidence=stored_reference_series(conn,currency=WETH,target_pool=POOL,start=0,
                                                    end=END,currencies=(WETH,USDG))
        self.assertEqual(evidence['status'],'reference_analytics_only')
        self.assertEqual((evidence['provider'],evidence['intervalSeconds']),
                         ('alchemy',300))
        self.assertEqual(evidence['reference']['address'],mapping_for(WETH).reference['address'])
        self.assertFalse(evidence['publicationTimeEstablished'])
        self.assertEqual(series.qualification.decimals,18)
        self.assertTrue(series.qualification.reference_only)

    def test_a_missing_series_or_mapping_refuses_to_build_one(self):
        with self.catalogue.connection() as conn:
            with self.assertRaisesRegex(DataError,'price_history_missing'):
                stored_reference_series(conn,currency=USDG,target_pool=POOL,start=0,end=END,
                                        currencies=(WETH,USDG))
            with self.assertRaisesRegex(DataError,'reference_mapping_required'):
                stored_reference_series(conn,currency='0x'+'11'*20,target_pool=POOL,start=0,
                                        end=END,currencies=(WETH,USDG))

    def test_the_service_helper_returns_none_when_the_reference_cannot_answer(self):
        with self.catalogue.connection() as conn:
            self.assertIsNone(reference_valuation(conn,pair_window(),(WETH,USDG),POOL))


if __name__=='__main__':unittest.main()
