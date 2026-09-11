"""Owner-bound durable deposits; the wallet signs and broadcasts every step."""
import json
import math
import time

from discovery import DataError
from deposit_models import (CONTRACT_VERSION, DepositError, PreparedArtifact, MAX_RESPONSE,
                            validate_request, validate_response)
from deposit_store import DepositStoreError
from read_deadline import check_read_deadline


class DepositService:
    def __init__(self, auth, store, preparer, reconciler_factory, *, clock=time.time,
                 private_values=(), allowance_reader_factory=None):
        self.auth, self.store, self.preparer = auth, store, preparer
        self.reconciler_factory, self.clock = reconciler_factory, clock
        self.private_values = tuple(private_values)
        self.allowance_reader_factory = allowance_reader_factory

    def _now(self):
        now = self.clock()
        if type(now) not in (int, float) or not math.isfinite(now) or not 0 <= now < 2**53:
            raise DepositError('upstream_invalid_response')
        return now

    @staticmethod
    def _operation(record):
        from deposit_receipt import receipt_summary
        history = []
        for entry in record['history']:
            artifact, outcome = entry['artifact'], entry['reconciliation']
            receipt = receipt_summary(outcome) if outcome else None
            history.append({'step': entry['step'], 'kind': artifact['kind'],
                'issuedAt': entry['issuedAt'], 'expiresAt': artifact['expiresAt'],
                'nonceRaw': artifact['transaction']['nonceRaw'],
                'transactionHash': outcome['transactionHash'] if outcome and outcome['transactionHash']
                    else entry['submissionHash'],
                'reconciliationState': outcome['state'] if outcome else None, 'receipt': receipt,
                'reportedEffectConflicts': entry.get('reportedEffectConflicts',
                    outcome.get('reportedEffectConflicts', []) if outcome else [])})
        return {**{key: record[key] for key in ('id', 'idempotencyKey', 'owner', 'chainId',
            'selection', 'state', 'version', 'outstanding', 'createdAt', 'updatedAt')},
            'history': history, 'serviceFeeBps': 0}

    def _respond(self, record, wallet_step=None):
        return {'contractVersion': CONTRACT_VERSION, 'operation': self._operation(record),
            'walletStep': wallet_step, 'serverBroadcastAvailable': False, 'automationAvailable': False}

    def _list_item(self, record):
        projected = self._operation(record)
        history = projected.pop('history')
        return {**projected, 'historyCount': len(history), 'lastStep': history[-1] if history else None}

    @staticmethod
    def _version(record, body):
        if record['version'] != body['version']:
            raise DepositError('deposit_version_conflict')

    def _artifact(self, owner, record, artifact):
        from deposit_receipt import validate_issued_artifact
        artifact = PreparedArtifact.model_validate(artifact).model_dump(by_alias=True)
        validate_issued_artifact(owner, record['selection'], artifact)
        now = self._now()
        if artifact['expiresAt'] <= now or artifact['expiresAt'] > now + 30:
            raise DepositError('deposit_artifact_expired')
        return artifact

    def _reconcile(self, context, record):
        if record['issued'] is None:
            raise DepositError('deposit_state_conflict')
        latest = record['history'][-1]
        previous = latest['reconciliation']
        known = list(record.get('submissionHashes', []))
        if record['submissionHash'] and record['submissionHash'] not in known:
            known.append(record['submissionHash'])
        def checkpoint(resolved, conflicts):
            nonlocal record
            check_read_deadline()
            self.auth.finish(context)
            record = self.store.record_observations(context['owner'], record['id'],
                record['version'], resolved, conflicts)
        result = self.reconciler_factory().reconcile(context['owner'], record['selection'],
            record['issued'], known_hashes=known,
            previous_receipt=latest.get('receipt'),
            scan_cursor=previous.get('scanCursor') if previous else None,
            previous_conflicts=latest.get('reportedEffectConflicts',
                previous.get('reportedEffectConflicts', []) if previous else []),
            previous_resolved=latest.get('resolvedSubmissionHashes', []),
            on_observation=checkpoint)
        check_read_deadline()
        self.auth.finish(context)
        return self.store.reconcile(context['owner'], record['id'], record['version'], result)

    def execute(self, route, body, *, client, session, csrf):
        request = validate_request(route, body)
        context = self.auth.begin(client, session, csrf)
        owner, wallet_step = context['owner'], None
        try:
            if route == 'create':
                self.auth.finish(context)
                record = self.store.create(owner, request['idempotencyKey'], request['selection'])
            elif route == 'list':
                records = self.store.list(owner, request['limit']+1, before=request['before'])
                has_more = len(records) > request['limit']
                records = records[:request['limit']]
                response = {'contractVersion': CONTRACT_VERSION,
                    'operations': [self._list_item(record) for record in records],
                    'hasMore': has_more, 'nextBefore': records[-1]['id'] if has_more else None,
                    'serverBroadcastAvailable': False, 'automationAvailable': False}
                return self._finish(context, route, response)
            else:
                record = self.store.get(owner, request['intentId'])
                if route == 'allowances':
                    if self.allowance_reader_factory is None:
                        raise DepositError('deposit_allowance_unavailable')
                    allowances = self.allowance_reader_factory().read(owner, record['selection'])
                    return self._finish(context, route, {**self._respond(record), 'allowances': allowances})
                if route != 'get':
                    self._version(record, request)
                if route == 'prepare':
                    if record['outstanding']:
                        if record['state'] != 'awaiting_wallet':
                            raise DepositError('deposit_state_conflict')
                        # A repeated request can return only the same already
                        # persisted nonce/effect while its short handoff is valid.
                        wallet_step = self._artifact(owner, record, record['issued'])
                    else:
                        if record['state'] != 'draft':
                            raise DepositError('deposit_state_conflict')
                        artifact = self._artifact(owner, record,
                            self.preparer.prepare(owner, record['selection']))
                        self.auth.finish(context)
                        record = self.store.issue(owner, record['id'], request['version'], artifact)
                        wallet_step = self._artifact(owner, record, record['issued'])
                elif route == 'report':
                    # The hash is only a durable hint, never success evidence.
                    self.auth.finish(context)
                    record = self.store.mark_submitted(owner, record['id'], request['version'], request['transactionHash'])
                    record = self._reconcile(context, record)
                elif route == 'reconcile':
                    record = self._reconcile(context, record)
                elif route == 'cancel':
                    self.auth.finish(context)
                    record = self.store.cancel(owner, record['id'], request['version'])
            return self._finish(context, route, self._respond(record, wallet_step))
        except DepositStoreError as error:
            raise DepositError(error.code) from None
        except DataError:
            check_read_deadline()
            raise DepositError('deposit_allowance_unavailable' if route == 'allowances'
                               else 'deposit_reconciliation_unavailable' if route in ('report', 'reconcile')
                               else 'deposit_preparation_unavailable') from None

    def _finish(self, context, route, response):
        check_read_deadline()
        response = validate_response(route, response)
        encoded = json.dumps(response, allow_nan=False, separators=(',', ':'))
        secrets = (*self.private_values, context['session'], context['csrf'])
        if (len(encoded.encode()) > MAX_RESPONSE or any(value and
                json.dumps(value)[1:-1] in encoded for value in secrets)):
            raise DepositError('upstream_invalid_response')
        self.auth.finish(context)
        check_read_deadline()
        if response.get('walletStep') and response['walletStep']['expiresAt'] <= self._now():
            raise DepositError('deposit_artifact_expired')
        return response
