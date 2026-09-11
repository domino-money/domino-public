"""Durable wallet-owned deposit intents; no signer or provider access.

Only a service that has authenticated its owner may call this store. The private
role is constrained by forced owner RLS, and never reads session bearers. Every
wallet payload is persisted before exposure; uncertainty never frees an owner
for a second issuance. Provider preparation/reconciliation occurs outside short
database transactions and must already have passed the service's validators.
"""
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import math
import re
import uuid

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from discovery import DataError, ZERO, address
from read_deadline import check_read_deadline, read_timeout

ROLE = 'domino_deposit_service'
LOCK_ID = 0x444F4D4445504F
MAX_HISTORY = 16
MAX_ARTIFACT_BYTES = 98304
MAX_OUTCOME_BYTES = 8192
MAX_STEP_BYTES = 131072
MAX_SELECTION_BYTES = 8192
MAX_LIST = 50
MAX_SUBMISSION_HASHES = 8
ERROR_CODES = frozenset(('deposit_invalid_request', 'deposit_not_found', 'deposit_idempotency_conflict',
    'deposit_version_conflict', 'deposit_owner_busy', 'deposit_state_conflict', 'deposit_artifact_expired',
    'deposit_capacity_busy', 'deposit_owner_capacity_busy', 'deposit_owner_history_full', 'deposit_history_full', 'deposit_store_unavailable', 'request_timeout'))
KINDS = frozenset(('erc20_reset', 'erc20_approval', 'permit2_approval', 'mint'))
HASH = re.compile(r'0x[0-9a-f]{64}\Z')


class DepositStoreError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_CODES else 'deposit_store_unavailable'
        super().__init__(self.code)


def _owner(value):
    try:
        result = address(value)
        if result == ZERO:
            raise ValueError()
        return result
    except (DataError, ValueError, TypeError):
        raise DepositStoreError('deposit_invalid_request') from None


def _uuid(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise DepositStoreError('deposit_invalid_request') from None
    return value


def _raw(value, maximum=(1 << 256)-1):
    if (not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]{0,77})', value)
            or int(value) > maximum):
        raise DepositStoreError('deposit_invalid_request')
    return value


def _json(value, maximum):
    """Canonicalize bounded JSON without accepting floats, bytes or implicit casts."""
    def walk(item, depth=0):
        if depth > 16:
            raise ValueError()
        if type(item) in (str, int, bool) or item is None:
            return
        if type(item) is dict:
            if any(type(key) is not str for key in item):
                raise ValueError()
            for child in item.values():
                walk(child, depth+1)
        elif type(item) is list:
            for child in item:
                walk(child, depth+1)
        else:
            raise ValueError()
    try:
        if type(value) is not dict:
            raise ValueError()
        walk(value)
        # Include whitespace overhead of PostgreSQL's jsonb text representation.
        if len(json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()) > maximum:
            raise ValueError()
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
        return json.loads(text), hashlib.sha256(text.encode()).hexdigest()
    except (ValueError, TypeError, OverflowError, RecursionError, UnicodeError):
        raise DepositStoreError('deposit_invalid_request') from None


def _artifact(value, owner):
    value, fingerprint = _json(value, MAX_ARTIFACT_BYTES)
    try:
        if value['kind'] not in KINDS or type(value['expiresAt']) is not int:
            raise ValueError()
        tx = value['transaction']
        expected = {'chainId', 'from', 'to', 'data', 'valueRaw', 'nonceRaw', 'gasLimitRaw',
                    'maxFeePerGasRaw', 'maxPriorityFeePerGasRaw'}
        if type(tx) is not dict or set(tx) != expected or type(tx['chainId']) is not int or tx['chainId'] != 4663:
            raise ValueError()
        if tx['from'] != owner or address(tx['to']) != tx['to'] or tx['to'] == ZERO:
            raise ValueError()
        if (not isinstance(tx['data'], str) or len(tx['data']) > 131074
                or not re.fullmatch(r'0x(?:[0-9a-f]{2})*', tx['data'])):
            raise ValueError()
        for name in ('valueRaw', 'gasLimitRaw', 'maxFeePerGasRaw', 'maxPriorityFeePerGasRaw'):
            _raw(tx[name])
        _raw(tx['nonceRaw'], (1 << 64)-1)
        if int(tx['gasLimitRaw']) == 0 or int(tx['maxPriorityFeePerGasRaw']) > int(tx['maxFeePerGasRaw']):
            raise ValueError()
        block = value['sourceBlock']
        if type(block) is not dict or set(block) != {'number', 'hash', 'timestamp'}:
            raise ValueError()
        if (type(block['number']) is not int or not 0 <= block['number'] < 1 << 64
                or type(block['timestamp']) is not int or not 0 <= block['timestamp'] < 1 << 53
                or not isinstance(block['hash'], str) or not HASH.fullmatch(block['hash'])):
            raise ValueError()
    except (KeyError, TypeError, ValueError, DataError):
        raise DepositStoreError('deposit_invalid_request') from None
    return value, fingerprint


def _outcome(value):
    value, _ = _json(value, MAX_OUTCOME_BYTES)
    try:
        if value['state'] not in ('not_found', 'pending', 'confirmed', 'reverted', 'mismatched', 'reorged'):
            raise ValueError()
        for key in ('nonceConsumed', 'nonceFinalized', 'replacement', 'differentEffect', 'cancellation',
                    'reorgDetected', 'scanComplete', 'retryAllowed'):
            if type(value[key]) is not bool:
                raise ValueError()
        if value['retryAllowed'] or value['nonceFinalized'] and not value['nonceConsumed']:
            raise ValueError()
        if value['transactionHash'] is not None and not HASH.fullmatch(value['transactionHash']):
            raise ValueError()
        if value['receipt'] is not None and type(value['receipt']) is not dict:
            raise ValueError()
        _effect_conflicts(value.get('reportedEffectConflicts', []))
        _submission_hashes(value.get('resolvedSubmissionHashes', []))
        if value['state'] in ('confirmed', 'reverted') and (
                not value['nonceConsumed'] or not value['nonceFinalized'] or value['receipt'] is None):
            raise ValueError()
        if value['state'] in ('confirmed', 'reverted'):
            receipt = value['receipt']
            if (not _finalized(receipt) or receipt.get('transactionHash') != value['transactionHash']
                    or receipt.get('status') != ('success' if value['state'] == 'confirmed' else 'reverted')):
                raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise DepositStoreError('deposit_invalid_request') from None
    return value


def _effect_conflicts(values):
    if type(values) is not list or len(values) > MAX_SUBMISSION_HASHES:
        raise DepositStoreError('deposit_invalid_request')
    seen = set()
    for value in values:
        if (type(value) is not dict or set(value) != {'transactionHash', 'nonceRaw'}
                or not isinstance(value['transactionHash'], str)
                or not HASH.fullmatch(value['transactionHash'])
                or value['transactionHash'] in seen):
            raise DepositStoreError('deposit_invalid_request')
        _raw(value['nonceRaw'], (1 << 64)-2)
        seen.add(value['transactionHash'])
    return values


def _submission_hashes(values):
    if (type(values) is not list or len(values) > MAX_SUBMISSION_HASHES
            or any(not isinstance(item, str) or not HASH.fullmatch(item) for item in values)
            or len(set(values)) != len(values)):
        raise DepositStoreError('deposit_invalid_request')
    return values


def _merge_observations(step, resolved, conflicts):
    hints = step.get('submissionHashes', [step['submissionHash']] if step['submissionHash'] else [])
    prior = step.get('reportedEffectConflicts',
        (step.get('reconciliation') or {}).get('reportedEffectConflicts', []))
    merged = deepcopy(_effect_conflicts(prior))
    for item in _effect_conflicts(conflicts):
        old = next((value for value in merged if value['transactionHash'] == item['transactionHash']), None)
        if old is not None and old != item:
            raise DepositStoreError('deposit_invalid_request')
        if old is None: merged.append(item)
    _effect_conflicts(merged)
    if any(item['nonceRaw'] == step['artifact']['transaction']['nonceRaw'] for item in merged):
        raise DepositStoreError('deposit_invalid_request')
    identified = list(dict.fromkeys([*_submission_hashes(step.get('resolvedSubmissionHashes', [])),
                                    *_submission_hashes(resolved)]))
    _submission_hashes(identified)
    if not set(identified) <= set(hints):
        raise DepositStoreError('deposit_invalid_request')
    step['resolvedSubmissionHashes'] = identified
    step['reportedEffectConflicts'] = merged
    return merged, [item for item in hints if item not in identified]


def _finalized(receipt):
    return (type(receipt) is dict and receipt.get('canonical') is True
            and type(receipt.get('finality')) is dict
            and receipt['finality'].get('status') == 'finalized'
            and receipt['finality'].get('basis') == 'rpc_finalized_tag')


class _Connection:
    def __init__(self, conn):
        self.conn = conn

    def execute(self, statement, params=None):
        check_read_deadline()
        millis = max(1, min(1000, int(read_timeout(1)*1000)))
        self.conn.execute(f'SET LOCAL statement_timeout={millis}')
        check_read_deadline()
        result = self.conn.execute(statement, params)
        check_read_deadline()
        return result


@dataclass
class _Issued:
    record: dict
    expires: int


class DepositStore:
    def __init__(self, settings, *, connect=psycopg.connect):
        if type(settings) is not dict or set(settings) != {'host', 'port', 'dbname'}:
            raise ValueError('invalid_deposit_database_settings')
        self.settings, self.connect = dict(settings), connect

    def _transaction(self, owner, operation):
        owner = _owner(owner)
        try:
            check_read_deadline()
            millis = max(1, min(1000, int(read_timeout(1)*1000)))
            with self.connect(**self.settings, user=ROLE,
                    connect_timeout=max(1, math.ceil(read_timeout(2))),
                    options=f'-c statement_timeout={millis} -c lock_timeout={min(millis,250)} '
                        '-c idle_in_transaction_session_timeout=1000 -c search_path=domino_deposits -c TimeZone=UTC',
                    row_factory=dict_row) as raw:
                conn = _Connection(raw)
                conn.execute("SELECT set_config('domino.deposit_owner',%s,true)", (owner,))
                conn.execute('SELECT pg_advisory_xact_lock(%s)', (LOCK_ID,))
                now = conn.execute('SELECT clock_timestamp() AS now').fetchone()['now']
                result = operation(conn, now, owner)
                if isinstance(result, _Issued):
                    if not conn.execute('SELECT extract(epoch FROM clock_timestamp())<%s AS valid',
                                        (result.expires,)).fetchone()['valid']:
                        raise DepositStoreError('deposit_artifact_expired')
                    result = result.record
                check_read_deadline()
            check_read_deadline()
            return result
        except psycopg.errors.LockNotAvailable:
            raise DepositStoreError('deposit_capacity_busy') from None
        except psycopg.errors.RaiseException as error:
            code = error.diag.message_primary if error.diag.message_primary in ERROR_CODES else 'deposit_store_unavailable'
            raise DepositStoreError(code) from None
        except psycopg.errors.UniqueViolation:
            raise DepositStoreError('deposit_owner_busy') from None
        except psycopg.Error:
            raise DepositStoreError('deposit_store_unavailable') from None
        except DataError:
            raise DepositStoreError('request_timeout') from None

    @staticmethod
    def _record(row):
        history = deepcopy(row['history'])
        step = history[-1] if history else None
        return {'id': str(row['id']), 'idempotencyKey': str(row['idempotency_key']), 'owner': row['owner'],
                'chainId': 4663, 'selection': deepcopy(row['selection']), 'state': row['state'],
                'version': row['version'], 'outstanding': row['outstanding'],
                'issued': deepcopy(step['artifact']) if step else None,
                'submissionHash': step['submissionHash'] if step else None,
                'submissionHashes': deepcopy(step.get('submissionHashes',
                    [step['submissionHash']] if step['submissionHash'] else [])) if step else [],
                'history': history, 'createdAt': int(row['created_at'].timestamp()),
                'updatedAt': int(row['updated_at'].timestamp())}

    @staticmethod
    def _row(conn, owner, intent_id, version=None):
        row = conn.execute('SELECT * FROM intents WHERE owner=%s AND id=%s FOR UPDATE', (owner, intent_id)).fetchone()
        if row is None:
            raise DepositStoreError('deposit_not_found')
        if version is not None and row['version'] != version:
            raise DepositStoreError('deposit_version_conflict')
        return row

    @staticmethod
    def _version(version):
        if type(version) is not int or not 1 <= version < (1 << 31)-1:
            raise DepositStoreError('deposit_invalid_request')
        return version

    def _save(self, conn, now, owner, row, state, history, outstanding):
        for step in history:
            _json(step, MAX_STEP_BYTES)
        result = conn.execute('UPDATE intents SET state=%s,history=%s,outstanding=%s,version=version+1,updated_at=%s '
            'WHERE owner=%s AND id=%s RETURNING *',
            (state, Jsonb(history), outstanding, now, owner, row['id'])).fetchone()
        return self._record(result)

    def create(self, owner, idempotency_key, selection):
        key = _uuid(idempotency_key)
        selection, fingerprint = _json(selection, MAX_SELECTION_BYTES)
        def operation(conn, now, owner):
            conn.execute('SELECT domino_deposits.expire_unissued()')
            previous = conn.execute('SELECT * FROM intents WHERE owner=%s AND idempotency_key=%s', (owner, key)).fetchone()
            if previous:
                if previous['selection_hash'] != fingerprint or previous['selection'] != selection:
                    raise DepositStoreError('deposit_idempotency_conflict')
                return self._record(previous)
            row = conn.execute('INSERT INTO intents(id,owner,idempotency_key,selection,selection_hash,state,version,created_at,updated_at) '
                "VALUES (%s,%s,%s,%s,%s,'draft',1,%s,%s) RETURNING *",
                (str(uuid.uuid4()), owner, key, Jsonb(selection), fingerprint, now, now)).fetchone()
            return self._record(row)
        return self._transaction(owner, operation)

    def get(self, owner, intent_id):
        identifier = _uuid(intent_id)
        return self._transaction(owner, lambda conn, now, owner: self._record(self._row(conn, owner, identifier)))

    def list(self, owner, limit=20, before=None):
        if type(limit) is not int or not 1 <= limit <= MAX_LIST:
            raise DepositStoreError('deposit_invalid_request')
        anchor = _uuid(before) if before is not None else None
        def operation(conn, now, owner):
            if anchor is None:
                rows = conn.execute('SELECT * FROM intents WHERE owner=%s ORDER BY created_at DESC,id DESC LIMIT %s',
                                    (owner, limit)).fetchall()
            else:
                prior = self._row(conn, owner, anchor)
                rows = conn.execute('SELECT * FROM intents WHERE owner=%s AND (created_at,id)<(%s,%s) '
                                    'ORDER BY created_at DESC,id DESC LIMIT %s',
                                    (owner, prior['created_at'], prior['id'], limit)).fetchall()
            return [self._record(row) for row in rows]
        return self._transaction(owner, operation)

    def issue(self, owner, intent_id, expected_version, artifact):
        owner, identifier, version = _owner(owner), _uuid(intent_id), self._version(expected_version)
        artifact, fingerprint = _artifact(artifact, owner)
        def operation(conn, now, owner):
            row = self._row(conn, owner, identifier, version)
            if row['state'] != 'draft' or row['outstanding']:
                raise DepositStoreError('deposit_state_conflict')
            if conn.execute("SELECT 1 FROM intents WHERE owner=%s AND (outstanding OR state='attention') LIMIT 1", (owner,)).fetchone():
                raise DepositStoreError('deposit_owner_busy')
            epoch = now.timestamp()
            if not epoch < artifact['expiresAt'] <= epoch+60:
                raise DepositStoreError('deposit_artifact_expired')
            if not epoch-120 <= artifact['sourceBlock']['timestamp'] <= epoch+15:
                raise DepositStoreError('deposit_artifact_expired')
            history = deepcopy(row['history'])
            if len(history) >= MAX_HISTORY:
                raise DepositStoreError('deposit_history_full')
            history.append({'step': len(history)+1, 'artifact': artifact, 'artifactHash': fingerprint,
                'issuedAt': int(epoch), 'submissionHash': None, 'submissionHashes': [], 'reconciliation': None,
                'receipt': None, 'initialFinalizedReceipt': None, 'everReorged': False})
            record = self._save(conn, now, owner, row, 'awaiting_wallet', history, True)
            return _Issued(record, artifact['expiresAt'])
        return self._transaction(owner, operation)

    def mark_submitted(self, owner, intent_id, expected_version, tx_hash):
        identifier, version = _uuid(intent_id), self._version(expected_version)
        if not isinstance(tx_hash, str) or not HASH.fullmatch(tx_hash):
            raise DepositStoreError('deposit_invalid_request')
        def operation(conn, now, owner):
            row = self._row(conn, owner, identifier, version)
            if not row['outstanding'] or not row['history']:
                raise DepositStoreError('deposit_state_conflict')
            history = deepcopy(row['history'])
            step = history[-1]
            hints = step.get('submissionHashes', [step['submissionHash']] if step['submissionHash'] else [])
            if tx_hash in hints:
                return self._record(row)
            if len(hints) >= MAX_SUBMISSION_HASHES:
                raise DepositStoreError('deposit_history_full')
            step['submissionHashes'] = hints + [tx_hash]
            step['submissionHash'] = tx_hash
            state = row['state'] if row['state'] in ('cancel_requested', 'attention') else 'pending'
            return self._save(conn, now, owner, row, state, history, True)
        return self._transaction(owner, operation)

    def cancel(self, owner, intent_id, expected_version):
        identifier, version = _uuid(intent_id), self._version(expected_version)
        def operation(conn, now, owner):
            row = self._row(conn, owner, identifier, version)
            if row['state'] in ('cancel_requested', 'cancelled'):
                return self._record(row)
            if row['outstanding']:
                return self._save(conn, now, owner, row, 'cancel_requested', row['history'], True)
            if row['state'] != 'draft':
                raise DepositStoreError('deposit_state_conflict')
            return self._save(conn, now, owner, row, 'cancelled', row['history'], False)
        return self._transaction(owner, operation)

    def record_observations(self, owner, intent_id, expected_version, resolved, conflicts):
        """Durably classify reported hashes before continuing fallible chain reads."""
        identifier, version = _uuid(intent_id), self._version(expected_version)
        resolved, conflicts = deepcopy(_submission_hashes(resolved)), deepcopy(_effect_conflicts(conflicts))
        def operation(conn, now, owner):
            row = self._row(conn, owner, identifier, version)
            history = deepcopy(row['history'])
            if not history: raise DepositStoreError('deposit_state_conflict')
            merged, _ = _merge_observations(history[-1], resolved, conflicts)
            state, outstanding = row['state'], row['outstanding']
            if merged:
                state = 'cancel_requested' if state == 'cancel_requested' else 'attention'
                other = conn.execute('SELECT 1 FROM intents WHERE owner=%s AND id<>%s AND outstanding LIMIT 1',
                                     (owner, identifier)).fetchone()
                outstanding = not bool(other)
            if state == row['state'] and outstanding == row['outstanding'] and history == row['history']:
                return self._record(row)
            return self._save(conn, now, owner, row, state, history, outstanding)
        return self._transaction(owner, operation)

    def reconcile(self, owner, intent_id, expected_version, outcome):
        identifier, version = _uuid(intent_id), self._version(expected_version)
        outcome = _outcome(outcome)
        def operation(conn, now, owner):
            observed = deepcopy(outcome)
            row = self._row(conn, owner, identifier, version)
            history = deepcopy(row['history'])
            if not history:
                raise DepositStoreError('deposit_state_conflict')
            step = history[-1]
            resolved = list(observed.get('resolvedSubmissionHashes', []))
            hints = step.get('submissionHashes', [step['submissionHash']] if step['submissionHash'] else [])
            resolved = [item for item in resolved if item in hints]
            # A candidate returned by the reconciler has an independently checked
            # owner/issued nonce. Its reported hash is therefore identified too.
            if observed['transactionHash'] in hints and observed['transactionHash'] not in resolved:
                resolved.append(observed['transactionHash'])
            conflicts, unresolved = _merge_observations(step, resolved,
                observed.get('reportedEffectConflicts', []))
            observed['reportedEffectConflicts'] = conflicts
            observed['resolvedSubmissionHashes'] = step['resolvedSubmissionHashes']
            observed['unresolvedSubmissionHashes'] = unresolved
            if conflicts or unresolved:
                observed['cancellation'] = False
                if observed['state'] != 'reorged':
                    observed.update(state='mismatched', reason='reported_effect_nonce_mismatch'
                        if conflicts else 'reported_transaction_unresolved')
            step['reconciliation'] = observed
            step['everReorged'] = step['everReorged'] or observed['reorgDetected'] or observed['state'] == 'reorged'
            if observed['receipt'] is not None:
                step['receipt'] = observed['receipt']
                if observed['nonceFinalized'] and step['initialFinalizedReceipt'] is None:
                    step['initialFinalizedReceipt'] = observed['receipt']
            state, outstanding = row['state'], row['outstanding']
            if observed['state'] in ('confirmed', 'reverted'):
                outstanding = False
                if observed['state'] == 'reverted':
                    state = 'reverted'
                elif step['artifact']['kind'] == 'mint':
                    state = 'confirmed'
                else:
                    state = 'cancelled' if row['state'] in ('cancel_requested', 'cancelled') else 'draft'
            elif (observed['state'] == 'mismatched' and row['state'] == 'cancel_requested'
                    and not conflicts and not unresolved
                    and observed['replacement'] and observed['differentEffect'] and observed['cancellation']
                    and observed['nonceFinalized'] and observed['nonceConsumed']
                    and _finalized(observed['receipt'])
                    and observed['receipt'].get('transactionHash') == observed['transactionHash']):
                state, outstanding = 'cancelled', False
            elif (not conflicts and not unresolved and observed['state'] == 'mismatched' and observed.get('reason') == 'transaction_mismatch'
                    and observed['replacement'] and observed['differentEffect']
                    and observed['nonceFinalized'] and observed['nonceConsumed']
                    and _finalized(observed['receipt'])
                    and observed['receipt'].get('transactionHash') == observed['transactionHash']
                    and observed['receipt'].get('mint') is None
                    and step['artifact']['expiresAt'] <= now.timestamp()):
                # Finalized consumption proves this exact nonce/effect can no
                # longer execute on the observed chain. This is not cancellation
                # or evidence of a mint. A later reorg re-enters attention below.
                state, outstanding = 'superseded', False
            elif observed['state'] in ('mismatched', 'reorged') or not row['outstanding']:
                # A reorg of an already finalized step can arrive while another
                # intent is outstanding. Persist attention without dropping the
                # newer reservation; any attention row blocks fresh issuance.
                state = 'cancel_requested' if row['state'] == 'cancel_requested' else 'attention'
                other = conn.execute('SELECT 1 FROM intents WHERE owner=%s AND id<>%s AND outstanding LIMIT 1',
                                     (owner, identifier)).fetchone()
                outstanding = not bool(other)
            elif state not in ('cancel_requested', 'attention'):
                state = 'pending' if observed['state'] == 'pending' or step['submissionHash'] else 'awaiting_wallet'
            if state == row['state'] and outstanding == row['outstanding'] and history == row['history']:
                return self._record(row)
            return self._save(conn, now, owner, row, state, history, outstanding)
        return self._transaction(owner, operation)
