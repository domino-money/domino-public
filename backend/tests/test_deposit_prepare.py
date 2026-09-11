"""Offline composition, admission and exact-step state-machine regressions."""
from copy import deepcopy
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from eth_abi import encode, decode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_models import DepositError, PreparedArtifact
from deposit_prepare import (DirectDepositPreparer, DEPLOYMENTS, PERMIT2,
    POLICY_VERSION, calldata, validate_admission_manifest)
from discovery import CHAIN_ID, POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, ZERO, DataError
from read_deadline import read_deadline
from uniswap_position import UniswapPosition
from test_lp_mint_inspection import OWNER, TOKEN0, TOKEN1, plan, set_plan
from test_uniswap_position import response, KEY

NOW = 1000
CODE = '0x60006000'
CODE_HASH = '0x' + keccak(bytes.fromhex(CODE[2:])).hex()
BLOCK_HASH = '0x' + 'ab' * 32


def signed_manifest(**changes):
    m = {'schemaVersion': 1, 'policyVersion': POLICY_VERSION, 'reviewedAt': 900,
        'expiresAt': 2000, 'reviewReference': 'offline synthetic review, not production approval',
        'nativeEnabled': True, 'deployments': dict.fromkeys(DEPLOYMENTS, CODE_HASH),
        'tokens': [{'address': token, 'codeHash': CODE_HASH, 'reviewReference': 'offline synthetic ERC20',
            'standardTransfer': True, 'nonRebasing': True, 'nonUpgradeable': True,
            'approvalReturn': 'bool'} for token in (TOKEN0, TOKEN1)]}
    m.update(changes)
    m.pop('manifestId', None)
    m['manifestId'] = hashlib.sha256(json.dumps(m, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return m


def selection(native=False):
    _, context = response(native=native)
    return {'chainId': CHAIN_ID, 'poolId': context['pool_id'], 'poolKey': asdict(context['pool_key']),
        'independentToken': context['pool_key'].currency0, 'amountRaw': '100',
        'tickLower': -120, 'tickUpper': 180, 'slippageBps': 50,
        'budget0Raw': '110', 'budget1Raw': '220', 'nativeGasReserveRaw': '1000',
        'maxGasLimitRaw': '300000', 'maxFeePerGasRaw': '10', 'maxPriorityFeePerGasRaw': '1'}


class Provider:
    def __init__(self, native=False):
        self.data = response(native=native)[0]
        self.calls = []
        self.after = lambda: None

    def __call__(self, url, body, **kwargs):
        self.calls.append((url, deepcopy(body), kwargs))
        result = deepcopy(self.data)
        actions, params, _ = plan(result['create'])
        set_plan(result['create'], actions, params, deadline=body['deadline'])
        self.after()
        return result


class Rpc:
    def __init__(self, native=False):
        self.selected = selection(native)
        self.calls, self.codes = [], {}
        self.chain, self.nonce, self.pending, self.final_nonce = CHAIN_ID, 7, 7, 7
        self.native, self.balance = 100_000_000, 1_000_000
        self.erc20 = {TOKEN0: 10_000, TOKEN1: 10_000}
        self.permit = {TOKEN0: (10_000, 2000, 0), TOKEN1: (10_000, 2000, 0)}
        self.estimate, self.simulation = 100_000, None
        self.canonical, self.pool_manager, self.fee = True, POOL_MANAGER, 3000
        self.block = {'number': '0x64', 'hash': BLOCK_HASH, 'timestamp': hex(NOW),
                      'baseFeePerGas': '0x2', 'gasLimit': '0x1c9c380'}
        self.after = lambda method, params: None

    def request(self, method, params=()):
        self.calls.append((method, deepcopy(params)))
        value = self._result(method, params)
        self.after(method, params)
        return value

    def _result(self, method, params):
        if method == 'eth_chainId':
            return hex(self.chain)
        if method == 'eth_getBlockByNumber':
            value = deepcopy(self.block)
            if params[0] != 'latest' and not self.canonical:
                value['hash'] = '0x' + '00' * 32
            return value
        if method == 'eth_getCode':
            return self.codes.get(params[0], '0x' if params[0] == OWNER else CODE)
        if method == 'eth_getBalance':
            return hex(self.native)
        if method == 'eth_getTransactionCount':
            return hex(self.pending if params[1] == 'pending' else self.final_nonce if params[1] == 'latest' else self.nonce)
        if method == 'eth_estimateGas':
            return hex(self.estimate)
        if method == 'eth_call':
            tx = params[0]
            if 'from' in tx:
                if self.simulation is not None:
                    return self.simulation
                return '0x' + encode(['bool'], [True]).hex() if tx['to'] in (TOKEN0, TOKEN1) else '0x'
            prefix, raw, target = tx['data'][:10], tx['data'][10:], tx['to']
            if prefix == calldata('poolManager()'):
                return '0x' + encode(['address'], [self.pool_manager]).hex()
            if prefix == calldata('permit2()'):
                return '0x' + encode(['address'], [PERMIT2]).hex()
            if prefix == calldata('poolKeys(bytes25)'):
                return '0x' + encode(['address', 'address', 'uint24', 'int24', 'address'],
                    list(self.selected['poolKey'].values())).hex()
            if prefix == calldata('getSlot0(bytes32)'):
                return '0x' + encode(['uint160', 'int24', 'uint24', 'uint24'], [2**96, 0, 0, self.fee]).hex()
            if prefix == calldata('balanceOf(address)'):
                return '0x' + encode(['uint256'], [self.balance]).hex()
            if prefix == calldata('allowance(address,address)'):
                return '0x' + encode(['uint256'], [self.erc20[target]]).hex()
            if prefix == calldata('allowance(address,address,address)'):
                _, token, _ = decode(['address', 'address', 'address'], bytes.fromhex(raw))
                return '0x' + encode(['uint160', 'uint48', 'uint48'], self.permit[token]).hex()
        raise AssertionError((method, params))


class DepositPreparationTests(unittest.TestCase):
    def setup_pipeline(self, native=False, manifest=True, clock=lambda: NOW):
        self.provider, self.rpc = Provider(native), Rpc(native)
        self.factories = []
        def factory():
            self.factories.append(True)
            return self.rpc
        self.preparer = DirectDepositPreparer(UniswapPosition(KEY, transport=self.provider, clock=clock),
            factory, admission=signed_manifest() if manifest is True else manifest or None, clock=clock)
        self.selected = selection(native)

    def run_prepare(self):
        return self.preparer.prepare(OWNER, self.selected)

    def reject(self, code='deposit_preparation_unavailable'):
        with self.assertRaisesRegex(DepositError, '^' + code + '$'):
            self.run_prepare()

    def test_mint_exact_simulated_transaction_and_binding(self):
        self.setup_pipeline()
        result = self.run_prepare()
        self.assertEqual(result['kind'], 'mint')
        self.assertEqual((result['expiresAt'], result['preparedDeadline']), (1030, 1120))
        self.assertEqual(result['transaction']['nonceRaw'], '7')
        self.assertEqual(result['transaction']['gasLimitRaw'], '120000')
        self.assertEqual(result['mintedBounds']['amount0MaxRaw'], '101')
        self.assertEqual(result['sourceBlock'], {'number': 100, 'hash': BLOCK_HASH, 'timestamp': 1000})
        self.assertEqual(len(self.factories), 1)
        simulated = [p for m, p in self.rpc.calls if m == 'eth_call' and 'from' in p[0]]
        self.assertEqual(len(simulated), 1)
        self.assertEqual(simulated[0][0]['data'], result['transaction']['data'])
        self.assertEqual(simulated[0][0]['gas'], hex(120000))
        self.assertEqual(simulated[0][1], {'blockHash': BLOCK_HASH, 'requireCanonical': True})
        self.assertEqual(PreparedArtifact.model_validate(result).model_dump(by_alias=True), result)
        self.assertNotIn(KEY, json.dumps(result))

    def test_missing_manifest_denies_before_factory_and_provider(self):
        self.setup_pipeline(manifest=False)
        self.reject('deposit_admission_required')
        self.assertFalse(self.factories or self.provider.calls)

    def test_manifest_tamper_expiry_flags_and_closed_schema(self):
        for change in ({'manifestId': '0'*64}, {'expiresAt': 1000}, {'nativeEnabled': 1}, {'unexpected': True}):
            m = signed_manifest()
            m.update(change)
            with self.subTest(change=change), self.assertRaises(DepositError):
                validate_admission_manifest(m, now=NOW)
        for field in ('standardTransfer', 'nonRebasing', 'nonUpgradeable'):
            m = signed_manifest()
            m['tokens'][0][field] = False
            m = signed_manifest(**m)
            with self.subTest(field=field), self.assertRaises(DepositError):
                validate_admission_manifest(m, now=NOW)

    def test_native_and_token_admission_are_explicit(self):
        self.setup_pipeline(native=True, manifest=signed_manifest(nativeEnabled=False))
        self.reject('deposit_admission_required')
        self.assertFalse(self.factories)
        self.setup_pipeline(manifest=signed_manifest(tokens=[]))
        self.reject('deposit_admission_required')

    def test_erc20_zero_reset_precedes_exact_bounded_approval(self):
        for allowance, kind, amount in ((1, 'erc20_reset', 0), (0, 'erc20_approval', 101)):
            self.setup_pipeline()
            self.rpc.erc20[TOKEN0] = allowance
            result = self.run_prepare()
            self.assertEqual(result['kind'], kind)
            self.assertEqual(result['transaction']['to'], TOKEN0)
            self.assertEqual(result['transaction']['data'], calldata('approve(address,uint256)',
                ['address', 'uint256'], [PERMIT2, amount]))
            self.assertEqual(result['transaction']['valueRaw'], '0')

    def test_permit2_amount_and_expiry_bound_to_exact_manager_cap_deadline(self):
        for previous in ((100, 2000, 0), (101, 1119, 0), (0, 0, 0)):
            self.setup_pipeline()
            self.rpc.permit[TOKEN0] = previous
            result = self.run_prepare()
            self.assertEqual(result['kind'], 'permit2_approval')
            self.assertEqual(result['transaction']['to'], PERMIT2)
            self.assertEqual(result['transaction']['data'], calldata('approve(address,address,uint160,uint48)',
                ['address', 'address', 'uint160', 'uint48'], [TOKEN0, POSITION_MANAGER, 101, 4600]))
            self.assertEqual(result['preparedDeadline'], 4600)

    def test_finalized_approval_delay_does_not_cause_perpetual_expiry_renewal(self):
        now = [NOW]
        self.setup_pipeline(clock=lambda: now[0])
        m = signed_manifest(expiresAt=10000)
        self.preparer.admission = m
        self.rpc.permit[TOKEN0] = (0, 0, 0)
        first = self.run_prepare()
        self.assertEqual(first['kind'], 'permit2_approval')
        self.rpc.permit[TOKEN0] = (101, first['preparedDeadline'], 0)
        self.rpc.permit[TOKEN1] = (0, 0, 0)
        now[0] += 900  # Synthetic finalized inclusion took 15 minutes.
        self.rpc.block['timestamp'] = hex(now[0])
        second = self.run_prepare()
        self.assertEqual(second['kind'], 'permit2_approval')
        self.assertEqual(decode(['address', 'address', 'uint160', 'uint48'],
            bytes.fromhex(second['transaction']['data'][10:]))[0], TOKEN1)
        self.rpc.permit[TOKEN1] = (202, second['preparedDeadline'], 0)
        now[0] += 900
        self.rpc.block['timestamp'] = hex(now[0])
        mint = self.run_prepare()
        self.assertEqual(mint['kind'], 'mint')
        self.assertEqual(mint['preparedDeadline'], now[0] + 120)
        now[0] = first['preparedDeadline'] + 1
        self.rpc.block['timestamp'] = hex(now[0])
        self.assertEqual(self.run_prepare()['kind'], 'permit2_approval')

    def test_second_token_and_native_do_not_request_unneeded_approvals(self):
        self.setup_pipeline(native=True)
        self.rpc.erc20[TOKEN1] = 0
        result = self.run_prepare()
        self.assertEqual(result['kind'], 'erc20_approval')
        self.assertEqual(result['transaction']['to'], TOKEN1)
        self.assertEqual(result['mintedBounds']['nativeValueRaw'], '101')
        self.assertEqual(result['balances']['token0Raw'], str(self.rpc.native))

    def test_native_mint_value_and_refund_identity_inspected(self):
        self.setup_pipeline(native=True)
        result = self.run_prepare()
        self.assertEqual(result['transaction']['valueRaw'], '101')
        self.assertEqual(result['kind'], 'mint')

    def test_selected_budget_or_balance_failure_never_emits_approval(self):
        for setting in ('budget', 'balance'):
            self.setup_pipeline()
            self.rpc.erc20[TOKEN0] = 0
            if setting == 'budget':
                self.selected['budget1Raw'] = '201'
            else:
                self.rpc.balance = 201
            self.reject('deposit_funding_insufficient')
            self.assertFalse(any(m == 'eth_estimateGas' for m, _ in self.rpc.calls))

    def test_nonzero_owner_code_and_any_admission_code_change_fail(self):
        for target in (OWNER, TOKEN0, TOKEN1, *DEPLOYMENTS.values()):
            self.setup_pipeline()
            self.rpc.codes[target] = '0x6001'
            with self.subTest(target=target):
                self.reject('deposit_admission_required')
            self.assertFalse(self.provider.calls)

    def test_chain_manager_pool_fee_and_nonce_fail_closed(self):
        for field, value in (('chain', 1), ('pool_manager', TOKEN0), ('fee', 500), ('pending', 8)):
            self.setup_pipeline()
            setattr(self.rpc, field, value)
            with self.subTest(field=field):
                self.reject('deposit_wallet_pending' if field == 'pending' else 'deposit_preparation_unavailable')
            self.assertFalse(self.provider.calls)

    def test_final_reorg_or_nonce_change_withholds_artifact(self):
        for field, value in (('canonical', False), ('final_nonce', 8)):
            self.setup_pipeline()
            setattr(self.rpc, field, value)
            with self.subTest(field=field):
                self.reject('deposit_state_changed')
            self.assertEqual(len(self.provider.calls), 1)

    def test_impossible_rpc_nonce_is_generic_and_never_reaches_provider(self):
        for field in ('nonce', 'pending'):
            self.setup_pipeline()
            setattr(self.rpc, field, 2**64)
            with self.subTest(field=field):
                self.reject()
            self.assertFalse(self.provider.calls)

    def test_impossible_nonce_in_final_recheck_is_generic(self):
        for field in ('final_nonce', 'pending'):
            self.setup_pipeline()
            self.provider.after = lambda field=field: setattr(self.rpc, field, 2**64)
            with self.subTest(field=field):
                self.reject()

    def test_snapshot_stale_future_or_non_safe_height(self):
        for field, value in (('timestamp', hex(969)), ('timestamp', hex(1006)), ('number', hex(2**53))):
            self.setup_pipeline()
            self.rpc.block[field] = value
            self.reject('deposit_state_changed' if field == 'timestamp' else 'deposit_preparation_unavailable')
            self.assertFalse(self.provider.calls)

    def test_estimate_buffer_and_fee_caps_and_native_headroom(self):
        for field, value in (('estimate', 250001), ('native', 1_200_999)):
            self.setup_pipeline()
            setattr(self.rpc, field, value)
            self.reject('deposit_gas_balance_insufficient' if field == 'native' else 'deposit_gas_limit_exceeded')
        self.setup_pipeline()
        self.selected['maxFeePerGasRaw'] = '2'
        self.reject('deposit_fee_cap_too_low')

    def test_estimate_below_intrinsic_gas_is_generic_and_never_simulated(self):
        for estimate in (0, 20999):
            self.setup_pipeline()
            self.rpc.estimate = estimate
            with self.subTest(estimate=estimate):
                self.reject()
            self.assertFalse(any(method == 'eth_call' and 'from' in params[0]
                                 for method, params in self.rpc.calls))

    def test_approval_false_malformed_or_empty_requires_reviewed_abi(self):
        for result in ('0x', '0x' + encode(['bool'], [False]).hex(), '0x01',
                       '0x' + encode(['bool'], [True]).hex() + '00'):
            self.setup_pipeline()
            self.rpc.erc20[TOKEN0], self.rpc.simulation = 0, result
            self.reject()
        m = signed_manifest()
        m['tokens'][0]['approvalReturn'] = 'empty'
        self.setup_pipeline(manifest=signed_manifest(**m))
        self.rpc.erc20[TOKEN0], self.rpc.simulation = 0, '0x'
        self.assertEqual(self.run_prepare()['kind'], 'erc20_approval')

    def test_mint_or_permit2_unexpected_return_fails(self):
        self.setup_pipeline()
        self.rpc.simulation = '0x01'
        self.reject()

    def test_provider_substituted_recipient_or_value_is_rejected(self):
        self.setup_pipeline()
        self.provider.data['create']['from'] = TOKEN0
        self.reject()
        self.setup_pipeline()
        self.provider.data['create']['value'] = '1'
        self.reject()

    def test_request_owner_override_precision_and_missing_caps_rejected(self):
        for changes in ({'owner': TOKEN0}, {'budget0Raw': None}, {'chainId': 4663.0},
                        {'budget1Raw': str(2**128)}, {'nativeBalanceRaw': '99'}, {'maxGasLimitRaw': '3000001'}):
            self.setup_pipeline()
            self.selected.update(changes)
            self.reject('deposit_invalid_request')
            self.assertFalse(self.factories or self.provider.calls)

    def test_shared_deadline_spans_provider_and_rpc_and_no_later_work(self):
        now = [0]
        self.setup_pipeline()
        self.provider.after = lambda: now.__setitem__(0, 21)
        with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
            with read_deadline(20, clock=lambda: now[0]):
                with self.assertRaisesRegex(DepositError, 'request_timeout'):
                    self.run_prepare()
        self.assertFalse(any(m == 'eth_estimateGas' for m, _ in self.rpc.calls))

    def test_wall_clock_expiry_after_simulation_never_returns_artifact(self):
        now = [NOW]
        self.setup_pipeline(clock=lambda: now[0])
        def after(method, params):
            if method == 'eth_call' and 'from' in params[0]:
                now[0] = 1030
        self.rpc.after = after
        self.reject('deposit_state_changed')

    def test_only_known_preparation_failures_get_actionable_public_codes(self):
        self.setup_pipeline()
        cases = {
            'deposit_pending_nonce': ('deposit_wallet_pending', 409),
            'deposit_budget_or_balance': ('deposit_funding_insufficient', 422),
            'deposit_fee_cap': ('deposit_fee_cap_too_low', 422),
            'deposit_gas_cap': ('deposit_gas_limit_exceeded', 422),
            'deposit_native_headroom': ('deposit_gas_balance_insufficient', 422),
            **{reason: ('deposit_state_changed', 409) for reason in (
                'deposit_snapshot_changed', 'deposit_composition_expired',
                'deposit_artifact_expired', 'deposit_snapshot_expired')},
            'read_deadline_exceeded': ('request_timeout', 504),
            'deposit_chain_mismatch': ('deposit_preparation_unavailable', 503),
            'invalid_deposit_block': ('deposit_preparation_unavailable', 503),
            'invalid_deposit_nonce': ('deposit_preparation_unavailable', 503),
            'invalid_deposit_gas_estimate': ('deposit_preparation_unavailable', 503),
            'invalid_deposit_code': ('deposit_preparation_unavailable', 503),
            'private-provider-url': ('deposit_preparation_unavailable', 503),
        }
        for reason, expected in cases.items():
            with self.subTest(reason=reason), patch.object(self.preparer, '_prepare', side_effect=DataError(reason)):
                with self.assertRaises(DepositError) as caught:
                    self.run_prepare()
                self.assertEqual((caught.exception.code, caught.exception.status), expected)
        with patch.object(self.preparer, '_prepare', side_effect=RuntimeError('deposit_pending_nonce')):
            self.reject()


if __name__ == '__main__':
    unittest.main()
