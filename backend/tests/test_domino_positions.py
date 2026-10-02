"""Pools holding a Domino position: the Setup contract's mints, each mapped to its pool."""
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import encode
from eth_hash.auto import keccak

from discovery import KEY_TYPES, POSITION_MANAGER, ZERO, Block, DataError
from domino_positions import MAX_POSITIONS, SETUP_CONTRACT, SETUP_DEPLOY_BLOCK, SETUP_MINTED_TOPIC, position_pools
from manage_activity import domino_position_targets

REPO = Path(__file__).resolve().parents[2]
HEAD = Block(78_000_000, '0x' + 'cd' * 32, 1_790_000_000)
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
TOKEN_A, TOKEN_B = '0x' + 'a1' * 20, '0x' + 'b2' * 20


def key(token, fee=3000, spacing=60):
    """A pool key as the PositionManager answers it: checksum-free, sorted currencies."""
    first, second = sorted((token, USDG))
    return (first, second, fee, spacing, ZERO)


def pool_of(pool_key):
    return '0x' + keccak(encode(list(KEY_TYPES), list(pool_key))).hex()


EMPTY = (ZERO, ZERO, 0, 0, ZERO)


def info_of(pool_key, lower=-600, upper=600):
    """positionInfo as the PositionManager packs it: its pool id's first 25 bytes, then the ticks."""
    return (int(pool_of(pool_key), 16) >> 56) << 56 | (upper & 0xffffff) << 32 | (lower & 0xffffff) << 8


def mint(token_id, *, address=SETUP_CONTRACT, topic=SETUP_MINTED_TOPIC, topics=None):
    return {'address': address, 'topics': topics or [topic, '0x' + '01' * 32, '0x' + '00' * 12 + '11' * 20,
                                                     '0x%064x' % token_id]}


class Rpc:
    """The Setup contract's logs and the PositionManager's answers, nothing else."""
    def __init__(self, logs, keys, infos=()):
        self.logs, self.keys, self.infos, self.calls = logs, keys, dict(infos), []

    def request(self, method, params):
        assert method == 'eth_getLogs', method
        self.calls.append(('eth_getLogs', params[0]))
        return self.logs

    def call(self, target, signature, inputs, values, outputs, *, block):
        assert (target, signature, list(inputs), block) == (
            POSITION_MANAGER, 'getPoolAndPositionInfo(uint256)', ['uint256'], HEAD.tag)
        self.calls.append(('eth_call', values[0]))
        pool_key = self.keys[values[0]]
        # A burned position's info is cleared, and its key with it.
        return pool_key, self.infos.get(values[0], 0 if pool_key == EMPTY else info_of(pool_key))


class PositionPoolTests(unittest.TestCase):
    def test_the_setup_contract_and_its_deployment_block_are_the_release_s(self):
        manifest = json.loads((REPO / 'docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json').read_text())
        self.assertEqual(manifest['contracts']['setup'], SETUP_CONTRACT)
        self.assertEqual([receipt['blockNumber'] for receipt in manifest['receipts']
                          if receipt['component'] == 'setup'], [SETUP_DEPLOY_BLOCK])
        # The site reads the same mints (app/functions/_lib/owned.ts): both must name one contract.
        owned = (REPO / 'app/functions/_lib/owned.ts').read_text()
        for name, value in (('SETUP_CONTRACT', SETUP_CONTRACT), ('SETUP_MINTED_TOPIC', SETUP_MINTED_TOPIC)):
            self.assertEqual(re.search(rf"export const {name} = '([^']+)'", owned).group(1), value)
        self.assertIn(f'SETUP_DEPLOY_BLOCK = {SETUP_DEPLOY_BLOCK:_}', owned)

    def test_every_minted_position_maps_to_its_pool_once(self):
        rpc = Rpc([mint(7), mint(3), mint(9), mint(7)], {3: key(TOKEN_A), 7: key(TOKEN_A), 9: key(TOKEN_B, 500, 10)})
        self.assertEqual(position_pools(rpc, HEAD), {pool_of(key(TOKEN_A)): [3, 7],
                                                     pool_of(key(TOKEN_B, 500, 10)): [9]})
        self.assertEqual(rpc.calls[0], ('eth_getLogs', {'address': SETUP_CONTRACT, 'topics': [SETUP_MINTED_TOPIC],
                                                        'fromBlock': hex(SETUP_DEPLOY_BLOCK),
                                                        'toBlock': hex(HEAD.number)}))
        # One key read per position, the duplicate mint included only once, in order.
        self.assertEqual([value for method, value in rpc.calls if method == 'eth_call'], [3, 7, 9])

    def test_a_checksummed_key_names_the_same_pool(self):
        upper = tuple(value.upper().replace('0X', '0x') if isinstance(value, str) else value
                      for value in key(TOKEN_A))
        self.assertEqual(position_pools(Rpc([mint(1)], {1: upper}), HEAD), {pool_of(key(TOKEN_A)): [1]})

    def test_a_burned_position_has_no_pool(self):
        self.assertEqual(position_pools(Rpc([mint(1), mint(2)], {1: EMPTY, 2: key(TOKEN_A)}), HEAD),
                         {pool_of(key(TOKEN_A)): [2]})
        self.assertEqual(position_pools(Rpc([], {}), HEAD), {})

    def test_an_answer_that_names_no_valid_pool_is_refused(self):
        reversed_key = (key(TOKEN_A)[1], key(TOKEN_A)[0], *key(TOKEN_A)[2:])
        cases = [({1: key(TOKEN_A)}, {1: None}, 'invalid_nft_position_info'),
                 ({1: key(TOKEN_A)}, {1: -1}, 'invalid_nft_position_info'),
                 ({1: key(TOKEN_A)}, {1: 2 ** 256}, 'invalid_nft_position_info'),
                 ({1: reversed_key}, {}, 'invalid_pool_key'),
                 ({1: key(TOKEN_A)}, {1: info_of(key(TOKEN_B))}, 'nft_pool_mismatch'),
                 # The 25th byte of the pool id counts too.
                 ({1: key(TOKEN_A)}, {1: info_of(key(TOKEN_A)) ^ 1 << 56}, 'nft_pool_mismatch')]
        for keys, infos, reason in cases:
            with self.subTest(reason=reason, infos=infos), self.assertRaisesRegex(DataError, f'^{reason}$'):
                position_pools(Rpc([mint(1)], keys, infos), HEAD)
        # The largest positionInfo is a valid answer.
        largest = info_of(key(TOKEN_A)) | (1 << 56) - 1
        self.assertEqual(position_pools(Rpc([mint(1)], {1: key(TOKEN_A)}, {1: largest}), HEAD),
                         {pool_of(key(TOKEN_A)): [1]})

    def test_a_foreign_or_malformed_log_is_refused(self):
        cases = [mint(1, address='0x' + '22' * 20), mint(1, topic='0x' + '33' * 32),
                 mint(1, topics=[SETUP_MINTED_TOPIC, '0x' + '01' * 32, '0x' + '02' * 32]),
                 mint(1, topics=[SETUP_MINTED_TOPIC, '0x' + '01' * 32, '0x' + '02' * 32, '0x12']), 'log', None]
        for log in cases:
            with self.subTest(log=log), self.assertRaises(DataError):
                position_pools(Rpc([log], {1: key(TOKEN_A)}), HEAD)
        for answer in ({'logs': []}, None):
            with self.subTest(answer=type(answer).__name__), self.assertRaisesRegex(DataError, '^invalid_logs_response$'):
                position_pools(Rpc(answer, {}), HEAD)
        with self.assertRaisesRegex(DataError, '^domino_positions_over_bound$'):
            position_pools(Rpc([mint(n) for n in range(MAX_POSITIONS + 1)], {}), HEAD)
        self.assertEqual(len(position_pools(Rpc([mint(1)] * MAX_POSITIONS, {1: key(TOKEN_A)}), HEAD)), 1)


class Store:
    def __init__(self, registered):
        self.registered = set(registered)

    def anchor(self, pool_id):
        return {'startBlock': 10} if pool_id in self.registered else None


class Worker:
    """ActivityIndexer.register as the catalogue answers it for each pool."""
    def __init__(self, answers):
        self.answers, self.registered = answers, []

    def register(self, pool_id, initialization_block=None):
        self.registered.append((pool_id, initialization_block))
        answer = self.answers[pool_id]
        if isinstance(answer, DataError):
            raise answer
        return answer


class TargetTests(unittest.TestCase):
    def test_registered_pools_are_followed_and_anchorable_ones_registered_first(self):
        held, event, hint, absent, busy = ('0x%064x' % n for n in range(1, 6))
        worker = Worker({event: {'status': 'registered', 'startBlock': 20},
                         hint: DataError('verified_initialization_block_required'),
                         absent: DataError('pool_not_in_catalogue'), busy: DataError('catalogue_writer_busy')})
        positions = {busy: [5], absent: [4], hint: [3], event: [2], held: [1]}
        followed, registered_now, not_registered = domino_position_targets(Store([held]), lambda: worker, positions)
        self.assertEqual(followed, [held, event])
        self.assertEqual(registered_now, [event])
        self.assertEqual(not_registered, [{'poolId': hint, 'reason': 'verified_initialization_block_required'},
                                           {'poolId': absent, 'reason': 'pool_not_in_catalogue'},
                                           {'poolId': busy, 'reason': 'catalogue_writer_busy'}])
        # A pool already registered is never registered again; no anchor is supplied for the rest.
        self.assertEqual(worker.registered, [(event, None), (hint, None), (absent, None), (busy, None)])


if __name__ == '__main__':
    unittest.main()
