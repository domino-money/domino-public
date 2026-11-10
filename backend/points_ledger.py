"""Points, season 1, part 1: the revenue ledger (docs/points/POINTS.md).

The owner's points campaign (decided 6-7 Nov 2026) gives a wallet 1,000 points
per US$1 of net revenue Domino receives from it. Per chain, this ledger keeps
one row for every Domino fee the V2 index holds: each FeeCharged (assisted
swap, automation, Auto-exit) with its payer, token, amount and ref, valued in
USD as read-v6 values a token (the chain's stable at US$1, ETH/WETH by
Chainlink, any other token by its deepest pool with at least US$10,000 of depth
within 10%; a token with none has no value, and its row says why), less the gas
Domino's operator paid for the fee's transaction. It is Domino's revenue per
wallet. No rule of a season applies here: the points engine (part 2) reads
these rows and applies the season's window, exclusions, the Auto-exit floor and
referrals. The bridge's app fee is not an index event and arrives with part 2.

Where a fee is valued: at its checkpoint, the first index checkpoint at or
after its block (the index proves its hash), so a caught-up ledger values a fee
within about a minute of it. A fee the ledger reaches late (more than
LATE_SECONDS after its checkpoint: a backlog, an outage, the first run) is
valued at the index's newest checkpoint, and its row says so (price_late): no
historical read. On 7 Nov 2026 the first run read October's blocks through the
fallbacks, and the archive provider's rate limit, shared with the V2
automation, answered the automation a 429; points start on 9 Nov, so an older
fee's exact price buys nothing. A failed read is never recorded: the pass stops,
and the next one tries again.

Gas: when the transaction's sender is one of Domino's operators (the
deployment's, and any the registry allowed since: OperatorSet), as for an
automation or an Auto-exit, its cost (gas used times effective gas price, plus OP Stack's L1
fee) is valued in the native currency at the same checkpoint and shared among
the transaction's fees by their value. A fee's net value never goes below zero.
A transaction the payer sent (an assisted swap) costs Domino nothing. A fee
whose transaction the index has not stored yet waits for it: the pass stops at
the checkpoint before it.

What it reads: the V2 index's own rows (checkpoints, logs, transactions, tokens
and the deployment's manifest) and, per checkpoint holding fees to value, one
read-v6 price survey (three Multicall3 rounds) through the V2 chain RPC file's
endpoints in their order (never a public RPC). It never reads the head and never
runs ahead of the index.

Reorganizations: the cursor is always one of the index's checkpoints. When the
index rewinds past it, the ledger deletes every row above the newest checkpoint
still standing and reads on from there; a commit holds its checkpoint against
the index's deletion until it is written.

CLI: `follow` (the unit domino-points-ledger@<chain>), `step`, `status`, and
`totals` (the rows' revenue between two times, per chain and kind).
"""
import argparse
from bisect import bisect_left
from contextlib import contextmanager
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
import json
import re
import sys
import time

import psycopg

from discovery import ZERO, Block, DataError

FEE_KINDS = {1: 'assisted_swap', 2: 'automation', 3: 'auto_exit'}
# A fee whose checkpoint is older than this when the ledger reaches it may be valued at the index's newest one.
LATE_SECONDS = 900
# Blocks one pass reads at most, and the fees and checkpoints to value it may take before it stops short.
DEFAULT_SPAN, MIN_SPAN, MAX_SPAN = 50_000, 1_000, 500_000
MAX_FEES = 2_000
MAX_SURVEYS = 16
# Tokens one survey values at most (read-v6's survey reads two calls per candidate pool).
SURVEY_TOKENS = 12
PRICE_REQUESTS = 64
PRICE_BUDGET_SECONDS = 20
NATIVE_DECIMALS = 18
USD_DECIMALS = 18
# A price read that failed: never recorded, the pass is tried again.
TRANSIENT = frozenset({'price_read_failed', 'pricing_limit_reached'})
LOCK_NAMESPACE = 0x5054 << 40
WRITER_STATEMENT_TIMEOUT = '15000ms'
ADDRESS = re.compile(r'0x[0-9a-f]{40}')
HASH32 = re.compile(r'0x[0-9a-f]{64}')


@dataclass(frozen=True)
class Fee:
    block: int
    log_index: int
    block_hash: str
    timestamp: int
    tx: str
    kind: int
    token: str
    payer: str
    amount: int
    ref: str


@dataclass(frozen=True)
class Priced:
    """A token's value at a checkpoint: USD per whole token and read-v6's source, or no value and its reason."""
    usd: object  # Fraction or None
    source: object
    reason: object
    decimals: object


def usd_text(value):
    """A non-negative Fraction as numeric(60,18): floored to 18 decimals, exactly (never through a float)."""
    if value < 0:
        raise DataError('points_negative_usd')
    scaled = value.numerator * 10 ** USD_DECIMALS // value.denominator
    return Decimal(f'{scaled // 10 ** USD_DECIMALS}.{scaled % 10 ** USD_DECIMALS:0{USD_DECIMALS}d}')


def decode_fee(row):
    """A domino_v2.logs FeeCharged row as a Fee, its arguments checked."""
    a = row['args']
    try:
        kind, amount = int(a['kind']), int(a['amount'])
        token, payer, ref = a['token'].lower(), a['payer'].lower(), a['ref'].lower()
    except (KeyError, TypeError, ValueError, AttributeError):
        raise DataError('points_fee_log_invalid') from None
    if kind not in FEE_KINDS or amount < 0 or not ADDRESS.fullmatch(token) or not ADDRESS.fullmatch(payer) \
            or not HASH32.fullmatch(ref):
        raise DataError('points_fee_log_invalid')
    return Fee(int(row['block_number']), int(row['log_index']), row['block_hash'], int(row['block_timestamp']),
               row['tx_hash'], kind, token, payer, amount, ref)


def value_fees(fees, priced, transactions, operators):
    """Each fee's row values, in the fees' order: `priced` {fee: Priced of its token}, the native currency's
    Priced under (fee, ZERO); gas shared by value among a transaction's fees when an operator sent it."""
    rows = []
    for fee in fees:
        p = priced[fee]
        gross = Fraction(0)
        if p.usd is not None:
            gross = Fraction(fee.amount, 10 ** p.decimals) * p.usd
        rows.append({'fee': fee, 'priced': p, 'gross': gross, 'gas_wei': None, 'gas': Fraction(0),
                     'gas_reason': None, 'net': gross})
    by_tx = {}
    for row in rows:
        by_tx.setdefault(row['fee'].tx, []).append(row)
    for tx_hash, group in by_tx.items():
        tx = transactions[tx_hash]
        if tx['sender'].lower() not in operators:
            continue
        wei = int(tx['gas_used']) * int(tx['effective_gas_price']) + int(tx['l1_fee'] or 0)
        native = priced[(group[0]['fee'], ZERO)]
        total = sum(row['gross'] for row in group)
        for row in group:
            row['gas_wei'] = wei
            if native.usd is None:
                row['gas_reason'], row['net'] = native.reason, Fraction(0)
                continue
            gas = Fraction(wei, 10 ** NATIVE_DECIMALS) * native.usd
            row['gas'] = gas * row['gross'] / total if total else gas / len(group)
            row['net'] = max(Fraction(0), row['gross'] - row['gas'])
    return rows


class SurveyPricer:
    """read-v6's qualified USD for a few tokens at one checkpoint: its survey, through the chain's endpoints
    anchored at that block (v2_chain_reads.survey, the same reads and rules as read-v6's prices)."""

    def __init__(self, chain, endpoints, *, max_requests=PRICE_REQUESTS):
        self.chain, self.endpoints, self.max_requests = chain, endpoints, max_requests

    def prices(self, block, tokens):
        """{token: Priced} for {token: decimals or None} at `block`; DataError when a survey cannot be read."""
        from read_deadline import read_deadline
        from v2_chain_reads import base_currencies, pool_candidates, survey
        base = {entry[0] for entry in base_currencies(self.chain)}
        out, items = {}, sorted(tokens.items())
        for start in range(0, len(items), SURVEY_TOKENS):
            chunk = dict(items[start:start + SURVEY_TOKENS])
            refs, subjects, unknown = [], {}, []
            for token, decimals in chunk.items():
                if token != ZERO and token not in base:
                    for ref in pool_candidates(self.chain, token):
                        refs.append(ref)
                        subjects[ref] = token
                if decimals is None and token != ZERO:
                    unknown.append(token)
            with read_deadline(PRICE_BUDGET_SECONDS):
                rpc = self.endpoints.read_rpc(anchor=block, max_requests=self.max_requests)
                found = survey(self.chain, rpc, block, refs, subjects, unknown)
            for token, decimals in chunk.items():
                if decimals is None:
                    decimals = NATIVE_DECIMALS if token == ZERO else found.metadata.get(token, (None,))[0]
                entry, reason = found.price(token, decimals)
                if entry is not None and decimals is None:
                    entry, reason = None, 'decimals_unknown'  # the chain's stable is priced before its decimals
                out[token] = Priced(None if entry is None else Fraction(entry['usd']),
                                    None if entry is None else entry['source'], reason, decimals)
        return out


# ------------------------------------------------------------------ storage
def lock_key(chain_id):
    if type(chain_id) is not int or not 0 < chain_id < 1 << 40:
        raise DataError('invalid_v2_chain_id')
    return LOCK_NAMESPACE | chain_id


class LedgerStore:
    """migrations/058_points_ledger.sql through the catalogue writer: one ledger per chain (its own advisory lock,
    never the indexer's or the fee follower's), reading the V2 index's rows."""

    def __init__(self, settings):
        from v2_index_store import V2Store
        self.index = V2Store(settings)

    @contextmanager
    def writer(self, chain_id):
        conn = self.index._connect('domino_catalogue_writer', autocommit=True)
        try:
            conn.execute(f"SET statement_timeout='{WRITER_STATEMENT_TIMEOUT}'")
            if not conn.execute('SELECT pg_try_advisory_lock(%s) AS held', (lock_key(chain_id),)).fetchone()['held']:
                raise DataError('points_ledger_busy')
            try:
                yield LedgerWriter(conn, chain_id)
            finally:
                conn.execute('SELECT pg_advisory_unlock(%s)', (lock_key(chain_id),))
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None
        finally:
            conn.close()

    def latest_checkpoint(self, chain_id):
        """The index's newest checkpoint on the chain, without the ledger's lock (the follow loop's target)."""
        try:
            with self.index._connect('domino_catalogue_writer', autocommit=True) as conn:
                return LedgerWriter(conn, chain_id).latest_checkpoint()
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None

    def connection(self):
        """The catalogue writer without the ledger's lock: the unit's user maps to the writer role only (the
        reader's login is refused there), and status and totals must answer while a pass holds the lock."""
        return self.index._connect('domino_catalogue_writer', autocommit=True)


def _checkpoint(row):
    return Block(int(row['end_block']), row['end_hash'], int(row['end_timestamp']))


def _cursor_checkpoint(row):
    return Block(int(row['block_number']), row['block_hash'], int(row['block_timestamp']))


class LedgerWriter:
    def __init__(self, conn, chain_id):
        self.conn, self.chain_id = conn, chain_id

    # -- the index
    def deployment(self):
        return self.conn.execute('''SELECT start_block,base_hash,lower(manifest->'roles'->>'operator') AS operator
          FROM domino_v2.deployments WHERE chain_id=%s''', (self.chain_id,)).fetchone()

    def latest_checkpoint(self):
        row = self.conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_v2.checkpoints
          WHERE chain_id=%s ORDER BY end_block DESC LIMIT 1''', (self.chain_id,)).fetchone()
        return None if row is None else _checkpoint(row)

    def standing(self, block):
        """The index still has this checkpoint."""
        return self.conn.execute('''SELECT 1 FROM domino_v2.checkpoints WHERE chain_id=%s AND end_block=%s
          AND end_hash=%s''', (self.chain_id, block.number, block.hash)).fetchone() is not None

    def checkpoint_below(self, number):
        """The index's newest checkpoint at or below `number`, or None."""
        row = self.conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_v2.checkpoints
          WHERE chain_id=%s AND end_block<=%s ORDER BY end_block DESC LIMIT 1''', (self.chain_id, number)).fetchone()
        return None if row is None else _checkpoint(row)

    def target(self, after, limit):
        """The checkpoint a pass reads to: the newest in (after, limit], else the first above `after`."""
        row = self.conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_v2.checkpoints
          WHERE chain_id=%s AND end_block>%s AND end_block<=%s ORDER BY end_block DESC LIMIT 1''',
                                (self.chain_id, after, limit)).fetchone()
        if row is None:
            row = self.conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_v2.checkpoints
              WHERE chain_id=%s AND end_block>%s ORDER BY end_block LIMIT 1''', (self.chain_id, after)).fetchone()
        return None if row is None else _checkpoint(row)

    def checkpoints(self, after, through):
        """The index's checkpoints in (after, through], oldest first."""
        rows = self.conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_v2.checkpoints
          WHERE chain_id=%s AND end_block>%s AND end_block<=%s ORDER BY end_block''',
                                 (self.chain_id, after, through)).fetchall()
        return [_checkpoint(row) for row in rows]

    def fees(self, after, through, limit):
        rows = self.conn.execute('''SELECT block_number,log_index,block_hash,block_timestamp,tx_hash,args
          FROM domino_v2.logs WHERE chain_id=%s AND event='FeeCharged' AND block_number>%s AND block_number<=%s
          ORDER BY block_number,log_index LIMIT %s''', (self.chain_id, after, through, limit)).fetchall()
        return [decode_fee(row) for row in rows]

    def transactions(self, hashes):
        if not hashes:
            return {}
        rows = self.conn.execute('''SELECT tx_hash,block_number,sender,gas_used,effective_gas_price,l1_fee
          FROM domino_v2.transactions WHERE chain_id=%s AND tx_hash=ANY(%s)''',
                                 (self.chain_id, sorted(hashes))).fetchall()
        return {row['tx_hash']: row for row in rows}

    def operators(self, through):
        """Every address the registry allowed as operator at or before `through` (OperatorSet), lower case."""
        rows = self.conn.execute('''SELECT DISTINCT lower(args->>'operator') AS operator FROM domino_v2.logs
          WHERE chain_id=%s AND event='OperatorSet' AND args->>'allowed'='true' AND block_number<=%s''',
                                 (self.chain_id, through)).fetchall()
        return {row['operator'] for row in rows}

    def decimals(self, tokens):
        if not tokens:
            return {}
        rows = self.conn.execute('''SELECT address,decimals FROM domino_v2.tokens WHERE chain_id=%s
          AND address=ANY(%s) AND decimals IS NOT NULL''', (self.chain_id, sorted(tokens))).fetchall()
        return {row['address']: int(row['decimals']) for row in rows}

    # -- the ledger
    def cursor(self):
        row = self.conn.execute('SELECT * FROM domino_points.ledger_cursor WHERE chain_id=%s',
                                (self.chain_id,)).fetchone()
        return None if row is None else {**row, 'block': _cursor_checkpoint(row)}

    def start(self, floor, base, now):
        self.conn.execute('''INSERT INTO domino_points.ledger_cursor(chain_id,floor_block,block_number,block_hash,
          block_timestamp,updated_at) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING''',
                          (self.chain_id, floor, base.number, base.hash, base.timestamp, int(now)))

    def record_error(self, code, at):
        code = code if isinstance(code, str) and re.fullmatch(r'[a-z0-9_]{1,80}', code) else 'points_ledger_error'
        self.conn.execute('UPDATE domino_points.ledger_cursor SET last_error=%s,last_error_at=%s WHERE chain_id=%s',
                          (code, int(at), self.chain_id))

    def commit(self, cursor, target, rows, *, caught_up, now):
        """One pass, atomically: its rows and the cursor moved to `target`. Refused when the cursor moved or the
        index no longer has the target, which stays held until this commits."""
        with self.conn.transaction():
            row = self.conn.execute('''SELECT block_number,block_hash FROM domino_points.ledger_cursor
              WHERE chain_id=%s FOR UPDATE''', (self.chain_id,)).fetchone()
            if row is None or (int(row['block_number']), row['block_hash']) != (cursor.number, cursor.hash):
                raise DataError('points_ledger_cursor_changed')
            if not self.conn.execute('''SELECT 1 FROM domino_v2.checkpoints WHERE chain_id=%s AND end_block=%s
              AND end_hash=%s FOR KEY SHARE''', (self.chain_id, target.number, target.hash)).fetchone():
                raise DataError('points_ledger_checkpoint_rewound')
            for r in rows:
                fee, p = r['fee'], r['priced']
                self.conn.execute('''INSERT INTO domino_points.revenue(chain_id,block_number,log_index,block_hash,
                  block_timestamp,tx_hash,kind,token,payer,amount,ref,decimals,price_block,price_late,token_usd,
                  price_source,price_reason,gross_usd,tx_gas_wei,gas_usd,gas_reason,net_usd,recorded_at)
                  VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                                  (self.chain_id, fee.block, fee.log_index, fee.block_hash, fee.timestamp, fee.tx,
                                   fee.kind, fee.token, fee.payer, fee.amount, fee.ref, p.decimals,
                                   r['price_block'], r['price_late'],
                                   None if p.usd is None else usd_text(p.usd), p.source,
                                   p.reason if p.usd is None else None, usd_text(r['gross']), r['gas_wei'],
                                   usd_text(r['gas']), r['gas_reason'], usd_text(r['net']), int(now)))
            self.conn.execute('''UPDATE domino_points.ledger_cursor SET block_number=%s,block_hash=%s,
              block_timestamp=%s,caught_up=%s,last_error=NULL,last_error_at=NULL,updated_at=%s WHERE chain_id=%s''',
                              (target.number, target.hash, target.timestamp, caught_up, int(now), self.chain_id))

    def rewind(self, fork, now):
        """Forget every row above `fork` (a checkpoint the index still has, or its base); read on from it."""
        with self.conn.transaction():
            self.conn.execute('DELETE FROM domino_points.revenue WHERE chain_id=%s AND block_number>%s',
                              (self.chain_id, fork.number))
            self.conn.execute('''UPDATE domino_points.ledger_cursor SET block_number=%s,block_hash=%s,
              block_timestamp=%s,caught_up=false,updated_at=%s WHERE chain_id=%s''',
                              (fork.number, fork.hash, fork.timestamp, int(now), self.chain_id))


# ------------------------------------------------------------------- ledger
class RevenueLedger:
    def __init__(self, store, chain_id, pricer, *, span=DEFAULT_SPAN, clock=time.time):
        if type(span) is not int or not MIN_SPAN <= span <= MAX_SPAN:
            raise DataError('invalid_points_ledger_config')
        self.store, self.chain_id, self.pricer, self.span, self.clock = store, chain_id, pricer, span, clock

    def index_head(self):
        """{'number': the index's newest checkpoint}, the target followers.follow gives each pass."""
        latest = self.store.latest_checkpoint(self.chain_id)
        if latest is None:
            raise DataError('points_ledger_index_not_started')
        return {'number': latest.number}

    def step(self, *, through=None):
        """One pass: the cursor checked against the index, then one range of fees valued and committed.
        `through` bounds the range (the follow loop's target)."""
        if through is not None and type(through) is not int:
            raise DataError('invalid_points_ledger_bounds')
        with self.store.writer(self.chain_id) as writer:
            try:
                return self._step(writer, through)
            except DataError as error:
                if writer.cursor() is not None:
                    writer.record_error(str(error), self.clock())
                raise

    def _step(self, writer, through):
        deployment = writer.deployment()
        if deployment is None:
            raise DataError('v2_deployment_not_registered')
        operator = deployment['operator']
        if not isinstance(operator, str) or not ADDRESS.fullmatch(operator):
            raise DataError('points_operator_unknown')
        floor = int(deployment['start_block'])
        base = Block(floor - 1, deployment['base_hash'], 0)
        if writer.cursor() is None:
            writer.start(floor, base, self.clock())
        cursor = writer.cursor()['block']
        # The cursor is the deployment's base or a checkpoint the index still has; otherwise the index rewound.
        if cursor.number >= floor and not writer.standing(cursor):
            fork = writer.checkpoint_below(cursor.number) or base
            writer.rewind(fork, self.clock())
            return {'status': 'rewound', 'through': fork.number}
        latest = writer.latest_checkpoint()
        if latest is None or latest.number <= cursor.number or (through is not None and through <= cursor.number):
            return {'status': 'caught_up_to_target', 'through': cursor.number}
        limit = cursor.number + self.span if through is None else min(through, cursor.number + self.span)
        target = writer.target(cursor.number, limit)
        fees = writer.fees(cursor.number, target.number, MAX_FEES + 1)
        checkpoints = writer.checkpoints(cursor.number, target.number)
        numbers = [c.number for c in checkpoints]
        own = {fee: checkpoints[bisect_left(numbers, fee.block)] for fee in fees}
        # Stop short: at the checkpoint before a fee whose transaction the index has not stored yet; at the
        # checkpoint holding the MAX_FEES-th fee; at the MAX_SURVEYS-th checkpoint holding fees.
        transactions = writer.transactions({fee.tx for fee in fees})
        waiting = next((fee for fee in fees if fee.tx not in transactions), None)
        if waiting is not None:
            shorter = writer.checkpoint_below(waiting.block - 1)
            if shorter is None or shorter.number <= cursor.number:
                # followers.follow knows three answers: waiting for the index is being caught up, idle until then.
                return {'status': 'caught_up_to_target', 'through': cursor.number, 'waitingFor': waiting.tx}
            target = shorter
        if len(fees) > MAX_FEES:
            target = min(target, own[fees[MAX_FEES - 1]], key=lambda c: c.number)
        held = sorted({own[fee] for fee in fees if fee.block <= target.number}, key=lambda c: c.number)
        if len(held) > MAX_SURVEYS:
            target = held[MAX_SURVEYS - 1]
        fees = [fee for fee in fees if fee.block <= target.number]
        operators = {operator} | writer.operators(target.number)
        rows = self._value(writer, fees, own, transactions, operators, latest)
        caught_up = target == latest
        writer.commit(cursor, target, rows, caught_up=caught_up, now=self.clock())
        return {'status': 'indexed', 'fromBlock': cursor.number + 1, 'through': target.number,
                'caughtUp': caught_up, 'fees': len(rows), 'late': sum(1 for r in rows if r['price_late'])}

    def _value(self, writer, fees, own, transactions, operators, latest):
        if not fees:
            return []
        decimals = writer.decimals({fee.token for fee in fees if fee.token != ZERO})
        asked = {}
        for fee in fees:
            tokens = asked.setdefault(own[fee], {})
            tokens[fee.token] = NATIVE_DECIMALS if fee.token == ZERO else decimals.get(fee.token)
            if transactions[fee.tx]['sender'].lower() in operators:
                tokens[ZERO] = NATIVE_DECIMALS
        now = self.clock()
        valued, late = {}, {}
        for checkpoint in sorted(asked, key=lambda c: c.number):
            if now - checkpoint.timestamp > LATE_SECONDS:
                late[checkpoint] = asked[checkpoint]  # never a historical read: the newest checkpoint values it
                continue
            result = self._read(checkpoint, asked[checkpoint])
            if result is None:
                raise DataError('points_price_read_failed')
            valued[checkpoint] = (checkpoint, False, result)
        if late:
            merged = {}
            for tokens in late.values():
                merged.update(tokens)
            result = self._read(latest, merged)
            if result is None:
                raise DataError('points_price_read_failed')
            for checkpoint in late:
                valued[checkpoint] = (latest, True, result)
        priced, where = {}, {}
        for fee in fees:
            block, is_late, result = valued[own[fee]]
            priced[fee] = result[fee.token]
            if ZERO in result:
                priced[(fee, ZERO)] = result[ZERO]
            where[fee] = (block.number, is_late)
        rows = value_fees(fees, priced, transactions, operators)
        for row in rows:
            row['price_block'], row['price_late'] = where[row['fee']]
        return rows

    def _read(self, checkpoint, tokens):
        """{token: Priced} at the checkpoint, or None when its read failed (an unreadable block, a failed pool)."""
        try:
            result = self.pricer.prices(checkpoint, tokens)
        except DataError:
            return None
        if any(p.reason in TRANSIENT for p in result.values()) or set(result) != set(tokens):
            return None
        return result


# --------------------------------------------------------------------- views
def status(store, chain_id):
    """The cursor and the rows, never under the ledger's lock, so it answers mid-pass."""
    with store.connection() as conn:
        view = LedgerWriter(conn, chain_id)
        cursor = view.cursor()
        latest = view.latest_checkpoint()
        counts = conn.execute('''SELECT count(*) AS fees,count(*) FILTER (WHERE token_usd IS NULL) AS unpriced,
          count(*) FILTER (WHERE price_late) AS late FROM domino_points.revenue WHERE chain_id=%s''',
                                     (chain_id,)).fetchone()
    if cursor is None:
        return {'chainId': chain_id, 'status': 'not_started'}
    return {'chainId': chain_id, 'floorBlock': cursor['floor_block'], 'through': cursor['block_number'],
            'caughtUp': cursor['caught_up'], 'indexThrough': None if latest is None else latest.number,
            'lastError': cursor['last_error'], 'lastErrorAt': cursor['last_error_at'],
            'fees': counts['fees'], 'unpriced': counts['unpriced'], 'late': counts['late']}


def totals(store, since, until, chain_id=None):
    """Revenue the rows hold with a block time in [since, until), per chain and kind, in USD."""
    if type(since) is not int or type(until) is not int or not 0 <= since < until:
        raise DataError('invalid_points_totals_window')
    with store.connection() as conn:
        rows = conn.execute('''SELECT chain_id,kind,count(*) AS fees,count(DISTINCT payer) AS wallets,
          count(*) FILTER (WHERE token_usd IS NULL) AS unpriced,sum(gross_usd) AS gross,sum(gas_usd) AS gas,
          sum(net_usd) AS net FROM domino_points.revenue WHERE block_timestamp>=%s AND block_timestamp<%s
          AND (%s::bigint IS NULL OR chain_id=%s) GROUP BY chain_id,kind ORDER BY chain_id,kind''',
                            (since, until, chain_id, chain_id)).fetchall()
    return {'since': since, 'until': until, 'rows': [
        {'chainId': row['chain_id'], 'kind': FEE_KINDS[row['kind']], 'fees': row['fees'], 'wallets': row['wallets'],
         'unpriced': row['unpriced'], 'grossUsd': str(row['gross']), 'gasUsd': str(row['gas']),
         'netUsd': str(row['net'])} for row in rows]}


def main(argv=None):
    from catalogue import database_settings
    from v2_chains import default_registry
    from v2_rpc import configured_endpoints, load_chain_rpc_config
    parser = argparse.ArgumentParser(description='Record one chain\'s Domino fees in USD (points, season 1).')
    parser.add_argument('command', choices=('step', 'follow', 'status', 'totals'))
    parser.add_argument('--chain', help='profile name, e.g. base-8453 (totals: all chains when omitted)')
    parser.add_argument('--chain-rpc-file', help='the private V2 chain RPC file (chains other than Robinhood)')
    parser.add_argument('--provider-file', help='the read path provider file (Robinhood)')
    parser.add_argument('--span', type=int, default=DEFAULT_SPAN, help='blocks one pass reads at most')
    parser.add_argument('--poll', type=float, default=60, help='follow: seconds between passes when caught up')
    parser.add_argument('--max-passes', type=int, default=0, help='follow: 0 runs until stopped')
    parser.add_argument('--since', type=int, help='totals: first block time, unix seconds')
    parser.add_argument('--until', type=int, help='totals: block time it stops before, unix seconds')
    args = parser.parse_args(argv)
    try:
        settings = database_settings()
        if settings is None:
            raise DataError('catalogue_not_configured')
        store = LedgerStore(settings)
        chain = None if args.chain is None else default_registry().chain(args.chain)
        if args.command == 'totals':
            report = totals(store, args.since if args.since is not None else 0,
                            args.until if args.until is not None else int(time.time()) + 1,
                            None if chain is None else chain.chainId)
            print(json.dumps(report, indent=2, sort_keys=True))
            return 0
        if chain is None:
            raise DataError('points_ledger_chain_required')
        if args.command == 'status':
            print(json.dumps(status(store, chain.chainId), default=str, indent=2, sort_keys=True))
            return 0
        if chain.chainId == 4663:
            from local_config import CONFIG_PATH, load_config
            endpoints = configured_endpoints(chain, provider_config=load_config(args.provider_file or str(CONFIG_PATH)))
        else:
            if not args.chain_rpc_file:
                raise DataError('v2_chain_rpc_not_configured')
            endpoints = configured_endpoints(chain, chain_rpc_config=load_chain_rpc_config(args.chain_rpc_file))
        ledger = RevenueLedger(store, chain.chainId, SurveyPricer(chain, endpoints), span=args.span)
        if args.command == 'step':
            report = ledger.step()
        else:
            from followers import follow
            report = follow(lambda through: ledger.step(through=through), ledger.index_head, lag=0,
                            max_passes=args.max_passes, poll_seconds=args.poll,
                            on_pass=lambda entry: print(json.dumps(entry, default=str, sort_keys=True), flush=True))
    except DataError as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(report, default=str, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
