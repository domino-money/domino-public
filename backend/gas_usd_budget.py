"""Pilot gas budget: qualified ETH/USD quote and a shared daily reservation.

This is an operating-cost control for publisher and operator, not a pool-token
price source. The feed is read at a canonical block. The private PostgreSQL
function serializes all reservations for a Sao Paulo calendar day. A reservation
must precede signing either leg; unresolved reservations continue to count.
"""
from dataclasses import dataclass
from datetime import datetime
import re
import time
from zoneinfo import ZoneInfo

from eth_abi import decode, encode
from eth_hash.auto import keccak
import psycopg

from chainlink_history import ETH_FEED, MANIFEST_SHA256
from read_deadline import read_deadline
from discovery import CHAIN_ID, address, bytes32, parse_block, quantity


class GasBudgetError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


USD_MICROS_PER_USD = 1_000_000
WEI_PER_ETH = 10**18
PILOT_DAILY_USD_MICROS = 20 * USD_MICROS_PER_USD
SOURCE = 'robinhood_chainlink_eth_usd_gas_v1'
ROUND_MASK = (1 << 64) - 1
_HEX = re.compile(r'^0x(?:[0-9a-fA-F]{2})*$')


@dataclass(frozen=True)
class QuotePolicy:
    # The feed's reviewed heartbeat is 24h; 2h is an independent, stricter
    # operating ceiling for gas accounting. The 20% buffer is not a price SLA.
    max_head_age_seconds: int = 180
    # Robinhood Chain finality is currently about 14 minutes behind latest.
    # This bound applies only to canonical finalized settlement quotes.
    max_finalized_lag_seconds: int = 1800
    max_answer_age_seconds: int = 7200
    confirmations: int = 2
    reservation_bps: int = 12000

    def __post_init__(self):
        if (type(self.max_head_age_seconds) is not int or
                not 1 <= self.max_head_age_seconds <= 180 or
                type(self.max_finalized_lag_seconds) is not int or
                not 180 <= self.max_finalized_lag_seconds <= 1800 or
                type(self.max_answer_age_seconds) is not int or
                not 1 <= self.max_answer_age_seconds <= 7200 or
                type(self.confirmations) is not int or
                not 2 <= self.confirmations <= 100 or
                type(self.reservation_bps) is not int or
                self.reservation_bps != 12000):
            raise GasBudgetError('gas_quote_policy_invalid')


@dataclass(frozen=True)
class EthUsdQuote:
    chain_id: int
    source: str
    manifest_sha256: str
    proxy: str
    aggregator: str
    block_number: int
    block_hash: str
    block_timestamp: int
    round_id: int
    answer_raw: int
    decimals: int
    answer_updated_at: int
    retrieved_at: int

    def usd_micros_for_wei(self, wei, *, reserve_bps=10000):
        if (type(wei) is not int or not 0 <= wei < 2**128 or
                type(reserve_bps) is not int or not 10000 <= reserve_bps <= 20000):
            raise GasBudgetError('gas_cost_invalid')
        numerator = wei * self.answer_raw * USD_MICROS_PER_USD * reserve_bps
        denominator = WEI_PER_ETH * (10**self.decimals) * 10000
        return (numerator + denominator - 1) // denominator


class EthUsdReader:
    """Read the reviewed Chainlink proxy from a canonical hash-pinned block.

    Reservations use latest minus the configured confirmation depth. A quote
    that can release capacity must use the RPC finalized head instead.
    """

    def __init__(self, rpc, *, policy=None, clock=time.time, finalized=False):
        if type(finalized) is not bool:
            raise GasBudgetError('gas_quote_policy_invalid')
        self.rpc = rpc
        self.policy = policy if policy is not None else QuotePolicy()
        self.clock = clock
        self.finalized = finalized

    def _request(self, method, params):
        try:
            return self.rpc.request(method, params)
        except Exception:
            raise GasBudgetError('gas_quote_rpc_unavailable') from None

    def _call(self, contract, signature, outputs, block, inputs=(), values=()):
        data = '0x' + (keccak(signature.encode())[:4] + encode(inputs, values)).hex()
        raw = self._request('eth_call', [{'to': contract, 'data': data, 'gas': '0x7a120'},
                                         {'blockHash': block.hash, 'requireCanonical': True}])
        if (type(raw) is not str or len(raw) > 8194 or not _HEX.fullmatch(raw)):
            raise GasBudgetError('gas_quote_invalid_abi')
        try:
            return decode(outputs, bytes.fromhex(raw[2:]))
        except Exception:
            raise GasBudgetError('gas_quote_invalid_abi') from None

    def _block(self, tag):
        try:
            return parse_block(self._request('eth_getBlockByNumber', [tag, False]))
        except GasBudgetError:
            raise
        except Exception:
            raise GasBudgetError('gas_quote_block_unavailable') from None

    def quote(self):
        now = self.clock()
        if type(now) not in (float, int) or not 0 <= now < 2**63:
            raise GasBudgetError('gas_quote_clock_invalid')
        now = int(now)
        try:
            chain_id = quantity(self._request('eth_chainId', []))
        except Exception:
            raise GasBudgetError('gas_quote_chain_invalid') from None
        if chain_id != CHAIN_ID:
            raise GasBudgetError('gas_quote_wrong_chain')
        head = self._block('latest')
        if head.number < self.policy.confirmations:
            raise GasBudgetError('gas_quote_block_unavailable')
        if head.timestamp > now or now - head.timestamp > self.policy.max_head_age_seconds:
            raise GasBudgetError('gas_quote_head_stale')
        block = (self._block('finalized') if self.finalized else
                 self._block(hex(head.number - self.policy.confirmations)))
        if (block.number > head.number or block.timestamp > head.timestamp or
                not self.finalized and block.number != head.number - self.policy.confirmations):
            raise GasBudgetError('gas_quote_block_invalid')
        block_age_limit = (self.policy.max_finalized_lag_seconds if self.finalized
                           else self.policy.max_head_age_seconds)
        if block.timestamp > now or now - block.timestamp > block_age_limit:
            raise GasBudgetError('gas_quote_block_stale')
        for contract in (ETH_FEED.proxy, ETH_FEED.aggregator):
            code = self._request('eth_getCode', [contract, {'blockHash': block.hash, 'requireCanonical': True}])
            if type(code) is not str or len(code) <= 2 or len(code) > 131074 or not _HEX.fullmatch(code):
                raise GasBudgetError('gas_quote_feed_code_invalid')
        try:
            aggregator, = self._call(ETH_FEED.proxy, 'aggregator()', ('address',), block)
            phase, = self._call(ETH_FEED.proxy, 'phaseId()', ('uint16',), block)
            mapped, = self._call(ETH_FEED.proxy, 'phaseAggregators(uint16)', ('address',), block,
                                 ('uint16',), (ETH_FEED.phase,))
            decimals, = self._call(ETH_FEED.proxy, 'decimals()', ('uint8',), block)
            description, = self._call(ETH_FEED.proxy, 'description()', ('string',), block)
            row = self._call(ETH_FEED.proxy, 'latestRoundData()',
                             ('uint80', 'int256', 'uint256', 'uint256', 'uint80'), block)
        except GasBudgetError:
            raise
        except Exception:
            raise GasBudgetError('gas_quote_feed_invalid') from None
        try:
            identity_ok = (address(aggregator) == ETH_FEED.aggregator and
                           address(mapped) == ETH_FEED.aggregator and
                           type(phase) is int and phase == ETH_FEED.phase and
                           type(decimals) is int and decimals == ETH_FEED.decimals and
                           description == ETH_FEED.description)
        except Exception:
            identity_ok = False
        if not identity_ok:
            raise GasBudgetError('gas_quote_feed_identity_changed')
        round_id, answer, started_at, updated_at, answered_in_round = row
        if (any(type(x) is not int for x in row) or
                not 0 < round_id < 2**80 or round_id >> 64 != ETH_FEED.phase or
                not round_id & ROUND_MASK or not 0 < answer < 2**255 or
                not 0 < started_at <= updated_at <= block.timestamp or
                answered_in_round != round_id):
            raise GasBudgetError('gas_quote_round_invalid')
        if now - updated_at > self.policy.max_answer_age_seconds:
            raise GasBudgetError('gas_quote_answer_stale')
        # A number-only re-read ensures the hash-pinned block stayed canonical.
        if self._block(hex(block.number)) != block:
            raise GasBudgetError('gas_quote_reorganized')
        if self.finalized:
            final_head = self._block('finalized')
            if (final_head.number < block.number or
                    final_head.number == block.number and final_head != block or
                    final_head.timestamp < block.timestamp):
                raise GasBudgetError('gas_quote_reorganized')
        return EthUsdQuote(chain_id=CHAIN_ID, source=SOURCE, manifest_sha256=MANIFEST_SHA256,
                           proxy=ETH_FEED.proxy, aggregator=ETH_FEED.aggregator,
                           block_number=block.number, block_hash=block.hash,
                           block_timestamp=block.timestamp, round_id=round_id,
                           answer_raw=answer, decimals=decimals,
                           answer_updated_at=updated_at, retrieved_at=now)


class GasUsdBudget:
    """Private DB caller. Its SQL function takes the row lock and owns the cap."""

    def __init__(self, connection, *, reader=None, quote_policy=None):
        self.connection = connection
        self.quote_policy = quote_policy if quote_policy is not None else QuotePolicy()
        if reader is not None and type(reader) is not EthUsdReader:
            raise GasBudgetError('gas_quote_reader_invalid')
        self.reader = reader

    def _trusted_quote(self):
        # A scheduler-supplied quote is only evidence for its earlier decision.
        # Reservation and settlement must independently read the reviewed feed
        # from the private RPC at the moment of the database write.
        if self.reader is None:
            raise GasBudgetError('gas_quote_reader_required')
        return self.reader.quote()

    def reserve(self, cycle_id, leg, signer, maximum_wei, quote):
        if (type(cycle_id) is not str or not re.fullmatch(r'0x[0-9a-f]{64}', cycle_id) or
                leg not in ('publisher', 'operator') or
                type(signer) is not str or not re.fullmatch(r'0x[0-9a-f]{40}', signer) or
                type(maximum_wei) is not int or not 0 < maximum_wei < 2**128 or
                type(quote) is not EthUsdQuote or quote.chain_id != CHAIN_ID or
                quote.source != SOURCE or quote.manifest_sha256 != MANIFEST_SHA256 or
                quote.proxy != ETH_FEED.proxy or quote.aggregator != ETH_FEED.aggregator or
                quote.decimals != ETH_FEED.decimals):
            raise GasBudgetError('gas_reservation_invalid')
        quote = self._trusted_quote()
        # Never interpret a stale or caller-manufactured quote as permission.
        now = int(time.time())
        if (quote.retrieved_at > now + 5 or now - quote.retrieved_at > 30 or
                quote.answer_updated_at > quote.block_timestamp or
                now - quote.answer_updated_at > self.quote_policy.max_answer_age_seconds):
            raise GasBudgetError('gas_reservation_quote_stale')
        reserved = quote.usd_micros_for_wei(maximum_wei,
                                            reserve_bps=self.quote_policy.reservation_bps)
        if reserved <= 0 or reserved > PILOT_DAILY_USD_MICROS:
            raise GasBudgetError('gas_daily_cap_exceeded')
        try:
            with self.connection.transaction():
                row = self.connection.execute(
                    'SELECT day::text,reserved_usd_micros::text,state FROM '
                    'domino_gas_budget.reserve(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (cycle_id, leg, signer, maximum_wei, quote.answer_raw, quote.round_id,
                     quote.answer_updated_at, quote.block_number, quote.block_hash,
                     quote.block_timestamp, self.quote_policy.reservation_bps)).fetchone()
        except psycopg.errors.CheckViolation as error:
            code = error.diag.message_primary
            if code in ('gas_daily_cap_exceeded','gas_reservation_invalid','gas_reservation_conflict'):
                raise GasBudgetError(code) from None
            raise GasBudgetError('gas_budget_unavailable') from None
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None
        return {'day': row[0], 'reservedUsdMicros': int(row[1]), 'state': row[2]}

    def settle(self, cycle_id, leg, actual_total_wei, quote, *, witnessed_quote=None):
        if (type(cycle_id) is not str or not re.fullmatch(r'0x[0-9a-f]{64}', cycle_id) or
                leg not in ('publisher', 'operator') or
                type(actual_total_wei) is not int or not 0 < actual_total_wei < 2**128 or
                type(quote) is not EthUsdQuote or quote.source != SOURCE or
                quote.proxy != ETH_FEED.proxy or quote.aggregator != ETH_FEED.aggregator):
            raise GasBudgetError('gas_settlement_invalid')
        quote = self._trusted_quote()
        now = int(time.time())
        if (quote.retrieved_at > now + 5 or now - quote.retrieved_at > 30 or
                now - quote.answer_updated_at > self.quote_policy.max_answer_age_seconds):
            raise GasBudgetError('gas_settlement_quote_stale')
        if witnessed_quote is not None:
            if (type(witnessed_quote) is not dict or
                    set(witnessed_quote) != {'answerRaw', 'roundId', 'answerUpdatedAt',
                                             'blockNumber', 'blockHash', 'blockTimestamp'} or
                    any(type(witnessed_quote[key]) is not int for key in
                        ('answerRaw', 'roundId', 'answerUpdatedAt', 'blockNumber', 'blockTimestamp')) or
                    type(witnessed_quote['blockHash']) is not str or
                    not re.fullmatch(r'0x[0-9a-f]{64}', witnessed_quote['blockHash'])):
                raise GasBudgetError('gas_settlement_quote_invalid')
            # This response is only an IPC hint. SQL compares it with the row
            # independently written by the reservation/oracle peer.
            answer_raw = witnessed_quote['answerRaw']
            round_id = witnessed_quote['roundId']
            answer_updated_at = witnessed_quote['answerUpdatedAt']
            block_timestamp = witnessed_quote['blockTimestamp']
        else:
            answer_raw = quote.answer_raw
            round_id = quote.round_id
            answer_updated_at = quote.answer_updated_at
            block_timestamp = quote.block_timestamp
        try:
            with self.connection.transaction():
                row = self.connection.execute(
                    'SELECT day::text,spent_usd_micros::text,state FROM '
                    'domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)',
                    (cycle_id, leg, actual_total_wei, answer_raw, round_id,
                     answer_updated_at, block_timestamp)).fetchone()
        except psycopg.errors.CheckViolation as error:
            code = error.diag.message_primary
            if code in ('gas_settlement_invalid','gas_reservation_missing','gas_settlement_conflict',
                        'gas_settlement_witness_missing','gas_settlement_witness_invalid',
                        'gas_settlement_finality_missing','gas_settlement_quote_missing'):
                raise GasBudgetError(code) from None
            raise GasBudgetError('gas_budget_unavailable') from None
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None
        return {'day': row[0], 'spentUsdMicros': int(row[1]), 'state': row[2]}

    def status(self, day):
        if type(day) is not str or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
            raise GasBudgetError('gas_budget_day_invalid')
        try:
            with self.connection.transaction():
                row = self.connection.execute(
                    'SELECT cap_usd_micros::text,used_usd_micros::text,remaining_usd_micros::text '
                    'FROM domino_gas_budget.status(%s::date)', (day,)).fetchone()
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None
        return {'capUsdMicros': int(row[0]), 'usedUsdMicros': int(row[1]),
                'remainingUsdMicros': int(row[2])}

    def authorized(self, cycle_id, leg, signer, required_wei):
        """Signer-facing read; the signer must fail closed unless this is true."""
        if (type(cycle_id) is not str or not re.fullmatch(r'0x[0-9a-f]{64}', cycle_id) or
                leg not in ('publisher', 'operator') or
                type(signer) is not str or not re.fullmatch(r'0x[0-9a-f]{40}', signer) or
                type(required_wei) is not int or not 0 < required_wei < 2**128):
            raise GasBudgetError('gas_authorization_invalid')
        try:
            with self.connection.transaction():
                row = self.connection.execute(
                    'SELECT domino_gas_budget.authorized(%s,%s,%s,%s)',
                    (cycle_id,leg,signer,required_wei)).fetchone()
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None
        return row == (True,)

    def require_reservation(self, cycle_id, leg, signer, required_wei):
        """Raise unless a fresh, shared-cap claim covers this exact signer leg."""
        if not self.authorized(cycle_id, leg, signer, required_wei):
            raise GasBudgetError('gas_reservation_not_authorized')

    def require_existing_reservation(self, cycle_id, leg, signer, required_wei):
        """Already signed bytes may be resent while their claim remains pending."""
        if (type(cycle_id) is not str or not re.fullmatch(r'0x[0-9a-f]{64}', cycle_id)
                or leg not in ('publisher', 'operator')
                or type(signer) is not str or not re.fullmatch(r'0x[0-9a-f]{40}', signer)
                or type(required_wei) is not int or not 0 < required_wei < 2**128):
            raise GasBudgetError('gas_authorization_invalid')
        try:
            with self.connection.transaction():
                row = self.connection.execute(
                    'SELECT domino_gas_budget.authorized_existing(%s,%s,%s,%s)',
                    (cycle_id, leg, signer, required_wei)).fetchone()
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None
        if row != (True,):
            raise GasBudgetError('gas_reservation_not_authorized')


class GasBudgetService:
    """Short-lived private connections for the two signer legs.

    Both initial claims commit together. A failed second claim rolls back the
    first, so one cycle never spends the publisher's gas without capacity
    reserved for its operator leg. No connection or RPC endpoint is persisted.
    """

    def __init__(self, settings, rpc, *, connect=psycopg.connect):
        if (type(settings) is not dict or set(settings) != {'host', 'port', 'dbname'}
                or any(type(settings[k]) not in (str, int) for k in settings)):
            raise GasBudgetError('gas_budget_configuration')
        self.settings = dict(settings)
        self.rpc = rpc
        self.connect = connect

    def _connection(self):
        try:
            return self.connect(**self.settings, user='domino_gas_reservation_login',
                connect_timeout=2, options='-c statement_timeout=5000 -c lock_timeout=2000 '
                '-c search_path=pg_catalog -c TimeZone=UTC')
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None

    def health(self):
        """Prove the peer can read its cap and quote both gas-accounting paths.

        This never reserves capacity, writes a claim or returns budget or price
        data across the IPC boundary. A spent daily cap is not a ready signer.
        """
        with read_deadline(7):
            day = datetime.now(ZoneInfo('America/Sao_Paulo')).date().isoformat()
            with self._connection() as conn:
                remaining = GasUsdBudget(conn).status(day)['remainingUsdMicros']
            if remaining <= 0:
                return False
            # Reservations use latest minus confirmations; settlement attests
            # against finalized. A healthy reservation path alone could
            # advertise a signer that cannot settle any receipt.
            EthUsdReader(self.rpc).quote()
            EthUsdReader(self.rpc, finalized=True).quote()
            return True

    def reserve_pair(self, publication_id, publisher, publisher_max_wei,
                     intent_id, operator, operator_max_wei):
        try:
            with self._connection() as conn:
                with conn.transaction():
                    reader = EthUsdReader(self.rpc)
                    budget = GasUsdBudget(conn, reader=reader)
                    quote = reader.quote()
                    pub = budget.reserve(publication_id, 'publisher', publisher,
                                         publisher_max_wei, quote)
                    op = budget.reserve(intent_id, 'operator', operator,
                                        operator_max_wei, quote)
                    return {'publisher': pub, 'operator': op}
        except GasBudgetError:
            raise
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None

    def reserve_one(self, cycle_id, leg, signer, maximum_wei):
        try:
            with self._connection() as conn:
                reader = EthUsdReader(self.rpc)
                budget = GasUsdBudget(conn, reader=reader)
                return budget.reserve(cycle_id, leg, signer, maximum_wei,
                                      reader.quote())
        except GasBudgetError:
            raise
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None

    def attest_settlement_quote(self, cycle_id, leg):
        """Only this keyless reservation/oracle peer may write a settlement quote.

        The caller supplies claim identity alone; the answer comes from this
        peer's independently verified, canonical Chainlink RPC read.
        """
        if (type(cycle_id) is not str or not re.fullmatch(r'0x[0-9a-f]{64}', cycle_id)
                or leg not in ('publisher', 'operator')):
            raise GasBudgetError('gas_settlement_quote_invalid')
        quote = EthUsdReader(self.rpc, finalized=True).quote()
        try:
            with self._connection() as conn:
                row = conn.execute(
                    'SELECT answer_raw::text,round::text,answer_updated_at,block_number,'
                    'block_hash,block_timestamp FROM '
                    'domino_gas_budget.attest_settlement_quote(%s,%s,%s,%s,%s,%s,%s,%s)',
                    (cycle_id, leg, quote.answer_raw, quote.round_id,
                     quote.answer_updated_at, quote.block_number, quote.block_hash,
                     quote.block_timestamp)).fetchone()
        except psycopg.errors.CheckViolation as error:
            if error.diag.message_primary in ('gas_settlement_quote_invalid',
                                              'gas_reservation_missing'):
                raise GasBudgetError(error.diag.message_primary) from None
            raise GasBudgetError('gas_budget_unavailable') from None
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None
        return {'answerRaw': int(row[0]), 'roundId': int(row[1]),
                'answerUpdatedAt': row[2], 'blockNumber': row[3],
                'blockHash': row[4], 'blockTimestamp': row[5]}

    def require_reservation(self, cycle_id, leg, signer, required_wei):
        try:
            with self._connection() as conn:
                GasUsdBudget(conn).require_reservation(cycle_id, leg, signer,
                                                       required_wei)
        except GasBudgetError:
            raise
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None

    def require_existing_reservation(self, cycle_id, leg, signer, required_wei):
        try:
            with self._connection() as conn:
                GasUsdBudget(conn).require_existing_reservation(
                    cycle_id, leg, signer, required_wei)
        except GasBudgetError:
            raise
        except psycopg.Error:
            raise GasBudgetError('gas_budget_unavailable') from None
