"""Pools that hold a Domino position: every NFT the Setup contract minted.

Nothing is sent to the chain. The Setup contract's own SetupMinted events since
its deployment name the positions; the PositionManager names each position's
pool at the head. The activity follower keeps those pools' activity current
(`manage_activity.py --follow --domino-positions`), so a new Domino pool joins
without anyone listing it.

4 Nov 2026 (launch round P3, F2): the scan keeps a checkpoint in PostgreSQL
(migration 056). Until then every run, once a minute, read the events from the
deployment block on: about 95 ms on the own node on 2 Oct 2026, a cost growing
with the range (docs/LOCAL_RPC_SOURCE.md), and possible only while the node's
log index (its last 60M blocks since 2 Nov) still reaches the deployment block,
which ends in early December 2026. Now a run reads only the blocks after the
checkpoint, up to the follower's target (the head less its lag), and stores
each mint with its block. The checkpoint keeps its block's hash: a run that
finds it changed (a reorganization across the checkpoint) deletes the mints of
the last RESCAN_BLOCKS below it and reads those blocks again. A burned position
still drops out: every stored mint is read at the head, as before.
"""
import time

from eth_abi import encode
from eth_hash.auto import keccak

from discovery import (KEY_TYPES, POSITION_MANAGER, DataError, PoolKey, address, bytes32, parse_block,
                       quantity)

# DominoSetupV1 on Robinhood (docs/deployments/v1-robinhood-mainnet-2026-09-21).
SETUP_CONTRACT = '0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a'
SETUP_DEPLOY_BLOCK = 69_249_061
SETUP_MINTED_TOPIC = '0x' + keccak(b'SetupMinted(bytes32,address,uint256,uint128,uint128,uint128)').hex()
# One run reads every position's key in turn, inside the follower's minute:
# 14 positions on 2 Oct 2026. Past the bound the scan refuses, and the bound
# (with manage_activity's request budget, derived from it) is raised then.
MAX_POSITIONS = 1_000
POOL_KEY = '(address,address,uint24,int24,address)'
# Blocks one log read covers at most: the queue worker unit's anchor-search
# window, which the own node answers from its log index in a fraction of a
# second. Some hosted gateways answer a window wider than they serve with an
# empty list and no error (a public Ethereum gateway at 10M blocks, 26 Sep
# 2026): before the checkpoint the next run read it all again, now it would
# skip those blocks for good, so no read asks for more than this.
MINT_SCAN_SPAN = 1_000_000
# Spans one run reads at most, and the seconds after which it starts no other.
# The first run after migration 056 reads from the deployment block (about 37M
# blocks by 4 Nov 2026, estimated: 37 spans from the log index, seconds); a run
# that stops early follows what it found, and the next one goes on from its
# checkpoint a minute later.
MAX_SCAN_SPANS = 64
MINT_SCAN_SECONDS = 20
# Requests one run's scan makes at most: per span, the checkpoint's header, the
# block under a rescan, the span end's header, the logs, and both headers again.
MAX_SCAN_REQUESTS = 6 * MAX_SCAN_SPANS
# How far below a checkpoint whose block hash changed the scan reads again: a
# day of this chain's blocks (V1 deployed at 69,249,061 on 21 Sep 2026 and V2 at
# 80,189,516 on 4 Oct, about 841,000 a day). No reorganization reaches that far:
# Robinhood's finalized blocks trail the head by about 14 minutes (migration
# 040). Reading the day again is one log read.
RESCAN_BLOCKS = 864_000
# The scan's own advisory key: the activity walkers' global and per-pool keys
# never wait on it (public-data locks use 46630240-51, the featured selector 60;
# test_domino_positions holds every numbered key in the backend to one user).
MINT_SCAN_LOCK = 46630290


def header(rpc, number):
    block = parse_block(rpc.request('eth_getBlockByNumber', [hex(number), False]))
    if block.number != number:
        raise DataError('unexpected_block_number')
    return block


def decode_mint(log):
    topics = log.get('topics') if isinstance(log, dict) else None
    if (not isinstance(topics, list) or len(topics) != 4 or address(log.get('address')) != SETUP_CONTRACT
            or bytes32(topics[0]) != SETUP_MINTED_TOPIC or log.get('removed') is not False):
        raise DataError('invalid_setup_log')
    return {'tokenId': int(bytes32(topics[3]), 16), 'blockNumber': quantity(log.get('blockNumber')),
            'blockHash': bytes32(log.get('blockHash')), 'transactionHash': bytes32(log.get('transactionHash')),
            'logIndex': quantity(log.get('logIndex'))}


def read_mints(rpc, start, end):
    """The Setup contract's SetupMinted events in blocks [start, end], each once, in chain order."""
    if type(start) is not int or type(end) is not int or not 1 <= start <= end < start + MINT_SCAN_SPAN:
        raise DataError('invalid_mint_scan_range')
    logs = rpc.request('eth_getLogs', [{'address': SETUP_CONTRACT, 'topics': [SETUP_MINTED_TOPIC],
                                        'fromBlock': hex(start), 'toBlock': hex(end)}])
    if not isinstance(logs, list):
        raise DataError('invalid_logs_response')
    if len(logs) > MAX_POSITIONS:
        raise DataError('domino_positions_over_bound')
    mints = {}
    for log in logs:
        mint = decode_mint(log)
        if not start <= mint['blockNumber'] <= end:
            raise DataError('mint_outside_scan')
        # A provider may repeat a log; the same block and index must be the same event.
        if mints.setdefault((mint['blockNumber'], mint['logIndex']), mint) != mint:
            raise DataError('conflicting_setup_log')
    return [mints[identity] for identity in sorted(mints)]


class PgMintScan:
    """The scan's checkpoint and the mints it read (migration 056), through the catalogue's connections."""

    def __init__(self, catalogue, *, contract=SETUP_CONTRACT, start_block=SETUP_DEPLOY_BLOCK):
        self.catalogue, self.contract, self.start_block = catalogue, contract, start_block

    def writing(self):
        return self.catalogue.connection(writer=True, lock=MINT_SCAN_LOCK)

    def checkpoint(self, conn):
        return conn.execute('SELECT * FROM domino_activity.position_scan WHERE contract=%s',
                            (self.contract,)).fetchone()

    def begin(self, conn, base):
        """The first scan: nothing read yet, and the block below the deployment as its checkpoint."""
        conn.execute('''INSERT INTO domino_activity.position_scan(contract,start_block,scanned_through,scanned_hash)
                        VALUES(%s,%s,%s,%s)''', (self.contract, self.start_block, base.number, base.hash))
        return self.checkpoint(conn)

    def rewind(self, conn, base):
        """Forget every mint above `base`, which becomes the checkpoint."""
        conn.execute('DELETE FROM domino_activity.position_mints WHERE contract=%s AND block_number>%s',
                     (self.contract, base.number))
        conn.execute('''UPDATE domino_activity.position_scan SET scanned_through=%s,scanned_hash=%s,
                        updated_at=clock_timestamp() WHERE contract=%s''', (base.number, base.hash, self.contract))
        return self.checkpoint(conn)

    def commit(self, conn, end, mints):
        for mint in mints:
            conn.execute('''INSERT INTO domino_activity.position_mints
                            (contract,block_number,log_index,block_hash,tx_hash,token_id) VALUES(%s,%s,%s,%s,%s,%s)''',
                         (self.contract, mint['blockNumber'], mint['logIndex'], mint['blockHash'],
                          mint['transactionHash'], mint['tokenId']))
        known = conn.execute('SELECT count(DISTINCT token_id) AS n FROM domino_activity.position_mints '
                             'WHERE contract=%s', (self.contract,)).fetchone()['n']
        if known > MAX_POSITIONS:
            raise DataError('domino_positions_over_bound')
        conn.execute('''UPDATE domino_activity.position_scan SET scanned_through=%s,scanned_hash=%s,
                        updated_at=clock_timestamp() WHERE contract=%s''', (end.number, end.hash, self.contract))

    def token_ids(self):
        with self.catalogue.connection() as conn:
            rows = conn.execute('''SELECT DISTINCT token_id FROM domino_activity.position_mints WHERE contract=%s
                                   ORDER BY token_id LIMIT %s''', (self.contract, MAX_POSITIONS + 1)).fetchall()
        if len(rows) > MAX_POSITIONS:
            raise DataError('domino_positions_over_bound')
        return [int(row['token_id']) for row in rows]


def scan_mints(scan, rpc, *, through, seconds=MINT_SCAN_SECONDS, clock=time.monotonic):
    """Read the Setup contract's mints from the checkpoint through block `through`, a span per transaction.

    Every span commits its mints with the checkpoint, so a run cut short (an
    error, its budget, the unit's timeout) loses nothing it read, and the next
    run goes on from there. Answers the run's report with `tokenIds`, every
    position minted up to the checkpoint.
    """
    if type(through) is not int:
        raise DataError('invalid_mint_scan_target')
    started = clock()
    report = {'targetBlock': through, 'fromBlock': None, 'scannedThrough': None, 'spans': 0,
              'rescannedFrom': None, 'stoppedBecause': 'caught_up'}
    while True:
        if report['spans'] >= MAX_SCAN_SPANS:
            report['stoppedBecause'] = 'span_budget'
            break
        if report['spans'] and clock() - started >= seconds:
            report['stoppedBecause'] = 'time_budget'
            break
        try:
            with scan.writing() as conn:
                row = scan.checkpoint(conn)
                if row is not None:
                    report['scannedThrough'] = row['scanned_through']
                # Nothing to read yet: no block, not even the checkpoint's, is asked for.
                if (scan.start_block - 1 if row is None else row['scanned_through']) >= through:
                    break
                if row is None:
                    row = scan.begin(conn, header(rpc, scan.start_block - 1))
                elif header(rpc, row['scanned_through']).hash != row['scanned_hash']:
                    # The checkpoint's block left the chain: read the last
                    # RESCAN_BLOCKS again, without the mints stored for them.
                    restart = max(row['start_block'], row['scanned_through'] - RESCAN_BLOCKS + 1)
                    row = scan.rewind(conn, header(rpc, restart - 1))
                    report['rescannedFrom'] = restart
                start = row['scanned_through'] + 1
                end = min(start + MINT_SCAN_SPAN - 1, through)
                last = header(rpc, end)
                mints = read_mints(rpc, start, end)
                # Nothing read may come from a branch that changed meanwhile.
                if header(rpc, end) != last or header(rpc, start - 1).hash != row['scanned_hash']:
                    raise DataError('mint_scan_reorganized')
                scan.commit(conn, last, mints)
        except DataError as error:
            if str(error) != 'catalogue_writer_busy':
                raise
            # Another run holds the scan; this one follows what is stored.
            report['stoppedBecause'] = 'busy'
            break
        if report['fromBlock'] is None:
            report['fromBlock'] = start
        report['scannedThrough'] = end
        report['spans'] += 1
        if end >= through:
            break
    report['tokenIds'] = scan.token_ids()
    return report


def position_pools(rpc, head, token_ids):
    """{poolId: [tokenIds]} for the minted positions `token_ids`, each read at `head`.

    A burned position has no pool any more and is left out: Uniswap clears its
    positionInfo, as nft_ownership.read_identity reads it.
    """
    token_ids = sorted(set(token_ids))
    if len(token_ids) > MAX_POSITIONS:
        raise DataError('domino_positions_over_bound')
    pools = {}
    for token_id in token_ids:
        raw_key, info = rpc.call(POSITION_MANAGER, 'getPoolAndPositionInfo(uint256)', ['uint256'], [token_id],
                                 [POOL_KEY, 'uint256'], block=head.tag)
        if type(info) is not int or not 0 <= info < 2 ** 256:
            raise DataError('invalid_nft_position_info')
        if info == 0:
            continue
        pool_id = '0x' + keccak(encode(KEY_TYPES, raw_key)).hex()
        PoolKey.checked(raw_key, pool_id)
        # positionInfo carries the first 25 bytes of its pool's id.
        if info >> 56 != int(pool_id, 16) >> 56:
            raise DataError('nft_pool_mismatch')
        pools.setdefault(pool_id, []).append(token_id)
    return pools
