"""Synthetic RPC receipts: no deployment admission, upstream RPC or signing."""
import copy
from pathlib import Path
import sys
import unittest

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import execution_models as m
import general_compound_receipts as g
from execution_cases import address, identity, position, scenario, sequence
from test_execution_models import replace


def abi(types, values):
    return '0x' + encode(types, values).hex()


def checkpoint(seq, token, liquidity, last, inside, block, *, last1=0, inside1=0):
    values = (liquidity, last, last1, inside, inside1, block)
    commitment = keccak(encode(['bytes32', 'bytes32', 'uint256', 'uint128', 'uint256',
                               'uint256', 'uint256', 'uint256', 'uint64'],
        [keccak(b'DominoRegistrationCheckpointV1'), bytes.fromhex(seq.digest()[2:]), token, *values]))
    return (*values, commitment)


class Rpc:
    def __init__(self, *, native=False, collection=False, charged=False):
        self.seq = replace(sequence(native=native), implementationVersion='3')
        seq = self.seq
        self.registration = checkpoint(seq, 101, 100, 17*2**128, 17*2**128, 1230)
        self.member = replace(position(seq), registrationBaselineId='0x'+self.registration[6].hex())
        self.manager_key = (seq.poolKey.currency0, seq.poolKey.currency1, 3000, 60, m.ZERO)
        self.manager_info = (int(seq.poolId,16) & ~((1 << 56)-1)) | (180 << 32) | ((-120 & 0xffffff) << 8) | 1
        self.source_ids = [m.FeeSourceIdentity(sequence=seq.digest(), position=self.member.digest(), currency=c).digest()
                           for c in (seq.poolKey.currency0, seq.poolKey.currency1)]
        self.blocks = {1234: {'number': hex(1234), 'hash': identity(301), 'timestamp': hex(1700000000), 'transactions': []},
                       1235: {'number': hex(1235), 'hash': identity(302), 'timestamp': hex(1700000030), 'transactions': [identity(402)]},
                       1236: {'number': hex(1236), 'hash': identity(303), 'timestamp': hex(1700000040), 'transactions': []}}
        self.code = '0x6001600055'
        self.clone = '0x363d3d373d3d3d363d73' + seq.implementation[2:] + '5af43d82803e903d91602b57fd5bf3'
        self.admission = g.CompoundAdmission(sequence=seq, stateView=address(10), readHelper=address(11),
            compoundEngine=address(12),
            runtimePins=tuple(g.RuntimePin(address=a, codeHash='0x'+keccak(bytes.fromhex((self.clone if a==seq.vault else self.code)[2:])).hex())
                for a in (seq.vault, seq.factory, seq.implementation, seq.positionManager, seq.poolManager, address(10), address(11), address(12))))
        self.before = checkpoint(seq, 101, 100, 17*2**128, 17*2**128, 1234)
        inside = (27 if collection else 17) * 2**128
        self.after = checkpoint(seq, 101, 101, inside, inside, 1235)
        self.fresh = checkpoint(seq, 101, 100, 17*2**128, inside, 1235)
        self.zeroed = checkpoint(seq, 101, 100, inside, inside, 1235)
        self.policy = (200, 500, 2000, 600, 4, 1, False)
        self.limits = (1, 5000, 100, 100, 10**15, 120, 3600)
        self.plan = g.CompoundPlan(intentId=identity(777), tokenId='101', positionIdentity=self.member.digest(),
            checkpointId='0x'+self.before[6].hex(), policyVersion='1', limitsVersion='1', stateNonce='7',
            authorityGeneration='1', observedAtBlock='1234', observedBlockHash=identity(301),
            observedAtTimestamp='1700000000', deadline='1700000060', liquidityIncrease='1',
            maxOriginal0='0' if charged else '1000', maxOriginal1='0',
            maxCharged0='1000' if charged else '0', maxCharged1='0', minAdded0='980', minAdded1='0',
            minSqrtPriceX96=str(2**96-1), maxSqrtPriceX96=str(2**96+1))
        self.rows = [(0, 1300, 0, 0, 980, 0, 980, 0, 320) if charged else
                     (0 if collection else 1300, 0, 1000 if collection else 0, 999, 0, 19, 980, 1 if collection else 301, 0),
                     (0,)*9]
        self.transaction = {'hash': identity(402), 'chainId': hex(4663), 'from': seq.owner,
            'to': seq.vault, 'value': '0x0', 'input': self.plan.calldata(), 'blockNumber': hex(1235),
            'blockHash': identity(302), 'transactionIndex': '0x0'}
        self.receipt = {'transactionHash': identity(402), 'from': seq.owner, 'to': seq.vault,
            'blockNumber': hex(1235), 'blockHash': identity(302), 'transactionIndex': '0x0',
            'status': '0x1', 'gasUsed': '0x1', 'effectiveGasPrice': '0x1', 'logs': []}
        self.calls, self.overrides = [], {}
        self.rebuild_logs()

    def rebuild_logs(self):
        p = self.plan
        raw = [(address(999), [identity(900)], '0x'), (address(998), [], '0x'),
            (self.admission.compoundEngine, [g.REALIZED, abi(['address'], [self.seq.vault]), p.intentId, identity(101)],
             abi(['bytes32','bytes32','uint128','uint128'], [self.fresh[6], self.zeroed[6], self.rows[0][2], self.rows[1][2]])),
            (address(997), [identity(901)], '0x')]
        for i, currency in enumerate((self.seq.poolKey.currency0, self.seq.poolKey.currency1)):
            raw.append((self.admission.compoundEngine, [g.APPLIED, abi(['address'], [self.seq.vault]), p.intentId, self.source_ids[i]],
                        abi(['address', g.AMOUNTS_TYPE], [currency, self.rows[i]])))
        raw.extend([(address(996), [], '0x'),
            (self.seq.vault, [g.COMPLETED, p.intentId, identity(101)],
             abi(['bytes32','uint128','uint128','uint64','uint64','uint64'],
                 [bytes.fromhex(p.contract_plan_hash(self.seq)[2:]), 100, 101, 1, 1, 8]))])
        self.receipt['logs'] = [{**{k: self.receipt[k] for k in ('transactionHash','blockNumber','blockHash','transactionIndex')},
            'address': emitter, 'topics': topics, 'data': data, 'removed': False, 'logIndex': hex(40+i)}
            for i, (emitter, topics, data) in enumerate(raw)]
        self.transaction['input'] = self.plan.calldata()

    def request(self, method, params):
        self.calls.append((method, copy.deepcopy(params)))
        if method in self.overrides:
            value = self.overrides[method]
            return value(params) if callable(value) else copy.deepcopy(value)
        if method == 'eth_chainId': return hex(4663)
        if method == 'eth_getBlockByNumber': return copy.deepcopy(self.blocks[1236 if params[0]=='finalized' else int(params[0],16)])
        if method == 'eth_getTransactionByHash': return copy.deepcopy(self.transaction)
        if method == 'eth_getTransactionReceipt': return copy.deepcopy(self.receipt)
        if method == 'eth_getCode': return self.clone if params[0]==self.seq.vault else self.code
        if method == 'eth_getLogs': return [copy.deepcopy(log) for log in self.receipt['logs'] if log['address'] in (self.seq.vault,self.admission.compoundEngine)]
        if method != 'eth_call': raise AssertionError(method)
        request, block = params
        assert block['requireCanonical'] is True
        is_after = block['blockHash'] == identity(302)
        data = bytes.fromhex(request['data'][2:])
        def match(signature): return data[:4] == keccak(signature.encode())[:4]
        addresses = {'owner()': self.seq.owner, 'factory()': self.seq.factory, 'implementation()': self.seq.implementation,
            'poolManager()': self.seq.poolManager, 'positionManager()': self.seq.positionManager,
            'stateView()': self.admission.stateView, 'readHelper()': self.admission.readHelper,
            'compoundEngine()': self.admission.compoundEngine,
            'serviceFeeRecipient()': self.seq.serviceFeeRecipient}
        for sig, value in addresses.items():
            if match(sig): return abi(['address'], [value])
        records = {'sequenceIdentityHash()': (['bytes32'], [bytes.fromhex(self.seq.digest()[2:])]),
            'implementationVersion()': (['uint64'], [3]),
            'compoundEngineCodeHash()': (['bytes32'], [keccak(bytes.fromhex(self.code[2:]))]),
            'cloneRuntimeHash()': (['bytes32'], [keccak(bytes.fromhex(self.clone[2:]))]),
            'policy()': (['(uint16,uint16,uint16,uint32,uint8,uint64,bool)'], [self.policy]),
            'executionLimits()': (['(uint64,uint32,uint16,uint16,uint128,uint32,uint32)'], [self.limits]),
            'stateNonce()': (['uint64'], [8 if is_after else 7]), 'authorityGeneration()': (['uint64'], [1]),
            'rootPermissionValid()': (['bool'], [True]), 'isOperator(address)': (['bool'], [False]),
            'consumedIntent(bytes32)': (['bool'], [is_after]),
            'position(uint256)': ([g.POSITION_TYPE], [(True, True, self.member.isRoot,
                int(self.member.parentTokenId), int(self.member.generation), self.member.tickLower, self.member.tickUpper,
                bytes.fromhex(self.member.registrationBaselineId[2:]), bytes.fromhex(self.member.digest()[2:]),
                *[bytes.fromhex(s[2:]) for s in self.source_ids])]),
            'checkpoint(uint256)': ([g.CHECKPOINT_TYPE], [self.after if is_after else self.before]),
            'registrationCheckpoint(uint256)': ([g.CHECKPOINT_TYPE], [self.registration])}
        for sig, (types, values) in records.items():
            if match(sig):
                override = self.overrides.get((sig, is_after))
                return abi(types, [override] if override is not None else values)
        if match('getPoolAndPositionInfo(uint256)'):
            return abi([g.POOL_KEY_TYPE,'uint256'], [self.manager_key, self.manager_info])
        if match('feeBalance(bytes32,address)'):
            source, currency = decode(['bytes32','address'], data[4:])
            i = self.source_ids.index('0x'+source.hex())
            assert currency == (self.seq.poolKey.currency0, self.seq.poolKey.currency1)[i]
            return abi(['(uint128,uint128)'], [self.rows[i][-2:] if is_after else self.rows[i][:2]])
        raise AssertionError(data[:4].hex())

    def run(self, **kwargs):
        return g.CompoundReceiptReconciler(self).reconcile(self.plan, self.admission, identity(402), **kwargs)

    def bind_e1(self):
        original, original_plan, _ = scenario(charged=bool(self.rows[0][1]))
        source = m.FeeSourceIdentity(sequence=self.seq.digest(), position=self.member.digest(), currency=self.seq.poolKey.currency0)
        collection = bool(self.rows[0][2])
        balances = () if collection else (m.SourceBalance(source=source, lotId=identity(201),
            currency=source.currency, convertedCharged=bool(self.rows[0][1]), amountRaw='1300',
            reservedRaw='100', reconciliationId=identity(202)),)
        obs = m.Observation(sequence=self.seq, policy=original.policy, stateNonce='7', authorityGeneration='1',
            blockNumber='1234', blockHash=identity(301), blockTimestamp='1700000000', sqrtPriceX96=str(2**96),
            operator=address(9), operatorEnabled=True, canonical=True, coverageComplete=True,
            positions=(m.CustodyObservation(position=self.member, holder=self.seq.owner,
                individualApproval=self.seq.vault, active=True),), balances=balances,
            accruals=(m.AccrualObservation(source=source, amountRaw='1000', checkpointId=self.plan.checkpointId),) if collection else ())
        gross_cap = '1000' if collection or self.rows[0][1] else '999'
        e1 = replace(original_plan, sequence=self.seq.model_dump(mode='json'), observationHash=obs.digest(),
            maxGrossFee0='0' if self.rows[0][1] else gross_cap,
            allocations=[] if collection else [{'lotId': identity(201), 'amountRaw': gross_cap}],
            collections=[{'sourceId': source.digest(), 'maxGrossRaw':'1000'}] if collection else [])
        self.plan = replace(self.plan, intentId=e1.intent_id(), maxOriginal0=e1.maxGrossFee0)
        self.rebuild_logs()
        return e1, obs


class GeneralCompoundReceiptTests(unittest.TestCase):
    def test_original_consumption_service_cut_and_retained_zero_snapshot(self):
        rpc = Rpc()
        result = rpc.run()
        self.assertEqual(result['sources'][0]['serviceFeeRaw'], '19')
        self.assertEqual(result['sources'][0]['originalAfterRaw'], '301')
        self.assertEqual(len(result['sources']), 2)
        self.assertEqual(result['collections'], ())
        self.assertIsNone(result['earningTimestamp'])
        self.assertFalse(result['complete24h'])
        self.assertLess(len(rpc.calls), g.MAX_REQUESTS)

    def test_actual_realization_native_and_erc20_uses_receipt_local_origin(self):
        for native in (False, True):
            rpc = Rpc(collection=True, native=native)
            result = rpc.run()
            credit, = result['collections']
            self.assertEqual(credit.amountRaw, '1000')
            self.assertEqual(credit.eventIndex, 2)
            self.assertNotEqual(result['checkpointBefore'], rpc.plan.checkpointId)
            self.assertEqual(result['collectionClassification'], 'realized_accrual_earning_time_unqualified')
            for log in rpc.receipt['logs']: log['logIndex'] = hex(int(log['logIndex'],16)+100)
            self.assertEqual(rpc.run()['collections'][0].credit_id(), credit.credit_id())

    def test_precharged_reserve_is_not_charged_again_and_caps_allow_less(self):
        result = Rpc(charged=True).run()
        row = result['sources'][0]
        self.assertEqual((row['chargedConsumedRaw'], row['serviceFeeRaw'], row['chargedAfterRaw']), ('980','0','320'))

    def test_mixed_original_and_precharged_budget_charges_only_original_once(self):
        rpc = Rpc()
        rpc.rows[0] = (1300, 500, 0, 91, 500, 1, 590, 1209, 0)
        rpc.plan = replace(rpc.plan, maxCharged0='1000', minAdded0='590')
        rpc.rebuild_logs()
        row = rpc.run()['sources'][0]
        self.assertEqual((row['grossOriginalConsumedRaw'],row['chargedConsumedRaw'],row['serviceFeeRaw']), ('91','500','1'))
        rpc.rows[0] = (1300, 500, 0, 499, 100, 9, 590, 801, 400)
        rpc.plan = replace(rpc.plan, maxCharged0='100')
        rpc.rebuild_logs()
        self.assertEqual(rpc.run()['sources'][0]['serviceFeeRaw'], '9')

    def test_charged_priority_rejects_conserving_minimal_original_alternative(self):
        rpc = Rpc()
        # Minimal gross for a spend of 100, but the charged cap permits 500.
        rpc.rows[0] = (1300, 500, 0, 499, 100, 9, 590, 801, 400)
        rpc.plan = replace(rpc.plan, maxCharged0='1000', minAdded0='590')
        rpc.rebuild_logs()
        with self.assertRaisesRegex(ValueError, 'compound_source_conservation_mismatch'):
            rpc.run()

    def test_inverse_plateau_rejects_extra_original_and_extra_floor_fee(self):
        rpc = Rpc()
        # Both 999-19 and 1000-20 leave 980, but V3 must choose 999.
        rpc.rows[0] = (1300, 0, 0, 1000, 0, 20, 980, 300, 0)
        rpc.rebuild_logs()
        with self.assertRaisesRegex(ValueError, 'compound_source_conservation_mismatch'):
            rpc.run()

    def test_aggregate_original_realized_and_charged_overflow_is_impossible(self):
        rpc = Rpc()
        # Each ABI field fits uint128 and the equations conserve, but the
        # combined pre-spend ledger exceeds V3's aggregate currency bound.
        maximum = 2**128-1
        rpc.rows[0] = (maximum, 1, 0, 999, 0, 19, 980, maximum-999, 1)
        rpc.rebuild_logs()
        with self.assertRaisesRegex(ValueError, 'compound_source_conservation_mismatch'):
            rpc.run()

    def test_realization_and_added_debt_use_signed_balance_delta_bounds(self):
        for kind in ('realized', 'added'):
            for amount in (2**127-1, 2**127):
                rpc = Rpc(collection=kind=='realized', charged=kind=='added')
                if kind == 'realized':
                    q = 2**128
                    inside = 17*q + (amount*q+99)//100
                    rpc.after = checkpoint(rpc.seq, 101, 101, inside, inside, 1235)
                    rpc.fresh = checkpoint(rpc.seq, 101, 100, 17*q, inside, 1235)
                    rpc.zeroed = checkpoint(rpc.seq, 101, 100, inside, inside, 1235)
                    rpc.rows[0] = (0, 0, amount, 999, 0, 19, 980, amount-999, 0)
                else:
                    rpc.rows[0] = (0, amount, 0, 0, amount, 0, amount, 0, 0)
                    rpc.plan = replace(rpc.plan, maxCharged0=str(amount), minAdded0=str(amount))
                rpc.rebuild_logs()
                with self.subTest(kind=kind, amount=amount):
                    if amount == 2**127:
                        with self.assertRaisesRegex(ValueError, 'compound_source_conservation_mismatch'):
                            rpc.run()
                    else:
                        self.assertEqual(rpc.run()['sources'][0][kind+'Raw' if kind=='realized' else 'liquidityAddedRaw'], str(amount))

    def test_source_is_derived_even_when_member_event_and_balance_getter_agree(self):
        for native in (False, True):
            for index in (0, 1):
                rpc = Rpc(collection=True, native=native)
                rpc.source_ids[index] = identity(999)
                rpc.rebuild_logs()
                with self.subTest(native=native, index=index), self.assertRaisesRegex(ValueError, 'compound_source_identity_mismatch'):
                    rpc.run()

    def test_position_preimage_cannot_be_renamed_coherently(self):
        rpc = Rpc(collection=True)
        rpc.member = replace(rpc.member, corePositionId=identity(999))
        rpc.source_ids = [m.FeeSourceIdentity(sequence=rpc.seq.digest(), position=rpc.member.digest(), currency=c).digest()
                          for c in (rpc.seq.poolKey.currency0, rpc.seq.poolKey.currency1)]
        rpc.plan = replace(rpc.plan, positionIdentity=rpc.member.digest())
        rpc.rebuild_logs()
        with self.assertRaisesRegex(ValueError, 'compound_position_identity_mismatch'):
            rpc.run()

    def test_registration_preimage_and_unchanged_opening_are_verified(self):
        for changed in ('preimage', 'after', 'renamed'):
            rpc = Rpc(collection=True)
            if changed == 'preimage':
                rpc.registration = (101, *rpc.registration[1:])
            elif changed == 'after':
                rpc.overrides[('registrationCheckpoint(uint256)', True)] = (101, *rpc.registration[1:])
            else:
                rpc.registration = (*rpc.registration[:6], bytes.fromhex(identity(999)[2:]))
                rpc.member = replace(rpc.member, registrationBaselineId=identity(999))
                rpc.source_ids = [m.FeeSourceIdentity(sequence=rpc.seq.digest(), position=rpc.member.digest(), currency=c).digest()
                                  for c in (rpc.seq.poolKey.currency0, rpc.seq.poolKey.currency1)]
                rpc.plan = replace(rpc.plan, positionIdentity=rpc.member.digest())
                rpc.rebuild_logs()
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, 'compound_registration_checkpoint_mismatch'):
                rpc.run()

    def test_core_full_key_and_packed_range_are_bound_to_admitted_sequence(self):
        for changed in ('key', 'prefix', 'range'):
            rpc = Rpc(collection=True)
            if changed == 'key':
                rpc.manager_key = (*rpc.manager_key[:2], 500, *rpc.manager_key[3:])
            elif changed == 'prefix':
                rpc.manager_info ^= 1 << 200
            else:
                rpc.manager_info ^= 1 << 32
            with self.subTest(changed=changed), self.assertRaisesRegex(ValueError, 'compound_core_position_mismatch'):
                rpc.run()

    def test_both_currencies_have_distinct_origins_for_one_realization_event(self):
        rpc = Rpc(collection=True, native=True)
        q = 2**128
        rpc.before = checkpoint(rpc.seq, 101, 100, 17*q, 17*q, 1234, last1=6*q, inside1=6*q)
        rpc.after = checkpoint(rpc.seq, 101, 101, 27*q, 27*q, 1235, last1=26*q, inside1=26*q)
        rpc.fresh = checkpoint(rpc.seq, 101, 100, 17*q, 27*q, 1235, last1=6*q, inside1=26*q)
        rpc.zeroed = checkpoint(rpc.seq, 101, 100, 27*q, 27*q, 1235, last1=26*q, inside1=26*q)
        rpc.rows[1] = (0,0,2000,1999,0,39,1960,1,0)
        rpc.plan = replace(rpc.plan, checkpointId='0x'+rpc.before[6].hex(), maxOriginal1='2000', minAdded1='1960')
        rpc.rebuild_logs()
        first, second = rpc.run()['collections']
        self.assertEqual((first.amountRaw, second.amountRaw), ('1000', '2000'))
        self.assertEqual(first.eventIndex, second.eventIndex)
        self.assertNotEqual(first.credit_id(), second.credit_id())

    def test_arithmetic_mutations_cannot_become_observed_effects(self):
        for field in range(9):
            rpc = Rpc(collection=True)
            row = list(rpc.rows[0]); row[field] += 1; rpc.rows[0] = tuple(row); rpc.rebuild_logs()
            with self.subTest(field=field), self.assertRaises(ValueError): rpc.run()

    def test_wrong_emitter_missing_duplicate_and_unknown_vault_events_fail(self):
        for mutation in ('emitter','missing','duplicate','unknown','order'):
            rpc = Rpc()
            if mutation=='emitter': rpc.receipt['logs'][2]['address'] = address(999)
            if mutation=='missing': rpc.receipt['logs'][2]['topics'] = []
            if mutation=='duplicate': rpc.receipt['logs'][3]['address'] = rpc.seq.vault
            if mutation=='unknown': rpc.receipt['logs'][4]['topics'][0] = identity(900)
            if mutation=='order': rpc.receipt['logs'][4]['topics'][3] = rpc.source_ids[1]
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): rpc.run()

    def test_calldata_actor_chain_finality_and_runtime_are_independently_checked(self):
        for mutation in ('calldata','actor','chain','finality','runtime','location','removed','status'):
            rpc = Rpc()
            if mutation=='calldata': rpc.transaction['input'] += '00'
            if mutation=='actor': rpc.transaction['from'] = rpc.receipt['from'] = address(987)
            if mutation=='chain': rpc.overrides['eth_chainId'] = '0x1'
            if mutation=='finality': rpc.overrides['eth_getBlockByNumber'] = lambda p: copy.deepcopy(rpc.blocks[1234 if p[0]=='finalized' else int(p[0],16)])
            if mutation=='runtime': rpc.overrides['eth_getCode'] = '0x6000'
            if mutation=='location': rpc.receipt['logs'][4]['blockHash'] = identity(900)
            if mutation=='removed': rpc.receipt['logs'][4]['removed'] = True
            if mutation=='status': rpc.receipt['status'] = '0x0'
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): rpc.run()

    def test_post_receipt_authority_and_checkpoint_changes_are_not_credited(self):
        for sig, value in [('rootPermissionValid()', False), ('stateNonce()', 9),
                           ('authorityGeneration()', 2), ('consumedIntent(bytes32)', False),
                           ('checkpoint(uint256)', (101,0,0,0,0,1235,bytes(32)))]:
            rpc = Rpc(); rpc.overrides[(sig, True)] = value
            with self.subTest(signature=sig), self.assertRaises(ValueError): rpc.run()

    def test_derived_models_and_malformed_abi_do_not_bypass_validation(self):
        rpc = Rpc(); rpc.plan = rpc.plan.model_copy(update={'liquidityIncrease': 1})
        with self.assertRaises(ValueError): rpc.run()
        rpc = Rpc(); rpc.receipt['logs'][4]['data'] += '00'
        with self.assertRaisesRegex(ValueError, 'invalid_compound_abi'): rpc.run()

    def test_rpc_failure_and_reorg_after_effect_checks_fail_closed(self):
        rpc = Rpc()
        def fail(_): raise RuntimeError('sensitive provider diagnostic')
        rpc.overrides['eth_getCode'] = fail
        with self.assertRaisesRegex(ValueError, '^compound_rpc_unavailable$'): rpc.run()
        rpc = Rpc(); counts = {}
        def reorg(params):
            number = 1236 if params[0]=='finalized' else int(params[0],16)
            counts[number] = counts.get(number,0)+1
            block = copy.deepcopy(rpc.blocks[number])
            if number==1234 and counts[number]>1: block['hash'] = identity(999)
            return block
        rpc.overrides['eth_getBlockByNumber'] = reorg
        with self.assertRaisesRegex(ValueError, 'compound_canonicality_changed'): rpc.run()

    def test_optional_e1_proof_binds_exact_plan_for_existing_and_collected_lots(self):
        for collection in (False, True):
            rpc = Rpc(collection=collection)
            plan, obs = rpc.bind_e1()
            result = rpc.run(e1_plan=plan, observation=obs)
            self.assertEqual(result['e1Proof']['effects'].intentId, plan.intent_id())
            self.assertEqual(len(result['e1Proof']['effects'].balances), 1)
            self.assertEqual(result['e1Proof']['effects'].balances[0].serviceFeeRaw, '19')

    def test_optional_e1_rejects_underconsumption_without_rewriting_immutable_plan(self):
        rpc = Rpc(charged=True)
        plan, obs = rpc.bind_e1()
        before = plan.model_dump_json()
        self.assertEqual(rpc.run()['sources'][0]['chargedConsumedRaw'], '980')
        with self.assertRaisesRegex(ValueError, 'net_input_disposition_mismatch'):
            rpc.run(e1_plan=plan, observation=obs)
        self.assertEqual(plan.model_dump_json(), before)

    def test_optional_e1_preserves_original_allocation_even_on_same_net_plateau(self):
        rpc = Rpc()
        plan, obs = rpc.bind_e1()
        plan = replace(plan, maxGrossFee0='1000', allocations=[{'lotId':identity(201), 'amountRaw':'1000'}])
        rpc.plan = replace(rpc.plan, intentId=plan.intent_id(), maxOriginal0='1000')
        rpc.rebuild_logs()
        before = plan.model_dump_json()
        self.assertEqual(rpc.run()['sources'][0]['grossOriginalConsumedRaw'], '999')
        with self.assertRaisesRegex(ValueError, 'receipt_measured_effect_mismatch'):
            rpc.run(e1_plan=plan, observation=obs)
        self.assertEqual(plan.model_dump_json(), before)

    def test_query_disagreement_and_receipt_memory_caps_fail_without_partial_result(self):
        rpc = Rpc(); rpc.overrides['eth_getLogs'] = []
        with self.assertRaisesRegex(ValueError, 'compound_log_query_mismatch'): rpc.run()
        rpc = Rpc(); rpc.receipt['logs'] += [copy.deepcopy(rpc.receipt['logs'][0])] * g.MAX_LOGS
        with self.assertRaisesRegex(ValueError, 'compound_log_budget'): rpc.run()
        rpc = Rpc(); rpc.receipt['oversized'] = 'x' * g.MAX_RECEIPT_BYTES
        with self.assertRaisesRegex(ValueError, 'compound_receipt_size_budget'): rpc.run()

    def test_engine_pins_and_finality_are_rechecked(self):
        for signature in ('cloneRuntimeHash()', 'compoundEngineCodeHash()'):
            rpc = Rpc(); rpc.overrides[(signature, True)] = bytes(32)
            with self.subTest(signature=signature), self.assertRaisesRegex(ValueError, 'compound_engine_identity_mismatch'):
                rpc.run()
        rpc = Rpc(); seen = [0]
        def regress(params):
            if params[0]=='finalized':
                seen[0] += 1
                return copy.deepcopy(rpc.blocks[1236 if seen[0]==1 else 1235])
            return copy.deepcopy(rpc.blocks[int(params[0],16)])
        rpc.overrides['eth_getBlockByNumber'] = regress
        with self.assertRaisesRegex(ValueError, 'compound_finality_changed'): rpc.run()

    def test_changed_commitment_minimums_and_source_currency_fail(self):
        for kind in ('hash','liquidity','intent','currency','checkpoint','minimum'):
            rpc = Rpc()
            if kind in ('hash','liquidity'):
                types = ['bytes32','uint128','uint128','uint64','uint64','uint64']
                fields = list(decode(types, bytes.fromhex(rpc.receipt['logs'][7]['data'][2:])))
                if kind=='hash': fields[0] = bytes(32)
                else: fields[2] = 102
                rpc.receipt['logs'][7]['data'] = abi(types,fields)
            if kind=='intent': rpc.receipt['logs'][2]['topics'][2] = identity(123)
            if kind=='currency': rpc.receipt['logs'][4]['data'] = abi(['address',g.AMOUNTS_TYPE],[address(888),rpc.rows[0]])
            if kind=='checkpoint': rpc.before = (*rpc.before[:6], bytes(32))
            if kind=='minimum': rpc.plan=replace(rpc.plan,minAdded0='981'); rpc.rebuild_logs()
            with self.subTest(kind=kind), self.assertRaises(ValueError): rpc.run()

    def test_engine_indexed_vault_cannot_cross_subjects_or_impersonate_completion(self):
        for kind in ('foreign_vault','source_emitter','completion_emitter','duplicate_engine'):
            rpc=Rpc()
            if kind=='foreign_vault': rpc.receipt['logs'][2]['topics'][1]=abi(['address'],[address(987)])
            if kind=='source_emitter': rpc.receipt['logs'][4]['address']=rpc.seq.vault
            if kind=='completion_emitter': rpc.receipt['logs'][7]['address']=rpc.admission.compoundEngine
            if kind=='duplicate_engine': rpc.receipt['logs'][3]['address']=rpc.admission.compoundEngine
            with self.subTest(kind=kind), self.assertRaises(ValueError): rpc.run()

    def test_receipt_gas_product_is_separate_unqualified_cost_evidence(self):
        rpc=Rpc();rpc.receipt.update(gasUsed='0x5208',effectiveGasPrice='0x3b9aca00',gasUsedForL1='0x64')
        result=rpc.run();gas=result['gas']
        self.assertEqual(gas['receiptGasProductWei'],'21000000000000')
        self.assertEqual(gas['payer'],rpc.transaction['from'])
        self.assertEqual(gas['basis'],'receipt_gas_product_unqualified_total')
        self.assertIsNone(gas['executionComponentWei']);self.assertIsNone(gas['fullL2CostWei']);self.assertIsNone(gas['usd'])
        self.assertFalse(gas['strategyDebitApplied'])
        self.assertEqual(result['sources'][0]['serviceFeeRaw'],'19')
        for value in (True,1,'0x01','-1',None):
            rpc.receipt['gasUsed']=value
            with self.subTest(value=value),self.assertRaises(ValueError):rpc.run()


if __name__ == '__main__':
    unittest.main()
