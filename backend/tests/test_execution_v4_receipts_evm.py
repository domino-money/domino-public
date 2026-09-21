"""Real local canonical V4 receipts; no synthetic effect substitution."""
import copy
import json
import os
import unittest
from eth_abi import encode
from eth_hash.auto import keccak
from evm_harness import EvmHarness as Harness, calldata, KEY_TYPE, INIT_TYPE, POLICY_TYPE
import execution_models as m
import general_compound_receipts as g
import execution_v4 as v

@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM')=='1','requires isolated local Anvil')
class ExecutionV4ReceiptEvmTests(unittest.TestCase):
    setUpClass=classmethod(Harness.setUpClass.__func__)
    stop=classmethod(Harness.stop.__func__)
    send=Harness.send
    deploy=Harness.deploy
    call=Harness.call
    swaps=Harness.swaps
    def setup_vault(self, *, native=False, simple=False, legacy_charged_fixture=False):
        self.manager = self.deploy('PoolManager.sol', 'PoolManager', ['address'], [self.owner])
        self.positions = self.deploy('PositionManager.sol', 'PositionManager',
            ['address', 'address', 'uint256', 'address', 'address'],
            [self.manager, '0x'+'11'*20, 100000, '0x'+'22'*20, '0x'+'33'*20])
        self.state = self.deploy('StateView.sol', 'StateView', ['address'], [self.manager])
        controller = self.deploy('OfficialV4Fixture.sol', 'OfficialV4Controller',
            ['address', 'address'], [self.manager, self.positions])
        self.trader = self.deploy('OfficialV4Fixture.sol', 'OfficialV4SwapDriver', ['address'], [self.manager])
        tokens = [self.deploy('OfficialV4Fixture.sol', 'OfficialFixtureToken') for _ in range(2)]
        currencies = [m.ZERO, tokens[0]] if native else sorted(tokens)
        self.key = (*currencies, 3000, 60, m.ZERO)
        for currency in currencies:
            for target in (controller, self.trader):
                if currency == m.ZERO:
                    self.send(target, value=10**20)
                else:
                    self.send(currency, calldata('mint(address,uint256)', ['address', 'uint256'], [target, 10**20]))
        self.send(self.manager, calldata('initialize('+KEY_TYPE+',uint160)', [KEY_TYPE, 'uint160'], [self.key, 2**96]))
        self.send(controller, calldata('seed('+KEY_TYPE+',uint128)', [KEY_TYPE, 'uint128'], [self.key, 10**18]))
        self.send(controller, calldata('refundSetup()'))
        self.token = self.call(controller, 'tokenId()', ['uint256'])[0]
        factory = self.deploy('DominoVaultFactoryV4.sol','DominoVaultFactoryV4',['address']*4,
            [self.manager,self.positions,self.state,self.recipient])
        helper=self.deploy('DominoVaultReadHelper.sol','DominoVaultReadHelper',['address']*2,[self.positions,self.state])
        routing=self.deploy('DominoRoutingHelperV4.sol','DominoRoutingHelperV4')
        publisher=self.rpc.request('eth_accounts',[])[2]
        # The guard bounds a published price against the pool's own reading:
        # publisher, that reader, and the band in basis points of sqrt price.
        # A cold guardian key can rotate the publisher; it is a fourth account here.
        guardian=self.rpc.request('eth_accounts',[])[3]
        guard=self.deploy('DominoPriceGuardV4.sol','DominoPriceGuardV4',
            ['address','address','uint256','address'],[publisher,self.state,2000,guardian])
        engine=self.deploy('DominoExecutionEngineV4.sol','DominoExecutionEngineV4',['address']*4,[factory,helper,routing,guard])
        implementation=self.deploy('SwapReinvestment.t.sol' if legacy_charged_fixture else 'DominoVaultV4.sol',
            'LegacyChargedVaultV4' if legacy_charged_fixture else 'DominoVaultV4',['address']*7,
            [factory,self.manager,self.positions,self.state,self.recipient,helper,engine])
        self.send(factory,calldata('finalizeImplementation(address)',['address'],[implementation]))
        self.vault = self.call(factory, 'predictVault(address,uint256)', ['address'],
            ['address', 'uint256'], [self.owner, 0])[0]
        self.send(self.positions, calldata('approve(address,uint256)', ['address', 'uint256'], [self.vault, self.token]))
        pool = m.PoolKey(currency0=currencies[0], currency1=currencies[1], fee_pips=3000, tick_spacing=60, hooks=m.ZERO)
        params = (self.token, bytes.fromhex(pool.pool_id()[2:]), *currencies, m.ZERO, True,
                  (200 if simple else 400, 1000, 1000, 1, 1 if simple else 4, 1, False), (1, 5000, 100, 100, 10**12, 120, 3600))
        self.send(factory, calldata('createVault('+INIT_TYPE+',uint256)', [INIT_TYPE, 'uint256'], [params, 0]))
        implementation = self.call(self.vault, 'implementation()', ['address'])[0]
        helper = self.call(self.vault, 'readHelper()', ['address'])[0]
        engine = self.call(self.vault, 'executionEngine()', ['address'])[0]
        sequence_id = self.call(factory, 'sequenceIdFor(address,uint256)', ['bytes32'],
            ['address', 'uint256'], [self.owner, 0])[0]
        seq = m.SequenceIdentity(chainId=4663, owner=self.owner, sequenceId='0x'+sequence_id.hex(),
            vault=self.vault, factory=factory, implementation=implementation, implementationVersion='4',
            poolManager=self.manager, positionManager=self.positions, poolKey=pool, poolId=pool.pool_id(),
            baseCurrency=currencies[0], quoteCurrency=currencies[1], serviceFeeRecipient=self.recipient)
        pins = tuple(g.RuntimePin(address=a, codeHash='0x'+keccak(bytes.fromhex(
            self.rpc.request('eth_getCode', [a, 'latest'])[2:])).hex())
            for a in (self.vault, factory, implementation, self.manager, self.positions, self.state, helper, engine, routing, guard))
        self.admission = v.Admission(sequence=seq,stateView=self.state,readHelper=helper,
            executionEngine=engine,routingHelper=routing,priceGuard=guard,pricePublisher=publisher,runtimePins=pins)

    def observe(self, a):
        """Publish this plan's observation at the pool's current price."""
        price=self.call(self.state,'getSlot0(bytes32)',['uint160','int24','uint24','uint24'],
            ['bytes32'],[bytes.fromhex(self.admission.sequence.poolId[2:])])[0]
        point=(bytes.fromhex(self.admission.sequence.poolId[2:]),int(a.observedAtBlock),
            bytes.fromhex(a.observedBlockHash[2:]),int(a.observedAtTimestamp),int(a.deadline),price)
        tx=self.rpc.request('eth_sendTransaction',[{'from':self.admission.pricePublisher,
            'to':self.admission.priceGuard,'gas':hex(1000000),
            'data':calldata('publish((bytes32,uint64,bytes32,uint64,uint64,uint160))',
                ['(bytes32,uint64,bytes32,uint64,uint64,uint160)'],[point])}])
        self.rpc.request('evm_mine',[])
        receipt=self.rpc.request('eth_getTransactionReceipt',[tx])
        if receipt['status']!='0x1': raise AssertionError('observation not published')
        return receipt['logs'][0]['topics'][1]

    def plan(self, action=0, increase=10**12):
        # Include the observed block strictly before the compound transaction.
        self.rpc.request('evm_increaseTime', [2])
        self.rpc.request('evm_mine', [])
        source = self.rpc.request('eth_getBlockByNumber', ['latest', False])
        member = self.call(self.vault, 'position(uint256)', [g.POSITION_TYPE], ['uint256'], [self.token])[0]
        checkpoint = self.call(self.vault, 'checkpoint(uint256)', [g.CHECKPOINT_TYPE], ['uint256'], [self.token])[0]
        timestamp = int(source['timestamp'], 16)
        plan = g.CompoundPlan(intentId='0x'+keccak(encode(['address','uint256'],
            [self.vault, int(source['number'], 16)])).hex(), tokenId=str(self.token), positionIdentity='0x'+member[8].hex(),
            checkpointId='0x'+checkpoint[6].hex(), policyVersion=str(self.call(self.vault,'policy()',[POLICY_TYPE])[0][5]), limitsVersion='1',
            stateNonce=str(self.call(self.vault, 'stateNonce()', ['uint64'])[0]),
            authorityGeneration=str(self.call(self.vault, 'authorityGeneration()', ['uint64'])[0]),
            observedAtBlock=str(int(source['number'], 16)), observedBlockHash=source['hash'],
            observedAtTimestamp=str(timestamp), deadline=str(timestamp+60), liquidityIncrease=str(increase),
            maxOriginal0='0', maxOriginal1='0', maxCharged0='0', maxCharged1='0',
            minAdded0='1', minAdded1='1', minSqrtPriceX96=str(2**95), maxSqrtPriceX96=str(2**97))
        budgets=tuple(sorted((v.FeeBudget(sourceId='0x'+member[9+i].hex(),currency=self.key[i],maxOriginal=str(2**128-1),maxCharged='0',minOriginal='0',minCharged='0') for i in (0,1)),key=lambda b:(b.sourceId,b.currency)))
        # Every action carries a published observation, swap or not.
        swap=v.SwapPlan(sourceId=m.ZERO_HASH,currencyIn=m.ZERO,amountIn='0',maxOriginal='0',maxCharged='0',
            minAmountOut='0',sqrtPriceLimitX96='0',priceObservationId=self.observe(plan))
        return v.Plan(authority=plan,action=action,destinationTokenId='0' if action==3 else str(self.token),
            tickLower=-420 if action==3 else 0,tickUpper=4680 if action==3 else 0,
            maxAdded0=str(2**127-1),maxAdded1=str(2**127-1),
            collect=(v.PositionRef(tokenId=str(self.token),positionIdentity=plan.positionIdentity,checkpointId=plan.checkpointId),),budgets=budgets,swap=swap)

    def execute(self,plan):
        receipt=self.send(self.vault,plan.calldata())
        self.rpc.request('anvil_mine',['0x40'])
        result=v.ReceiptReconciler(self.rpc).reconcile(plan,self.admission,receipt['transactionHash'])
        self.assertEqual(result['planHash'],plan.contract_plan_hash(self.admission.sequence))
        self.assertEqual(result['liquidityIncreaseRaw'],plan.authority.liquidityIncrease)
        self.assertTrue(result['canonical'] and result['finalized'])
        self.assertFalse(result['complete24h'])
        return receipt,result

    def test_actual_general_net_and_native_receipts(self):
        for native,action in ((False,0),(False,1),(True,1)):
            with self.subTest(native=native,action=action):
                self.setup_vault(native=native);self.swaps();_,result=self.execute(self.plan(action))
                self.assertEqual(len(result['collections']),2)
                for row in result['sources']:
                    self.assertEqual(int(row['originalBeforeRaw'])+int(row['realizedRaw']),int(row['grossOriginalConsumedRaw'])+int(row['originalAfterRaw']))
                    self.assertEqual(int(row['serviceFeeRaw']),int(row['grossOriginalConsumedRaw'])*400//10000)

    def test_actual_successor_funding_and_reorganized_receipt(self):
        self.setup_vault();self.swaps();plan=self.plan(3,10**10)
        snapshot=self.rpc.request('evm_snapshot',[]);receipt,result=self.execute(plan)
        child=result['destinationTokenId'];self.assertEqual(result['successorCreated']['tokenId'],child)
        self.assertEqual(result['serviceFeeBps'],400)
        for row in result['sources']:self.assertEqual(int(row['serviceFeeRaw']),int(row['grossOriginalConsumedRaw'])*400//10000)
        self.assertEqual(len(result['applications']),2)
        self.swaps()
        next_plan=self.plan(2,10**10).model_copy(update={'destinationTokenId':child})
        _,funded=self.execute(next_plan);self.assertEqual(funded['liquidityAfterRaw'],str(2*10**10))
        self.assertEqual(funded['serviceFeeBps'],400)
        for row in funded['sources']:self.assertEqual(int(row['serviceFeeRaw']),int(row['grossOriginalConsumedRaw'])*400//10000)
        self.assertTrue(self.rpc.request('evm_revert',[snapshot]))
        with self.assertRaises(ValueError):v.ReceiptReconciler(self.rpc).reconcile(plan,self.admission,receipt['transactionHash'])
        _,again=self.execute(plan);self.assertEqual(again['destinationTokenId'],child)

    def test_real_receipt_tampering_runtime_and_canonical_calldata(self):
        self.setup_vault();self.swaps();plan=self.plan();receipt,_=self.execute(plan)
        original=self.rpc
        class Corrupt:
            def request(self,method,params):
                result=original.request(method,params)
                if method=='eth_getTransactionReceipt':
                    result=copy.deepcopy(result);log=next(x for x in result['logs'] if x['topics'][0]==v.APPLIED)
                    log['data']=log['data'][:-2]+'ff'
                return result
        with self.assertRaisesRegex(ValueError,'log_query_mismatch'):
            v.ReceiptReconciler(Corrupt()).reconcile(plan,self.admission,receipt['transactionHash'])
        bad=self.admission.model_copy(update={'runtimePins':tuple(p.model_copy(update={'codeHash':'0x'+'ff'*32}) if p.address==self.admission.routingHelper else p for p in self.admission.runtimePins)})
        with self.assertRaisesRegex(ValueError,'v4_runtime_changed'):
            v.ReceiptReconciler(original).reconcile(plan,bad,receipt['transactionHash'])
        plan=self.plan()
        with self.assertRaises(Exception):
            original.request('eth_call',[{'from':self.owner,'to':self.vault,'data':plan.calldata()+'00'},'latest'])

    def test_actual_swap_receipt_lineage_and_cumulative_cut(self):
        self.setup_vault();self.swaps();plan=self.plan(0,10**11)
        price=self.call(self.state,'getSlot0(bytes32)',['uint160','int24','uint24','uint24'],['bytes32'],[bytes.fromhex(self.admission.sequence.poolId[2:])])[0]
        # plan() already published this plan's observation; the guard
        # refuses a second identical one, and one anchor governs the whole
        # execution, so reuse it rather than publishing again.
        observation_id=plan.swap.priceObservationId
        member=self.call(self.vault,'position(uint256)',[g.POSITION_TYPE],['uint256'],[self.token])[0]
        sid='0x'+member[9].hex()
        minimum=self.call(self.admission.routingHelper,'minimumOutput(uint128,uint160,bool,uint16)',['uint256'],
            ['uint128','uint160','bool','uint16'],[10**9,price,True,100])[0]
        swap=v.SwapPlan(sourceId=sid,currencyIn=self.key[0],amountIn=str(10**9),maxOriginal=str(2*10**9),maxCharged='0',
            minAmountOut=str(minimum),sqrtPriceLimitX96=str(m.MIN_SQRT_RATIO+1),priceObservationId=observation_id)
        output=v.FeeBudget(sourceId=sid,currency=self.key[1],maxOriginal='0',maxCharged='0',minOriginal='0',minCharged='0')
        plan=plan.model_copy(update={'swap':swap,'budgets':tuple(sorted((*plan.budgets,output),key=lambda b:(b.sourceId,b.currency)))})
        _,result=self.execute(plan)
        self.assertEqual(len(result['conversions']),1)
        self.assertEqual(result['conversions'][0]['sourceId'],sid)
        self.assertEqual(result['conversions'][0]['sourceTokenId'],str(self.token))
        for row in result['sources']:
            self.assertEqual(int(row['serviceFeeRaw']),int(row['grossOriginalConsumedRaw'])*400//10000)
        out=next(r for r in result['sources'] if (r['sourceId'],r['currency'])==(sid,self.key[1]))
        self.assertEqual(out['serviceFeeRaw'],'0');self.assertEqual(out['originalAfterRaw'],'0')
        self.assertEqual(out['chargedAfterRaw'],'0')
        self.assertGreater(int(out['liquidityFromSwapRaw']),0)

    def test_exact_allocation_floor_reverts_atomically_and_accepts_measured_debit(self):
        self.setup_vault();self.swaps();self.execute(self.plan())
        plan=self.plan();before=self.call(self.vault,'stateNonce()',['uint64'])[0]
        with self.assertRaises(Exception):self.rpc.request('eth_call',[{'from':self.owner,'to':self.vault,'data':plan.calldata()},'latest'])
        # Quote exact debts from the same fixed AMM slot/range for old allocations.
        price=self.call(self.state,'getSlot0(bytes32)',['uint160','int24','uint24','uint24'],['bytes32'],[bytes.fromhex(self.admission.sequence.poolId[2:])])[0]
        from v4_math import sqrt_at_tick as get_sqrt_ratio_at_tick
        # Integer round-up is the manager's required settlement direction.
        lower=get_sqrt_ratio_at_tick(-600);upper=get_sqrt_ratio_at_tick(600);liquidity=int(plan.authority.liquidityIncrease)
        owed0=(liquidity*(upper-price)*(1<<96)+upper*price-1)//(upper*price)
        owed1=(liquidity*(price-lower)+(1<<96)-1)//(1<<96)
        grosses={self.key[0]:(owed0-1)*10000//9600+1,self.key[1]:(owed1-1)*10000//9600+1}
        exact=plan.model_copy(update={'budgets':tuple(b.model_copy(update={'minOriginal':str(grosses[b.currency]),'maxOriginal':str(grosses[b.currency])}) for b in plan.budgets)})
        _,accepted=self.execute(exact)
        self.assertEqual(self.call(self.vault,'stateNonce()',['uint64'])[0],before+1)
        self.assertEqual({r['currency']:int(r['grossOriginalConsumedRaw']) for r in accepted['sources']},grosses)

    def test_netting_gas_parity_uses_separate_transactions_from_identical_snapshot(self):
        for native in (False,True):
            self.setup_vault(native=native);self.swaps();plan=self.plan()
            snapshot=self.rpc.request('evm_snapshot',[])
            general_receipt,general=self.execute(plan)
            self.assertTrue(self.rpc.request('evm_revert',[snapshot]))
            net_receipt,net=self.execute(plan.model_copy(update={'action':1}))
            fields=('originalAfterRaw','chargedAfterRaw','grossOriginalConsumedRaw','serviceFeeRaw','liquidityAddedRaw')
            self.assertEqual([tuple(r[f] for f in fields) for r in general['sources']], [tuple(r[f] for f in fields) for r in net['sources']])
            self.assertEqual(general['liquidityAfterRaw'],net['liquidityAfterRaw'])
            general_gas=int(general_receipt['gasUsed'],16);net_gas=int(net_receipt['gasUsed'],16)
            self.assertLess(net_gas,general_gas)
            print(json.dumps({'native':native,'generalGasUsed':general_gas,'netGasUsed':net_gas,'basis':'same_snapshot_separate_local_transactions'}))


    def test_simple_general_and_net_keep_two_percent_and_refuse_domino_actions(self):
        for action in (0,1):
            self.setup_vault(simple=True);self.swaps()
            plan=self.plan(action)
            for forbidden in (2,3):
                bad=plan.model_copy(update={'action':forbidden})
                with self.assertRaises(Exception):
                    self.rpc.request('eth_call',[{'from':self.owner,'to':self.vault,'data':bad.calldata()},'latest'])
            _,result=self.execute(plan)
            self.assertEqual(result['serviceFeeBps'],200)
            self.assertTrue(any(int(row['serviceFeeRaw'])>0 for row in result['sources']))
            for row in result['sources']:
                self.assertEqual(int(row['serviceFeeRaw']),int(row['grossOriginalConsumedRaw'])*200//10000)

    def test_domino_to_simple_requires_child_exit_and_stale_plan_never_revives(self):
        self.setup_vault();self.swaps()
        _,minted=self.execute(self.plan(3,10**10));child=int(minted['destinationTokenId'])
        before=self.call(self.vault,'stateNonce()',['uint64'])[0]
        policy=(200,1000,1000,1,1,2,False)
        change=calldata('setPolicy('+POLICY_TYPE+')',[POLICY_TYPE],[policy])
        with self.assertRaises(Exception):
            self.rpc.request('eth_call',[{'from':self.owner,'to':self.vault,'data':change},'latest'])
        self.assertEqual(self.call(self.vault,'stateNonce()',['uint64'])[0],before)
        stale=self.plan()
        self.send(self.vault,calldata('withdrawChildPosition(uint256)',['uint256'],[child]))
        self.send(self.vault,change)
        self.assertEqual(self.call(self.vault,'policy()',[POLICY_TYPE])[0][0],200)
        self.assertEqual(self.call(self.vault,'activePositions()',['uint256'])[0],1)
        with self.assertRaises(Exception):
            self.rpc.request('eth_call',[{'from':self.owner,'to':self.vault,'data':stale.calldata()},'latest'])
        self.swaps();_,result=self.execute(self.plan())
        self.assertEqual(result['serviceFeeBps'],200)
        # A historical successor entry remains, but cannot make a simple vault
        # a Domino route; only an explicit later 400-bps policy can change mode.
        self.assertEqual(self.call(self.vault,'successorOf(uint256)',['uint256'],['uint256'],[self.token])[0],child)


    def test_two_percent_converted_reserve_is_not_recharged_after_domino_upgrade(self):
        self.setup_vault(simple=True,legacy_charged_fixture=True);self.swaps();first=self.plan(0,10**11)
        price=self.call(self.state,'getSlot0(bytes32)',['uint160','int24','uint24','uint24'],
            ['bytes32'],[bytes.fromhex(self.admission.sequence.poolId[2:])])[0]
        member=self.call(self.vault,'position(uint256)',[g.POSITION_TYPE],['uint256'],[self.token])[0]
        sid='0x'+member[9].hex()
        minimum=self.call(self.admission.routingHelper,'minimumOutput(uint128,uint160,bool,uint16)',['uint256'],
            ['uint128','uint160','bool','uint16'],[10**9,price,True,100])[0]
        swap=v.SwapPlan(sourceId=sid,currencyIn=self.key[0],amountIn=str(10**9),maxOriginal=str(2*10**9),maxCharged='0',
            minAmountOut=str(minimum),sqrtPriceLimitX96=str(m.MIN_SQRT_RATIO+1),priceObservationId=first.swap.priceObservationId)
        output=v.FeeBudget(sourceId=sid,currency=self.key[1],maxOriginal='0',maxCharged='0',minOriginal='0',minCharged='0')
        first=first.model_copy(update={'swap':swap,'budgets':tuple(sorted((*first.budgets,output),key=lambda b:(b.sourceId,b.currency)))})
        _,converted=self.execute(first)
        self.assertEqual(converted['serviceFeeBps'],200)
        self.assertEqual(len(converted['conversions']),1)
        for row in converted['sources']:
            self.assertEqual(int(row['serviceFeeRaw']),int(row['grossOriginalConsumedRaw'])*200//10000)
        charged=next(row for row in converted['sources'] if row['sourceId']==sid and row['currency']==self.key[1])
        self.assertEqual(charged['chargedAfterRaw'],'0')
        # New swaps must consume their complete output. Represent a waiting lot
        # from the prior rules explicitly through a test-only vault, with real
        # token backing; never manufacture a production conversion receipt.
        legacy_charged=10**9
        self.send(self.key[1],calldata('mint(address,uint256)',['address','uint256'],[self.vault,legacy_charged]))
        self.send(self.vault,calldata('seedCharged(bytes32,address,uint128)',
            ['bytes32','address','uint128'],[bytes.fromhex(sid[2:]),self.key[1],legacy_charged]))

        self.send(self.vault,calldata('setPolicy('+POLICY_TYPE+')',[POLICY_TYPE],[(400,1000,1000,1,4,2,False)]))
        following=self.plan(0,10**8)
        price=self.call(self.state,'getSlot0(bytes32)',['uint160','int24','uint24','uint24'],
            ['bytes32'],[bytes.fromhex(self.admission.sequence.poolId[2:])])[0]
        from v4_math import amount_delta, sqrt_at_tick
        owed0=amount_delta(price,sqrt_at_tick(600),10**8,0,True)
        owed1=amount_delta(sqrt_at_tick(-600),price,10**8,1,True)
        # Minimal original gross at the new tariff pays currency0; the already
        # converted balance pays currency1. Both are exact prior-reserve spends.
        gross0=(owed0-1)*10000//9600+1
        self.assertGreaterEqual(legacy_charged,owed1)
        budgets=(v.FeeBudget(sourceId=sid,currency=self.key[0],maxOriginal=str(gross0),minOriginal=str(gross0),maxCharged='0',minCharged='0'),
                 v.FeeBudget(sourceId=sid,currency=self.key[1],maxOriginal='0',minOriginal='0',maxCharged=str(owed1),minCharged=str(owed1)))
        following=following.model_copy(update={'authority':following.authority.model_copy(update={'minAdded0':str(owed0),'minAdded1':str(owed1)}),
            'budgets':tuple(sorted(budgets,key=lambda b:(b.sourceId,b.currency))),'collect':(),
            'maxAdded0':str(owed0),'maxAdded1':str(owed1)})
        _,applied=self.execute(following)
        self.assertEqual(applied['serviceFeeBps'],400)
        original=next(row for row in applied['sources'] if row['sourceId']==sid and row['currency']==self.key[0])
        old_charged=next(row for row in applied['sources'] if row['sourceId']==sid and row['currency']==self.key[1])
        self.assertEqual(int(original['serviceFeeRaw']),gross0*400//10000)
        self.assertGreater(int(original['serviceFeeRaw']),0)
        self.assertEqual((old_charged['grossOriginalConsumedRaw'],old_charged['serviceFeeRaw']),('0','0'))
        self.assertEqual(int(old_charged['chargedBeforeRaw']),legacy_charged)
        self.assertEqual(int(old_charged['chargedConsumedRaw']),owed1)
        self.assertEqual(int(old_charged['chargedAfterRaw']),legacy_charged-owed1)
