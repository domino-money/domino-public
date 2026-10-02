"""The V2 operator's executor: presimulate, cap, journal, sign, send, reconcile.

One executor serves one chain with one operator key (v2_chains, v2_rpc,
v2_head). It never signs bytes a caller hands it as a transaction: it is given
a target among the deployment's contracts (a factory vault or the auto-exit
module) and calldata the planners built (a compound, an exit, or a closed
vault's returnReserves), and it

1. presimulates the exact call from the operator with eth_call at a pinned
   head, then eth_estimateGas, and refuses a revert with the contract's error
   name as a fixed code (#250's lesson, with no publication transaction to
   simulate first: V2 observations are signed off-chain);
2. holds the per-chain gas policy: gas per transaction, fee per gas, cost per
   transaction and a rolling 24-hour spend cap in native wei (V1's US$20 a day
   became one cap per chain, USD-free), and the balance it needs;
3. claims a nonce in the journal and persists the signed bytes before anything
   is sent (V1's design: a claimed nonce is spent only by its own signed
   bytes; nothing that is ambiguous, a restart, a timeout or a lost receipt,
   ever authorizes a new nonce);
4. sends, then reconciles: every attempt's receipt is checked (an earlier
   replacement can win), inclusion is verified field by field, and a receipt
   is final after the configured confirmations. A transaction the node lost
   is re-sent as the same bytes, after the call presimulates again; once its
   deadline is behind the head it is re-sent anyway, so it reverts and spends
   its nonce instead of blocking every later one (8a6e505). A nonce the chain
   spent without one of our receipts stops the signer for an operator to look
   at ('attention'). A stuck transaction is replaced with the same nonce and
   calldata at a higher fee, a bounded number of times, inside the caps.

The journal is a SQLite file per chain and signer, written in the service's
own state directory: one process owns a signer's nonces on a chain, and
SQLite's transactions make each claim, persistence and state change atomic
and durable (synchronous=FULL). It holds public chain data and signed
transactions that are broadcast anyway; never a key.
"""
from dataclasses import dataclass
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

from eth_abi import decode
from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from eth_hash.auto import keccak
from eth_utils import to_checksum_address
from hexbytes import HexBytes

from discovery import DataError, address, bytes32, parse_block, quantity
from rpc_failover import RETRYABLE
from v2_rpc import ChainEndpoints

_LOG = logging.getLogger(__name__)
METHODS = frozenset({'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_getCode', 'eth_call', 'eth_estimateGas',
                     'eth_getBalance', 'eth_sendRawTransaction', 'eth_getTransactionReceipt',
                     'eth_getTransactionByHash', 'eth_getLogs'})
MAX_REVERT_BYTES = 4096
U64 = 2**64 - 1
# What the operator sends: a vault's compound, an auto-exit mandate's exit, and
# a closed vault's returnReserves (IDominoVaultLedger), which pays its owner.
KINDS = ('compound', 'exit', 'return')
# Every custom error a V2 call the operator makes can raise: the frozen
# interfaces' and the implementations' (contracts/src/v2, DominoAutoExit).
# tests/test_v2_executor.py checks each against the Solidity sources.
CONTRACT_ERRORS = (
    'ApprovalFailed(address)', 'AutomationHalted()', 'AutomationUnavailable()', 'BelowMinimum()',
    'DeliveryMismatch(address)', 'DirectCall()', 'ExitModuleNotEnabled()', 'FeeMismatch()', 'FeeNotBacked(address)',
    'FeeRecipientUnavailable()', 'FeeTransferMismatch(address)', 'ForeignSubscriber(address)', 'HookedPool(address)',
    'InsufficientLiquidity(uint128,uint128)', 'InsufficientReserves()', 'InvalidAmount()', 'InvalidAnchor()',
    'InvalidExecution()', 'InvalidFloor()', 'InvalidInit()', 'InvalidInstruction()', 'InvalidMandate()',
    'InvalidObservation()', 'InvalidPlan()', 'InvalidPool()', 'InvalidPosition()',
    'InvalidRange(int24,int24,int24)', 'InvalidRecipient(address)', 'InvalidRoute()', 'MandateAlreadyRegistered()',
    'MandateNotActive()', 'NonceAlreadyUsed()', 'ObservationExpired()', 'ObservationRevoked()',
    'OpenDelta(int256,int256)', 'PartialBurn(uint256,uint128,uint128)', 'PlanExpired()', 'PoolNotInitialized()',
    'PoolUnavailable()', 'PositionPoolMismatch(uint256)', 'ReentrantCall()', 'RootOpen()',
    'SettlementMismatch(address,uint256,uint256)', 'SpotOutsideBand()', 'StaleNonce()', 'StepUnavailable()',
    'SuccessorActive()', 'SwapEffectMismatch()', 'TokenCallFailed(address)', 'TooSoon()', 'TransferFailed(address)',
    'TriggerNotReached()', 'TwapUnavailable()', 'TwapWindowTooShort()', 'Unauthorized()', 'UnexpectedCallback()',
    'VaultOwnerChanged()', 'WrappedError(address,bytes4,bytes,bytes)',
)


def _snake(name):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


ERROR_NAMES = {'0x' + keccak(signature.encode())[:4].hex(): _snake(signature.split('(')[0])
               for signature in CONTRACT_ERRORS}
ERROR_NAMES['0x08c379a0'] = 'error_string'  # Error(string): Uniswap v3's require messages
ERROR_NAMES['0x4e487b71'] = 'panic'


def revert_code(data):
    """A fixed, recordable code for revert data: the contract error's name in
    snake case ([a-z0-9_], #249's lesson), never the node's message."""
    if type(data) is not str or not re.fullmatch(r'0x(?:[0-9a-f]{2})*', data):
        return 'reverted_unknown'
    if len(data) < 10:
        return 'reverted_without_data'
    return 'reverted_' + ERROR_NAMES.get(data[:10], 'unknown_' + data[2:10])


class CallReverted(DataError):
    """The node executed the call and the chain refused it."""
    def __init__(self, data):
        self.data = data
        super().__init__(revert_code(data))


def _revert_data(error):
    """The revert data of a JSON-RPC error that is an execution revert, or None."""
    if type(error) is not dict:
        return None
    code, message, data = error.get('code'), error.get('message'), error.get('data', '0x')
    reverted = (code == 3 or (type(message) is str and message.lower().startswith('execution reverted')))
    if not reverted:
        return None
    if type(data) is dict:  # some nodes nest it
        data = data.get('data', '0x')
    if type(data) is not str or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', data) or len(data) > 2 + 2 * MAX_REVERT_BYTES:
        return '0x'
    return data.lower()


class OperatorRpc:
    """The operator's calls on one chain, through the chain's endpoints (their
    limits, pacing, cooldown and billing counts) with failover on transport
    failures. Reverts and other JSON-RPC errors never fail over: they are the
    chain's answer. Never requests eth_chainId (the profile's id is used)."""

    def __init__(self, endpoints):
        if not isinstance(endpoints, ChainEndpoints):
            raise DataError('v2_chain_endpoints_required')
        self.endpoints, self.chain_id = endpoints, endpoints.chain.chainId

    def request(self, method, params):
        if method not in METHODS:
            raise DataError('v2_operator_method')
        body = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': list(params)}
        failure = None
        for endpoint in self.endpoints.usable():
            try:
                payload = self.endpoints(endpoint.url, body)
            except DataError as error:
                if str(error) in RETRYABLE:
                    failure = error
                    _LOG.warning('v2_operator_failover chain=%s endpoint=%s reason=%s', self.endpoints.chain.key,
                                 endpoint.name, error)
                    continue
                raise
            if (not isinstance(payload, dict) or payload.get('jsonrpc') != '2.0' or payload.get('id') != 1
                    or ('result' in payload) == ('error' in payload)):
                raise DataError('invalid_rpc_envelope')
            if 'error' in payload:
                data = _revert_data(payload['error']) if method in ('eth_call', 'eth_estimateGas') else None
                if data is not None:
                    raise CallReverted(data)
                raise DataError('v2_rpc_error')
            return payload['result']
        raise DataError(str(failure) if failure is not None else 'v2_rpc_endpoints_cooling')

    def block(self, tag='latest'):
        return parse_block(self.request('eth_getBlockByNumber', [tag, False]))

    def header(self, tag='latest'):
        raw = self.request('eth_getBlockByNumber', [tag, False])
        block = parse_block(raw)
        fee = raw.get('baseFeePerGas')
        return block, (None if fee is None else quantity(fee))


# ------------------------------------------------------------------ policy
@dataclass(frozen=True)
class GasPolicy:
    """The operator's gas limits on one chain, all in native wei: an execution
    whose envelope would exceed one waits rather than pays."""
    max_gas: int
    max_fee_per_gas: int
    priority_fee_per_gas: int
    max_cost_wei: int
    daily_cap_wei: int
    min_balance_wei: int
    # The fee ceiling offered: base fee × this / 100 + the tip (V1: twice the base).
    base_fee_multiplier_percent: int = 200
    # A presimulated estimate is raised by this before it becomes the gas limit.
    gas_limit_margin_bps: int = 2000
    confirmations: int = 3
    replace_after_seconds: int = 60
    max_replacements: int = 2
    bump_bps: int = 1250
    enabled: bool = False

    def __post_init__(self):
        values = (self.max_gas, self.max_fee_per_gas, self.max_cost_wei, self.daily_cap_wei)
        if (any(type(v) is not int or not 0 < v < 2**128 for v in values)
                or type(self.priority_fee_per_gas) is not int or not 0 <= self.priority_fee_per_gas <= self.max_fee_per_gas
                or type(self.min_balance_wei) is not int or not 0 <= self.min_balance_wei < 2**128
                or type(self.base_fee_multiplier_percent) is not int or not 100 <= self.base_fee_multiplier_percent <= 1000
                or type(self.gas_limit_margin_bps) is not int or not 0 <= self.gas_limit_margin_bps <= 10_000
                or type(self.confirmations) is not int or not 0 <= self.confirmations <= 1000
                or type(self.replace_after_seconds) is not int or not 1 <= self.replace_after_seconds <= 3600
                or type(self.max_replacements) is not int or not 0 <= self.max_replacements <= 5
                or type(self.bump_bps) is not int or not 1000 <= self.bump_bps <= 10_000
                or type(self.enabled) is not bool or self.max_cost_wei > self.daily_cap_wei):
            raise DataError('v2_invalid_gas_policy')

    def fees(self, base_fee):
        """(maxFeePerGas, maxPriorityFeePerGas) for a block's base fee, inside the caps."""
        if base_fee is None:
            raise DataError('v2_base_fee_unavailable')
        fee = min(self.max_fee_per_gas, base_fee * self.base_fee_multiplier_percent // 100 + self.priority_fee_per_gas)
        if fee < base_fee + self.priority_fee_per_gas:
            raise DataError('v2_gas_price_above_cap')  # not includable now: wait
        return fee, self.priority_fee_per_gas

    def gas_limit(self, estimate):
        limit = estimate * (10_000 + self.gas_limit_margin_bps) // 10_000
        if estimate <= 0 or limit > self.max_gas:
            raise DataError('v2_gas_above_cap')
        return limit


# ---------------------------------------------------------------- signing
def envelope(chain_id, nonce, to, data, gas, max_fee, priority):
    return {'chainId': chain_id, 'nonce': nonce, 'type': 2, 'to': address(to), 'value': 0, 'data': data,
            'gas': gas, 'maxFeePerGas': max_fee, 'maxPriorityFeePerGas': priority, 'accessList': []}


def verify_signed(raw, expected, signer, digest):
    """The signed bytes are exactly the envelope, from the signer (V1's boundary)."""
    try:
        decoded = TypedTransaction.from_bytes(HexBytes(raw)).as_dict()
        normalized = {**expected, 'to': bytes.fromhex(expected['to'][2:]), 'data': bytes.fromhex(expected['data'][2:]),
                      'accessList': ()}
        if (Account.recover_transaction(raw).lower() != signer or '0x' + keccak(raw).hex() != digest
                or any(decoded.get(key) != value for key, value in normalized.items())
                or set(decoded) != set(normalized) | {'v', 'r', 's'} or expected['type'] != 2
                or expected['value'] != 0):
            raise ValueError()
    except Exception:
        raise DataError('v2_signature_mismatch') from None


class OperatorKey:
    """The operator's key, held by the executor alone."""

    def __init__(self, key):
        if type(key) is not bytes or len(key) != 32:
            raise DataError('v2_operator_key_invalid')
        self._account = Account.from_key(key)
        self.address = self._account.address.lower()

    def __repr__(self):
        return f'OperatorKey(address={self.address!r})'

    def sign(self, tx):
        signed = self._account.sign_transaction({**tx, 'to': to_checksum_address(tx['to'])})
        raw = bytes(signed.raw_transaction)
        digest = '0x' + keccak(raw).hex()
        verify_signed(raw, tx, self.address, digest)
        return raw, digest


# ---------------------------------------------------------------- journal
UNRESOLVED = ('signing', 'signed', 'submitted', 'broadcast_unknown', 'included')
# 'attention' stops the signer until an operator, having looked at the chain,
# acknowledges it (`v2_automation.py acknowledge`).
FINAL = ('confirmed', 'reverted', 'attention', 'acknowledged')
STATES = UNRESOLVED + FINAL
DAY = 86400


def intent_id(chain_id, kind, target, data, subject):
    """One intent per call and subject. A compound's subject is its plan hash and an
    exit's its mandate hash, both bound to the calldata already; a returnReserves
    call has the same calldata on every pass, and its subject (v2_plan.return_subject)
    tells one pass's return from the next."""
    return '0x' + keccak(f'{chain_id}:{kind}:{address(target)}:{data}:{subject}'.encode()).hex()


class Journal:
    """Nonce claims, signed attempts and outcomes of one signer on one chain."""

    SCHEMA = (
        'CREATE TABLE IF NOT EXISTS heads (chain_id INTEGER NOT NULL, signer TEXT NOT NULL, next_nonce INTEGER NOT NULL,'
        ' PRIMARY KEY (chain_id, signer))',
        'CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, signer TEXT NOT NULL,'
        ' kind TEXT NOT NULL, target TEXT NOT NULL, subject TEXT NOT NULL, data TEXT NOT NULL,'
        ' deadline INTEGER NOT NULL, nonce INTEGER NOT NULL, gas INTEGER NOT NULL, envelope TEXT NOT NULL,'
        ' state TEXT NOT NULL, reason TEXT NOT NULL, reserved_wei TEXT NOT NULL, spent_wei TEXT,'
        ' effect TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL, UNIQUE (chain_id, signer, nonce))',
        'CREATE TABLE IF NOT EXISTS attempts (intent_id TEXT NOT NULL REFERENCES intents(id), ordinal INTEGER NOT NULL,'
        ' tx_hash TEXT NOT NULL UNIQUE, raw BLOB NOT NULL, envelope TEXT NOT NULL, sent_at REAL,'
        ' PRIMARY KEY (intent_id, ordinal))',
        # Why each vault and mandate waits: the last decision, since when it has
        # held (the first pass that gave it), and the last presimulation that
        # reverted (owner decision, 2 Oct: "Waiting: …").
        "CREATE TABLE IF NOT EXISTS waiting (chain_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN"
        " ('vault', 'mandate')), subject TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,"
        ' block INTEGER NOT NULL, revert TEXT, revert_at INTEGER, revert_block INTEGER,'
        ' since INTEGER NOT NULL, since_block INTEGER NOT NULL,'
        ' PRIMARY KEY (chain_id, kind, subject))',
    )

    def __init__(self, path, chain_id, signer, *, clock=time.time):
        path = Path(path)
        if not path.is_absolute():
            raise DataError('v2_journal_path')
        parent = path.parent
        info = os.stat(parent)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise DataError('v2_journal_directory_not_private')
        self.path, self.chain_id, self.signer, self.clock = path, chain_id, address(signer), clock
        self._db = sqlite3.connect(str(path), isolation_level=None, timeout=5)
        self._db.execute('PRAGMA journal_mode=WAL')
        self._db.execute('PRAGMA synchronous=FULL')
        self._db.execute('PRAGMA foreign_keys=ON')
        for statement in self.SCHEMA:
            self._db.execute(statement)
        # A journal written before `since` was recorded: each row's reason has
        # held since its last pass, at least.
        columns = {row[1] for row in self._db.execute('PRAGMA table_info(waiting)').fetchall()}
        if 'since' not in columns:
            with self._tx():
                self._db.execute('ALTER TABLE waiting ADD COLUMN since INTEGER NOT NULL DEFAULT 0')
                self._db.execute('ALTER TABLE waiting ADD COLUMN since_block INTEGER NOT NULL DEFAULT 0')
                self._db.execute('UPDATE waiting SET since=at, since_block=block')
        os.chmod(path, 0o600)

    def close(self):
        self._db.close()

    def _tx(self):
        return _Transaction(self._db)

    @staticmethod
    def _row(cursor, row):
        return {column[0]: value for column, value in zip(cursor.description, row)}

    def intent(self, identifier):
        cursor = self._db.execute('SELECT * FROM intents WHERE id=?', (identifier,))
        row = cursor.fetchone()
        if row is None:
            raise DataError('v2_intent_not_found')
        intent = self._row(cursor, row)
        cursor = self._db.execute('SELECT * FROM attempts WHERE intent_id=? ORDER BY ordinal', (identifier,))
        intent['attempts'] = [self._row(cursor, item) for item in cursor.fetchall()]
        intent['envelope'] = json.loads(intent['envelope'])
        for attempt in intent['attempts']:
            attempt['envelope'] = json.loads(attempt['envelope'])
        return intent

    def unresolved(self):
        cursor = self._db.execute('SELECT id FROM intents WHERE chain_id=? AND signer=? AND state IN (%s) ORDER BY nonce'
                                  % ','.join('?' * len(UNRESOLVED)), (self.chain_id, self.signer, *UNRESOLVED))
        return [row[0] for row in cursor.fetchall()]

    def attention(self):
        cursor = self._db.execute("SELECT id FROM intents WHERE chain_id=? AND signer=? AND state='attention'",
                                  (self.chain_id, self.signer))
        return [row[0] for row in cursor.fetchall()]

    def spent_today(self, now):
        """Native wei committed in the last 24 hours: what was paid, else what is reserved."""
        cursor = self._db.execute('SELECT reserved_wei, spent_wei FROM intents WHERE chain_id=? AND signer=?'
                                  ' AND created_at>?', (self.chain_id, self.signer, now - DAY))
        return sum(int(spent) if spent is not None else int(reserved) for reserved, spent in cursor.fetchall())

    def claim(self, *, kind, target, subject, data, deadline, gas, max_fee, priority, chain_counts, daily_cap):
        """A new intent with the next nonce, or a refusal. One unresolved intent
        per signer: a new nonce is never claimed behind an ambiguous one."""
        identifier = intent_id(self.chain_id, kind, target, data, subject)
        now = self.clock()
        reserved = gas * max_fee
        with self._tx():
            if self.unresolved():
                raise DataError('v2_intent_in_flight')
            if self.attention():
                raise DataError('v2_signer_needs_attention')
            if self._db.execute('SELECT 1 FROM intents WHERE id=?', (identifier,)).fetchone():
                raise DataError('v2_intent_exists')
            if self.spent_today(now) + reserved > daily_cap:
                raise DataError('v2_daily_gas_cap')
            row = self._db.execute('SELECT next_nonce FROM heads WHERE chain_id=? AND signer=?',
                                   (self.chain_id, self.signer)).fetchone()
            nonce = max([row[0] if row else 0, *chain_counts])
            if nonce >= U64:
                raise DataError('v2_nonce_exhausted')
            tx = envelope(self.chain_id, nonce, target, data, gas, max_fee, priority)
            self._db.execute('INSERT INTO intents (id, chain_id, signer, kind, target, subject, data, deadline, nonce,'
                             ' gas, envelope, state, reason, reserved_wei, created_at, updated_at)'
                             " VALUES (?,?,?,?,?,?,?,?,?,?,?,'signing','',?,?,?)",
                             (identifier, self.chain_id, self.signer, kind, address(target), subject, data, deadline,
                              nonce, gas, json.dumps(tx), str(reserved), now, now))
            self._db.execute('INSERT INTO heads (chain_id, signer, next_nonce) VALUES (?,?,?) ON CONFLICT'
                             ' (chain_id, signer) DO UPDATE SET next_nonce=max(next_nonce, excluded.next_nonce)',
                             (self.chain_id, self.signer, nonce + 1))
        return identifier

    def persist(self, identifier, raw, digest, tx):
        """Signed bytes, stored before they can be sent."""
        now = self.clock()
        with self._tx():
            intent = self.intent(identifier)
            if intent['state'] not in ('signing', 'signed', 'submitted', 'broadcast_unknown'):
                raise DataError('v2_intent_state_conflict')
            if any(a['tx_hash'] == digest for a in intent['attempts']):
                return
            self._db.execute('INSERT INTO attempts (intent_id, ordinal, tx_hash, raw, envelope) VALUES (?,?,?,?,?)',
                             (identifier, len(intent['attempts']), digest, raw, json.dumps(tx)))
            if intent['state'] == 'signing':
                self._db.execute("UPDATE intents SET state='signed', updated_at=? WHERE id=?", (now, identifier))

    def sent(self, identifier, digest, state):
        now = self.clock()
        with self._tx():
            self._db.execute('UPDATE attempts SET sent_at=? WHERE intent_id=? AND tx_hash=?', (now, identifier, digest))
            self._db.execute("UPDATE intents SET state=?, reason=?, updated_at=? WHERE id=? AND state IN"
                             " ('signed','submitted','broadcast_unknown')",
                             (state, '' if state == 'submitted' else 'broadcast_ambiguous', now, identifier))

    def reserve(self, identifier, wei, daily_cap):
        """Raise an intent's reservation (a replacement's higher fee), inside the daily cap."""
        with self._tx():
            reserved = int(self.intent(identifier)['reserved_wei'])
            if wei <= reserved:
                return True
            if self.spent_today(self.clock()) - reserved + wei > daily_cap:
                return False
            self._db.execute('UPDATE intents SET reserved_wei=? WHERE id=?', (str(wei), identifier))
            return True

    def record_waiting(self, entries, *, at, block):
        """One pass's decisions: (kind, subject, reason, simulation) with
        simulation 'passed', 'reverted' or None (no presimulation ran). `since`
        and `since_block` are the time and block of the first pass that gave the
        subject's current reason: kept while the reason is unchanged, reset to
        this pass when it changes or clears (a pass whose head is earlier than
        the recorded start, after a reorganization, restarts it too). A revert
        stays recorded, with its time and block, until a later presimulation of
        the same subject passes."""
        rows = []
        for kind, subject, reason, simulation in entries:
            if (kind not in ('vault', 'mandate') or not re.fullmatch(r'0x[0-9a-f]{40}|0x[0-9a-f]{64}', subject)
                    or simulation not in (None, 'passed', 'reverted')):
                raise DataError('v2_waiting_invalid')
            # Reasons are fixed codes; anything else is recorded as such, never as text.
            rows.append((kind, subject, reason if re.fullmatch(r'[a-z0-9_]{1,100}', str(reason))
                         else 'unrecognized_reason', simulation))
        with self._tx():
            for kind, subject, reason, simulation in rows:
                # SQLite evaluates every SET expression against the row as it was.
                self._db.execute('INSERT INTO waiting (chain_id, kind, subject, reason, at, block, since, since_block)'
                                 ' VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (chain_id, kind, subject) DO UPDATE SET'
                                 ' since=CASE WHEN waiting.reason=excluded.reason AND waiting.since<=excluded.at'
                                 ' AND waiting.since_block<=excluded.block THEN waiting.since ELSE excluded.at END,'
                                 ' since_block=CASE WHEN waiting.reason=excluded.reason AND waiting.since<=excluded.at'
                                 ' AND waiting.since_block<=excluded.block THEN waiting.since_block'
                                 ' ELSE excluded.block END,'
                                 ' reason=excluded.reason, at=excluded.at, block=excluded.block',
                                 (self.chain_id, kind, subject, reason, at, block, at, block))
                if simulation == 'reverted':
                    self._db.execute('UPDATE waiting SET revert=?, revert_at=?, revert_block=? WHERE chain_id=? AND'
                                     ' kind=? AND subject=?', (reason, at, block, self.chain_id, kind, subject))
                elif simulation == 'passed':
                    self._db.execute('UPDATE waiting SET revert=NULL, revert_at=NULL, revert_block=NULL WHERE'
                                     ' chain_id=? AND kind=? AND subject=?', (self.chain_id, kind, subject))

    def waiting(self):
        """Every recorded subject, as the read API's waiting snapshot lists it."""
        cursor = self._db.execute('SELECT kind, subject, reason, at, block, since, since_block, revert, revert_at,'
                                  ' revert_block FROM waiting WHERE chain_id=? ORDER BY kind, subject', (self.chain_id,))
        result = {'vaults': {}, 'mandates': {}}
        for kind, subject, reason, at, block, since, since_block, revert, revert_at, revert_block in cursor.fetchall():
            result['vaults' if kind == 'vault' else 'mandates'][subject] = {
                'reason': reason, 'since': since, 'sinceBlock': since_block, 'at': at, 'block': block,
                'lastRevert': None if revert is None else {'code': revert, 'at': revert_at, 'block': revert_block}}
        return result

    def acknowledge(self, identifier):
        """An operator looked at an 'attention' intent: the signer may claim again."""
        with self._tx():
            if self.intent(identifier)['state'] != 'attention':
                raise DataError('v2_intent_not_in_attention')
            self._db.execute("UPDATE intents SET state='acknowledged', updated_at=? WHERE id=?",
                             (self.clock(), identifier))

    def set_state(self, identifier, state, reason='', *, spent=None, effect=None):
        if state not in STATES or not re.fullmatch(r'[a-z0-9_]{0,100}', reason):
            raise DataError('v2_intent_state_invalid')
        with self._tx():
            self._db.execute('UPDATE intents SET state=?, reason=?, updated_at=?, spent_wei=coalesce(?, spent_wei),'
                             ' effect=coalesce(?, effect) WHERE id=?',
                             (state, reason, self.clock(), None if spent is None else str(spent),
                              None if effect is None else json.dumps(effect, sort_keys=True), identifier))


class _Transaction:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        if self.db.in_transaction:
            self.nested = True
            return self
        self.nested = False
        self.db.execute('BEGIN IMMEDIATE')
        return self

    def __exit__(self, kind, value, traceback):
        if self.nested:
            return False
        self.db.execute('COMMIT' if kind is None else 'ROLLBACK')
        return False


# --------------------------------------------------------------- executor
@dataclass(frozen=True)
class Outcome:
    intent: str
    state: str
    reason: str = ''


class ChainExecutor:
    """Submits and reconciles the operator's transactions on one chain."""

    def __init__(self, chain, deployment, rpc, key, journal, policy, *, clock=time.time):
        if (not isinstance(rpc, OperatorRpc) or not isinstance(key, OperatorKey) or not isinstance(journal, Journal)
                or not isinstance(policy, GasPolicy) or rpc.chain_id != chain.chainId
                or journal.chain_id != chain.chainId or journal.signer != key.address
                or deployment.chain.chainId != chain.chainId):
            raise DataError('v2_invalid_executor')
        if key.address != deployment.operator:
            raise DataError('v2_operator_not_in_deployment')
        self.chain, self.deployment, self.rpc, self.key = chain, deployment, rpc, key
        self.journal, self.policy, self.clock = journal, policy, clock

    # ------------------------------------------------------------- checks
    def check_signer(self, head):
        """The key is a plain admitted operator with gas: no EIP-7702 code on it
        (whatever runs there was never admitted), the registry's operator, not
        a publisher, and a balance above the floor."""
        if self.rpc.request('eth_getCode', [self.key.address, head.tag]) != '0x':
            raise DataError('v2_operator_has_code')
        registry = self.deployment.registry
        is_operator = self._view(registry, 'isOperator(address)', ['address'], [self.key.address], head)
        is_publisher = self._view(registry, 'isPublisher(address)', ['address'], [self.key.address], head)
        if not is_operator or is_publisher:
            raise DataError('v2_operator_not_admitted')
        balance = quantity(self.rpc.request('eth_getBalance', [self.key.address, head.tag]))
        if balance < self.policy.min_balance_wei:
            raise DataError('v2_operator_balance_low')
        return balance

    def _view(self, target, signature, types, values, head, outputs=('bool',)):
        from eth_abi import encode
        data = '0x' + (keccak(signature.encode())[:4] + encode(types, values)).hex()
        raw = self.rpc.request('eth_call', [{'to': target, 'data': data}, head.tag])
        return decode(list(outputs), bytes.fromhex(raw[2:]))[0]

    # ------------------------------------------------------- presimulation
    def presimulate(self, target, data, head, *, output=False):
        """The exact call from the operator at `head`: its gas limit and estimate,
        and with `output` what the call returned (raw hex), or the contract's
        refusal (CallReverted with the error's code)."""
        call = {'from': self.key.address, 'to': address(target), 'data': data, 'gas': hex(self.policy.max_gas)}
        result = self.rpc.request('eth_call', [call, {'blockHash': head.hash}])
        estimate = quantity(self.rpc.request('eth_estimateGas', [{k: v for k, v in call.items() if k != 'gas'},
                                                                 head.tag]))
        limits = (self.policy.gas_limit(estimate), estimate)
        if not output:
            return limits
        if type(result) is not str or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', result):
            raise DataError('invalid_abi_response')
        return (*limits, result.lower())

    # ---------------------------------------------------------- submission
    def submit(self, *, kind, target, subject, data, deadline, head, base_fee, gas):
        """Claim, sign, persist and send one presimulated call. `gas` is the
        presimulated gas limit."""
        if not self.policy.enabled:
            raise DataError('v2_executor_disabled')
        if kind not in KINDS or not re.fullmatch(r'0x(?:[0-9a-f]{2})+', data):
            raise DataError('v2_invalid_intent')
        # Only the deployment's own targets: the auto-exit module, or a vault its factories created.
        target = address(target)
        if kind == 'exit' and target != self.deployment.auto_exit:
            raise DataError('v2_target_not_admitted')
        if kind in ('compound', 'return') and not any(
                self._view(self.deployment.factory(dex), 'isVault(address)', ['address'], [target], head)
                for dex in (3, 4)):
            raise DataError('v2_target_not_admitted')
        max_fee, priority = self.policy.fees(base_fee)
        if gas > self.policy.max_gas or gas * max_fee > self.policy.max_cost_wei:
            raise DataError('v2_gas_above_cap')
        balance = quantity(self.rpc.request('eth_getBalance', [self.key.address, head.tag]))
        if balance < max(self.policy.min_balance_wei, gas * max_fee):
            raise DataError('v2_operator_balance_low')
        counts = [quantity(self.rpc.request('eth_getTransactionCount', [self.key.address, tag]))
                  for tag in ('pending', 'latest')]
        identifier = self.journal.claim(kind=kind, target=target, subject=subject, data=data, deadline=deadline,
                                        gas=gas, max_fee=max_fee, priority=priority, chain_counts=counts,
                                        daily_cap=self.policy.daily_cap_wei)
        self._sign_and_send(identifier)
        intent = self.journal.intent(identifier)
        return Outcome(identifier, intent['state'], intent['reason'])

    def _sign_and_send(self, identifier, *, tx=None):
        intent = self.journal.intent(identifier)
        tx = tx or intent['envelope']
        raw, digest = self.key.sign(tx)
        self.journal.persist(identifier, raw, digest, tx)
        self._send(identifier, raw, digest)

    def _send(self, identifier, raw, digest):
        try:
            reply = self.rpc.request('eth_sendRawTransaction', ['0x' + raw.hex()])
            state = 'submitted' if type(reply) is str and reply.lower() == digest else 'broadcast_unknown'
        except DataError:
            state = 'broadcast_unknown'
        self.journal.sent(identifier, digest, state)

    # ------------------------------------------------------- reconciliation
    def reconcile(self, identifier, *, requalify=True):
        """One bounded look at an intent; returns its Outcome."""
        intent = self.journal.intent(identifier)
        if intent['state'] in FINAL:
            return Outcome(identifier, intent['state'], intent['reason'])
        if intent['state'] == 'signing' or not intent['attempts']:
            # Claimed but not persisted: sign the same envelope (RFC 6979 gives the same bytes).
            self._sign_and_send(identifier)
            intent = self.journal.intent(identifier)
        head, base_fee = self.rpc.header('latest')
        for attempt in reversed(intent['attempts']):
            receipt = self.rpc.request('eth_getTransactionReceipt', [attempt['tx_hash']])
            if receipt is None:
                continue
            return self._receipt(intent, attempt, receipt, head)
        spent = quantity(self.rpc.request('eth_getTransactionCount', [self.key.address, head.tag]))
        if spent > intent['nonce']:
            # A load-balanced provider can show the nonce before the receipt:
            # look once more before deciding no attempt of ours spent it.
            for attempt in intent['attempts']:
                if self.rpc.request('eth_getTransactionReceipt', [attempt['tx_hash']]) is not None:
                    return Outcome(identifier, intent['state'], 'receipt_pending')
            self.journal.set_state(identifier, 'attention', 'nonce_consumed_without_receipt')
            return Outcome(identifier, 'attention', 'nonce_consumed_without_receipt')
        last = intent['attempts'][-1]
        known = self.rpc.request('eth_getTransactionByHash', [last['tx_hash']])
        if known is None:
            if head.timestamp <= intent['deadline'] and requalify:
                # The node lost it. Same bytes only, and only if the call still holds.
                try:
                    self.presimulate(intent['target'], intent['data'], head)
                except DataError as error:
                    self.journal.set_state(identifier, intent['state'], 'revalidation_pending')
                    return Outcome(identifier, intent['state'], f'revalidation_pending:{error}')
            # Past its deadline the bytes can only revert and spend the nonce.
            self._send(identifier, bytes(last['raw']), last['tx_hash'])
            intent = self.journal.intent(identifier)
            return Outcome(identifier, intent['state'], 'resent')
        sent_at = last['sent_at'] or intent['updated_at']
        if (self.clock() - sent_at >= self.policy.replace_after_seconds
                and len(intent['attempts']) <= self.policy.max_replacements):
            replaced = self._replacement(intent, last, base_fee)
            if replaced is not None and self.journal.reserve(identifier, replaced['gas'] * replaced['maxFeePerGas'],
                                                              self.policy.daily_cap_wei):
                self._sign_and_send(identifier, tx=replaced)
                return Outcome(identifier, self.journal.intent(identifier)['state'], 'replaced')
        return Outcome(identifier, intent['state'], 'pending')

    def _replacement(self, intent, last, base_fee):
        """Same nonce, calldata and gas; fees bumped by bump_bps, inside the caps."""
        old = last['envelope']
        bump = 10_000 + self.policy.bump_bps
        fee = max(old['maxFeePerGas'] + 1, -(-old['maxFeePerGas'] * bump // 10_000))
        priority = max(old['maxPriorityFeePerGas'] + 1, -(-old['maxPriorityFeePerGas'] * bump // 10_000))
        if base_fee is not None:
            fee = max(fee, base_fee + priority)
        if (fee > self.policy.max_fee_per_gas or priority > fee or old['gas'] * fee > self.policy.max_cost_wei):
            return None
        return {**old, 'maxFeePerGas': fee, 'maxPriorityFeePerGas': priority}

    def _receipt(self, intent, attempt, receipt, head):
        identifier = intent['id']
        block_number = quantity(receipt.get('blockNumber'))
        block = self.rpc.block(hex(block_number))
        if bytes32(receipt.get('blockHash')) != block.hash:
            return Outcome(identifier, intent['state'], 'receipt_not_canonical')
        tx = self.rpc.request('eth_getTransactionByHash', [attempt['tx_hash']])
        expected = attempt['envelope']
        if (type(tx) is not dict or bytes32(receipt.get('transactionHash')) != attempt['tx_hash']
                or address(receipt.get('from')) != self.key.address or address(receipt.get('to') or '0x' + '00' * 20)
                != expected['to'] or quantity(tx.get('nonce')) != intent['nonce']
                or (tx.get('input') or tx.get('data') or '').lower() != expected['data']):
            self.journal.set_state(identifier, 'attention', 'receipt_identity_mismatch')
            return Outcome(identifier, 'attention', 'receipt_identity_mismatch')
        if head.number - block_number + 1 < self.policy.confirmations:
            if intent['state'] != 'included':
                self.journal.set_state(identifier, 'included', 'awaiting_confirmations')
            return Outcome(identifier, 'included', 'awaiting_confirmations')
        gas_used = quantity(receipt.get('gasUsed'))
        price = quantity(receipt.get('effectiveGasPrice'))
        l1_fee = quantity(receipt['l1Fee']) if receipt.get('l1Fee') not in (None, '0x') else 0
        spent = gas_used * price + l1_fee
        effect = {'transactionHash': attempt['tx_hash'], 'blockNumber': block_number, 'blockHash': block.hash,
                  'gasUsed': gas_used, 'effectiveGasPrice': price, 'l1Fee': l1_fee,
                  'logs': [_log_record(log) for log in receipt.get('logs') or []]}
        if quantity(receipt.get('status')) != 1:
            self.journal.set_state(identifier, 'reverted', 'reverted_on_chain', spent=spent, effect=effect)
            return Outcome(identifier, 'reverted', 'reverted_on_chain')
        self.journal.set_state(identifier, 'confirmed', '', spent=spent, effect=effect)
        return Outcome(identifier, 'confirmed')

    def reconcile_all(self):
        return [self.reconcile(identifier) for identifier in self.journal.unresolved()]


def _log_record(log):
    return {'address': address(log['address']), 'topics': [bytes32(topic) for topic in log['topics']],
            'data': log['data'].lower(), 'logIndex': quantity(log['logIndex'])}
