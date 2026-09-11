"""Adversarial static inspection; no RPC, signer, or LP amount calculation."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, POSITION_MANAGER, ZERO, DataError, PoolKey
from lp_mint_inspection import MAX_CALLDATA_BYTES, MAX_LIQUIDITY, inspect_mint


OWNER = '0x' + 'ab' * 20
OTHER = '0x' + 'cd' * 20
TOKEN0 = '0x' + '11' * 20
TOKEN1 = '0x' + '22' * 20
SENDER_ALIAS = '0x' + '00' * 19 + '01'
THIS_ALIAS = '0x' + '00' * 19 + '02'
KEY_TYPES = ('address', 'address', 'uint24', 'int24', 'address')
MINT_TYPES = ('(address,address,uint24,int24,address)', 'int24', 'int24',
              'uint256', 'uint128', 'uint128', 'address', 'bytes')
DEADLINE = 1_800_000_300
SELECTOR = keccak(b'modifyLiquidities(bytes,uint256)')[:4]


def fixture(*, native=False, liquidity=12345, cap0=101, cap1=202,
            refund=SENDER_ALIAS, recipient=OWNER, hook_data=b''):
    raw_key = (ZERO if native else TOKEN0, TOKEN1, 3000, 60, ZERO)
    key = PoolKey(*raw_key)
    context = {'owner': OWNER, 'pool_key': key,
               'pool_id': '0x' + keccak(encode(KEY_TYPES, raw_key)).hex(),
               'tick_lower': -120, 'tick_upper': 180, 'deadline': DEADLINE}
    mint = encode(MINT_TYPES, (raw_key, -120, 180, liquidity, cap0, cap1,
                               recipient, hook_data))
    params = [mint, encode(('address', 'address'), raw_key[:2])]
    actions = b'\x02\x0d'
    if native:
        actions += b'\x14'
        params.append(encode(('address', 'address'), (ZERO, refund)))
    transaction = {'from': OWNER, 'to': POSITION_MANAGER, 'chainId': CHAIN_ID,
                   'value': hex(cap0) if native else '0x00'}
    set_plan(transaction, actions, params)
    return transaction, context


def set_unlock(transaction, unlock_data, deadline=DEADLINE):
    transaction['data'] = '0x' + (SELECTOR + encode(('bytes', 'uint256'), (unlock_data, deadline))).hex()


def set_plan(transaction, actions, params, deadline=DEADLINE):
    set_unlock(transaction, encode(('bytes', 'bytes[]'), (actions, params)), deadline)


def plan(transaction):
    unlock_data, deadline = decode(('bytes', 'uint256'), bytes.fromhex(transaction['data'][10:]))
    actions, params = decode(('bytes', 'bytes[]'), unlock_data)
    return actions, list(params), deadline


class MintInspectionTests(unittest.TestCase):
    def reject(self, transaction, context, code):
        with self.assertRaisesRegex(DataError, '^' + code + '$'):
            inspect_mint(transaction, **context)

    def test_erc20_mint_returns_only_exact_scalar_limits(self):
        transaction, context = fixture()
        original = deepcopy(transaction)
        self.assertEqual(inspect_mint(transaction, **context), {
            'mintLiquidityRaw': '12345', 'amount0MaxRaw': '101',
            'amount1MaxRaw': '202', 'nativeValueRaw': '0'})
        self.assertEqual(transaction, original)
        self.assertEqual(SELECTOR.hex(), 'dd46508f')

    def test_native_mint_refunds_verified_sender_or_explicit_owner(self):
        for recipient in (OWNER, SENDER_ALIAS):
            with self.subTest(recipient=recipient):
                transaction, context = fixture(native=True, refund=recipient)
                self.assertEqual(inspect_mint(transaction, **context)['nativeValueRaw'], '101')

    def test_one_sided_cap_zero_is_not_missing(self):
        for caps in ((0, 9), (11, 0)):
            for native in (False, True):
                with self.subTest(caps=caps, native=native):
                    transaction, context = fixture(native=native, cap0=caps[0], cap1=caps[1])
                    result = inspect_mint(transaction, **context)
                    self.assertEqual(result['amount0MaxRaw'], str(caps[0]))
                    self.assertEqual(result['amount1MaxRaw'], str(caps[1]))

    def test_maximum_encoded_caps_and_signed_liquidity_are_preserved(self):
        transaction, context = fixture(liquidity=MAX_LIQUIDITY,
                                       cap0=(1 << 128) - 1, cap1=(1 << 128) - 1)
        result = inspect_mint(transaction, **context)
        self.assertEqual(result['mintLiquidityRaw'], str(MAX_LIQUIDITY))
        self.assertEqual(result['amount0MaxRaw'], str((1 << 128) - 1))

    def test_case_normalization_keeps_same_addresses(self):
        transaction, context = fixture()
        transaction['from'] = '0x' + OWNER[2:].upper()
        transaction['to'] = '0x' + POSITION_MANAGER[2:].upper()
        context['owner'] = transaction['from']
        self.assertEqual(inspect_mint(transaction, **context)['mintLiquidityRaw'], '12345')

    def test_optional_gas_fields_are_bounded_unsigned_quantities(self):
        transaction, context = fixture()
        transaction.update(gasLimit='200000', maxFeePerGas='0x05', maxPriorityFeePerGas='0')
        self.assertEqual(inspect_mint(transaction, **context)['nativeValueRaw'], '0')
        for field in ('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'):
            for invalid in (None, 1, True, '-1', '0x', '1e3', ' 1', '01', str(1 << 256)):
                with self.subTest(field=field, invalid=invalid):
                    bad = dict(transaction, **{field: invalid})
                    self.reject(bad, context, 'invalid_lp_mint_transaction')
        transaction['gasPrice'] = '1'
        self.reject(transaction, context, 'invalid_lp_mint_transaction')

    def test_transaction_identity_substitution_rejected(self):
        transaction, context = fixture()
        for field, value in (('from', OTHER), ('to', OTHER), ('chainId', 1),
                             ('chainId', True), ('chainId', 4663.0), ('chainId', '4663')):
            with self.subTest(field=field, value=value):
                self.reject(dict(transaction, **{field: value}), context, 'lp_mint_request_mismatch')

    def test_missing_unknown_and_malformed_envelope_fields_rejected(self):
        transaction, context = fixture()
        self.reject(None, context, 'invalid_lp_mint_transaction')
        for field in transaction:
            with self.subTest(missing=field):
                self.reject({k: v for k, v in transaction.items() if k != field}, context,
                            'invalid_lp_mint_transaction')
        for field in ('nonce', 'permit', 'signature', 'authorizationList', 'gas'):
            with self.subTest(unknown=field):
                self.reject(dict(transaction, **{field: '0'}), context, 'invalid_lp_mint_transaction')
        for field in ('from', 'to'):
            self.reject(dict(transaction, **{field: 'not an address'}), context,
                        'invalid_lp_mint_transaction')

    def test_bad_native_quantities_rejected(self):
        transaction, context = fixture()
        for value in (None, False, 0, '-1', '1.0', '+0', ' 0', '0x',
                      '0x' + '1' * 65, str(1 << 256)):
            with self.subTest(value=value):
                self.reject(dict(transaction, value=value), context, 'invalid_lp_mint_transaction')

    def test_native_transfer_must_equal_mint_cap_erc20_must_be_zero(self):
        for native in (False, True):
            transaction, context = fixture(native=native)
            for value in ('1', '100', '102', str((1 << 256) - 1)):
                with self.subTest(native=native, value=value):
                    self.reject(dict(transaction, value=value), context, 'lp_mint_native_value_mismatch')

    def test_recipient_substitution_including_contract_alias_rejected(self):
        for recipient in (OTHER, ZERO, SENDER_ALIAS, THIS_ALIAS):
            with self.subTest(recipient=recipient):
                transaction, context = fixture(recipient=recipient)
                self.reject(transaction, context, 'lp_mint_request_mismatch')

    def test_native_refund_cannot_be_omitted_redirected_or_swapped(self):
        for recipient in (OTHER, ZERO, THIS_ALIAS):
            transaction, context = fixture(native=True, refund=recipient)
            self.reject(transaction, context, 'lp_mint_request_mismatch')
        transaction, context = fixture(native=True)
        actions, params, _ = plan(transaction)
        params[-1] = encode(('address', 'address'), (TOKEN1, OWNER))
        set_plan(transaction, actions, params)
        self.reject(transaction, context, 'lp_mint_request_mismatch')
        transaction, context = fixture(native=True)
        actions, params, _ = plan(transaction)
        set_plan(transaction, actions[:2], params[:2])
        self.reject(transaction, context, 'unsupported_lp_mint_plan')

    def test_pool_key_components_and_ticks_bound_to_context(self):
        changes = ((0, (TOKEN0, OTHER, 3000, 60, ZERO)),
                   (0, (TOKEN0, TOKEN1, 500, 60, ZERO)),
                   (0, (TOKEN0, TOKEN1, 3000, 10, ZERO)),
                   (0, (TOKEN0, TOKEN1, 3000, 60, OTHER)),
                   (1, -180), (2, 240))
        for index, value in changes:
            with self.subTest(index=index, value=value):
                transaction, context = fixture()
                actions, params, _ = plan(transaction)
                mint = list(decode(MINT_TYPES, params[0]))
                mint[index] = value
                params[0] = encode(MINT_TYPES, mint)
                set_plan(transaction, actions, params)
                self.reject(transaction, context, 'lp_mint_request_mismatch')

    def test_settlement_must_use_exact_canonical_pool_pair(self):
        for pair in ((TOKEN1, TOKEN0), (TOKEN0, OTHER), (OTHER, TOKEN1), (TOKEN0, TOKEN0)):
            transaction, context = fixture()
            actions, params, _ = plan(transaction)
            params[1] = encode(('address', 'address'), pair)
            set_plan(transaction, actions, params)
            self.reject(transaction, context, 'lp_mint_request_mismatch')

    def test_deadline_bound_to_review_context(self):
        transaction, context = fixture()
        actions, params, _ = plan(transaction)
        for deadline in (0, DEADLINE - 1, DEADLINE + 1, (1 << 256) - 1):
            set_plan(transaction, actions, params, deadline)
            self.reject(transaction, context, 'lp_mint_request_mismatch')

    def test_zero_or_excessive_liquidity_and_both_zero_caps_rejected(self):
        for liquidity in (0, MAX_LIQUIDITY + 1, (1 << 256) - 1):
            transaction, context = fixture(liquidity=liquidity)
            self.reject(transaction, context, 'invalid_lp_mint_amounts')
        transaction, context = fixture(cap0=0, cap1=0)
        self.reject(transaction, context, 'invalid_lp_mint_amounts')

    def test_hook_data_rejected(self):
        transaction, context = fixture(hook_data=b'\x00')
        self.reject(transaction, context, 'unsupported_lp_mint_plan')

    def test_other_selectors_and_multicall_rejected(self):
        transaction, context = fixture()
        for signature in (b'multicall(bytes[])', b'initializePool((address,address,uint24,int24,address),uint160)',
                          b'modifyLiquiditiesWithoutUnlock(bytes,bytes[])', b'approve(address,uint256)'):
            with self.subTest(signature=signature):
                bad = dict(transaction, data='0x' + keccak(signature)[:4].hex() + transaction['data'][10:])
                self.reject(bad, context, 'unsupported_lp_mint_transaction')

    def test_extra_missing_reordered_swap_delta_and_wrap_actions_rejected(self):
        transaction, context = fixture()
        _, params, _ = plan(transaction)
        for actions in (b'', b'\x02', b'\x0d\x02', b'\x05\x0d', b'\x06\x0d',
                        b'\x02\x0b', b'\x02\x0d\x14', b'\x02\x0d\x15',
                        b'\x02\x0d\x16', b'\x02\x0d\x02', b'\x82\x0d'):
            with self.subTest(actions=actions):
                set_plan(transaction, actions, params)
                self.reject(transaction, context, 'unsupported_lp_mint_plan')
        for changed in (params[:1], params + [b'']):
            set_plan(transaction, b'\x02\x0d', changed)
            self.reject(transaction, context, 'unsupported_lp_mint_plan')

    def test_invalid_data_shape_and_size_rejected_before_decoding(self):
        transaction, context = fixture()
        for value in (None, False, b'', '0x', '0x123', '0xzzzzzzzz',
                      '0x' + '00' * (MAX_CALLDATA_BYTES + 1)):
            with self.subTest(length=len(value) if isinstance(value, (str, bytes)) else None):
                self.reject(dict(transaction, data=value), context, 'invalid_lp_mint_transaction')

    def test_truncated_and_trailing_bytes_rejected_at_every_abi_layer(self):
        transaction, context = fixture()
        for data in (transaction['data'][:-2], transaction['data'] + '00' * 32):
            self.reject(dict(transaction, data=data), context, 'invalid_lp_mint_encoding')
        actions, params, _ = plan(transaction)
        unlock = encode(('bytes', 'bytes[]'), (actions, params))
        for bad in (unlock[:-1], unlock + bytes(32)):
            set_unlock(transaction, bad)
            self.reject(transaction, context, 'invalid_lp_mint_encoding')
        for index in (0, 1):
            for transform in (lambda value: value[:-1], lambda value: value + bytes(32)):
                changed = list(params)
                changed[index] = transform(params[index])
                set_plan(transaction, actions, changed)
                self.reject(transaction, context, 'invalid_lp_mint_encoding')

    def test_abi_offset_gaps_are_rejected_even_when_decodable(self):
        transaction, context = fixture()
        outer = bytes.fromhex(transaction['data'][10:])
        gapped_outer = (96).to_bytes(32) + outer[32:64] + bytes(32) + outer[64:]
        self.assertEqual(decode(('bytes', 'uint256'), gapped_outer), decode(('bytes', 'uint256'), outer))
        self.reject(dict(transaction, data='0x' + (SELECTOR + gapped_outer).hex()), context,
                    'invalid_lp_mint_encoding')
        actions, params, _ = plan(transaction)
        unlock = encode(('bytes', 'bytes[]'), (actions, params))
        gapped_unlock = ((int.from_bytes(unlock[:32]) + 32).to_bytes(32)
                         + (int.from_bytes(unlock[32:64]) + 32).to_bytes(32)
                         + bytes(32) + unlock[64:])
        self.assertEqual(decode(('bytes', 'bytes[]'), gapped_unlock), (actions, tuple(params)))
        set_unlock(transaction, gapped_unlock)
        self.reject(transaction, context, 'invalid_lp_mint_encoding')

    def test_nonzero_padding_and_oversized_narrow_uint_rejected(self):
        transaction, context = fixture()
        actions, params, _ = plan(transaction)
        unlock = bytearray(encode(('bytes', 'bytes[]'), (actions, params)))
        unlock[127] = 1  # nonzero bytes padding after the two action bytes
        set_unlock(transaction, bytes(unlock))
        self.reject(transaction, context, 'invalid_lp_mint_encoding')
        transaction, context = fixture()
        actions, params, _ = plan(transaction)
        changed = bytearray(params[0])
        changed[8 * 32:9 * 32] = (1 << 128).to_bytes(32)  # amount0Max uint128
        params[0] = bytes(changed)
        set_plan(transaction, actions, params)
        self.reject(transaction, context, 'invalid_lp_mint_encoding')

    def test_aliased_parameter_offsets_are_rejected(self):
        transaction, context = fixture()
        actions, params, _ = plan(transaction)
        unlock = bytearray(encode(('bytes', 'bytes[]'), (actions, params)))
        array_start = int.from_bytes(unlock[32:64])
        # Point both dynamic array entries to the first parameter. The ABI
        # decoder accepts the alias, but re-encoding cannot reproduce it.
        unlock[array_start + 64:array_start + 96] = unlock[array_start + 32:array_start + 64]
        decoded_actions, decoded_params = decode(('bytes', 'bytes[]'), unlock)
        self.assertEqual(decoded_actions, actions)
        self.assertEqual(decoded_params, (params[0], params[0]))
        set_unlock(transaction, bytes(unlock))
        self.reject(transaction, context, 'invalid_lp_mint_encoding')

    def test_mint_dynamic_offset_gap_rejected(self):
        transaction, context = fixture()
        actions, params, _ = plan(transaction)
        mint = params[0]
        hook_offset_word = 11 * 32
        self.assertEqual(int.from_bytes(mint[hook_offset_word:hook_offset_word + 32]), 384)
        params[0] = mint[:hook_offset_word] + (416).to_bytes(32) + bytes(32) + mint[384:]
        self.assertEqual(decode(MINT_TYPES, params[0]), decode(MINT_TYPES, mint))
        set_plan(transaction, actions, params)
        self.reject(transaction, context, 'invalid_lp_mint_encoding')

    def test_huge_nested_array_lengths_rejected_with_bounded_input(self):
        transaction, context = fixture()
        actions, params, _ = plan(transaction)
        unlock = bytearray(encode(('bytes', 'bytes[]'), (actions, params)))
        array_start = int.from_bytes(unlock[32:64])
        unlock[array_start:array_start + 32] = ((1 << 256) - 1).to_bytes(32)
        set_unlock(transaction, bytes(unlock))
        self.reject(transaction, context, 'invalid_lp_mint_encoding')

    def test_context_rejects_malformed_or_unbound_pool_owner_ticks_deadline(self):
        transaction, context = fixture()
        cases = [('owner', ZERO), ('owner', SENDER_ALIAS), ('owner', THIS_ALIAS),
                 ('owner', 'bad'), ('pool_key', None), ('pool_id', '0x' + '00' * 32),
                 ('tick_lower', -121), ('tick_lower', -887280), ('tick_lower', 180),
                 ('tick_upper', -120), ('tick_upper', 887280), ('tick_upper', True),
                 ('tick_lower', -120.0), ('deadline', True), ('deadline', 0),
                 ('deadline', '1800000300'), ('deadline', 1 << 256)]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                self.reject(transaction, dict(context, **{field: value}), 'invalid_lp_mint_context')
        for key in (PoolKey(TOKEN0, TOKEN1, 3000, 0, ZERO),
                    PoolKey(TOKEN1, TOKEN0, 3000, 60, ZERO),
                    PoolKey(TOKEN0, TOKEN1, 3000, 60, OTHER),
                    PoolKey(TOKEN0, TOKEN1, 0x800000, 60, ZERO)):
            raw = (key.currency0, key.currency1, key.fee_pips, key.tick_spacing, key.hooks)
            changed = dict(context, pool_key=key, pool_id='0x' + keccak(encode(KEY_TYPES, raw)).hex())
            self.reject(transaction, changed, 'invalid_lp_mint_context')


if __name__ == '__main__':
    unittest.main()
