"""Actual role/RLS, concurrency and crash tests for the UNSIGNED E5 boundary."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import time
import unittest
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.types.json import Jsonb
import execution_models as m
from execution_store import ExecutionLedgerStore, UnsignedExecutionStore, ExecutionStoreError, WORKER_ROLE, LEDGER_ROLE
from execution_cases import scenario, address, identity
from execution_pg import ExecutionPostgres


def fresh_case(*, owner=1, number=11, action=1, amount=1000, collection=False):
    observation,plan,credit=scenario(owner=owner,number=number,action=action)
    c=credit.model_dump(mode='json');c['finalized']=True
    credit=m.FeeCredit.model_validate_json(json.dumps(c))
    o=observation.model_dump(mode='json')
    o['blockTimestamp']=str(int(time.time()))
    o['balances'][0]['reservedRaw']='0'
    o['balances'][0]['reconciliationId']=credit.credit_id()
    o['balances'][0]['lotId']=credit.credit_id()
    source=observation.balances[0].source
    if collection:
        o['accruals']=[{'source':source.model_dump(mode='json'),'amountRaw':'1300','checkpointId':identity(505)}]
        o['balances']=[]
    observation=m.Observation.model_validate_json(json.dumps(o))
    p=plan.model_dump(mode='json')
    p['observationHash']=observation.digest();p['deadline']=str(int(o['blockTimestamp'])+60)
    p['maxGrossFee0']=str(amount);p['minNetAdded0']=str(amount-amount*200//10000)
    if collection:
        p['allocations']=[];p['collections']=[{'sourceId':source.digest(),'maxGrossRaw':str(amount)}]
    else:
        p['allocations'][0]['amountRaw']=str(amount)
        p['allocations'][0]['lotId']=credit.credit_id()
    plan=m.ExecutionPlan.model_validate_json(json.dumps(p))
    return observation,plan,credit,source


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','set DOMINO_TEST_POSTGRES=1 for actual private PostgreSQL roles')
class UnsignedExecutionStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pg=ExecutionPostgres().start()

    @classmethod
    def tearDownClass(cls):
        cls.pg.close()

    def setUp(self):
        with self.pg.admin() as conn:
            conn.execute('TRUNCATE domino_execution.intents,domino_execution.origins CASCADE')
        self.store=UnsignedExecutionStore(self.pg.settings)
        self.ledger=ExecutionLedgerStore(self.pg.settings)
        self.worker=str(uuid.uuid4())

    def case(self,**kwargs):
        obs,plan,credit,source=fresh_case(**kwargs)
        if obs.balances:
            self.ledger.record_credit(obs.sequence.owner,obs.sequence,source,obs.balances[0].lotId,credit)
        item=self.store.persist(obs.sequence.owner,plan,obs,actor=obs.operator)
        return obs,plan,credit,source,item

    def lease(self,item,worker=None):
        return self.store.acquire(item['owner'],item['intentId'],worker or self.worker)

    def reserved(self,**kwargs):
        result=self.case(**kwargs)
        item=self.lease(result[-1])
        item=self.store.reserve(item['owner'],item['intentId'],self.worker,item['fence'])
        return (*result[:-1],item)

    def error(self,code,call):
        with self.assertRaises(ExecutionStoreError) as raised:call()
        self.assertEqual(raised.exception.code,code)
        self.assertEqual(str(raised.exception),code)

    def sql(self,query,args=(),*,owner=address(1),role=WORKER_ROLE):
        with psycopg.connect(**self.pg.settings,user=role) as conn:
            conn.execute("SELECT set_config('domino.execution_owner',%s,true)",(owner,))
            return conn.execute(query,args).fetchall() if query.lstrip().upper().startswith('SELECT') else conn.execute(query,args)

    def test_roles_are_actual_unprivileged_and_every_table_forces_rls(self):
        for role in (WORKER_ROLE,LEDGER_ROLE,'domino_execution_owner'):
            with psycopg.connect(**self.pg.settings,user=role) as conn:
                self.assertEqual(conn.execute('SELECT current_user').fetchone()[0],role)
                flags=conn.execute('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=current_user').fetchone()
                self.assertEqual(flags,(False,False,False,False,False))
        with self.pg.admin() as conn:
            tables=conn.execute("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='domino_execution'::regnamespace AND relkind='r'").fetchall()
            self.assertEqual(len(tables),7);self.assertTrue(all(row==(True,True) for row in tables))
            self.assertEqual(conn.execute("SELECT count(*) FROM pg_proc WHERE pronamespace='domino_execution'::regnamespace AND prosecdef").fetchone()[0],0)

    def test_tenant_isolation_missing_context_and_table_owner_do_not_bypass(self):
        first=self.case()[-1];second=self.case(owner=2)[-1]
        self.assertEqual(self.sql('SELECT intent_id FROM domino_execution.intents'),[(first['intentId'],)])
        self.assertEqual(self.sql('SELECT intent_id FROM domino_execution.intents',owner=address(2)),[(second['intentId'],)])
        self.error('execution_not_found',lambda:self.store.get(address(2),first['intentId']))
        for role in (WORKER_ROLE,'domino_execution_owner'):
            with psycopg.connect(**self.pg.settings,user=role) as conn:
                self.assertEqual(conn.execute('SELECT intent_id FROM domino_execution.intents').fetchall(),[])
                with self.assertRaises(psycopg.Error):
                    conn.execute('SET LOCAL row_security=off');conn.execute('SELECT * FROM domino_execution.intents').fetchall()
        with psycopg.connect(**self.pg.settings,user=WORKER_ROLE) as conn:
            conn.execute("SELECT set_config('domino.execution_owner',%s,true)",(address(2),))
            self.assertEqual(conn.execute('UPDATE domino_execution.intents SET fence=fence+1 WHERE intent_id=%s',(first['intentId'],)).rowcount,0)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.sql('SET ROLE domino_execution_owner')

    def test_worker_cannot_create_credit_or_rewrite_financial_amounts(self):
        obs,plan,credit,source,item=self.case()
        for query,args in [
            ("UPDATE domino_execution.origins SET amount_raw=999999 WHERE lot_id=%s",(obs.balances[0].lotId,)),
            ('DELETE FROM domino_execution.origins',()),
            ('INSERT INTO domino_execution.origins SELECT * FROM domino_execution.origins',()),
            ('TRUNCATE domino_execution.intents CASCADE',()),
            ("CREATE TABLE domino_execution.bypass(n int)",()),
        ]:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):self.sql(query,args)
        changed=deepcopy(item['plan']);changed['maxGrossFee0']='999'
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.sql('UPDATE domino_execution.intents SET plan=%s WHERE intent_id=%s',(Jsonb(changed),item['intentId']))
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.sql("UPDATE domino_execution.intents SET fence=fence+1",role=LEDGER_ROLE)

    def test_duplicate_credit_reinclusion_conflict_and_permanent_quarantine(self):
        obs,plan,credit,source,item=self.case()
        args=(obs.sequence.owner,obs.sequence,source,obs.balances[0].lotId,credit)
        original=self.ledger.record_credit(*args)
        changed=credit.model_dump(mode='json');changed['blockHash']=identity(444)
        self.error('execution_identity_conflict',lambda:self.ledger.record_credit(*args[:-1],m.FeeCredit.model_validate_json(json.dumps(changed))))
        self.error('execution_identity_conflict',lambda:self.ledger.record_credit(*args[:3],identity(777),credit))
        self.ledger.quarantine(obs.sequence.owner,original['originId'])
        self.assertEqual(ExecutionLedgerStore(self.pg.settings).record_credit(*args)['state'],'quarantined')
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.sql("UPDATE domino_execution.origins SET state='available'",role=LEDGER_ROLE)
        item=self.lease(item)
        self.error('execution_origin_unavailable',lambda:self.store.reserve(item['owner'],item['intentId'],self.worker,item['fence']))

    def test_concurrent_duplicate_credit_and_intent_are_idempotent(self):
        obs,plan,credit,source=fresh_case()
        def create(_):
            self.ledger.record_credit(obs.sequence.owner,obs.sequence,source,obs.balances[0].lotId,credit)
            return self.store.persist(obs.sequence.owner,plan,obs,actor=obs.operator)
        with ThreadPoolExecutor(max_workers=4) as pool:rows=list(pool.map(create,range(4)))
        self.assertEqual(len({r['intentId'] for r in rows}),1)
        self.assertEqual(self.sql('SELECT count(*) FROM domino_execution.origins'),[(1,)])
        self.assertFalse(rows[0]['executionEligible'])
        rows[0]['plan']['maxGrossFee0']='1'
        self.assertEqual(self.store.get(rows[1]['owner'],rows[1]['intentId'])['plan']['maxGrossFee0'],'1000')

    def test_persistence_precedes_work_and_wrong_owner_is_rejected(self):
        self.error('execution_not_found',lambda:self.store.acquire(address(1),identity(919),self.worker))
        obs,plan,credit,source=fresh_case()
        self.error('execution_invalid_record',lambda:self.store.persist(address(2),plan,obs,actor=obs.operator))
        invalid=plan.model_copy(update={'maxGrossFee0':'1001'})
        self.error('execution_invalid_record',lambda:self.store.persist(address(1),invalid,obs,actor=obs.operator))
        item=self.store.persist(address(1),plan,obs,actor=obs.operator)
        again=UnsignedExecutionStore(self.pg.settings).get(address(1),item['intentId'])
        self.assertEqual(again,item)
        self.assertEqual(item['state'],'planned')

    def test_two_workers_and_expired_lease_preserve_reservations_and_fence(self):
        obs,plan,credit,source,item=self.case()
        item=self.store.acquire(item['owner'],item['intentId'],self.worker,lease_seconds=1)
        item=self.store.reserve(item['owner'],item['intentId'],self.worker,item['fence'])
        peer=str(uuid.uuid4())
        self.error('execution_lease_busy',lambda:self.store.acquire(item['owner'],item['intentId'],peer))
        time.sleep(1.05)
        self.error('execution_stale_fence',lambda:self.store.cancel(item['owner'],item['intentId'],self.worker,item['fence']))
        self.assertEqual(self.sql('SELECT active FROM domino_execution.lot_claims'),[(True,)])
        recovered=self.store.acquire(item['owner'],item['intentId'],peer)
        self.assertEqual(recovered['fence'],item['fence']+1)
        self.error('execution_stale_fence',lambda:self.store.reserve(item['owner'],item['intentId'],self.worker,item['fence']))
        self.error('execution_stale_fence',lambda:self.store.renew(item['owner'],item['intentId'],self.worker,item['fence']))
        self.assertEqual(self.store.cancel(item['owner'],item['intentId'],peer,recovered['fence'])['state'],'cancelled')
        self.assertEqual(self.sql('SELECT active FROM domino_execution.lot_claims'),[(False,)])

    def test_duplicate_workers_claim_once(self):
        item=self.case()[-1]
        def claim(worker):
            try:return self.store.acquire(item['owner'],item['intentId'],worker)['fence']
            except ExecutionStoreError as e:return e.code
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(claim,[str(uuid.uuid4()),str(uuid.uuid4())]))
        self.assertEqual(sorted(results,key=str),[1,'execution_lease_busy'])

    def test_overlapping_lot_claims_fail_atomically_under_concurrency(self):
        obs,plan,credit,source,first=self.case(amount=1000)
        data=plan.model_dump(mode='json');data['maxGasCostWei']=str(int(data['maxGasCostWei'])+1)
        second=self.store.persist(first['owner'],m.ExecutionPlan.model_validate_json(json.dumps(data)),obs,actor=obs.operator)
        first,second=self.lease(first),self.lease(second)
        def reserve(item):
            try:return self.store.reserve(item['owner'],item['intentId'],self.worker,item['fence'])['state']
            except ExecutionStoreError as e:return e.code
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(reserve,[first,second]))
        self.assertCountEqual(results,['reserved','execution_balance_reserved'])
        self.assertEqual(self.sql('SELECT sum(amount_raw) FROM domino_execution.lot_claims WHERE active'),[(1000,)])
        self.assertCountEqual([self.store.get(i['owner'],i['intentId'])['state'] for i in (first,second)],['planned','reserved'])

    def test_successor_identity_excludes_range_and_failed_claim_rolls_back_lots(self):
        obs,plan,credit,source,first=self.case(action=3,amount=500)
        data=plan.model_dump(mode='json');data['destination']['tickUpper']=660
        other=m.ExecutionPlan.model_validate_json(json.dumps(data))
        self.assertEqual(plan.successor_id(),other.successor_id())
        second=self.store.persist(first['owner'],other,obs,actor=obs.operator)
        first,second=self.lease(first),self.lease(second)
        self.store.reserve(first['owner'],first['intentId'],self.worker,first['fence'])
        self.error('execution_reservation_conflict',lambda:self.store.reserve(second['owner'],second['intentId'],self.worker,second['fence']))
        self.assertEqual(self.sql('SELECT sum(amount_raw) FROM domino_execution.lot_claims WHERE active'),[(500,)])
        self.store.cancel(first['owner'],first['intentId'],self.worker,first['fence'])
        self.assertEqual(self.store.reserve(second['owner'],second['intentId'],self.worker,second['fence'])['state'],'reserved')

    def test_collection_checkpoint_is_exclusive_until_explicit_cancellation(self):
        obs,plan,credit,source,first=self.case(collection=True)
        data=plan.model_dump(mode='json');data['maxGasCostWei']='1000000000001'
        second=self.store.persist(first['owner'],m.ExecutionPlan.model_validate_json(json.dumps(data)),obs,actor=obs.operator)
        first,second=self.lease(first),self.lease(second)
        self.store.reserve(first['owner'],first['intentId'],self.worker,first['fence'])
        self.error('execution_reservation_conflict',lambda:self.store.reserve(second['owner'],second['intentId'],self.worker,second['fence']))
        self.store.cancel(first['owner'],first['intentId'],self.worker,first['fence'])
        self.assertEqual(self.store.reserve(second['owner'],second['intentId'],self.worker,second['fence'])['state'],'reserved')

    def test_cross_owner_nonce_claim_is_global_and_cancelled_nonce_reusable(self):
        first=self.reserved(owner=1)[-1];second=self.reserved(owner=2)[-1]
        def claim(item):
            try:return self.store.reserve_nonce(item['owner'],item['intentId'],self.worker,item['fence'],signer=address(77),nonce_raw='40')
            except ExecutionStoreError as e:return e.code
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(claim,[first,second]))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1)
        self.assertIn('execution_reservation_conflict',results)
        winner=first if isinstance(results[0],dict) else second
        loser=second if winner is first else first
        self.store.cancel(winner['owner'],winner['intentId'],self.worker,winner['fence'])
        result=claim(loser)
        self.assertTrue(result['unsigned'])
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*),count(*) FILTER(WHERE active) FROM domino_execution.nonce_claims').fetchone(),(2,1))
        self.error('execution_state_conflict',lambda:self.store.acquire(winner['owner'],winner['intentId'],str(uuid.uuid4())))

    def fenced_sql(self,item,query,args=(),*,worker=None,acquirer=None):
        with psycopg.connect(**self.pg.settings,user=WORKER_ROLE) as conn:
            conn.execute("SELECT set_config('domino.execution_owner',%s,true),set_config('domino.execution_worker',%s,true),set_config('domino.execution_fence',%s,true),set_config('domino.execution_acquirer',%s,true)",
                         (item['owner'],worker or self.worker,str(item['fence']),acquirer or self.worker))
            return conn.execute(query,args)

    def test_direct_sql_cannot_insert_already_reserved_or_leased_intent(self):
        item=self.case()[-1]
        for state,fence,worker in [('reserved',0,None),('planned',4,self.worker),('cancelled',0,None)]:
            with self.assertRaises(psycopg.errors.CheckViolation):
                self.sql('INSERT INTO domino_execution.intents(intent_id,owner,sequence_hash,chain_id,model_version,plan,observation,commitments,state,fence,worker_id,lease_until) '
                    "SELECT %s,owner,sequence_hash,chain_id,model_version,plan,observation,commitments,%s,%s,%s,CASE WHEN %s::text IS NULL THEN NULL ELSE clock_timestamp()+interval '30 seconds' END FROM domino_execution.intents WHERE intent_id=%s",
                    (identity(901),state,fence,worker,worker,item['intentId']))

    def test_direct_sql_cannot_steal_or_revive_lease_or_skip_fence(self):
        item=self.store.acquire(self.case()[-1]['owner'],self.sql('SELECT intent_id FROM domino_execution.intents')[0][0],self.worker,lease_seconds=1)
        peer=str(uuid.uuid4())
        queries=[
            ('UPDATE domino_execution.intents SET worker_id=%s WHERE intent_id=%s',(peer,item['intentId'])),
            ("UPDATE domino_execution.intents SET worker_id=%s,fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE intent_id=%s",(peer,item['intentId'])),
            ("UPDATE domino_execution.intents SET lease_until=clock_timestamp()+interval '301 seconds' WHERE intent_id=%s",(item['intentId'],)),
            ("UPDATE domino_execution.intents SET state='cancelled',fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE intent_id=%s",(item['intentId'],)),
        ]
        for query,args in queries:
            with self.assertRaises(psycopg.errors.CheckViolation):self.fenced_sql(item,query,args,acquirer=peer)
        time.sleep(1.05)
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.fenced_sql(item,"UPDATE domino_execution.intents SET lease_until=clock_timestamp()+interval '30 seconds' WHERE intent_id=%s",(item['intentId'],))
        renewed=self.store.acquire(item['owner'],item['intentId'],peer)
        self.assertEqual(renewed['fence'],item['fence']+1)
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.fenced_sql(item,"UPDATE domino_execution.intents SET lease_until=clock_timestamp()+interval '30 seconds' WHERE intent_id=%s",(item['intentId'],))

    def test_direct_sql_binds_successor_and_complete_reservation_before_state(self):
        item=self.lease(self.case(action=3)[-1])
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.fenced_sql(item,'INSERT INTO domino_execution.successor_claims(owner,intent_id,successor_id) VALUES(%s,%s,%s)',(item['owner'],item['intentId'],identity(888)))
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.fenced_sql(item,"UPDATE domino_execution.intents SET state='reserved' WHERE intent_id=%s",(item['intentId'],))
        self.assertEqual(self.store.get(item['owner'],item['intentId'])['state'],'planned')
        self.assertEqual(self.store.reserve(item['owner'],item['intentId'],self.worker,item['fence'])['state'],'reserved')

    def test_direct_sql_cannot_borrow_another_sources_checkpoint(self):
        obs,plan,credit,source=fresh_case(collection=True)
        other=m.FeeSourceIdentity(sequence=source.sequence,position=source.position,currency=obs.sequence.poolKey.currency1)
        data=obs.model_dump(mode='json')
        data['accruals'].append({'source':other.model_dump(mode='json'),'amountRaw':'1300','checkpointId':identity(506)})
        data['accruals'].sort(key=lambda a:m.FeeSourceIdentity.model_validate(a['source']).digest())
        obs=m.Observation.model_validate_json(json.dumps(data))
        data=plan.model_dump(mode='json');data['observationHash']=obs.digest()
        plan=m.ExecutionPlan.model_validate_json(json.dumps(data))
        item=self.lease(self.store.persist(obs.sequence.owner,plan,obs,actor=obs.operator))
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.fenced_sql(item,'INSERT INTO domino_execution.source_claims(owner,intent_id,source_id,checkpoint_id,amount_raw) VALUES(%s,%s,%s,%s,%s)',
                (item['owner'],item['intentId'],source.digest(),identity(506),1000))
        self.assertEqual(self.store.reserve(item['owner'],item['intentId'],self.worker,item['fence'])['state'],'reserved')

    def test_postgres_never_rounds_fractional_raw_claim_to_integer(self):
        obs,plan,credit,source,item=self.case()
        item=self.lease(item)
        with self.assertRaises(psycopg.errors.CheckViolation):
            self.fenced_sql(item,'INSERT INTO domino_execution.lot_claims(owner,intent_id,lot_id,amount_raw) VALUES(%s,%s,%s,%s)',
                (item['owner'],item['intentId'],obs.balances[0].lotId,'1000.1'))
        self.assertEqual(self.sql('SELECT count(*) FROM domino_execution.lot_claims'),[(0,)])

    def test_recovery_reads_committed_unsigned_nonce_without_original_process(self):
        item=self.reserved()[-1]
        self.store.reserve_nonce(item['owner'],item['intentId'],self.worker,item['fence'],signer=address(77),nonce_raw='40')
        recovered=UnsignedExecutionStore(self.pg.settings).reservations(item['owner'],item['intentId'])
        self.assertTrue(recovered['unsignedOnly'])
        self.assertEqual(recovered['nonceClaims'],[{'chainId':4663,'signer':address(77),'nonceRaw':'40','active':True}])
        self.error('execution_not_found',lambda:self.store.reservations(address(2),item['intentId']))
        self.store.cancel(item['owner'],item['intentId'],self.worker,item['fence'])
        self.assertFalse(self.store.reservations(item['owner'],item['intentId'])['nonceClaims'][0]['active'])

    def test_nonce_claim_does_not_accept_signed_bytes_or_change_nonce(self):
        item=self.reserved()[-1]
        for invalid in ('-1','01','1e3',1,True,str(2**64-1)):
            self.error('execution_invalid_record',lambda:self.store.reserve_nonce(item['owner'],item['intentId'],self.worker,item['fence'],signer=address(77),nonce_raw=invalid))
        first=self.store.reserve_nonce(item['owner'],item['intentId'],self.worker,item['fence'],signer=address(77),nonce_raw='0')
        self.assertEqual(self.store.reserve_nonce(item['owner'],item['intentId'],self.worker,item['fence'],signer=address(77),nonce_raw='0'),first)
        self.error('execution_identity_conflict',lambda:self.store.reserve_nonce(item['owner'],item['intentId'],self.worker,item['fence'],signer=address(77),nonce_raw='1'))
        for name in ('sign','broadcast','mark_signed','mark_submitted','reconcile_receipt'):
            self.assertFalse(hasattr(self.store,name))
        with self.assertRaises(TypeError):self.store.reserve_nonce(item['owner'],item['intentId'],self.worker,item['fence'],signer=address(77),nonce_raw='0',signed_bytes='0x1234')

    def failing_store(self,needle):
        original=psycopg.connect
        class Failing:
            def __init__(self,conn):self.conn=conn
            def __enter__(self):self.conn.__enter__();return self
            def __exit__(self,*args):return self.conn.__exit__(*args)
            def execute(self,query,args=None):
                result=self.conn.execute(query,args)
                if needle in query:raise RuntimeError('synthetic_process_crash_before_commit')
                return result
        return UnsignedExecutionStore(self.pg.settings,connect=lambda *a,**kw:Failing(original(*a,**kw)))

    def test_crash_during_persist_leaves_no_partial_intent(self):
        obs,plan,credit,source=fresh_case()
        with self.assertRaises(RuntimeError):self.failing_store('INSERT INTO intents').persist(obs.sequence.owner,plan,obs,actor=obs.operator)
        self.error('execution_not_found',lambda:self.store.get(obs.sequence.owner,plan.intent_id()))
        self.assertEqual(self.store.persist(obs.sequence.owner,plan,obs,actor=obs.operator)['state'],'planned')

    def test_crash_during_reservation_rolls_back_all_resources(self):
        item=self.lease(self.case(action=3)[-1])
        with self.assertRaises(RuntimeError):self.failing_store("UPDATE intents SET state='reserved'").reserve(item['owner'],item['intentId'],self.worker,item['fence'])
        self.assertEqual(self.store.get(item['owner'],item['intentId'])['state'],'planned')
        self.assertEqual(self.sql('SELECT count(*) FROM domino_execution.lot_claims'),[(0,)])
        self.assertEqual(self.sql('SELECT count(*) FROM domino_execution.successor_claims'),[(0,)])
        self.assertEqual(self.store.reserve(item['owner'],item['intentId'],self.worker,item['fence'])['state'],'reserved')

    def test_crash_during_nonce_or_cancellation_keeps_committed_reservations(self):
        item=self.reserved(action=3)[-1]
        with self.assertRaises(RuntimeError):self.failing_store('INSERT INTO nonce_claims').reserve_nonce(item['owner'],item['intentId'],self.worker,item['fence'],signer=address(77),nonce_raw='40')
        self.assertEqual(self.sql('SELECT count(*) FROM domino_execution.nonce_claims'),[(0,)])
        self.store.reserve_nonce(item['owner'],item['intentId'],self.worker,item['fence'],signer=address(77),nonce_raw='40')
        with self.assertRaises(RuntimeError):self.failing_store('UPDATE lot_claims SET active=false').cancel(item['owner'],item['intentId'],self.worker,item['fence'])
        self.assertEqual(self.store.get(item['owner'],item['intentId'])['state'],'reserved')
        for table in ('lot_claims','successor_claims','nonce_claims'):
            self.assertEqual(self.sql(f'SELECT active FROM domino_execution.{table}'),[(True,)])
        self.assertEqual(self.store.cancel(item['owner'],item['intentId'],self.worker,item['fence'])['state'],'cancelled')

    @unittest.skipUnless(hasattr(m,'ConvertedLotLineage'),'#99 required for converted lineage')
    def test_converted_origin_is_unique_exact_and_quarantined(self):
        obs,plan,credit,source,item=self.case()
        lineage=m.ConvertedLotLineage(source=source.digest(),transactionHash=identity(600),eventIndex=7,currency=obs.sequence.poolKey.currency1,
            inputAllocations=(m.Allocation(lotId=obs.balances[0].lotId,amountRaw='100'),))
        args=(obs.sequence.owner,obs.sequence,source,identity(601),lineage,'190')
        result=self.ledger.record_converted(*args)
        self.assertEqual(result['state'],'quarantined')
        self.assertEqual(ExecutionLedgerStore(self.pg.settings).record_converted(*args),result)
        self.error('execution_identity_conflict',lambda:self.ledger.record_converted(*args[:-1],'191'))
        changed=lineage.model_copy(update={'inputAllocations':(m.Allocation(lotId=obs.balances[0].lotId,amountRaw='101'),)})
        self.assertEqual(changed.allocation_id(),lineage.allocation_id())
        self.error('execution_identity_conflict',lambda:self.ledger.record_converted(*args[:4],changed,'190'))
        with self.assertRaises(psycopg.errors.CheckViolation):self.sql("UPDATE domino_execution.origins SET state='available' WHERE origin_id=%s",(result['originId'],),role=LEDGER_ROLE)
        self.assertEqual(self.sql('SELECT input_lot_id,amount_raw FROM domino_execution.converted_inputs'),[(obs.balances[0].lotId,100)])

    @unittest.skipUnless(hasattr(m,'ConvertedLotLineage'),'#99 required for converted lineage')
    def test_converted_lineage_rejects_foreign_source_and_atomically_rolls_back(self):
        obs,plan,credit,source,item=self.case()
        other=self.case(number=12)[0]
        lineage=m.ConvertedLotLineage(source=source.digest(),transactionHash=identity(600),eventIndex=7,currency=obs.sequence.poolKey.currency1,
            inputAllocations=(m.Allocation(lotId=other.balances[0].lotId,amountRaw='100'),))
        self.error('execution_lineage_mismatch',lambda:self.ledger.record_converted(obs.sequence.owner,obs.sequence,source,identity(601),lineage,'190'))
        self.assertEqual(self.sql("SELECT count(*) FROM domino_execution.origins WHERE kind='converted'"),[(0,)])


if __name__=='__main__':unittest.main()
