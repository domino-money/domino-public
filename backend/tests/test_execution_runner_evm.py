"""Durability of the executor on the V4 vault: crash points, nonces, reorgs,
signer identity and backup/restore, with a synthetic key, an isolated Anvil
and real private PostgreSQL roles.

These eighteen tests ran on the V3 vault until V3 was retired on 20 September
2026. The runner, signer, store and journal under test are the same; the V4
executor suite's fixture (setup, candidate, finish) replaces the V3 plan
construction, so the scenarios are unchanged.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import time
import unittest
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from eth_account import Account
from eth_hash.auto import keccak
import execution_models as m
from execution_store import UnsignedExecutionStore, ExecutionStoreError
from execution_signer import RestrictedSigner, SignerPolicy, ExecutionError
from execution_runner import ExecutionRunner, ExecutionJournal
from execution_pg import ExecutionPostgres
import test_execution_runner_v4_evm as v4suite
from evm_harness import calldata

KEY=bytes([66])*32  # Public synthetic fixture only. Never a production wallet.


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1' and os.environ.get('DOMINO_TEST_EVM')=='1','isolated PG and EVM required')
class DurableExecutorEvmTests(unittest.TestCase):
    # Composed from the V4 executor suite rather than inherited, so its own
    # tests are not discovered a second time here.
    _V4=v4suite.DurableV4ExecutorTests
    send=_V4.send; deploy=_V4.deploy; call=_V4.call; swaps=_V4.swaps; setup_vault=_V4.setup_vault
    stop=classmethod(_V4.stop.__func__)
    setUpClass=classmethod(_V4.setUpClass.__func__)
    setup=_V4.setup; mined_receipt=_V4.mined_receipt; candidate=_V4.candidate; finish=_V4.finish

    def setUp(self):
        self._V4.setUp(self)
        self.setup()
        self.candidate()

    def step(self,**kwargs):return self.runner.step(self.owner,self.identifier,self.worker,**kwargs)
    def prepare(self):return self.runner.journal.prepare(self.owner,self.identifier,self.worker,self.lease['fence'],self.signer)
    def finality(self):self.rpc.request('anvil_mine',['0x40'])

    def failing_journal(self,needle,failures):
        class FailingConnection:
            def __init__(self,conn):self.conn=conn
            def __enter__(self):self.conn.__enter__();return self
            def __exit__(self,*args):return self.conn.__exit__(*args)
            def execute(self,query,args=None):
                result=self.conn.execute(query,args)
                if needle in query:
                    failures.append(needle)
                    raise RuntimeError('synthetic_journal_crash_before_commit')
                return result
        return ExecutionJournal(self.pg.settings,connect=lambda *a,**kw:FailingConnection(psycopg.connect(*a,**kw)))

    def test_signed_persist_before_broadcast_and_exactly_once_canonical_effect(self):
        original=self.rpc.request
        sends=[]
        def watched(method,params):
            if method=='eth_sendRawTransaction':
                stored=ExecutionJournal(self.pg.settings).read(self.owner,self.identifier)
                self.assertEqual(len(stored['attempts']),1)
                self.assertEqual(bytes(stored['attempts'][0]['signed_bytes']),bytes.fromhex(params[0][2:]))
                self.assertEqual('0x'+keccak(bytes.fromhex(params[0][2:])).hex(),stored['attempts'][0]['transaction_hash'])
                sends.append(params[0])
            return original(method,params)
        self.rpc.request=watched
        try:
            status=self.step();self.assertEqual(status['state'],'submitted')
            self.assertNotIn('signed_bytes',json.dumps(status));self.assertNotIn('data',status)
            self.finality()
            first=self.step()
            if first['state']!='reconciled':
                item=self.runner.journal.read(self.owner,self.identifier)
                cp,_=self.runner._stored_compound(item)
                self.signer.verifier().reconcile(cp,self.admission,item['attempts'][0]['transaction_hash'],e1_plan=self.plan,observation=self.obs)
            self.assertEqual(first['state'],'reconciled',first)
            second=self.step();self.assertEqual(second['receipt'],first['receipt'])
            self.assertEqual(len(sends),1)
            self.assertTrue(first['receipt']['e1Proof'])
            self.assertEqual(first['receipt']['serviceFeeBps'],400)
            with self.pg.admin() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects WHERE canonical').fetchone()[0],1)
        finally:self.rpc.request=original

    def test_ambiguous_broadcast_cannot_cancel_or_allocate_new_nonce(self):
        original=self.rpc.request
        def lost(method,params):
            result=original(method,params)
            if method=='eth_sendRawTransaction':raise TimeoutError('synthetic response lost')
            return result
        self.rpc.request=lost
        try:self.assertEqual(self.step()['state'],'broadcast_unknown')
        finally:self.rpc.request=original
        with self.assertRaises(ExecutionStoreError):self.store.cancel(self.owner,self.identifier,self.worker,self.lease['fence'])
        self.finality();self.assertEqual(self.step()['state'],'reconciled')
        self.assertEqual(len(self.runner.journal.read(self.owner,self.identifier)['attempts']),1)

    def test_crash_after_signing_barrier_then_deterministic_recovery(self):
        self.prepare()
        with self.assertRaises(ExecutionStoreError):self.store.cancel(self.owner,self.identifier,self.worker,self.lease['fence'])
        self.runner=ExecutionRunner(self.pg.settings,self.signer,restore_only=True)
        self.assertEqual(self.step()['state'],'submitted')
        self.finality();self.assertEqual(self.step()['state'],'reconciled')

    def test_crash_after_signature_before_attempt_commit_recovers_same_bytes_and_nonce(self):
        self.prepare()
        before=self.runner.journal.read(self.owner,self.identifier)
        original=self.signer.sign;signatures=[];failures=[]
        def watched(*args,**kwargs):
            result=original(*args,**kwargs);signatures.append(result);return result
        self.signer.sign=watched
        try:
            # Both the signed bytes and state update have executed in PostgreSQL;
            # failing before commit must leave only the prior signing barrier.
            journal=self.failing_journal("UPDATE journal SET state='signed'",failures)
            with self.assertRaisesRegex(RuntimeError,'synthetic_journal_crash_before_commit'):
                journal.persist_signed(self.owner,self.identifier,self.worker,self.lease['fence'],self.signer)
            self.assertEqual(len(failures),1);self.assertEqual(len(signatures),1)
            after=self.runner.journal.read(self.owner,self.identifier)
            self.assertEqual(after['journal']['state'],'signing');self.assertEqual(after['attempts'],[])
            self.assertEqual(after['journal']['nonce'],before['journal']['nonce'])
            self.assertEqual(after['journal']['envelope'],before['journal']['envelope'])
            self.assertIsNone(self.rpc.request('eth_getTransactionByHash',[signatures[0][1]]))
            with self.assertRaises(ExecutionStoreError):
                self.store.cancel(self.owner,self.identifier,self.worker,self.lease['fence'])
            self.runner=ExecutionRunner(self.pg.settings,self.signer,restore_only=True)
            status=self.step();self.assertEqual(status['state'],'submitted')
            self.assertEqual(len(signatures),2);self.assertEqual(signatures[0],signatures[1])
            committed=self.runner.journal.read(self.owner,self.identifier)
            self.assertEqual(len(committed['attempts']),1)
            self.assertEqual(bytes(committed['attempts'][0]['signed_bytes']),signatures[0][0])
            self.assertEqual(committed['attempts'][0]['transaction_hash'],signatures[0][1])
            self.assertEqual(committed['journal']['nonce'],before['journal']['nonce'])
            self.finality();self.assertEqual(self.step()['state'],'reconciled')
            with self.pg.admin() as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.nonce_claims').fetchone()[0],1)
                self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects WHERE canonical').fetchone()[0],1)
        finally:self.signer.sign=original

    def test_crash_during_effect_settlement_rolls_back_then_recovers_once(self):
        self.assertEqual(self.step()['state'],'submitted');self.finality()
        before=self.runner.journal.read(self.owner,self.identifier)
        digest=before['attempts'][0]['transaction_hash'];failures=[]
        self.runner.journal=self.failing_journal('INSERT INTO spends',failures)
        with self.assertRaisesRegex(RuntimeError,'synthetic_journal_crash_before_commit'):
            self.step()
        self.assertEqual(len(failures),1)
        unchanged=ExecutionJournal(self.pg.settings).read(self.owner,self.identifier)
        self.assertEqual(unchanged['journal']['state'],'submitted');self.assertIsNone(unchanged['effect'])
        with self.pg.admin() as conn:
            for table in ('effects','origins','spends'):
                self.assertEqual(conn.execute(f'SELECT count(*) FROM domino_execution.{table}').fetchone()[0],0,table)
            claims=conn.execute('SELECT active FROM domino_execution.source_claims').fetchall()
            self.assertTrue(claims);self.assertTrue(all(row[0] for row in claims))
        self.assertEqual(self.rpc.request('eth_getTransactionReceipt',[digest])['status'],'0x1')
        original=self.rpc.request
        def no_new_broadcast(method,params):
            if method=='eth_sendRawTransaction':raise AssertionError('canonical recovery must not broadcast again')
            return original(method,params)
        self.rpc.request=no_new_broadcast
        try:
            self.runner=ExecutionRunner(self.pg.settings,self.signer,restore_only=True)
            first=self.step();self.assertEqual(first['state'],'reconciled')
            with self.pg.admin() as conn:
                effects=conn.execute('SELECT count(*) FROM domino_execution.effects WHERE canonical').fetchone()[0]
                origins=conn.execute('SELECT lot_id,amount_raw FROM domino_execution.origins ORDER BY lot_id').fetchall()
                spends=conn.execute('SELECT lot_id,amount_raw FROM domino_execution.spends ORDER BY lot_id').fetchall()
            self.assertEqual(effects,1);self.assertTrue(origins);self.assertTrue(spends)
            self.assertEqual(self.step()['receipt'],first['receipt'])
            with self.pg.admin() as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects WHERE canonical').fetchone()[0],1)
                self.assertEqual(conn.execute('SELECT lot_id,amount_raw FROM domino_execution.origins ORDER BY lot_id').fetchall(),origins)
                self.assertEqual(conn.execute('SELECT lot_id,amount_raw FROM domino_execution.spends ORDER BY lot_id').fetchall(),spends)
            final=self.runner.journal.read(self.owner,self.identifier)
            self.assertEqual(len(final['attempts']),1)
            self.assertEqual(final['attempts'][0]['transaction_hash'],digest)
            self.assertEqual(final['journal']['nonce'],before['journal']['nonce'])
        finally:self.rpc.request=original

    def test_restricted_signer_disabled_wrong_identity_and_owner_revocation(self):
        disabled=RestrictedSigner(self.rpc,KEY,self.admission,SignerPolicy(6000000,10**10,10**6,10**17),price_observation_id=self.signer.price_observation_id)
        with self.assertRaisesRegex(ExecutionError,'execution_disabled'):disabled.qualify(self.plan,self.obs)
        wrong=RestrictedSigner(self.rpc,bytes([67])*32,self.admission,self.signer.policy,price_observation_id=self.signer.price_observation_id)
        with self.assertRaisesRegex(ExecutionError,'execution_signer_identity'):wrong.qualify(self.plan,self.obs)
        self.send(self.vault,calldata('revokeOperator()'))
        with self.assertRaisesRegex(ExecutionError,'execution_authority_changed'):self.signer.qualify(self.plan,self.obs)
        self.assertIsNone(self.runner.journal.read(self.owner,self.identifier)['journal'])

    def test_stale_worker_and_actual_roles_cannot_read_or_modify_signed_bytes(self):
        self.prepare();self.runner.journal.persist_signed(self.owner,self.identifier,self.worker,self.lease['fence'],self.signer)
        for role in ('domino_execution_worker','domino_execution_ledger','domino_execution_owner'):
            with psycopg.connect(**self.pg.settings,user=role) as conn:
                conn.execute("SELECT set_config('domino.execution_owner',%s,true)",(self.owner,))
                if role=='domino_execution_owner':self.assertEqual(conn.execute('SELECT signed_bytes FROM domino_execution.attempts').fetchall(),[])
                else:
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege):conn.execute('SELECT signed_bytes FROM domino_execution.attempts')
        with self.pg.admin() as conn:
            conn.execute('ALTER TABLE domino_execution.intents DISABLE TRIGGER USER')
            conn.execute("UPDATE domino_execution.intents SET lease_until=clock_timestamp()-interval '1 second'")
            conn.execute('ALTER TABLE domino_execution.intents ENABLE TRIGGER USER')
        fresh=self.store.acquire(self.owner,self.identifier,str(uuid.uuid4()))
        self.assertGreater(fresh['fence'],self.lease['fence'])
        with self.assertRaises(ExecutionStoreError):self.runner.journal.state(self.owner,self.identifier,self.worker,self.lease['fence'],'submitted')

    def test_restore_default_cannot_create_new_signed_work(self):
        runner=ExecutionRunner(self.pg.settings,self.signer)
        with self.assertRaisesRegex(ExecutionError,'execution_restore_reconciliation_required'):
            runner.step(self.owner,self.identifier,self.worker)
        self.assertIsNone(runner.journal.read(self.owner,self.identifier)['journal'])

    def test_reorg_invalidates_effect_and_preserves_ambiguity(self):
        snapshot=self.rpc.request('evm_snapshot',[])
        self.assertEqual(self.step()['state'],'submitted');self.finality()
        self.assertEqual(self.step()['state'],'reconciled')
        self.rpc.request('evm_revert',[snapshot])
        self.assertEqual(self.step()['state'],'reorged')
        self.assertIsNone(self.runner.journal.status(self.owner,self.identifier)['receipt'])
        self.assertEqual(self.step()['state'],'reorged')
        with self.assertRaises(ExecutionStoreError):self.store.cancel(self.owner,self.identifier,self.worker,self.lease['fence'])

    def test_bounded_replacements_keep_nonce_and_payload_then_one_effect(self):
        self.rpc.request('evm_setAutomine',[False])
        first=self.step();self.assertEqual(first['state'],'submitted')
        second=self.step(replace=True);third=self.step(replace=True)
        self.assertEqual([a['ordinal'] for a in third['attempts']],[0,1,2])
        with self.assertRaisesRegex(ExecutionError,'execution_replacement_limit'):self.step(replace=True)
        attempts=self.runner.journal.read(self.owner,self.identifier)['attempts']
        self.assertEqual(len({a['envelope']['nonce'] for a in attempts}),1)
        self.assertEqual(len({a['envelope']['data'] for a in attempts}),1)
        self.assertTrue(all(a['envelope']['value']==0 for a in attempts))
        self.assertLess(attempts[0]['envelope']['maxFeePerGas'],attempts[1]['envelope']['maxFeePerGas'])
        self.rpc.request('evm_setAutomine',[True]);self.rpc.request('evm_mine',[]);self.finality()
        status=self.step();self.assertEqual(status['state'],'reconciled')
        self.assertEqual(status['receipt']['transactionHash'],attempts[-1]['transaction_hash'])
        with self.pg.admin() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects').fetchone()[0],1)

    def reinclusion(self,*,revert=False,finalize=False):
        snapshot=self.rpc.request('evm_snapshot',[])
        self.assertEqual(self.step()['state'],'submitted');self.finality()
        old=self.step();self.assertEqual(old['state'],'reconciled')
        attempt=self.runner.journal.read(self.owner,self.identifier)['attempts'][0]
        with self.pg.admin() as conn:
            totals=(conn.execute('SELECT count(*),sum(amount_raw) FROM domino_execution.origins').fetchone(),
                    conn.execute('SELECT count(*),sum(amount_raw) FROM domino_execution.spends').fetchone())
        self.assertTrue(self.rpc.request('evm_revert',[snapshot]))
        # No runner step occurs between loss of the old receipt and the new
        # inclusion. A disappearance-only regression does not exercise this.
        if revert:self.send(self.vault,calldata('revokeOperator()'))
        else:self.rpc.request('evm_mine',[])
        self.rpc.request('eth_sendRawTransaction',['0x'+bytes(attempt['signed_bytes']).hex()])
        if finalize:self.finality()
        return old,totals

    def test_immediate_reinclusion_finalized_updates_one_effect_without_duplicate_spends(self):
        old,totals=self.reinclusion(finalize=True)
        new=self.step();self.assertEqual(new['state'],'reconciled')
        self.assertEqual(new['receipt']['transactionHash'],old['receipt']['transactionHash'])
        self.assertNotEqual(new['receipt']['block']['hash'],old['receipt']['block']['hash'])
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects WHERE canonical').fetchone()[0],1)
            self.assertEqual(totals,(conn.execute('SELECT count(*),sum(amount_raw) FROM domino_execution.origins').fetchone(),
                                    conn.execute('SELECT count(*),sum(amount_raw) FROM domino_execution.spends').fetchone()))
        self.assertEqual(self.step()['receipt'],new['receipt'])

    def test_immediate_unfinalized_reinclusion_hides_old_receipt_and_blocks_sequence(self):
        self.reinclusion()
        status=self.step();self.assertEqual(status['state'],'included');self.assertIsNone(status['receipt'])
        other=self.plan.model_copy(update={'maxGasCostWei':str(10**17-1)});identifier=other.intent_id()
        self.store.persist(self.owner,other,self.obs,actor=self.operator)
        lease=self.store.acquire(self.owner,identifier,self.worker,lease_seconds=300)
        self.store.reserve(self.owner,identifier,self.worker,lease['fence'])
        with self.assertRaisesRegex(ExecutionError,'execution_sequence_attention'):
            self.runner.step(self.owner,identifier,self.worker)
        self.finality();self.assertEqual(self.step()['state'],'reconciled')

    def test_immediate_reverted_reinclusion_never_returns_old_financial_receipt(self):
        self.reinclusion(revert=True,finalize=True)
        status=self.step();self.assertEqual(status['state'],'reverted');self.assertIsNone(status['receipt'])
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects WHERE canonical').fetchone()[0],0)
            self.assertGreater(conn.execute('SELECT count(*) FROM domino_execution.spends').fetchone()[0],0)

    def test_signed_crash_before_send_reloads_bytes_without_resigning(self):
        self.prepare();self.runner.journal.persist_signed(self.owner,self.identifier,self.worker,self.lease['fence'],self.signer)
        before=self.runner.journal.read(self.owner,self.identifier)['attempts'][0]
        original=self.signer.sign
        self.signer.sign=lambda *args: (_ for _ in ()).throw(AssertionError('must not sign again'))
        try:self.assertEqual(self.step()['state'],'submitted')
        finally:self.signer.sign=original
        after=self.runner.journal.read(self.owner,self.identifier)['attempts'][0]
        self.assertEqual(before['transaction_hash'],after['transaction_hash'])
        self.assertEqual(bytes(before['signed_bytes']),bytes(after['signed_bytes']))

    def test_real_revert_consumes_nonce_but_has_no_financial_effect(self):
        self.rpc.request('evm_setAutomine',[False])
        self.assertEqual(self.step()['state'],'submitted')
        self.rpc.request('anvil_dropTransaction',[self.runner.journal.status(self.owner,self.identifier)['attempts'][0]['transactionHash']])
        # Owner revokes after signing. The previously signed call cannot obtain
        # fee authority even if later broadcast by a third party.
        self.rpc.request('evm_setAutomine',[True]);self.send(self.vault,calldata('revokeOperator()'))
        attempt=self.runner.journal.read(self.owner,self.identifier)['attempts'][0]
        self.rpc.request('eth_sendRawTransaction',['0x'+bytes(attempt['signed_bytes']).hex()]);self.finality()
        self.assertEqual(self.step()['state'],'reverted')
        self.assertIsNone(self.runner.journal.status(self.owner,self.identifier)['receipt'])
        with self.pg.admin() as conn:self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects').fetchone()[0],0)

    def test_api_reader_has_only_sanitized_columns_and_real_keyset_is_tenant_bound(self):
        from execution_status import ExecutionStatusReader, Status
        with self.pg.admin() as conn:conn.execute('ALTER ROLE domino_execution_reader LOGIN')
        reader=ExecutionStatusReader(self.pg.settings)
        initial=reader.list(self.owner);self.assertEqual(len(initial),1);Status.model_validate(initial[0])
        self.assertEqual(reader.list('0x'+'aa'*20),[])
        self.assertEqual(reader.list(self.owner,after=self.identifier),[])
        with psycopg.connect(**self.pg.settings,user='domino_execution_reader') as conn:
            conn.execute("SELECT set_config('domino.execution_owner',%s,true)",(self.owner,))
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):conn.execute('SELECT signed_bytes FROM domino_execution.attempts')
        self.assertEqual(self.step()['state'],'submitted');self.finality();self.step()
        row=reader.list(self.owner)[0];Status.model_validate(row)
        self.assertEqual(row['state'],'reconciled');self.assertIsNotNone(row['receipt'])
        self.assertNotIn('e1Proof',json.dumps(row));self.assertNotIn('envelope',json.dumps(row))

    def test_actual_backup_restore_recovers_signed_attempt_without_new_nonce(self):
        import subprocess
        self.prepare();self.runner.journal.persist_signed(self.owner,self.identifier,self.worker,self.lease['fence'],self.signer)
        before=self.runner.journal.read(self.owner,self.identifier)['attempts'][0]
        backup=self.pg.root/'signed-backup.dump'
        self.pg.run('pg_dump','-h',self.pg.settings['host'],'-p',str(self.pg.settings['port']),'-U','execution_test_admin',
            '-d','execution_test','-Fc','-f',str(backup))
        with self.pg.admin(autocommit=True) as conn:
            conn.execute('DROP DATABASE IF EXISTS execution_restore')
            conn.execute('CREATE DATABASE execution_restore')
        self.pg.run('pg_restore','-h',self.pg.settings['host'],'-p',str(self.pg.settings['port']),'-U','execution_test_admin',
            '-d','execution_restore','--no-owner',str(backup))
        recovered=ExecutionRunner({**self.pg.settings,'dbname':'execution_restore'},self.signer)
        result=recovered.step(self.owner,self.identifier,self.worker)
        self.assertEqual(result['state'],'submitted')
        self.assertEqual(result['nonceRaw'],str(before['envelope']['nonce']))
        self.assertEqual(result['attempts'][0]['transactionHash'],before['transaction_hash'])
        self.finality();self.assertEqual(recovered.step(self.owner,self.identifier,self.worker)['state'],'reconciled')

    def test_signer_reconstructs_and_rejects_arbitrary_target_value_nonce_chain_or_data(self):
        record={'plan':self.plan.model_dump(mode='json'),'observation':self.obs.model_dump(mode='json')}
        envelope=self.signer.envelope(record,0)
        for field,value in [('to',self.owner),('value',1),('chainId',1),('data','0x'),('gas',21000)]:
            with self.assertRaisesRegex(ExecutionError,'execution_envelope_changed'):
                self.signer.sign(record,{**envelope,field:value})
        raw,digest=self.signer.sign(record,envelope)
        from execution_signer import verify_signed
        for field,value in [('to',self.owner),('nonce',1),('maxFeePerGas',envelope['maxFeePerGas']+1)]:
            with self.assertRaisesRegex(ExecutionError,'execution_signature_mismatch'):
                verify_signed(raw,{**envelope,field:value},self.operator,digest)
