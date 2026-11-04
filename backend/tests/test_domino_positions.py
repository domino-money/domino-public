"""Pools holding a Domino position: the Setup contract's mints, each mapped to its pool.

The checkpointed scan itself runs against PostgreSQL in test_domino_position_scan.py."""
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import encode
from eth_hash.auto import keccak

from discovery import KEY_TYPES, POSITION_MANAGER, ZERO, Block, DataError
from domino_positions import (MAX_POSITIONS, MINT_SCAN_LOCK, MINT_SCAN_SPAN, SETUP_CONTRACT, SETUP_DEPLOY_BLOCK,
                              SETUP_MINTED_TOPIC, position_pools, read_mints, scan_mints)
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


def mint(token_id, *, address=SETUP_CONTRACT, topic=SETUP_MINTED_TOPIC, topics=None, block=HEAD.number - 10,
         index=0, **fields):
    """A SetupMinted log as eth_getLogs answers it."""
    return {'address': address, 'removed': False, 'blockNumber': hex(block), 'logIndex': hex(index),
            'blockHash': '0x%064x' % block, 'transactionHash': '0x%064x' % (block * 1000 + index),
            'topics': topics or [topic, '0x' + '01' * 32, '0x' + '00' * 12 + '11' * 20, '0x%064x' % token_id],
            **fields}


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


START, END = HEAD.number - 100, HEAD.number


def token_ids(logs):
    return [item['tokenId'] for item in read_mints(Rpc(logs, {}), START, END)]


class MintLogTests(unittest.TestCase):
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

    def test_the_scans_advisory_key_is_its_own(self):
        """No other writer in the backend takes the scan's advisory key, written as a number: sharing it would make
        the two refuse each other as catalogue_writer_busy."""
        keys = []
        for path in [*(REPO / 'backend').glob('*.py'), *(REPO / 'backend/migrations').glob('*.sql')]:
            text = path.read_text()
            keys += re.findall(r'pg_(?:try_)?advisory(?:_xact)?_lock\((\d+)\)', text)
            keys += re.findall(r'^[A-Z_]*LOCK[A-Z_]*\s*=\s*(\d+)\s*$', text, re.M)
        self.assertIn('46630001', keys)
        self.assertEqual(keys.count(str(MINT_SCAN_LOCK)), 1)

    def test_one_read_of_the_range_each_mint_once_in_chain_order(self):
        rpc = Rpc([mint(7, block=START + 5, index=2), mint(3, block=START + 5), mint(9, block=START + 1),
                   mint(7, block=START + 5, index=2)], {})
        found = read_mints(rpc, START, END)
        self.assertEqual(rpc.calls, [('eth_getLogs', {'address': SETUP_CONTRACT, 'topics': [SETUP_MINTED_TOPIC],
                                                      'fromBlock': hex(START), 'toBlock': hex(END)})])
        # The repeated log is one mint; the order is the chain's, not the token ids'.
        self.assertEqual([(item['blockNumber'], item['logIndex'], item['tokenId']) for item in found],
                         [(START + 1, 0, 9), (START + 5, 0, 3), (START + 5, 2, 7)])
        self.assertEqual(found[0], {'tokenId': 9, 'blockNumber': START + 1, 'logIndex': 0,
                                    'blockHash': '0x%064x' % (START + 1),
                                    'transactionHash': '0x%064x' % ((START + 1) * 1000)})
        self.assertEqual(token_ids([]), [])

    def test_a_foreign_removed_or_malformed_log_is_refused(self):
        cases = [mint(1, address='0x' + '22' * 20), mint(1, topic='0x' + '33' * 32),
                 mint(1, topics=[SETUP_MINTED_TOPIC, '0x' + '01' * 32, '0x' + '02' * 32]),
                 mint(1, topics=[SETUP_MINTED_TOPIC, '0x' + '01' * 32, '0x' + '02' * 32, '0x12']),
                 mint(1, removed=True), mint(1, removed=None), mint(1, blockNumber=None), mint(1, blockHash='0x12'),
                 mint(1, logIndex='first'), mint(1, transactionHash=None), 'log', None]
        for log in cases:
            with self.subTest(log=log), self.assertRaises(DataError):
                token_ids([log])
        for answer in ({'logs': []}, None):
            with self.subTest(answer=type(answer).__name__), self.assertRaisesRegex(DataError, '^invalid_logs_response$'):
                token_ids(answer)
        # A checksummed topic is the same event.
        self.assertEqual(token_ids([mint(1, topic=SETUP_MINTED_TOPIC.upper().replace('0X', '0x'))]), [1])

    def test_a_log_outside_the_range_or_a_conflicting_repeat_is_refused(self):
        for block in (START - 1, END + 1):
            with self.subTest(block=block), self.assertRaisesRegex(DataError, '^mint_outside_scan$'):
                token_ids([mint(1, block=block)])
        self.assertEqual(token_ids([mint(1, block=START), mint(2, block=END)]), [1, 2])
        # Two different events can never share a block and log index.
        with self.assertRaisesRegex(DataError, '^conflicting_setup_log$'):
            token_ids([mint(1, block=START), mint(2, block=START)])

    def test_a_range_wider_than_one_span_or_out_of_order_is_never_asked(self):
        rpc = Rpc([], {})
        for start, end in ((START, START + MINT_SCAN_SPAN), (END, START), (0, 10), (START, float(END)), (None, END)):
            with self.subTest(start=start, end=end), self.assertRaisesRegex(DataError, '^invalid_mint_scan_range$'):
                read_mints(rpc, start, end)
        self.assertEqual(rpc.calls, [])
        self.assertEqual(read_mints(rpc, START, START + MINT_SCAN_SPAN - 1), [])

    def test_a_scan_target_is_a_block_number(self):
        for through in ('70000000', 7e7, None, True):
            with self.subTest(through=through), self.assertRaisesRegex(DataError, '^invalid_mint_scan_target$'):
                scan_mints(None, None, through=through)

    def test_more_mints_than_the_bound_are_refused(self):
        with self.assertRaisesRegex(DataError, '^domino_positions_over_bound$'):
            token_ids([mint(n, block=START + n % 100, index=n) for n in range(MAX_POSITIONS + 1)])
        self.assertEqual(len(token_ids([mint(n, block=START + n % 100, index=n) for n in range(MAX_POSITIONS)])),
                         MAX_POSITIONS)


class PositionPoolTests(unittest.TestCase):
    def test_every_minted_position_maps_to_its_pool_once(self):
        rpc = Rpc([], {3: key(TOKEN_A), 7: key(TOKEN_A), 9: key(TOKEN_B, 500, 10)})
        self.assertEqual(position_pools(rpc, HEAD, [7, 3, 9, 7]), {pool_of(key(TOKEN_A)): [3, 7],
                                                                    pool_of(key(TOKEN_B, 500, 10)): [9]})
        # One key read per position at the head, the repeated id included only once, in order.
        self.assertEqual(rpc.calls, [('eth_call', 3), ('eth_call', 7), ('eth_call', 9)])

    def test_a_checksummed_key_names_the_same_pool(self):
        upper = tuple(value.upper().replace('0X', '0x') if isinstance(value, str) else value
                      for value in key(TOKEN_A))
        self.assertEqual(position_pools(Rpc([], {1: upper}), HEAD, [1]), {pool_of(key(TOKEN_A)): [1]})

    def test_a_burned_position_has_no_pool(self):
        self.assertEqual(position_pools(Rpc([], {1: EMPTY, 2: key(TOKEN_A)}), HEAD, [1, 2]),
                         {pool_of(key(TOKEN_A)): [2]})
        self.assertEqual(position_pools(Rpc([], {}), HEAD, []), {})

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
                position_pools(Rpc([], keys, infos), HEAD, [1])
        # The largest positionInfo is a valid answer.
        largest = info_of(key(TOKEN_A)) | (1 << 56) - 1
        self.assertEqual(position_pools(Rpc([], {1: key(TOKEN_A)}, {1: largest}), HEAD, [1]),
                         {pool_of(key(TOKEN_A)): [1]})

    def test_more_positions_than_the_bound_are_refused_before_any_read(self):
        rpc = Rpc([], {})
        with self.assertRaisesRegex(DataError, '^domino_positions_over_bound$'):
            position_pools(rpc, HEAD, range(MAX_POSITIONS + 1))
        self.assertEqual(rpc.calls, [])
        many = Rpc([], {n: EMPTY for n in range(MAX_POSITIONS)})
        self.assertEqual(position_pools(many, HEAD, range(MAX_POSITIONS)), {})


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
