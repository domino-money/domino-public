"""The V2 operator's wire formats: PlanV1 against F3's golden, the plan hash, the exit Execution."""
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import DataError
from v2_plan import (ACTION_COMPOUND, ACTION_MINT, LEG_UNIVERSAL_ROUTER, LEG_V3_POOL, LEG_V4_POOL, PLAN_V1_TYPE,
                     U128, Budget, ExitExecution, PlanV1, Swap, SwapLeg, decode_plan, execute_calldata,
                     exit_calldata, plan_hash, pool_leg, return_reserves_calldata, return_subject, returned_amounts,
                     twap_evidence, v3_path, v4_path)
from v2_uniswap import PoolRef

ROOT = Path(__file__).resolve().parents[2]
F3_GOLDEN_TEST = ROOT / 'contracts/test/v2/vault/DominoV2VaultPlan.t.sol'
F3_DOC = ROOT / 'docs/v2/F3_VAULT.md'
ZERO = '0x' + '00' * 20


def golden():
    """DominoV2VaultPlanTest._golden(), field for field."""
    leg = SwapLeg(1, '0x00000000000000000000000000000000000000AA', '0x' + '11' * 20, '0x' + '22' * 20,
                  970, 957, bytes.fromhex('deadbeef'))
    return PlanV1(action=ACTION_MINT, state_nonce=7, deadline=1790871000, target=1234,
                  tick_lower=5400, tick_upper=10080, amount0_max=U128, amount1_max=5000, min_liquidity=1,
                  collect=(1234,), budgets=(Budget(1234, 1000, 2000), Budget(5678, 3, 4)),
                  swap=Swap(1234, True, 970, 957, (leg,)), anchor_evidence=bytes.fromhex('a0b1'))


class PlanEncodingTests(unittest.TestCase):
    def test_the_encoding_is_f3s_golden_vector(self):
        source = F3_GOLDEN_TEST.read_text()
        digest = re.search(r'GOLDEN = (0x[0-9a-f]{64});', source).group(1)
        length = int(re.search(r'GOLDEN_LENGTH = (\d+);', source).group(1))
        raw = golden().encode()
        self.assertEqual((len(raw), '0x' + keccak(raw).hex()), (length, digest))
        self.assertEqual((length, digest),
                         (1313, '0x890394e7f13c2a4a3f22faf01049af9cfb5c3ecfe20f8b72ba6df3d5aabdaff6'))
        self.assertEqual(raw[0], 1)

    def test_the_type_string_is_the_documented_one(self):
        documented = re.search(r'```\n(\(uint8,uint64,uint64,uint256,[^\n]+)\n```', F3_DOC.read_text()).group(1)
        self.assertEqual(PLAN_V1_TYPE, documented)

    def test_decoding_round_trips_and_refuses_what_a_vault_would_not_send(self):
        raw = golden().encode()
        self.assertEqual(decode_plan(raw), golden())
        for bad in (b'', b'\x02' + raw[1:], raw[:-1], raw + b'\x00' * 32, b'\x01'):
            with self.assertRaises(DataError):
                decode_plan(bad)

    def test_no_swap_is_the_all_zero_value(self):
        plan = PlanV1(ACTION_COMPOUND, 3, 100, 9, 10, 20, 1, (9,), (Budget(9, 5, 6),), twap_evidence(600))
        (value,) = decode([PLAN_V1_TYPE], plan.encode()[1:])
        self.assertEqual(value[11], (0, False, 0, 0, ()))
        self.assertEqual((value[4], value[5]), (0, 0))

    def test_fields_out_of_their_solidity_range_are_refused(self):
        with self.assertRaises(DataError):
            PlanV1(3, 1, 1, 1, 1, 1, 1, (1,), (Budget(1, 1, 1),), b'')
        with self.assertRaises(DataError):
            PlanV1(ACTION_COMPOUND, 2**64, 1, 1, 1, 1, 1, (1,), (Budget(1, 1, 1),), b'')
        with self.assertRaises(DataError):
            Budget(1, 2**128, 0)
        with self.assertRaises(DataError):
            PlanV1(ACTION_MINT, 1, 1, 1, 1, 1, 1, (1,), (Budget(1, 1, 1),), b'', tick_lower=-887273)
        with self.assertRaises(DataError):
            Swap(legs=tuple(SwapLeg(LEG_V3_POOL, ZERO, '0x' + '11' * 20, '0x' + '22' * 20, 1, 1, b'')
                            for _ in range(9)))

    def test_a_leg_names_a_router_exactly_when_it_is_a_router_leg(self):
        token0, token1 = '0x' + '11' * 20, '0x' + '22' * 20
        SwapLeg(LEG_UNIVERSAL_ROUTER, '0x' + 'aa' * 20, token0, token1, 1, 1, b'\x01')
        for kind, router in ((LEG_UNIVERSAL_ROUTER, ZERO), (LEG_V3_POOL, '0x' + 'aa' * 20),
                             (LEG_V4_POOL, '0x' + 'aa' * 20), (4, ZERO)):
            with self.assertRaises(DataError):
                SwapLeg(kind, router, token0, token1, 1, 1, b'')
        with self.assertRaises(DataError):
            SwapLeg(LEG_V3_POOL, ZERO, token0, token0, 1, 1, b'')

    def test_the_plan_hash_is_the_vaults(self):
        # keccak256(abi.encodePacked(block.chainid, address(this), plan)) in DominoV2VaultExecutor.execute.
        raw = golden().encode()
        vault = '0x' + 'ab' * 20
        expected = keccak(encode(['uint256'], [4663]) + bytes.fromhex('ab' * 20) + raw).hex()
        self.assertEqual(plan_hash(4663, vault, raw), '0x' + expected)
        self.assertNotEqual(plan_hash(8453, vault, raw), plan_hash(4663, vault, raw))

    def test_execute_calldata_carries_the_plan_bytes(self):
        raw = golden().encode()
        data = execute_calldata(raw)
        self.assertEqual(data[:10], '0x' + keccak(b'execute(bytes)')[:4].hex())
        self.assertEqual(decode(['bytes'], bytes.fromhex(data[10:]))[0], raw)


class LegTests(unittest.TestCase):
    def test_a_v3_path_is_token_fee_token(self):
        path = v3_path('0x' + '11' * 20, 3000, '0x' + '22' * 20)
        self.assertEqual(path.hex(), '11' * 20 + '000bb8' + '22' * 20)

    def test_a_pool_leg_swaps_through_the_pool_itself(self):
        v4 = PoolRef(4, ZERO, '0x' + '22' * 20, 3000, 60)
        leg = pool_leg(v4, True, 10, 9)
        self.assertEqual((leg.kind, leg.token_in, leg.token_out, leg.router), (LEG_V4_POOL, ZERO, '0x' + '22' * 20,
                                                                              ZERO))
        self.assertEqual(leg.data, v4_path([v4]))
        self.assertEqual(decode(['(uint8,address,address,uint24,int24,address)[]'], leg.data)[0][0][3:5], (3000, 60))
        v3 = PoolRef(3, '0x' + '11' * 20, '0x' + '22' * 20, 500, 10)
        leg = pool_leg(v3, False, 10, 9)
        self.assertEqual((leg.kind, leg.token_in, leg.token_out), (LEG_V3_POOL, '0x' + '22' * 20, '0x' + '11' * 20))
        self.assertEqual(leg.data, v3_path('0x' + '22' * 20, 500, '0x' + '11' * 20))

    def test_twap_evidence_is_exactly_32_bytes(self):
        self.assertEqual(twap_evidence(600), (600).to_bytes(32, 'big'))
        for bad in (0, 2**32, -1):
            with self.assertRaises(DataError):
                twap_evidence(bad)


class ExitExecutionTests(unittest.TestCase):
    def test_the_calldata_is_the_frozen_execute(self):
        mandate = '0x' + '5a' * 32
        leg = SwapLeg(LEG_V4_POOL, ZERO, '0x' + '22' * 20, ZERO, 0, 1, b'\x00')
        execution = ExitExecution(twap_evidence(600), (leg,), 7, 8)
        data = exit_calldata(mandate, execution)
        signature = 'execute(bytes32,(bytes,(uint8,address,address,address,uint128,uint128,bytes)[],uint128,uint128))'
        self.assertEqual(data[:10], '0x' + keccak(signature.encode())[:4].hex())
        hash_, value = decode(['bytes32', '(bytes,(uint8,address,address,address,uint128,uint128,bytes)[],uint128,uint128)'],
                              bytes.fromhex(data[10:]))
        self.assertEqual(hash_.hex(), '5a' * 32)
        self.assertEqual((value[0], value[2], value[3]), ((600).to_bytes(32, 'big'), 7, 8))
        self.assertEqual(value[1][0][4], 0)



class ReturnReservesTests(unittest.TestCase):
    def test_the_call_and_its_result_are_the_frozen_ledgers(self):
        self.assertEqual(return_reserves_calldata(), '0x' + keccak(b'returnReserves()')[:4].hex())
        self.assertEqual(returned_amounts('0x' + encode(['uint256', 'uint256'], [12, 0]).hex()), (12, 0))
        with self.assertRaisesRegex(DataError, '^invalid_abi_response$'):
            returned_amounts('0x' + '00' * 32)

    def test_the_subject_is_the_vault_its_state_and_the_pass(self):
        vault = '0x' + 'a4' * 20
        subject = return_subject(8453, vault, 7, 123)
        self.assertEqual(subject, '0x' + keccak(encode(['uint256', 'address', 'uint64', 'uint256'],
                                                       [8453, vault, 7, 123])).hex())
        self.assertEqual(return_subject(8453, vault.upper().replace('0X', '0x'), 7, 123), subject)
        others = {return_subject(4663, vault, 7, 123), return_subject(8453, '0x' + 'a5' * 20, 7, 123),
                  return_subject(8453, vault, 8, 123), return_subject(8453, vault, 7, 124)}
        self.assertEqual(len(others | {subject}), 5)
        for arguments in ((8453, vault, -1, 123), (8453, vault, 2**64, 123), (8453, vault, 7, True),
                          ('1', vault, 7, 1)):
            with self.subTest(arguments), self.assertRaisesRegex(DataError, '^v2_invalid_return$'):
                return_subject(*arguments)


if __name__ == '__main__':
    unittest.main()
