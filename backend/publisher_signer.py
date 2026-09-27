"""Restricted price publisher: one registered call, one admitted guard, a
journal that holds the signed bytes before anything is sent.

The signer builds publish(Observation) for the guard it was configured with
and nothing else; it receives points, never envelopes or calldata. Every
publication row is written with its signature inside the same transaction, so
a crash after signing leaves either nothing or a re-sendable record, and a
restart re-sends those bytes instead of publishing twice. The row's key is the
id the guard will assign to that exact point, which is how two cycles on the
same pool and block share one transaction and how the intent binds its anchor
before the publisher spends anything. A nonce gets one signed transaction:
while the chain has not spent it, the journal sends those bytes again before
it claims another nonce, even for a row it retired as expired.
"""
from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from eth_account import Account
from eth_hash.auto import keccak
from eth_utils import to_checksum_address

import general_compound_receipts as g
from automation_plan import PRICE_OBSERVED, observation_id, publish_calldata
from execution_signer import ExecutionError, verify_signed
from execution_store import ExecutionStoreError, _hash
from gas_receipt_settlement import GasReceiptSettlement, GasSettlementError

PUBLISHER_ROLE = 'domino_execution_publisher'
LIVE = ('signed', 'submitted', 'broadcast_unknown', 'reorged')
# An expired row never had a receipt: while the chain has not spent its nonce,
# its bytes are still the only ones signed for that nonce.
HOLDING = LIVE + ('expired',)


class _PublisherReceiptProbe(GasReceiptSettlement):
    """Reuse the canonical receipt verifier without a settlement DB login."""
    def __init__(self, rpc):
        self.rpc = rpc


@dataclass(frozen=True)
class PublisherPolicy:
    max_gas: int
    max_fee_per_gas: int
    priority_fee_per_gas: int
    max_total_cost: int
    expiry_seconds: int
    enabled: bool = False

    def __post_init__(self):
        if (any(type(v) is not int or not 0 < v < 2**128 for v in (self.max_gas, self.max_fee_per_gas, self.priority_fee_per_gas, self.max_total_cost))
                or self.priority_fee_per_gas > self.max_fee_per_gas or type(self.expiry_seconds) is not int
                or not 1 <= self.expiry_seconds <= 3600 or type(self.enabled) is not bool):
            raise ExecutionError('publisher_policy')


def point_record(point):
    pool, number, block_hash, timestamp, expires, price = point
    if (type(pool) is not bytes or len(pool) != 32 or type(block_hash) is not bytes or len(block_hash) != 32
            or any(type(v) is not int for v in (number, timestamp, expires, price)) or not 0 <= number < 2**64
            or not 0 <= timestamp < expires < 2**64 or not 0 < price < 2**160 or not any(pool) or not any(block_hash)):
        raise ExecutionError('publisher_invalid_point')
    return {'poolId': '0x' + pool.hex(), 'blockNumber': number, 'blockHash': '0x' + block_hash.hex(),
            'timestamp': timestamp, 'expiresAt': expires, 'sqrtPriceX96': price}


class PublisherSigner:
    def __init__(self, rpc, key, guard, policy, *, gas_budget=None):
        self.rpc = rpc
        self._account = Account.from_key(key)
        self.address = self._account.address.lower()
        self.guard = g._address(guard)
        self.policy = policy
        self.gas_budget = gas_budget

    def qualify(self, point, *, max_source_age):
        """The guard would accept this point now: the key publishes, the id is
        unused, the source block is inside the window, and the exact call
        simulates at the head to the id this process computed offline."""
        if not self.policy.enabled:
            raise ExecutionError('publisher_disabled')
        record = point_record(point)
        if g._quantity(self.rpc.request('eth_chainId', [])) != 4663:
            raise ExecutionError('execution_wrong_chain')
        head = g._header(self.rpc.request('eth_getBlockByNumber', ['latest', False]))
        identifier = observation_id(self.guard, point)
        def call(target, signature, outputs, inputs=(), values=()):
            data = '0x' + (keccak(signature.encode())[:4] + g.encode(list(inputs), list(values))).hex()
            return g._abi(list(outputs), self.rpc.request('eth_call', [{'to': target, 'data': data, 'gas': hex(500000)},
                                                                       {'blockHash': head['hash'], 'requireCanonical': True}]))
        if call(self.guard, 'publisher()', ['address'])[0] != self.address:
            raise ExecutionError('publisher_not_current')
        # Same rule as the operator: code on the publisher's account means its
        # key signed an EIP-7702 authorization. Publish nothing through it.
        if self.rpc.request('eth_getCode', [self.address, {'blockHash': head['hash'], 'requireCanonical': True}]) != '0x':
            raise ExecutionError('publisher_account_has_code')
        stored = call(self.guard, 'observations(bytes32)', ['bytes32', 'uint64', 'bytes32', 'uint64', 'uint64', 'uint160'], ['bytes32'], [bytes.fromhex(identifier[2:])])
        if stored[5] != 0 or call(self.guard, 'revoked(bytes32)', ['bool'], ['bytes32'], [bytes.fromhex(identifier[2:])])[0]:
            raise ExecutionError('publisher_observation_exists')
        age = head['number'] - record['blockNumber']
        if not 0 < age <= max_source_age or record['expiresAt'] <= head['timestamp'] or record['timestamp'] > head['timestamp']:
            raise ExecutionError('publisher_source_window')
        source = g._header(self.rpc.request('eth_getBlockByNumber', [hex(record['blockNumber']), False]))
        if source['hash'] != record['blockHash'] or source['timestamp'] != record['timestamp']:
            raise ExecutionError('publisher_source_reorg')
        data = publish_calldata(point)
        request = {'from': self.address, 'to': self.guard, 'data': data, 'value': '0x0', 'gas': hex(self.policy.max_gas)}
        try:
            simulated = g._abi(['bytes32'], self.rpc.request('eth_call', [request, {'blockHash': head['hash'], 'requireCanonical': True}]))[0]
            estimated = g._quantity(self.rpc.request('eth_estimateGas', [request, hex(head['number'])]))
        except Exception:
            raise ExecutionError('publisher_simulation_failed') from None
        if '0x' + simulated.hex() != identifier:
            raise ExecutionError('publisher_simulation_mismatch')
        if estimated > self.policy.max_gas:
            raise ExecutionError('execution_gas_budget')
        return identifier, head

    def envelope(self, point, nonce, *, fee=None, priority=None):
        if type(nonce) is not int or not 0 <= nonce < 2**64 - 1:
            raise ExecutionError('publisher_invalid_nonce')
        base = g._quantity(self.rpc.request('eth_getBlockByNumber', ['latest', False]).get('baseFeePerGas'))
        fee = min(self.policy.max_fee_per_gas, 2 * base + self.policy.priority_fee_per_gas) if fee is None else fee
        priority = self.policy.priority_fee_per_gas if priority is None else priority
        if fee > self.policy.max_fee_per_gas or priority > fee or self.policy.max_gas * fee > self.policy.max_total_cost:
            raise ExecutionError('execution_gas_budget')
        if g._quantity(self.rpc.request('eth_getBalance', [self.address, 'latest'])) < self.policy.max_gas * fee:
            raise ExecutionError('execution_gas_balance')
        return {'chainId': 4663, 'nonce': nonce, 'type': 2, 'to': self.guard, 'value': 0, 'data': publish_calldata(point),
                'gas': self.policy.max_gas, 'maxFeePerGas': fee, 'maxPriorityFeePerGas': priority, 'accessList': []}

    def sign(self, point, envelope):
        # Rebuild from the point: the key boundary never signs a handed envelope.
        expected = self.envelope(point, envelope['nonce'], fee=envelope['maxFeePerGas'], priority=envelope['maxPriorityFeePerGas'])
        if envelope != expected:
            raise ExecutionError('execution_envelope_changed')
        if self.gas_budget is None:
            raise ExecutionError('publisher_gas_reservation_required')
        try:
            self.gas_budget.require_reservation(
                observation_id(self.guard, point), 'publisher', self.address,
                envelope['gas'] * envelope['maxFeePerGas'])
        except Exception:
            raise ExecutionError('publisher_gas_reservation_required') from None
        signed = self._account.sign_transaction({**envelope, 'to': to_checksum_address(envelope['to'])})
        raw = bytes(signed.raw_transaction)
        digest = '0x' + keccak(raw).hex()
        verify_signed(raw, envelope, self.address, digest)
        return raw, digest


class PublicationJournal:
    """The publisher role's own store: no tenant owner, no plan, no key."""
    def __init__(self, settings, *, gas_budget=None, connect=psycopg.connect):
        if type(settings) is not dict or set(settings) != {'host', 'port', 'dbname'}:
            raise ValueError('invalid_execution_database_settings')
        self.settings, self.connect, self.gas_budget = dict(settings), connect, gas_budget

    def _transaction(self, operation):
        try:
            with self.connect(**self.settings, user=PUBLISHER_ROLE, row_factory=dict_row, connect_timeout=2,
                    options='-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=60000 '
                            '-c search_path=domino_execution -c TimeZone=UTC') as conn:
                return operation(conn)
        except psycopg.errors.UniqueViolation:
            raise ExecutionStoreError('execution_reservation_conflict') from None
        except psycopg.errors.CheckViolation as error:
            raise ExecutionStoreError(error.diag.message_primary) from None
        except psycopg.Error:
            raise ExecutionStoreError('execution_store_unavailable') from None

    @staticmethod
    def _row(conn, identifier, *, lock=False):
        row = conn.execute('SELECT * FROM publications WHERE observation_id=%s' + (' FOR UPDATE' if lock else ''), (identifier,)).fetchone()
        if row is None:
            raise ExecutionStoreError('execution_not_found')
        return row

    @staticmethod
    def _status(row):
        return {'observationId': row['observation_id'], 'guard': row['guard'], 'poolId': row['pool_id'],
                'blockNumber': int(row['block_number']), 'blockHash': row['block_hash'], 'blockTimestamp': int(row['block_timestamp']),
                'expiresAt': int(row['expires_at']), 'sqrtPriceX96': str(row['sqrt_price']), 'signer': row['signer'],
                'nonceRaw': str(row['nonce']), 'transactionHash': row['transaction_hash'], 'state': row['state'], 'reason': row['reason'],
                'includedBlockNumber': int(row['included_block_number']) if row['included_block_number'] is not None else None,
                'includedBlockHash': row['included_block_hash'],
                'gasUsedRaw': str(row['gas_used']) if row['gas_used'] is not None else None,
                'effectiveGasPriceRaw': str(row['effective_gas_price']) if row['effective_gas_price'] is not None else None}

    def status(self, identifier):
        identifier = _hash(identifier)
        return self._transaction(lambda conn: self._status(self._row(conn, identifier)))

    def settlement_record(self, identifier):
        """Private full journal row for canonical gas receipt reconciliation."""
        identifier = _hash(identifier)
        return self._transaction(lambda conn: self._row(conn, identifier))

    def prepare(self, signer, point, *, max_source_age, fee=None):
        """Qualify, claim the next nonce, sign and persist in one transaction.
        An existing row for this id is returned as is: same point, same bytes.
        Earlier nonces the chain still waits for go out first (resend_unspent),
        so no nonce is claimed behind a gap this journal's own bytes can close.

        `fee` is the fee ceiling the caller reserved the claim at. The base fee
        moves with nearly every 100 ms block: an envelope priced from a later
        read may cost more than the claim covers, and the signer refuses it."""
        record = point_record(point)
        identifier = observation_id(signer.guard, point)
        self.resend_unspent(signer.address, signer.rpc)
        def operation(conn):
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (identifier,))
            existing = conn.execute('SELECT * FROM publications WHERE observation_id=%s', (identifier,)).fetchone()
            if existing:
                return self._status(existing)
            signer.qualify(point, max_source_age=max_source_age)
            pending = g._quantity(signer.rpc.request('eth_getTransactionCount', [signer.address, 'pending']))
            latest = g._quantity(signer.rpc.request('eth_getTransactionCount', [signer.address, 'latest']))
            conn.execute('INSERT INTO publisher_heads(chain_id,signer,next_nonce) VALUES(4663,%s,%s) ON CONFLICT DO NOTHING', (signer.address, max(pending, latest)))
            head = conn.execute('SELECT next_nonce FROM publisher_heads WHERE chain_id=4663 AND signer=%s FOR UPDATE', (signer.address,)).fetchone()
            nonce = max(int(head['next_nonce']), pending, latest)
            if nonce >= 2**64 - 1:
                raise ExecutionError('execution_nonce_exhausted')
            envelope = signer.envelope(point, nonce, fee=fee)
            raw, digest = signer.sign(point, envelope)
            conn.execute('UPDATE publisher_heads SET next_nonce=greatest(next_nonce,%s) WHERE chain_id=4663 AND signer=%s', (nonce + 1, signer.address))
            row = conn.execute('INSERT INTO publications(observation_id,guard,pool_id,block_number,block_hash,block_timestamp,expires_at,sqrt_price,'
                               "signer,nonce,envelope,signed_bytes,transaction_hash,state) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'signed') RETURNING *",
                               (identifier, signer.guard, record['poolId'], record['blockNumber'], record['blockHash'], record['timestamp'],
                                record['expiresAt'], record['sqrtPriceX96'], signer.address, nonce, Jsonb(envelope), raw, digest)).fetchone()
            return self._status(row)
        return self._transaction(operation)

    def send(self, identifier, rpc):
        """Re-send the persisted bytes while the row is live; a timeout is ambiguous, never a retry with new bytes."""
        return self._send(_hash(identifier), rpc, LIVE)

    def resend_unspent(self, signer_address, rpc):
        """Send again the bytes of every row holding a nonce the chain has not
        spent and the node does not hold. A node can drop a transaction it
        accepted, and a check may then retire the row as expired; the nonce
        stays unspent either way, and every later publication of the key waits
        behind it. Only the same bytes, never a second signature for that
        nonce: a late publication reverts at the guard, and its nonce is spent.
        An expired row sent again is live until its receipt."""
        signer_address = g._address(signer_address)
        pending = g._quantity(rpc.request('eth_getTransactionCount', [signer_address, 'pending']))
        latest = g._quantity(rpc.request('eth_getTransactionCount', [signer_address, 'latest']))
        held = self._transaction(lambda conn: [r['observation_id'] for r in conn.execute(
            'SELECT observation_id FROM publications WHERE signer=%s AND nonce>=%s AND state=ANY(%s) ORDER BY nonce',
            (signer_address, max(pending, latest), list(HOLDING))).fetchall()])
        return [self._send(identifier, rpc, HOLDING) for identifier in held]

    def _send(self, identifier, rpc, states):
        def operation(conn):
            row = self._row(conn, identifier, lock=True)
            if row['state'] not in states:
                return self._status(row)
            # A restart may resend a row signed before this cap existed. Such a
            # row has no counted claim and must fail closed. A valid pending
            # claim remains counted even when its new-signature gate is stale.
            if self.gas_budget is None:
                raise ExecutionError('publisher_gas_reservation_required')
            try:
                envelope = row['envelope']
                self.gas_budget.require_existing_reservation(
                    identifier, 'publisher', row['signer'],
                    envelope['gas'] * envelope['maxFeePerGas'])
            except Exception:
                raise ExecutionError('publisher_gas_reservation_required') from None
            raw = bytes(row['signed_bytes'])
            verify_signed(raw, row['envelope'], row['signer'], row['transaction_hash'])
            try:
                reply = rpc.request('eth_sendRawTransaction', ['0x' + raw.hex()])
                state = 'submitted' if g._hash(reply) == row['transaction_hash'] else 'broadcast_unknown'
            except Exception:
                state = 'broadcast_unknown'
            row = conn.execute('UPDATE publications SET state=%s,reason=%s,updated_at=clock_timestamp() WHERE observation_id=%s RETURNING *',
                               (state, '' if state == 'submitted' else 'publication_broadcast_ambiguous', identifier)).fetchone()
            return self._status(row)
        return self._transaction(operation)

    def check(self, identifier, rpc, *, confirmations):
        """Reconcile the row with the chain: inclusion with the guard's own
        PriceObserved id, confirmation depth, revert, loss of the block, or a
        consumed nonce with no receipt."""
        identifier = _hash(identifier)
        def operation(conn):
            row = self._row(conn, identifier, lock=True)
            if row['state'] in ('expired', 'revoked', 'attention') or (
                    row['state'] == 'reverted' and conn.execute(
                        'SELECT 1 FROM publication_finality WHERE observation_id=%s',
                        (identifier,)).fetchone()):
                return self._status(row)
            head = g._header(rpc.request('eth_getBlockByNumber', ['latest', False]))
            receipt = rpc.request('eth_getTransactionReceipt', [row['transaction_hash']])
            state, reason, fields = row['state'], row['reason'], {}
            if type(receipt) is dict:
                number = g._quantity(receipt.get('blockNumber'))
                block = g._header(rpc.request('eth_getBlockByNumber', [hex(number), False]))
                if (block['hash'] != g._hash(receipt.get('blockHash')) or
                        row['state'] in ('included', 'confirmed', 'reverted') and
                        row['included_block_hash'] is not None and row['included_block_hash'] != block['hash']):
                    state, reason = ('reorged', 'publication_block_lost') if row['state'] in ('included', 'confirmed', 'reverted') else (row['state'], row['reason'])
                elif g._quantity(receipt.get('status')) != 1:
                    state, reason = 'reverted', 'publication_reverted'
                else:
                    logs = [log for log in receipt.get('logs', []) if type(log) is dict and g._address(log.get('address')) == row['guard']
                            and log.get('topics') and g._hash(log['topics'][0]) == PRICE_OBSERVED]
                    if len(logs) != 1 or len(logs[0]['topics']) != 3 or g._hash(logs[0]['topics'][1]) != identifier:
                        state, reason = 'attention', 'publication_event_mismatch'
                    else:
                        depth = head['number'] - number
                        state, reason = ('confirmed' if depth >= confirmations else 'included'), ''
                fields = {'included_block_number': number, 'included_block_hash': block['hash'],
                          'gas_used': g._quantity(receipt.get('gasUsed')), 'effective_gas_price': g._quantity(receipt.get('effectiveGasPrice'))}
                if state == 'reorged':
                    fields = {}
            else:
                # The nonce is read at the head that was read before the
                # receipt. Read at the latest block, it would count this very
                # transaction if it was mined between the two reads, and report
                # a nonce spent by someone else.
                if row['state'] in ('included', 'confirmed', 'reverted'):
                    state, reason = 'reorged', 'publication_block_lost'
                elif g._quantity(rpc.request('eth_getTransactionCount', [row['signer'], {'blockHash': head['hash'], 'requireCanonical': True}])) > int(row['nonce']):
                    state, reason = 'attention', 'publication_nonce_consumed_without_receipt'
                elif head['timestamp'] >= int(row['expires_at']):
                    state, reason = 'expired', 'publication_expired_before_inclusion'
            if state == row['state'] and reason == row['reason'] and not fields:
                return self._status(row)
            sets = ['state=%s', 'reason=%s', 'updated_at=clock_timestamp()'] + [f'{k}=%s' for k in fields]
            row = conn.execute(f'UPDATE publications SET {",".join(sets)} WHERE observation_id=%s RETURNING *',
                               (state, reason, *fields.values(), identifier)).fetchone()
            return self._status(row)
        return self._transaction(operation)

    def pending_finality(self, signer_address, *, limit=8):
        """Rotate durable terminal rows before RPC reads; unavailable old rows cannot starve new ones."""
        signer_address = g._address(signer_address)
        if type(limit) is not int or not 1 <= limit <= 32:
            raise ExecutionError('publisher_finality_limit_invalid')
        def operation(conn):
            conn.execute('INSERT INTO publication_finality_cursor(signer) VALUES(%s) ON CONFLICT DO NOTHING',
                         (signer_address,))
            cursor = conn.execute('SELECT * FROM publication_finality_cursor WHERE signer=%s FOR UPDATE',
                                  (signer_address,)).fetchone()
            marker = (cursor['last_created_at'], cursor['last_observation_id'])
            suffix = conn.execute(
                'SELECT 1 FROM publications p LEFT JOIN publication_finality f USING(observation_id) '
                'WHERE p.signer=%s AND p.state IN (%s,%s) AND f.observation_id IS NULL '
                'AND (p.created_at,p.observation_id)>(%s,%s) LIMIT 1',
                (signer_address, 'confirmed', 'reverted', *marker)).fetchone() if marker[0] else None
            if marker[0] and suffix is None:
                marker = (None, None)
            rows = conn.execute(
                'SELECT p.observation_id,p.created_at FROM publications p '
                'LEFT JOIN publication_finality f USING(observation_id) '
                'WHERE p.signer=%s AND p.state IN (%s,%s) AND f.observation_id IS NULL '
                'AND (%s::timestamptz IS NULL OR (p.created_at,p.observation_id)>(%s,%s)) '
                'ORDER BY p.created_at,p.observation_id LIMIT %s',
                (signer_address, 'confirmed', 'reverted', marker[0], *marker, limit)).fetchall()
            if rows:
                last = rows[-1]
                conn.execute('UPDATE publication_finality_cursor SET last_created_at=%s,'
                    'last_observation_id=%s,updated_at=clock_timestamp() WHERE signer=%s',
                    (last['created_at'], last['observation_id'], signer_address))
            elif marker[0]:
                conn.execute('UPDATE publication_finality_cursor SET last_created_at=NULL,'
                    'last_observation_id=NULL,updated_at=clock_timestamp() WHERE signer=%s',
                    (signer_address,))
            return [row['observation_id'] for row in rows]
        return self._transaction(operation)

    def finalize_receipt(self, identifier, rpc, *, confirmations):
        """Append one publisher-only witness after independent finalized RPC proof."""
        identifier = _hash(identifier)
        row = self.check(identifier, rpc, confirmations=confirmations)
        if row['state'] not in ('confirmed', 'reverted'):
            return {'observationId': identifier, 'state': 'pending'}
        full = self.settlement_record(identifier)
        verifier = _PublisherReceiptProbe(rpc)
        try:
            proof = verifier._proof(full['transaction_hash'], full['signer'],
                                    full['envelope'], full['signed_bytes'])
            verifier._still_canonical(proof)
        except GasSettlementError as error:
            if error.code in ('gas_receipt_pending', 'gas_receipt_not_final',
                              'gas_receipt_rpc_unavailable', 'gas_receipt_reorganized'):
                return {'observationId': identifier, 'state': 'pending', 'reason': error.code}
            raise ExecutionError('publisher_finality_invalid') from None
        if (full['state'] != ('confirmed' if proof.status else 'reverted') or
                int(full['included_block_number']) != proof.block['number'] or
                full['included_block_hash'] != proof.block['hash'] or
                int(full['gas_used']) != proof.gas_used or
                int(full['effective_gas_price']) != proof.effective_gas_price):
            raise ExecutionError('publisher_finality_mismatch')
        try:
            final = g._header(verifier._rpc('eth_getBlockByNumber', ['finalized', False]))
            verifier._still_canonical(proof)
        except (GasSettlementError, ValueError, TypeError, KeyError):
            return {'observationId': identifier, 'state': 'pending',
                    'reason': 'gas_receipt_reorganized'}
        if (final['number'] < proof.block['number'] or
                final['number'] == proof.block['number'] and final != proof.block):
            return {'observationId': identifier, 'state': 'pending',
                    'reason': 'gas_receipt_not_final'}
        def operation(conn):
            current = self._row(conn, identifier, lock=True)
            if (current['state'] != full['state'] or
                    current['included_block_number'] != full['included_block_number'] or
                    current['included_block_hash'] != full['included_block_hash'] or
                    current['gas_used'] != full['gas_used'] or
                    current['effective_gas_price'] != full['effective_gas_price']):
                raise ExecutionError('publisher_finality_mismatch')
            conn.execute('INSERT INTO publication_finality(observation_id,signer,transaction_hash,'
                'included_block_number,included_block_hash,finalized_head_number,finalized_head_hash,'
                'receipt_status,gas_used,effective_gas_price) '
                'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(observation_id) DO NOTHING',
                (identifier, full['signer'], proof.transaction_hash, proof.block['number'],
                 proof.block['hash'], final['number'], final['hash'], proof.status,
                 proof.gas_used, proof.effective_gas_price))
            witness = conn.execute('SELECT * FROM publication_finality WHERE observation_id=%s',
                                   (identifier,)).fetchone()
            if (witness['transaction_hash'] != proof.transaction_hash or
                    witness['included_block_hash'] != proof.block['hash'] or
                    witness['gas_used'] != proof.gas_used or
                    witness['effective_gas_price'] != proof.effective_gas_price):
                raise ExecutionError('publisher_finality_mismatch')
            return {'observationId': identifier, 'state': 'finalized'}
        return self._transaction(operation)

    def finalize_pending(self, signer_address, rpc, *, confirmations, limit=8):
        results = []
        for identifier in self.pending_finality(signer_address, limit=limit):
            try:
                results.append(self.finalize_receipt(identifier, rpc,
                                                     confirmations=confirmations))
            except (ExecutionError, ExecutionStoreError) as error:
                results.append({'observationId': identifier, 'state': 'attention',
                                'reason': getattr(error, 'code', 'publisher_finality_unavailable')})
        return results

    def live(self, signer_address):
        """Rows a restart must still drive to a receipt for this signer."""
        signer_address = g._address(signer_address)
        return self._transaction(lambda conn: [self._status(r) for r in conn.execute(
            'SELECT * FROM publications WHERE signer=%s AND state IN (%s,%s,%s,%s) ORDER BY nonce', (signer_address, *LIVE)).fetchall()])
