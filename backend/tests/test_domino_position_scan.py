"""The activity follower's mint scan keeps a checkpoint (migration 056) and never misses a position.

4 Nov 2026 (launch round P3, F2): until then every run read the Setup contract's
SetupMinted events from its deployment block, which works only while the node's
log index reaches that block (until early December 2026). These tests run the
scan against real PostgreSQL and a synthetic chain whose blocks, logs and
PositionManager answers can be reorganized: the positions stay exact across a
mint between runs, a reorganization across the checkpoint, one during a scan and
a restart, and the first run after the migration reads from the deployment block
once.
"""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_hash.auto import keccak
import psycopg
from psycopg.rows import dict_row

import domino_positions
from catalogue import PgCatalogue
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import POSITION_MANAGER, Block, DataError
from domino_positions import (MAX_SCAN_SPANS, MINT_SCAN_LOCK, MINT_SCAN_SPAN, RESCAN_BLOCKS, SETUP_CONTRACT,
                              SETUP_DEPLOY_BLOCK, SETUP_MINTED_TOPIC, PgMintScan, position_pools, scan_mints)
from test_domino_positions import EMPTY, TOKEN_A, TOKEN_B, info_of, key, pool_of

BACKEND = Path(__file__).resolve().parents[1]
MIGRATION = BACKEND / 'migrations/056_position_mint_scan.sql'
DEPLOY = SETUP_DEPLOY_BLOCK
# Pools of the synthetic positions: the first two hold Domino positions, the third an unrelated mint's.
P1, P2, P3 = key(TOKEN_A), key(TOKEN_B, 500, 10), key('0x' + 'c3' * 20)


class Chain:
    """Headers, the Setup contract's logs and the PositionManager of a chain whose tail can be replaced.

    `fork(at)` puts a new branch from block `at` on: new hashes, and only the mints
    added to that branch. The fake refuses what the scan promises never to ask: a
    log read over more than MINT_SCAN_SPAN blocks, any block above the head, and
    more requests than the follower's budget for one run.
    """

    def __init__(self, head):
        self.head, self.fork_at, self.branch = head, None, 0
        self.mints = {}       # (branch, block) -> [(log index, token id)]
        self.keys = {}        # token id -> [(branch, block, pool key)], each mint of that id on any branch
        self.burned = set()
        self.requests = []
        self.budget = domino_positions.MAX_SCAN_REQUESTS
        self.after_logs = self.on_header = None
        self.fail_logs = None

    def on(self, number):
        return self.branch if self.fork_at is not None and number >= self.fork_at else 0

    def hash(self, number):
        return '0x' + keccak(f'{self.on(number)}:{number}'.encode()).hex()

    def mint(self, number, token_id, pool_key, *, index=0, branch=0):
        self.mints.setdefault((branch, number), []).append((index, token_id))
        self.keys.setdefault(token_id, []).append((branch, number, pool_key))

    def fork(self, at):
        self.fork_at, self.branch = at, self.branch + 1
        return self.branch

    def request(self, method, params):
        self.requests.append((method, params))
        if len(self.requests) > self.budget:
            raise AssertionError('more requests than the scan budgets')
        if method == 'eth_getBlockByNumber':
            number = int(params[0], 16)
            if number > self.head:
                raise AssertionError(f'block {number} above the head {self.head}')
            if self.on_header:
                self.on_header(number)
            return {'number': hex(number), 'hash': self.hash(number), 'timestamp': hex(1_700_000_000 + number)}
        if method == 'eth_getLogs':
            query = params[0]
            start, end = int(query['fromBlock'], 16), int(query['toBlock'], 16)
            if (query['address'], query['topics']) != (SETUP_CONTRACT, [SETUP_MINTED_TOPIC]):
                raise AssertionError(query)
            if not start <= end <= self.head or end - start + 1 > MINT_SCAN_SPAN:
                raise AssertionError(f'log read {start}..{end}')
            if self.fail_logs and self.fail_logs(start):
                raise DataError('network_unavailable')
            logs = [{'address': SETUP_CONTRACT, 'removed': False, 'blockNumber': hex(number), 'logIndex': hex(index),
                     'blockHash': self.hash(number), 'transactionHash': '0x%064x' % (number * 100 + index),
                     'topics': [SETUP_MINTED_TOPIC, '0x' + '01' * 32, '0x' + '00' * 12 + '11' * 20,
                                '0x%064x' % token_id]}
                    for (branch, number), entries in sorted(self.mints.items())
                    if start <= number <= end and branch == self.on(number) for index, token_id in entries]
            if self.after_logs:
                self.after_logs()
            return logs
        raise AssertionError(method)

    def call(self, target, signature, inputs, values, outputs, *, block):
        assert (target, signature, block) == (POSITION_MANAGER, 'getPoolAndPositionInfo(uint256)', hex(self.head))
        token_id = values[0]
        # The position as the head holds it: minted on the chain as it is now, and not burned.
        live = [pool_key for branch, number, pool_key in self.keys.get(token_id, ())
                if number <= self.head and branch == self.on(number)]
        if not live or token_id in self.burned:
            return EMPTY, 0
        return live[0], info_of(live[0])

    def logs_read(self):
        return [(int(params[0]['fromBlock'], 16), int(params[0]['toBlock'], 16))
                for method, params in self.requests if method == 'eth_getLogs']


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class MintScanPostgresTests(unittest.TestCase):
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def setUp(self):
        assert self.settings['dbname'] == 'domino_catalogue_tests'
        with psycopg.connect(**self.settings, user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_activity.position_mints,domino_activity.position_scan')
        self.catalogue = PgCatalogue(self.settings)

    def run_scan(self, chain, through, **kwargs):
        """One follower run's scan and pools, by a new store as a new process would build it."""
        chain.requests.clear()
        report = scan_mints(PgMintScan(self.catalogue), chain, through=through, **kwargs)
        head = Block(chain.head, chain.hash(chain.head), 0)
        return report, position_pools(chain, head, report.pop('tokenIds'))

    def stored(self):
        with psycopg.connect(**self.settings, user=ADMIN, row_factory=dict_row) as conn:
            scan = conn.execute('SELECT * FROM domino_activity.position_scan').fetchall()
            mints = conn.execute('SELECT block_number,block_hash,token_id FROM domino_activity.position_mints '
                                 'ORDER BY block_number,log_index').fetchall()
        return scan, [(row['block_number'], row['block_hash'], int(row['token_id'])) for row in mints]

    def test_the_first_run_after_the_migration_reads_from_the_deployment_block_once(self):
        chain = Chain(DEPLOY + 2_500_000)
        chain.mint(DEPLOY, 1, P1)
        chain.mint(DEPLOY + 1_200_000, 2, P2)
        through = chain.head - 100
        report, pools = self.run_scan(chain, through)
        # Spans of MINT_SCAN_SPAN from the deployment block, each block once, up to the target.
        self.assertEqual(chain.logs_read(), [(DEPLOY, DEPLOY + 999_999), (DEPLOY + 1_000_000, DEPLOY + 1_999_999),
                                             (DEPLOY + 2_000_000, through)])
        self.assertEqual(report, {'targetBlock': through, 'fromBlock': DEPLOY, 'scannedThrough': through, 'spans': 3,
                                  'rescannedFrom': None, 'stoppedBecause': 'caught_up'})
        self.assertEqual(pools, {pool_of(P1): [1], pool_of(P2): [2]})
        scan, mints = self.stored()
        self.assertEqual([(row['start_block'], row['scanned_through'], row['scanned_hash']) for row in scan],
                         [(DEPLOY, through, chain.hash(through))])
        self.assertEqual(mints, [(DEPLOY, chain.hash(DEPLOY), 1), (DEPLOY + 1_200_000, chain.hash(DEPLOY + 1_200_000), 2)])
        # The next run, a new process, never goes back to the deployment block.
        chain.head += 600
        report, again = self.run_scan(chain, chain.head - 100)
        self.assertEqual(chain.logs_read(), [(through + 1, chain.head - 100)])
        self.assertEqual((report['fromBlock'], report['spans']), (through + 1, 1))
        self.assertEqual(again, pools)

    def test_a_mint_between_runs_is_found_in_the_new_blocks_alone(self):
        chain = Chain(DEPLOY + 50_000)
        chain.mint(DEPLOY + 10, 1, P1)
        first, pools = self.run_scan(chain, chain.head - 100)
        self.assertEqual(pools, {pool_of(P1): [1]})
        # A new Domino position in a new pool, and another in the first pool, after the checkpoint.
        chain.mint(first['scannedThrough'] + 1, 2, P2)
        chain.mint(first['scannedThrough'] + 400, 3, P1, index=4)
        chain.head += 600
        report, pools = self.run_scan(chain, chain.head - 100)
        self.assertEqual(chain.logs_read(), [(first['scannedThrough'] + 1, chain.head - 100)])
        self.assertEqual(pools, {pool_of(P1): [1, 3], pool_of(P2): [2]})
        # Nothing new: no log is read and no block either, and the positions stay.
        report, same = self.run_scan(chain, chain.head - 100)
        self.assertEqual(chain.requests, [])
        self.assertEqual((report['spans'], report['scannedThrough'], report['stoppedBecause']),
                         (0, chain.head - 100, 'caught_up'))
        self.assertEqual(same, pools)

    def test_the_scan_stops_at_its_target_and_finds_a_later_mint_next_time(self):
        chain = Chain(DEPLOY + 5_000)
        # Minted inside the follower's lag: not read until the target passes it.
        chain.mint(chain.head - 50, 1, P1)
        report, pools = self.run_scan(chain, chain.head - 100)
        self.assertEqual((report['scannedThrough'], pools), (chain.head - 100, {}))
        chain.head += 100
        report, pools = self.run_scan(chain, chain.head - 100)
        self.assertEqual(pools, {pool_of(P1): [1]})

    def test_a_reorganization_across_the_checkpoint_rescans_from_the_safe_depth(self):
        checkpoint = DEPLOY + 3_000_000
        chain = Chain(checkpoint + 100)
        chain.mint(DEPLOY + 10, 1, P1)
        chain.mint(DEPLOY + 2_000_000, 2, P2)
        # Minted on the branch that will be replaced; on the new one the same token id is someone else's position.
        chain.mint(checkpoint - 100, 3, P1)
        report, pools = self.run_scan(chain, checkpoint)
        self.assertEqual(pools, {pool_of(P1): [1, 3], pool_of(P2): [2]})
        branch = chain.fork(checkpoint - 500)
        chain.keys[3].append((branch, checkpoint - 450, P3))
        chain.mint(checkpoint - 200, 4, P2, branch=branch)
        chain.mint(checkpoint + 50, 5, P1, branch=branch)
        chain.head += 1_000
        report, pools = self.run_scan(chain, chain.head - 100)
        restart = checkpoint - RESCAN_BLOCKS + 1
        self.assertEqual(report['rescannedFrom'], restart)
        self.assertEqual(chain.logs_read(), [(restart, chain.head - 100)])
        # Token 3 is no Domino position on the chain as it is: its stored mint went with its branch.
        self.assertEqual(pools, {pool_of(P1): [1, 5], pool_of(P2): [2, 4]})
        scan, mints = self.stored()
        self.assertEqual(mints, [(DEPLOY + 10, chain.hash(DEPLOY + 10), 1),
                                 (DEPLOY + 2_000_000, chain.hash(DEPLOY + 2_000_000), 2),
                                 (checkpoint - 200, chain.hash(checkpoint - 200), 4),
                                 (checkpoint + 50, chain.hash(checkpoint + 50), 5)])
        self.assertEqual((scan[0]['scanned_through'], scan[0]['scanned_hash']),
                         (chain.head - 100, chain.hash(chain.head - 100)))

    def test_a_target_below_the_deployment_block_reads_and_stores_nothing(self):
        chain = Chain(DEPLOY - 10)
        for through in (DEPLOY - 110, -90):
            report, pools = self.run_scan(chain, through)
            self.assertEqual((report['spans'], report['scannedThrough'], pools, chain.requests), (0, None, {}, []))
        self.assertEqual(self.stored(), ([], []))
        # The deployment's own block is the first target with anything to read.
        chain.head = DEPLOY + 100
        report, pools = self.run_scan(chain, DEPLOY)
        self.assertEqual((report['fromBlock'], report['scannedThrough'], chain.logs_read()),
                         (DEPLOY, DEPLOY, [(DEPLOY, DEPLOY)]))

    def test_a_rescan_never_reads_below_the_deployment_block(self):
        chain = Chain(DEPLOY + 1_000)
        chain.mint(DEPLOY + 5, 1, P1)
        self.run_scan(chain, DEPLOY + 900)
        branch = chain.fork(DEPLOY + 3)
        chain.mint(DEPLOY + 4, 2, P2, branch=branch)
        report, pools = self.run_scan(chain, DEPLOY + 950)
        self.assertEqual(report['rescannedFrom'], DEPLOY)
        self.assertEqual(chain.logs_read(), [(DEPLOY, DEPLOY + 950)])
        self.assertEqual(pools, {pool_of(P2): [2]})
        self.assertEqual([mint[2] for mint in self.stored()[1]], [2])

    def test_a_reorganization_during_a_span_commits_nothing_of_it(self):
        for moment in ('logs', 'before_end'):
            with self.subTest(moment=moment):
                self.setUp()
                chain = Chain(DEPLOY + 10_000)
                chain.mint(DEPLOY + 1_000, 1, P1)
                first, _ = self.run_scan(chain, DEPLOY + 5_000)
                chain.mint(DEPLOY + 6_000, 2, P2)
                chain.head += 1_000
                target = chain.head - 100
                # The new branch carries the same new position at the same block.
                def fork(at):
                    chain.mint(DEPLOY + 6_000, 2, P2, branch=chain.fork(at))
                if moment == 'logs':
                    # The span's end moves while its logs are read; its start does not.
                    def change():
                        chain.after_logs = None
                        fork(DEPLOY + 5_500)
                    chain.after_logs = change
                else:
                    # The checkpoint itself moves after the scan checked it, before the span's end is read: that
                    # end is the same before and after the logs, so only the checkpoint's second read sees it.
                    def change(number):
                        if number == target:
                            chain.on_header = None
                            fork(DEPLOY + 4_000)
                    chain.on_header = change
                with self.assertRaisesRegex(DataError, '^mint_scan_reorganized$'):
                    self.run_scan(chain, target)
                scan, mints = self.stored()
                self.assertEqual((scan[0]['scanned_through'], [mint[2] for mint in mints]), (DEPLOY + 5_000, [1]))
                # The next run finds the moved checkpoint and reads the blocks again from its depth.
                report, pools = self.run_scan(chain, target)
                self.assertEqual(report['rescannedFrom'] is not None, moment == 'before_end')
                self.assertEqual(pools, {pool_of(P1): [1], pool_of(P2): [2]})

    def test_a_restart_goes_on_from_the_last_span_committed(self):
        chain = Chain(DEPLOY + 3_500_000)
        for token_id, offset in ((1, 10), (2, 1_500_000), (3, 2_500_000), (4, 3_100_000)):
            chain.mint(DEPLOY + offset, token_id, P1 if token_id % 2 else P2)
        # The third span's read fails: the process ends there.
        chain.fail_logs = lambda start: start == DEPLOY + 2_000_000
        with self.assertRaisesRegex(DataError, '^network_unavailable$'):
            self.run_scan(chain, chain.head - 100)
        scan, mints = self.stored()
        self.assertEqual((scan[0]['scanned_through'], [mint[2] for mint in mints]), (DEPLOY + 1_999_999, [1, 2]))
        chain.fail_logs = None
        report, pools = self.run_scan(chain, chain.head - 100)
        # Each block read once across both processes; nothing between them skipped.
        self.assertEqual(chain.logs_read(), [(DEPLOY + 2_000_000, DEPLOY + 2_999_999),
                                             (DEPLOY + 3_000_000, chain.head - 100)])
        self.assertEqual(pools, {pool_of(P1): [1, 3], pool_of(P2): [2, 4]})

    def test_a_burned_position_drops_out_and_its_mint_stays(self):
        chain = Chain(DEPLOY + 5_000)
        chain.mint(DEPLOY + 10, 1, P1)
        chain.mint(DEPLOY + 20, 2, P1)
        self.run_scan(chain, chain.head - 100)
        chain.burned.add(1)
        chain.head += 600
        report, pools = self.run_scan(chain, chain.head - 100)
        self.assertEqual(pools, {pool_of(P1): [2]})
        self.assertEqual([mint[2] for mint in self.stored()[1]], [1, 2])

    def test_one_run_reads_at_most_its_spans_and_its_seconds(self):
        chain = Chain(DEPLOY + 8_000_000)
        chain.mint(DEPLOY + 7_500_000, 1, P1)
        with patch.object(domino_positions, 'MAX_SCAN_SPANS', 2):
            report, pools = self.run_scan(chain, chain.head - 100)
            self.assertEqual((report['spans'], report['scannedThrough'], report['stoppedBecause'], pools),
                             (2, DEPLOY + 1_999_999, 'span_budget', {}))
            # A run whose last allowed span reaches its target has caught up; it did not run out of spans.
            report, pools = self.run_scan(chain, DEPLOY + 3_999_999)
            self.assertEqual((report['spans'], report['stoppedBecause']), (2, 'caught_up'))
        # The clock passes the run's seconds during its first span: it starts no other.
        now = [0.0]
        chain.after_logs = lambda: now.__setitem__(0, now[0] + 25)
        report, pools = self.run_scan(chain, chain.head - 100, seconds=20, clock=lambda: now[0])
        self.assertEqual((report['spans'], report['stoppedBecause'], report['scannedThrough']),
                         (1, 'time_budget', DEPLOY + 4_999_999))
        chain.after_logs = None
        report, pools = self.run_scan(chain, chain.head - 100)
        self.assertEqual((report['stoppedBecause'], pools), ('caught_up', {pool_of(P1): [1]}))

    def test_the_budgets_hold_a_whole_first_scan_and_the_request_bound_holds_them(self):
        # Every span the bound allows, each a rescan's worth of requests, fits the run's request budget.
        chain = Chain(DEPLOY + MAX_SCAN_SPANS * MINT_SCAN_SPAN + 10_000)
        report, _ = self.run_scan(chain, chain.head - 100)
        self.assertEqual((report['spans'], report['stoppedBecause']), (MAX_SCAN_SPANS, 'span_budget'))
        self.assertLessEqual(len(chain.requests), domino_positions.MAX_SCAN_REQUESTS)

    def test_a_scan_another_run_holds_follows_what_is_stored(self):
        chain = Chain(DEPLOY + 5_000)
        chain.mint(DEPLOY + 10, 1, P1)
        self.run_scan(chain, DEPLOY + 1_000)
        chain.mint(DEPLOY + 2_000, 2, P2)
        with psycopg.connect(**self.settings, user=ADMIN, autocommit=True) as holder:
            holder.execute('SELECT pg_advisory_lock(%s)', (MINT_SCAN_LOCK,))
            report, pools = self.run_scan(chain, chain.head - 100)
        self.assertEqual((report['stoppedBecause'], report['spans'], pools), ('busy', 0, {pool_of(P1): [1]}))
        self.assertEqual(chain.requests, [])

    def test_positions_past_the_bound_are_refused_and_nothing_is_committed(self):
        chain = Chain(DEPLOY + 5_000)
        for token_id in (1, 2):
            chain.mint(DEPLOY + token_id, token_id, P1)
        self.run_scan(chain, DEPLOY + 1_000)
        chain.mint(DEPLOY + 2_000, 3, P2)
        with patch.object(domino_positions, 'MAX_POSITIONS', 2), \
             self.assertRaisesRegex(DataError, '^domino_positions_over_bound$'):
            self.run_scan(chain, DEPLOY + 3_000)
        scan, mints = self.stored()
        self.assertEqual((scan[0]['scanned_through'], [mint[2] for mint in mints]), (DEPLOY + 1_000, [1, 2]))
        # Stored mints past a lowered bound are refused when read, too.
        with patch.object(domino_positions, 'MAX_POSITIONS', 1), \
             self.assertRaisesRegex(DataError, '^domino_positions_over_bound$'):
            PgMintScan(self.catalogue).token_ids()

    def test_the_migration_applies_again_and_grants_reads_and_writes_by_role(self):
        with psycopg.connect(**self.settings, user=ADMIN) as conn, conn.transaction(force_rollback=True):
            # From nothing, as on a host that never had it, then again, as dev_postgres.py applies every migration.
            conn.execute('DROP TABLE domino_activity.position_mints,domino_activity.position_scan')
            conn.execute(MIGRATION.read_text())
            conn.execute(MIGRATION.read_text())
            for table in ('position_scan', 'position_mints'):
                for role, privileges in (('domino_catalogue_reader', (True, False, False, False)),
                                         ('domino_catalogue_writer', (True, True, True, True))):
                    with self.subTest(table=table, role=role):
                        self.assertEqual(conn.execute(
                            'SELECT ' + ','.join(f"has_table_privilege(%s,%s,'{name}')"
                                                 for name in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')),
                            [role, f'domino_activity.{table}'] * 4).fetchone(), privileges)


if __name__ == '__main__':
    unittest.main()
