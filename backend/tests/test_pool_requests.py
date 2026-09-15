"""The demand queue: one narrow capability for readers, one for the worker."""
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg

from catalogue import configured_catalogue
from dev_postgres import ADMIN
from discovery import DataError
from pool_requests import PgRequests, REQUESTER_ROLE
from read_service import ReadService
from test_catalogue import block_hash

POOL='0x'+'7a'*32
OTHER='0x'+'7b'*32


class FakeRequests:
    def __init__(self,fail=False):
        self.asked=[];self.fail=fail
    def enqueue(self,pool_id,*,reason='read'):
        if self.fail:raise DataError('pool_request_database_unavailable')
        self.asked.append((pool_id,reason));return True


class RequestTriggerTests(unittest.TestCase):
    """The read path asks for a pool and never fails because of the ask."""
    def service(self,requests):
        return ReadService(rpc_urls=('https://rpc.invalid',),requests=requests)

    def test_a_read_asks_the_queue_for_the_pool_it_could_not_serve(self):
        requests=FakeRequests()
        self.assertTrue(self.service(requests).request_pool(POOL))
        self.assertEqual(requests.asked,[(POOL,'read')])

    def test_a_failing_queue_never_fails_a_read(self):
        self.assertFalse(self.service(FakeRequests(fail=True)).request_pool(POOL))

    def test_no_queue_configured_is_not_an_ask(self):
        self.assertFalse(self.service(None).request_pool(POOL))

    def test_the_read_path_does_not_validate_what_the_store_validates(self):
        # Identity is the store's business; the read path only forwards and
        # reports success or failure.
        requests=FakeRequests()
        self.assertTrue(self.service(requests).request_pool(POOL))
        self.assertEqual(requests.asked,[(POOL,'read')])


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1',
                     'set DOMINO_TEST_POSTGRES=1 after dev_postgres.py prepare-tests')
class PoolRequestStoreTests(unittest.TestCase):
    def setUp(self):
        self.catalogue=configured_catalogue()
        assert self.catalogue.settings['dbname']=='domino_catalogue'
        with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_activity.pool_requests')
        self.requests=PgRequests(self.catalogue)

    def privileges(self,role,statement):
        try:
            with psycopg.connect(**self.catalogue.settings,user=role) as conn:
                conn.execute(statement)
            return 'allowed'
        except psycopg.Error as error:
            return type(error).__name__

    def test_the_requester_may_only_ask(self):
        # The read role may call the function and nothing else: the queue is not
        # writable by the public read path, even though it may read it.
        self.assertTrue(self.requests.enqueue(POOL,reason='read'))
        with self.assertRaises(DataError):
            self.requests.enqueue(POOL,reason='guessing')
        self.assertEqual(self.privileges(REQUESTER_ROLE,
                         "UPDATE domino_activity.pool_requests SET status='following'"),
                         'InsufficientPrivilege')
        self.assertEqual(self.privileges(REQUESTER_ROLE,
                         'DELETE FROM domino_activity.pool_requests'),'InsufficientPrivilege')
        self.assertEqual(self.privileges(REQUESTER_ROLE,
                         "INSERT INTO domino_activity.pool_requests(pool_id,reason) "
                         "VALUES('0x"+'9f'*32+"','read')"),'InsufficientPrivilege')
        # The one capability it gained is the function.
        with psycopg.connect(**self.catalogue.settings,user=REQUESTER_ROLE) as conn:
            self.assertTrue(conn.execute('SELECT domino_activity.request_pool(%s,%s)',
                                         ('0x'+'9e'*32,'read')).fetchone()[0])

    def test_asking_twice_keeps_one_row_and_one_reason(self):
        self.assertTrue(self.requests.enqueue(POOL,reason='read'))
        self.assertTrue(self.requests.enqueue(POOL,reason='operator'))
        rows=self.requests.status()
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['reason'],'read')
        self.assertEqual(rows[0]['status'],'queued')

    def test_a_claim_is_exclusive_until_it_goes_stale(self):
        self.requests.enqueue(POOL)
        first=self.requests.claim(limit=1,stale_seconds=300)
        self.assertEqual([row['pool_id'] for row in first],[POOL])
        self.assertEqual(first[0]['attempts'],1)
        self.assertEqual(self.requests.claim(limit=1,stale_seconds=300),[])
        # A worker that died mid-pool leaves its claim behind; the age is the
        # only thing that makes it claimable again.
        with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_activity.pool_requests "
                         "SET updated_at=clock_timestamp()-interval '1 hour'")
        reclaimed=self.requests.claim(limit=1,stale_seconds=300)
        self.assertEqual(reclaimed[0]['attempts'],2)

    def test_a_worker_records_following_indexing_and_blocked(self):
        self.requests.enqueue(POOL);self.requests.enqueue(OTHER)
        for row in self.requests.claim(limit=2,stale_seconds=1):
            pool_id=row['pool_id']
            if pool_id==POOL:
                self.requests.record(pool_id,'following',detail={'anchorBlock':10})
            else:
                self.requests.record(pool_id,'blocked',error='initialize_anchor_not_found')
        following=self.requests.status(POOL)
        blocked=self.requests.status(OTHER)
        self.assertEqual((following['status'],following['detail']),
                         ('following',{'anchorBlock':10}))
        self.assertEqual((blocked['status'],blocked['last_error']),
                         ('blocked','initialize_anchor_not_found'))
        # A blocked pool is not claimed again by itself; a transient one is.
        self.requests.enqueue('0x'+'7c'*32)
        transient=self.requests.claim(limit=1,stale_seconds=1)[0]
        self.requests.record(transient['pool_id'],'indexing',error='network_unavailable')
        self.assertEqual([row['pool_id'] for row in self.requests.claim(limit=4,stale_seconds=1)],
                         [transient['pool_id']])
        self.assertIn(OTHER,self.requests.retry(OTHER))
        self.assertEqual(self.requests.status(OTHER)['status'],'queued')

    def test_invalid_arguments_are_refused(self):
        with self.assertRaises(DataError): self.requests.enqueue('0x00')
        with self.assertRaises(DataError): self.requests.enqueue(POOL,reason='guessing')
        with self.assertRaises(DataError): self.requests.claim(limit=0)
        with self.assertRaises(DataError): self.requests.claim(stale_seconds=0)
        with self.assertRaises(DataError): self.requests.record(POOL,'queued')
        with self.assertRaises(DataError): self.requests.record('0x'+'7e'*32,'following')


if __name__=='__main__':unittest.main()
