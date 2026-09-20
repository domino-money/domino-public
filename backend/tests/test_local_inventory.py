import hashlib
import json
import os
from contextlib import contextmanager
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from discovery import DataError, ZERO
from inventory import AlchemyInventory, CursorCodec, LocalCatalogueInventory, LocalFirstInventory
from read_contract import validate_response
from read_service import ReadService
from test_discovery import FakeRpc, OWNER, TOKEN, OTHER
from test_inventory import ProviderTransport, URL, page


class CandidateCatalogue:
    """A deterministic SQL boundary; real schema/query is tested below too."""
    settings = {'dbname':'isolated-test'}
    def __init__(self,values):
        self.values = sorted(set(values)-{ZERO})
        self.queries = 0
    @contextmanager
    def connection(self):yield self
    def execute(self,query,params):
        self.queries += 1
        after,limit = params[-2:]
        fingerprint = hashlib.md5(','.join(self.values).encode()).hexdigest()
        rows = [{'fingerprint':fingerprint,'currency':x} for x in self.values if x>after][:limit]
        self.rows = rows or [{'fingerprint':fingerprint,'currency':None}]
        return self
    def fetchall(self):return self.rows


class LocalInventoryTests(unittest.TestCase):
    def service(self,catalogue=None,fallback=None,rpc=None):
        return ReadService(catalogue=catalogue,inventory=fallback,inventory_local_first=True,
                           rpc_factory=lambda:rpc or FakeRpc(),clock=lambda:1010)

    def test_local_normal_page_probes_balances_without_external_inventory(self):
        external=ProviderTransport([page([OTHER])])
        service=self.service(CandidateCatalogue([TOKEN]),AlchemyInventory(URL,transport=external))
        result=service.wallet_assets(OWNER)
        validate_response('wallet-assets',result)
        self.assertEqual(external.calls,[])
        self.assertEqual(result['inventory']['source'],'local_catalogue')
        self.assertEqual(result['inventory']['coverage'],'local_catalogue_only')
        self.assertIsNone(result['inventory']['fallbackReason'])
        self.assertTrue(result['inventory']['hasMore'])
        self.assertEqual(result['items'][1]['amountRaw'],str(2**255+123))
        continued=service.wallet_assets(OWNER,cursor=result['inventory']['nextCursor'])
        validate_response('wallet-assets',continued)
        self.assertEqual(len(external.calls),2)
        self.assertEqual(continued['items'][1]['address'],OTHER)
        self.assertEqual(continued['inventory']['source'],'alchemy')
        self.assertEqual(continued['inventory']['fallbackReason'],'local_inventory_coverage_partial')

    def test_no_external_config_exhaustion_remains_partial_not_wallet_complete(self):
        result=self.service(CandidateCatalogue([TOKEN])).wallet_assets(OWNER)
        validate_response('wallet-assets',result)
        self.assertEqual(result['inventory']['coverage'],'local_catalogue_only')
        self.assertFalse(result['inventory']['hasMore'])
        self.assertEqual(result['balanceCoverage'],'requested_and_page_addresses_only')

    def test_empty_healthy_local_catalogue_without_fallback_is_not_database_outage(self):
        result=self.service(CandidateCatalogue([])).wallet_assets(OWNER,[TOKEN])
        validate_response('wallet-assets',result)
        self.assertEqual(result['inventory']['status'],'page_received')
        self.assertEqual(result['inventory']['coverage'],'local_catalogue_only')
        self.assertEqual(result['inventory']['rowsReceived'],0)
        self.assertFalse(result['inventory']['hasMore'])
        self.assertEqual(result['items'][1]['address'],TOKEN)

    def test_local_unavailable_or_empty_falls_back_with_reason(self):
        class Broken(CandidateCatalogue):
            @contextmanager
            def connection(self):raise DataError('catalogue_database_unavailable');yield
        for catalogue,reason in ((None,'local_inventory_unavailable'),
                                 (Broken([]),'local_inventory_unavailable'),
                                 (CandidateCatalogue([]),'local_inventory_empty')):
            with self.subTest(reason=reason):
                external=ProviderTransport([page([TOKEN])])
                result=self.service(catalogue,AlchemyInventory(URL,transport=external)).wallet_assets(OWNER)
                validate_response('wallet-assets',result)
                self.assertEqual(result['inventory']['fallbackReason'],reason)
                self.assertEqual(result['inventory']['source'],'alchemy')
                self.assertEqual(len(external.calls),2)

    def test_external_failure_keeps_explicit_balances_and_fallback_attribution(self):
        def fail(*args):raise DataError('http_503')
        result=self.service(None,AlchemyInventory(URL,transport=fail)).wallet_assets(OWNER,[TOKEN])
        validate_response('wallet-assets',result)
        self.assertEqual(result['inventory']['status'],'unavailable')
        self.assertEqual(result['inventory']['source'],'alchemy')
        self.assertEqual(result['inventory']['fallbackReason'],'local_inventory_unavailable')
        self.assertEqual(result['items'][1]['address'],TOKEN)

    def test_keyset_pagination_covers_every_known_token_and_rejects_changed_set(self):
        values=['0x'+format(index,'040x') for index in range(1,58)]
        catalogue=CandidateCatalogue(values)
        inventory=LocalCatalogueInventory(catalogue)
        key=None;seen=[]
        while True:
            result=inventory.page(OWNER,key)
            self.assertLessEqual(len(result['currencies']),20)
            seen.extend(result['currencies']);key=result['nextKey']
            if not key:break
        self.assertEqual(seen,values)
        first=inventory.page(OWNER)
        catalogue.values.append('0x'+'f'*40)
        with self.assertRaisesRegex(DataError,'invalid_or_expired_cursor'):
            inventory.page(OWNER,first['nextKey'])

    def test_continuation_bound_to_wallet_tokens_config_and_local_revision_before_rpc(self):
        catalogue=CandidateCatalogue([TOKEN,OTHER])
        rpc=FakeRpc();rpc.max_requests=16  # one candidate per local page
        external=ProviderTransport([page([TOKEN])])
        service=self.service(catalogue,AlchemyInventory(URL,transport=external),rpc)
        first=service.wallet_assets(OWNER)
        self.assertEqual(first['inventory']['candidatesSkipped'],0)
        cursor=first['inventory']['nextCursor']
        for wallet,tokens in ((OTHER,[]),(OWNER,[TOKEN])):
            with self.assertRaisesRegex(DataError,'invalid_or_expired_cursor'):
                service.wallet_assets(wallet,tokens,cursor=cursor)
        catalogue.values.append('0x'+'f'*40)
        before=rpc.blocks_read
        with self.assertRaisesRegex(DataError,'invalid_or_expired_cursor'):
            service.wallet_assets(OWNER,cursor=cursor)
        self.assertEqual(rpc.blocks_read,before)
        self.assertEqual(external.calls,[])

    def test_maximum_external_cursor_survives_nested_authenticated_continuation(self):
        next_key='"\\'*512
        external=ProviderTransport([page([TOKEN],next_key),page([OTHER])])
        provider=LocalFirstInventory(None,AlchemyInventory(URL,transport=external))
        first=provider.page(OWNER)
        codec=CursorCodec(secret=b'x'*32)
        cursor=codec.issue(OWNER,[],provider.context,first['nextKey'])
        self.assertLessEqual(len(cursor),4096)
        key=codec.read(cursor,OWNER,[],provider.context)
        second=provider.page(OWNER,key)
        self.assertEqual(external.calls[-1]['params'][2]['pageKey'],next_key)
        self.assertEqual(second['currencies'],[OTHER])

    def test_disabled_discovery_does_not_query_local_or_external(self):
        catalogue=CandidateCatalogue([TOKEN]);external=ProviderTransport([])
        result=self.service(catalogue,AlchemyInventory(URL,transport=external)).wallet_assets(OWNER,[TOKEN],auto_discover=False)
        self.assertEqual(catalogue.queries,0)
        self.assertEqual(external.calls,[])
        self.assertEqual(result['inventory']['status'],'not_requested')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','isolated PostgreSQL required')
class LocalInventoryPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from dev_postgres import ADMIN,PORT,SOCKET,create_database
        from catalogue import PgCatalogue
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_restore_tests'}
        create_database(cls.settings['dbname'])
        cls.catalogue=PgCatalogue(cls.settings)
        cls.admin=ADMIN

    def test_actual_query_covers_pool_and_searched_token_without_pool(self):
        import psycopg
        from test_discovery import POOL,KEY,BLOCK
        from psycopg.types.json import Jsonb
        from dataclasses import asdict
        from discovery import PoolKey
        searched='0x'+'8'*40
        with psycopg.connect(**self.settings,user=self.admin) as conn:
            conn.execute('TRUNCATE domino_catalogue.events,domino_catalogue.hints,domino_public.entities CASCADE')
            conn.execute('INSERT INTO domino_catalogue.hints VALUES(%s,%s,%s,%s,%s,%s)',
                         (POOL,KEY[0],KEY[1],Jsonb(asdict(PoolKey.checked(KEY,POOL))),700,BLOCK['hash']))
            conn.execute("INSERT INTO domino_public.entities(kind,entity_id) VALUES('token',%s)",(searched,))
        inventory=LocalCatalogueInventory(self.catalogue)
        first=inventory.page(OWNER,limit=1)
        second=inventory.page(OWNER,first['nextKey'],limit=1)
        self.assertEqual(sorted(first['currencies']+second['currencies']),sorted([TOKEN,searched]))
        self.assertIsNone(second['nextKey'])


if __name__=='__main__':unittest.main()
