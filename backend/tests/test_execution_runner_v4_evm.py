"""Real V4 -> synthetic signing -> PG journal -> canonical source settlement."""
import json
import os
from pathlib import Path
import sys
import time
import unittest
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from eth_account import Account
from eth_hash.auto import keccak
import execution_models as m
import execution_v4 as v4
import general_compound_receipts as g
from execution_signer import RestrictedSigner,SignerPolicy,ExecutionError
from execution_runner import ExecutionRunner
from execution_store import UnsignedExecutionStore,ExecutionStoreError
from execution_v4_adapter import rebuild_v4
from execution_pg import ExecutionPostgres
from position_accounting import core_position_id
import test_execution_v4_receipts_evm as evm
from evm_harness import calldata,LIMITS_TYPE

KEY=bytes([66])*32  # Published synthetic local test key; never funded remotely.


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1' and os.environ.get('DOMINO_TEST_EVM')=='1','isolated PG and EVM required')
class DurableV4ExecutorTests(unittest.TestCase):
    send=evm.ExecutionV4ReceiptEvmTests.send
    deploy=evm.ExecutionV4ReceiptEvmTests.deploy
    call=evm.ExecutionV4ReceiptEvmTests.call
    swaps=evm.ExecutionV4ReceiptEvmTests.swaps
    setup_vault=evm.ExecutionV4ReceiptEvmTests.setup_vault
    stop=classmethod(evm.ExecutionV4ReceiptEvmTests.stop.__func__)
    @classmethod
    def setUpClass(cls):
        evm.ExecutionV4ReceiptEvmTests.setUpClass.__func__(cls)
        cls.base_snapshot=cls.rpc.request('evm_snapshot',[])
        cls.pg=ExecutionPostgres().start();cls.addClassCleanup(cls.pg.close)
        with cls.pg.admin() as conn:
            conn.execute((Path(__file__).resolve().parents[1]/'migrations/019_execution_journal.sql').read_text())
            conn.execute('ALTER ROLE domino_execution_signer LOGIN')
    def setUp(self):
        with self.pg.admin() as conn:conn.execute('TRUNCATE domino_execution.intents,domino_execution.origins,domino_execution.signer_heads CASCADE')
        self.rpc.request('evm_revert',[self.base_snapshot]);type(self).base_snapshot=self.rpc.request('evm_snapshot',[])
        self.rpc.request('evm_setAutomine',[True])
        self.operator=Account.from_key(KEY).address.lower()
        self.store=UnsignedExecutionStore(self.pg.settings);self.worker=str(uuid.uuid4());self.children=[]
    def setup(self,*,native=False):
        self.setup_vault(native=native)
        self.rpc.request('anvil_setBalance',[self.operator,hex(10**20)])
        self.send(self.vault,calldata('setOperator(address)',['address'],[self.operator]))
        self.send(self.vault,calldata('setExecutionLimits('+LIMITS_TYPE+')',[LIMITS_TYPE],[(2,5000,100,100,10**18,120,3600)]))
        self.swaps()
    def mined_receipt(self,tx):
        # Anvil auto-mining can finish just after the send reply under the full
        # suite's load. This waits for the actual receipt, never invents one.
        end=time.monotonic()+2
        while time.monotonic()<end:
            receipt=self.rpc.request('eth_getTransactionReceipt',[tx])
            if receipt is not None:return receipt
            time.sleep(.01)
        self.fail('synthetic publisher transaction was not mined within two seconds')
    def candidate(self,*,action=1,net=False,swap=False,destination=None,charged_lot=None):
        # Pin a time that satisfies both the contract interval and PostgreSQL's
        # real-time admission. Advancing Anvil into the future is not valid
        # evidence; neither does a fixed host sleep prove the chain interval.
        head=self.rpc.request('eth_getBlockByNumber',['latest',False])
        last=self.call(self.vault,'lastExecutionAt()',['uint64'])[0]
        target=max(int(head['timestamp'],16)+1,last+1,int(time.time()))
        wait_until=time.monotonic()+5
        while time.time()<target:
            if time.monotonic()>=wait_until:self.fail('local chain is ahead of the database clock')
            time.sleep(min(.01,max(.001,target-time.time())))
        self.rpc.request('evm_setNextBlockTimestamp',[target]);self.rpc.request('evm_mine',[])
        block=self.rpc.request('eth_getBlockByNumber',['latest',False]);seq=self.admission.sequence
        members=[];points={}
        for token in (self.token,*self.children):
            row=self.call(self.vault,'position(uint256)',[g.POSITION_TYPE],['uint256'],[token])[0]
            point=self.call(self.vault,'checkpoint(uint256)',[g.CHECKPOINT_TYPE],['uint256'],[token])[0]
            member=m.PositionIdentity(sequence=seq.digest(),tokenId=str(token),generation=str(row[4]),isRoot=row[2],parentTokenId=str(row[3]),
                tickLower=row[5],tickUpper=row[6],registrationBaselineId='0x'+row[7].hex(),
                corePositionId=core_position_id(seq.positionManager,row[5],row[6],'0x'+token.to_bytes(32,'big').hex()))
            members.append(m.CustodyObservation(position=member,holder=seq.owner if row[2] else seq.vault,
                individualApproval=seq.vault if row[2] else m.ZERO,active=row[1]));points[str(token)]='0x'+point[6].hex()
        root=next(p.position for p in members if p.position.isRoot)
        target=next(p.position for p in members if p.position.tokenId==str(destination or self.token))
        limits=m.ExecutionLimits(version='2',baseCurrency=seq.baseCurrency,quoteCurrency=seq.quoteCurrency,upsideBps=5000,
            maxSlippageBps=100,maxPriceImpactBps=100,maxGasCostWei=str(10**18),maxObservationAgeSeconds=120,forecastHorizonSeconds=3600)
        policy=m.SequencePolicy(serviceFeeBps=400,triggerDistanceBps=1000,maxOverlapBps=1000,minimumIntervalSeconds=1,maxPositions=4,version='1',paused=False,limits=limits)
        accruals=tuple(sorted((m.AccrualObservation(source=m.FeeSourceIdentity(sequence=seq.digest(),position=root.digest(),currency=c),
            amountRaw=str(10**15),checkpointId=points[root.tokenId]) for c in (seq.poolKey.currency0,seq.poolKey.currency1)),key=lambda a:a.source.digest()))
        balances=[]
        # Admin helper returns tuples; use a trusted role snapshot with
        # a dict cursor only in this disposable fixture.
        from psycopg.rows import dict_row
        with self.pg.admin() as conn:
            with conn.cursor(row_factory=dict_row) as cursor:
                cursor.execute('SELECT o.*,o.amount_raw-coalesce((SELECT sum(s.amount_raw) FROM domino_execution.spends s WHERE s.lot_id=o.lot_id),0) AS remaining FROM domino_execution.origins o WHERE sequence_hash=%s AND state=\'available\'',(seq.digest(),))
                for row in cursor.fetchall():
                    balances.append(m.SourceBalance(source=m.FeeSourceIdentity.model_validate(row['source_record']),lotId=row['lot_id'],currency=row['currency'],
                        convertedCharged=row['kind']=='converted',amountRaw=str(row['remaining']),reservedRaw='0',reconciliationId=row['origin_id']))
        price=self.call(self.state,'getSlot0(bytes32)',['uint160','int24','uint24','uint24'],['bytes32'],[bytes.fromhex(seq.poolId[2:])])[0]
        observation=m.Observation(sequence=seq,policy=policy,stateNonce=str(self.call(self.vault,'stateNonce()',['uint64'])[0]),
            authorityGeneration=str(self.call(self.vault,'authorityGeneration()',['uint64'])[0]),blockNumber=str(int(block['number'],16)),blockHash=block['hash'],
            blockTimestamp=str(int(block['timestamp'],16)),sqrtPriceX96=str(price),operator=self.operator,operatorEnabled=True,canonical=True,coverageComplete=True,
            positions=tuple(sorted(members,key=lambda p:p.position.digest())),balances=tuple(sorted(balances,key=lambda b:b.lotId)),accruals=accruals)
        disabled=m.SwapBounds(enabled=False,adapterId=m.ZERO_HASH,adapterVersion='0',routeCommitment=m.ZERO_HASH,currencyIn=m.ZERO,currencyOut=m.ZERO,amountInRaw='0',minAmountOutRaw='0')
        charged=[0,0];allocations=[]
        if charged_lot:
            chosen=next(b for b in balances if b.lotId==charged_lot)
            allocations=[m.Allocation(lotId=charged_lot,amountRaw='1')];charged[(seq.poolKey.currency0,seq.poolKey.currency1).index(chosen.currency)]=1
        plan=m.ExecutionPlan(sequence=seq,policyHash=policy.digest(),observationHash=observation.digest(),action=action,path=1 if net else 0,
            expectedPolicyVersion='1',expectedStateNonce=observation.stateNonce,expectedAuthorityGeneration=observation.authorityGeneration,
            sourceBlockNumber=observation.blockNumber,sourceBlockHash=observation.blockHash,deadline=str(int(observation.blockTimestamp)+100),
            allocations=tuple(allocations),collections=tuple(m.CollectionBudget(sourceId=a.source.digest(),maxGrossRaw=str(10**15)) for a in accruals),
            destination=m.Destination(createChild=action==3,tokenId=target.tokenId,tickLower=-420 if action==3 else target.tickLower,tickUpper=4680 if action==3 else target.tickUpper),
            liquidityIncrease=str(10**11 if swap else 10**10 if action in (2,3) or charged_lot else 5*10**13),maxGrossFee0=str(10**15),maxGrossFee1=str(10**15),
            maxChargedInput0=str(charged[0]),maxChargedInput1=str(charged[1]),minNetAdded0='1',minNetAdded1='1',
            maxNetAdded0=str(2**127-1),maxNetAdded1=str(2**127-1),
            minSqrtPriceX96=str(2**95),maxSqrtPriceX96=str(2**97),maxGasCostWei=str(10**17),swap=disabled)
        self.rpc.request('evm_mine',[])
        # Every action carries a published observation, swap or not: the engine
        # anchors the whole execution, so the signer requires one to sign at all.
        point=(bytes.fromhex(seq.poolId[2:]),int(observation.blockNumber),bytes.fromhex(observation.blockHash[2:]),int(observation.blockTimestamp),int(plan.deadline),price)
        tx=self.rpc.request('eth_sendTransaction',[{'from':self.admission.pricePublisher,'to':self.admission.priceGuard,'gas':hex(1000000),
            'data':calldata('publish((bytes32,uint64,bytes32,uint64,uint64,uint160))',['(bytes32,uint64,bytes32,uint64,uint64,uint160)'],[point])}])
        receipt=self.mined_receipt(tx);self.assertEqual(receipt['status'],'0x1');price_id=receipt['logs'][0]['topics'][1]
        if swap:
            incoming=10**9
            minimum=self.call(self.admission.routingHelper,'minimumOutput(uint128,uint160,bool,uint16)',['uint256'],
                ['uint128','uint160','bool','uint16'],[incoming,price,True,100])[0]
            source=next(a.source.digest() for a in accruals if a.source.currency==seq.poolKey.currency0)
            route=v4.SwapPlan(sourceId=source,currencyIn=seq.poolKey.currency0,amountIn=str(incoming),maxOriginal=str(10**15),maxCharged='0',
                minAmountOut=str(minimum),sqrtPriceLimitX96=plan.minSqrtPriceX96,priceObservationId=price_id)
            bounds=m.SwapBounds(enabled=True,adapterId=v4.ADAPTER_ID,adapterVersion=v4.ADAPTER_VERSION,routeCommitment=v4.route_commitment(route,seq.poolId),
                currencyIn=seq.poolKey.currency0,currencyOut=seq.poolKey.currency1,amountInRaw=str(incoming),minAmountOutRaw=str(minimum))
            plan=m.ExecutionPlan.model_validate_json(json.dumps({**plan.model_dump(mode='json'),'swap':bounds.model_dump(mode='json')}))
        self.obs,self.plan=observation,plan
        self.signer=RestrictedSigner(self.rpc,KEY,self.admission,SignerPolicy(6000000,10**10,10**6,10**17,enabled=True),price_observation_id=price_id)
        self.runner=ExecutionRunner(self.pg.settings,self.signer,restore_only=False);self.identifier=plan.intent_id()
        self.store.persist(self.owner,plan,observation,actor=self.operator)
        self.lease=lease=self.store.acquire(self.owner,self.identifier,self.worker,lease_seconds=300)
        self.store.reserve(self.owner,self.identifier,self.worker,lease['fence'])
        return plan
    def step(self):
        original=self.rpc.request;failures=[]
        def diagnosed(method,params):
            try:return original(method,params)
            except Exception as error:
                if method in ('eth_call','eth_estimateGas'):
                    # This harness owns a disposable loopback chain and public
                    # synthetic accounts. Keep the actual revert/transport cause
                    # in test output; production diagnostics stay sanitized.
                    failures.append(f'{method}: {str(error)[:800]}')
                raise
        self.rpc.request=diagnosed
        try:return self.runner.step(self.owner,self.identifier,self.worker)
        except ValueError as error:
            for detail in failures:error.add_note('Synthetic local EVM '+detail)
            raise
        finally:self.rpc.request=original
    def finish(self):
        self.rpc.request('anvil_mine',['0x40','0x0'])
        status=self.step()
        if status['state']!='reconciled':
            data=self.runner.journal.read(self.owner,self.identifier);typed,_=self.runner._stored_compound(data)
            self.signer.verifier().reconcile(typed,self.admission,data['attempts'][0]['transaction_hash'],e1_plan=self.plan,observation=self.obs)
        self.assertEqual(status['state'],'reconciled',status)
        return status
    def test_general_actual_signed_bytes_and_exactly_once_effect(self):
        self.setup();self.candidate()
        self.assertEqual(self.step()['state'],'submitted')
        status=self.finish();again=self.step();self.assertEqual(status['receipt'],again['receipt'])
        self.assertEqual(status['receipt']['action'],0)
        self.assertTrue(status['receipt']['e1Proof'])
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects').fetchone()[0],1)
            self.assertGreater(conn.execute('SELECT count(*) FROM domino_execution.spends').fetchone()[0],0)
    def test_native_net_actual_receipt(self):
        self.setup(native=True);self.candidate(net=True)
        self.assertEqual(self.step()['state'],'submitted');status=self.finish()
        self.assertEqual(status['receipt']['action'],1)
        self.assertIn(m.ZERO,{row['currency'] for row in status['receipt']['sources']})
    def test_successor_then_foreign_source_funds_existing_child(self):
        self.setup();self.candidate(action=3)
        self.assertEqual(self.step()['state'],'submitted');created=self.finish()
        child=int(created['receipt']['destinationTokenId']);self.children.append(child)
        self.swaps()
        self.candidate(action=2,destination=child)
        self.assertEqual(self.step()['state'],'submitted');funded=self.finish()
        self.assertEqual(funded['receipt']['destinationTokenId'],str(child))
        self.assertEqual(funded['receipt']['liquidityAfterRaw'],str(2*10**10))
    def test_swap_output_is_qualified_once_with_input_debits_and_fully_consumed(self):
        self.setup();self.candidate(swap=True)
        self.assertEqual(self.step()['state'],'submitted');status=self.finish()
        self.assertEqual(len(status['receipt']['conversions']),1)
        with self.pg.admin() as conn:
            rows=conn.execute("SELECT lot_id,amount_raw,state,qualification_intent_id FROM domino_execution.origins WHERE kind='converted'").fetchall()
            self.assertEqual(len(rows),1);lot,amount,state,intent=rows[0]
            self.assertEqual((state,intent),('available',self.identifier))
            spent=conn.execute('SELECT coalesce(sum(amount_raw),0) FROM domino_execution.spends WHERE lot_id=%s',(lot,)).fetchone()[0]
            self.assertGreater(amount,0);self.assertEqual(amount-spent,0)
            self.assertGreater(conn.execute('SELECT count(*) FROM domino_execution.converted_inputs').fetchone()[0],0)
        # The legacy ledger can report a quarantined lineage, but cannot promote
        # even this known transaction to another available converted origin.
        from execution_store import ExecutionLedgerStore
        def forged(conn,owner):
            conn.execute("INSERT INTO origins(origin_id,owner,sequence_hash,source_id,lot_id,currency,kind,transaction_hash,event_index,amount_raw,state,source_record,evidence,qualification_intent_id) SELECT %s,owner,sequence_hash,source_id,%s,currency,kind,transaction_hash,event_index+1,amount_raw,state,source_record,evidence,qualification_intent_id FROM origins WHERE lot_id=%s",
                ('0x'+'dd'*32,'0x'+'ee'*32,lot))
        with self.assertRaisesRegex(ExecutionStoreError,'execution_lineage_mismatch'):
            ExecutionLedgerStore(self.pg.settings)._transaction(self.owner,forged)
        # The consumed conversion remains auditable but cannot fund a new
        # action. Pre-existing waiting lots have separate explicit fixtures.
        self.swaps()
        with self.assertRaisesRegex(ValueError,'allocation_unavailable'):
            self.candidate(charged_lot=lot)
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT coalesce(sum(amount_raw),0) FROM domino_execution.spends WHERE lot_id=%s',(lot,)).fetchone()[0],amount)

    def test_price_identity_and_revocation_block_signing_before_journal(self):
        self.setup();self.candidate(swap=True)
        with self.assertRaisesRegex(ExecutionError,'execution_price_publisher_not_independent'):
            RestrictedSigner(self.rpc,KEY,self.admission.model_copy(update={'pricePublisher':self.operator}),self.signer.policy)
        price_id=self.signer.price_observation_id
        tx=self.rpc.request('eth_sendTransaction',[{'from':self.admission.pricePublisher,'to':self.admission.priceGuard,'gas':hex(1000000),
            'data':calldata('revoke(bytes32)',['bytes32'],[bytes.fromhex(price_id[2:])])}])
        self.assertEqual(self.mined_receipt(tx)['status'],'0x1')
        with self.assertRaisesRegex(ValueError,'execution_price_observation_unqualified'):self.step()
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.journal').fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.attempts').fetchone()[0],0)

    def test_unallocated_old_original_fees_cannot_cover_empty_new_collection(self):
        self.setup();self.candidate()
        self.assertEqual(self.step()['state'],'submitted');first=self.finish()
        self.assertTrue(any(int(r['originalAfterRaw'])>0 for r in first['receipt']['sources']))
        # No trade occurred after the first collection. Its unspent old fees do
        # not authorize another plan containing only prospective collection caps.
        self.candidate()
        with self.assertRaises(ValueError):self.step()
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.journal').fetchone()[0],1)
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.attempts').fetchone()[0],1)

    def test_swap_ambiguous_delivery_recovers_once_then_reorg_blocks_new_work(self):
        self.setup();self.candidate(swap=True)
        snapshot=self.rpc.request('evm_snapshot',[])
        request=self.rpc.request
        def lost(method,params):
            result=request(method,params)
            if method=='eth_sendRawTransaction':raise TimeoutError('synthetic reply lost')
            return result
        self.rpc.request=lost
        try:self.assertEqual(self.step()['state'],'broadcast_unknown')
        finally:self.rpc.request=request
        lease=self.store.acquire(self.owner,self.identifier,self.worker,lease_seconds=300)
        with self.assertRaises(ExecutionStoreError):self.store.cancel(self.owner,self.identifier,self.worker,lease['fence'])
        self.finish()
        self.assertEqual(len(self.runner.journal.read(self.owner,self.identifier)['attempts']),1)
        self.assertTrue(self.rpc.request('evm_revert',[snapshot]))
        self.assertEqual(self.step()['state'],'reorged')
        candidate=m.ExecutionPlan.model_validate_json(json.dumps({**self.plan.model_dump(mode='json'),'deadline':str(int(self.plan.deadline)-1)}))
        identifier=candidate.intent_id()
        self.store.persist(self.owner,candidate,self.obs,actor=self.operator)
        lease=self.store.acquire(self.owner,identifier,self.worker,lease_seconds=300)
        self.store.reserve(self.owner,identifier,self.worker,lease['fence'])
        with self.assertRaisesRegex(ExecutionError,'execution_sequence_attention'):
            self.runner.journal.prepare(self.owner,identifier,self.worker,lease['fence'],self.signer)
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.effects WHERE canonical').fetchone()[0],0)
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.journal').fetchone()[0],1)
