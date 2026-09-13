"""Unsigned E5 storage candidate. No signer, transaction bytes, RPC or HTTP API.

The owner context is set by a trusted internal service, never a browser claim.
Stored observations/credits are supplied evidence, not independent chain proofs.
Converted lineage is durable but quarantined until E4 can atomically reconcile
its original debits. Nothing here grants financial execution eligibility.
"""
from copy import deepcopy
from datetime import timedelta
import json
import re
import uuid

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

import execution_models as models

WORKER_ROLE = 'domino_execution_worker'
LEDGER_ROLE = 'domino_execution_ledger'
MAX_LEASE_SECONDS = 300
MAX_RECORD_BYTES = 4 * 1024 * 1024
MAX_FENCE = 2**63-1
HASH = re.compile(r'0x[0-9a-f]{64}\Z')
ADDRESS = re.compile(r'0x[0-9a-f]{40}\Z')
CODES = frozenset(('execution_invalid_record','execution_not_found','execution_identity_conflict',
    'execution_origin_immutable','execution_intent_immutable','execution_claim_immutable',
    'execution_origin_unavailable','execution_stale_fence','execution_state_conflict',
    'execution_balance_reserved','execution_claim_mismatch','execution_lineage_mismatch',
    'execution_reservation_conflict','execution_lease_busy','execution_expired','execution_store_unavailable'))


class ExecutionStoreError(Exception):
    def __init__(self, code):
        self.code = code if code in CODES else 'execution_store_unavailable'
        super().__init__(self.code)


def _invalid():
    raise ExecutionStoreError('execution_invalid_record')


def _hash(value):
    if not isinstance(value, str) or not HASH.fullmatch(value) or value == models.ZERO_HASH:
        _invalid()
    return value


def _owner(value):
    if not isinstance(value, str) or not ADDRESS.fullmatch(value) or value == models.ZERO:
        _invalid()
    return value


def _worker(value):
    try:
        if type(value) is not str or str(uuid.UUID(value)) != value:
            _invalid()
    except (ValueError, AttributeError):
        _invalid()
    return value


def _raw(value, maximum=2**128-1):
    if type(value) is not str or not re.fullmatch(r'0|[1-9][0-9]{0,77}', value) or int(value) > maximum:
        _invalid()
    return int(value)


def _model(kind, value):
    """Rebuild nested records: frozen models can still have been model_construct'ed."""
    try:
        raw = value.model_dump(mode='json') if isinstance(value, kind) else value
        if type(raw) is not dict:
            _invalid()
        encoded = json.dumps(raw, separators=(',', ':'), allow_nan=False)
        if len(encoded.encode()) > MAX_RECORD_BYTES:
            _invalid()
        return kind.model_validate_json(encoded)
    except (ValueError, TypeError, AttributeError, OverflowError, RecursionError):
        _invalid()


def _dump(value):
    return value.model_dump(mode='json')


class _Store:
    role = WORKER_ROLE

    def __init__(self, settings, *, connect=psycopg.connect):
        if type(settings) is not dict or set(settings) != {'host','port','dbname'}:
            raise ValueError('invalid_execution_database_settings')
        self.settings = dict(settings)
        self.connect = connect

    def _transaction(self, owner, operation, *, worker=None, fence=None):
        owner = _owner(owner)
        if worker is not None:
            _worker(worker)
            if type(fence) is not int or not 1 <= fence <= MAX_FENCE:
                _invalid()
        try:
            with self.connect(**self.settings, user=self.role, row_factory=dict_row, connect_timeout=2,
                    options='-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000 '
                            '-c search_path=domino_execution -c TimeZone=UTC') as conn:
                conn.execute("SELECT set_config('domino.execution_owner',%s,true)", (owner,))
                if worker is not None:
                    conn.execute("SELECT set_config('domino.execution_worker',%s,true),set_config('domino.execution_fence',%s,true)", (worker,str(fence)))
                return operation(conn, owner)
        except psycopg.errors.UniqueViolation:
            raise ExecutionStoreError('execution_reservation_conflict') from None
        except psycopg.errors.CheckViolation as error:
            raise ExecutionStoreError(error.diag.message_primary) from None
        except psycopg.Error:
            raise ExecutionStoreError('execution_store_unavailable') from None

    @staticmethod
    def _row(conn, owner, intent_id):
        row = conn.execute('SELECT * FROM intents WHERE owner=%s AND intent_id=%s FOR UPDATE', (owner,intent_id)).fetchone()
        if row is None:
            raise ExecutionStoreError('execution_not_found')
        return row

    @staticmethod
    def _fence(conn, intent_id):
        conn.execute('SELECT domino_execution.live_fence(%s)', (intent_id,))

    @staticmethod
    def _snapshot(row):
        return {'intentId':row['intent_id'],'owner':row['owner'],'chainId':row['chain_id'],
                'sequenceHash':row['sequence_hash'],'modelVersion':row['model_version'],
                'plan':deepcopy(row['plan']),'observation':deepcopy(row['observation']),
                'state':row['state'],'fence':row['fence'],
                'workerId':str(row['worker_id']) if row['worker_id'] else None,
                'leaseUntil':row['lease_until'].isoformat() if row['lease_until'] else None,
                'executionEligible':False}


class ExecutionLedgerStore(_Store):
    """Separate reconciliation role; the execution worker cannot create fee money."""
    role = LEDGER_ROLE

    def record_credit(self, owner, sequence, source, lot_id, credit):
        seq = _model(models.SequenceIdentity, sequence)
        origin = _model(models.FeeSourceIdentity, source)
        credit = _model(models.FeeCredit, credit)
        lot_id = _hash(lot_id)
        if seq.owner != owner or origin.sequence != seq.digest() or credit.source != origin.digest():
            _invalid()
        if origin.currency not in (seq.poolKey.currency0,seq.poolKey.currency1) or not credit.canonical or not credit.finalized:
            _invalid()
        values = {'origin_id':credit.credit_id(),'sequence_hash':seq.digest(),'source_id':origin.digest(),
            'lot_id':lot_id,'currency':origin.currency,'kind':'original','transaction_hash':credit.transactionHash,
            'event_index':credit.eventIndex,'amount_raw':int(credit.amountRaw),'state':'available',
            'source_record':_dump(origin),'evidence':{'sequence':_dump(seq),'credit':_dump(credit)}}
        return self._put_origin(owner, values)

    def record_converted(self, owner, sequence, source, lot_id, lineage, amount_raw):
        # Introduced by #99. No substitute identity scheme is defined here.
        seq = _model(models.SequenceIdentity, sequence)
        origin = _model(models.FeeSourceIdentity, source)
        lineage = _model(models.ConvertedLotLineage, lineage)
        amount = _raw(amount_raw)
        if (seq.owner != owner or origin.sequence != seq.digest() or lineage.source != origin.digest()
                or lineage.currency not in (seq.poolKey.currency0,seq.poolKey.currency1)):
            _invalid()
        values = {'origin_id':lineage.allocation_id(),'sequence_hash':seq.digest(),'source_id':origin.digest(),
            'lot_id':_hash(lot_id),'currency':lineage.currency,'kind':'converted','transaction_hash':lineage.transactionHash,
            'event_index':lineage.eventIndex,'amount_raw':amount,'state':'quarantined',
            'source_record':_dump(origin),'evidence':{'sequence':_dump(seq),'lineage':_dump(lineage)}}
        return self._put_origin(owner, values, lineage.inputAllocations)

    def _put_origin(self, owner, values, inputs=()):
        def operation(conn, owner):
            # Serializes duplicate reports of this stable origin without masking a
            # changed fork/amount payload. Never ON CONFLICT UPDATE financial data.
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (values['origin_id'],))
            old = conn.execute('SELECT * FROM origins WHERE owner=%s AND origin_id=%s', (owner,values['origin_id'])).fetchone()
            if old:
                if any(old[key] != value for key,value in values.items() if key != 'state'):
                    raise ExecutionStoreError('execution_identity_conflict')
                return {'originId':old['origin_id'],'lotId':old['lot_id'],'state':old['state']}
            conn.execute('INSERT INTO origins(owner,origin_id,sequence_hash,source_id,lot_id,currency,kind,transaction_hash,event_index,amount_raw,state,source_record,evidence) '
                         'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                         (owner,*(values[key] for key in ('origin_id','sequence_hash','source_id','lot_id','currency','kind','transaction_hash','event_index','amount_raw','state')),
                          Jsonb(values['source_record']),Jsonb(values['evidence'])))
            for allocation in inputs:
                conn.execute('INSERT INTO converted_inputs(owner,origin_id,input_lot_id,amount_raw) VALUES(%s,%s,%s,%s)',
                             (owner,values['origin_id'],allocation.lotId,int(allocation.amountRaw)))
            return {'originId':values['origin_id'],'lotId':values['lot_id'],'state':values['state']}
        return self._transaction(owner,operation)

    def quarantine(self, owner, origin_id):
        """Fail closed on suspect supplied evidence; no re-enable/delete path."""
        def operation(conn, owner):
            row = conn.execute('SELECT * FROM origins WHERE owner=%s AND origin_id=%s FOR UPDATE', (owner,_hash(origin_id))).fetchone()
            if row is None:
                raise ExecutionStoreError('execution_not_found')
            if row['state'] != 'quarantined':
                conn.execute("UPDATE origins SET state='quarantined' WHERE origin_id=%s", (origin_id,))
            return {'originId':origin_id,'state':'quarantined'}
        return self._transaction(owner,operation)


class UnsignedExecutionStore(_Store):
    """Persist -> lease -> reserve -> optional nonce claim -> safe cancellation.

    A caller-provided nonce is a reservation candidate, not a canonical RPC
    observation. An eventual signer must reconstruct and revalidate everything.
    """
    def persist(self, owner, plan, observation, *, actor):
        plan = _model(models.ExecutionPlan, plan)
        observation = _model(models.Observation, observation)
        _owner(actor)
        if plan.sequence.owner != owner:
            _invalid()
        identifier = plan.intent_id()
        def operation(conn, owner):
            conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (identifier,))
            prior = conn.execute('SELECT * FROM intents WHERE owner=%s AND intent_id=%s', (owner,identifier)).fetchone()
            if prior:
                if prior['plan'] != _dump(plan) or prior['observation'] != _dump(observation):
                    raise ExecutionStoreError('execution_identity_conflict')
                return self._snapshot(prior)
            now = int(conn.execute('SELECT extract(epoch FROM clock_timestamp()) AS epoch').fetchone()['epoch'])
            try:
                models.validate_candidate(plan, observation, now=now, actor=actor)
            except ValueError:
                _invalid()
            accruals={a.source.digest():a for a in observation.accruals}
            commitments={'collections':[{'sourceId':c.sourceId,'checkpointId':accruals[c.sourceId].checkpointId,'amountRaw':c.maxGrossRaw} for c in plan.collections],
                'successorId':plan.successor_id() if plan.action==3 else None}
            row = conn.execute('INSERT INTO intents(intent_id,owner,sequence_hash,chain_id,model_version,plan,observation,commitments) VALUES(%s,%s,%s,4663,%s,%s,%s,%s) RETURNING *',
                (identifier,owner,plan.sequence.digest(),models.VERSION,Jsonb(_dump(plan)),Jsonb(_dump(observation)),Jsonb(commitments))).fetchone()
            return self._snapshot(row)
        return self._transaction(owner,operation)

    def get(self, owner, intent_id):
        identifier = _hash(intent_id)
        return self._transaction(owner, lambda conn,owner:self._snapshot(self._row(conn,owner,identifier)))

    def reservations(self, owner, intent_id):
        """Recover committed unsigned claims after worker/process loss."""
        identifier=_hash(intent_id)
        def operation(conn,owner):
            self._row(conn,owner,identifier)
            lots=conn.execute('SELECT lot_id,amount_raw,active FROM lot_claims WHERE intent_id=%s ORDER BY lot_id',(identifier,)).fetchall()
            sources=conn.execute('SELECT source_id,checkpoint_id,amount_raw,active FROM source_claims WHERE intent_id=%s ORDER BY source_id',(identifier,)).fetchall()
            successors=conn.execute('SELECT successor_id,active FROM successor_claims WHERE intent_id=%s',(identifier,)).fetchall()
            nonces=conn.execute('SELECT chain_id,signer,nonce,active FROM nonce_claims WHERE intent_id=%s',(identifier,)).fetchall()
            return {'lots':[{'lotId':r['lot_id'],'amountRaw':str(r['amount_raw']),'active':r['active']} for r in lots],
                'collections':[{'sourceId':r['source_id'],'checkpointId':r['checkpoint_id'],'amountRaw':str(r['amount_raw']),'active':r['active']} for r in sources],
                'successors':[{'successorId':r['successor_id'],'active':r['active']} for r in successors],
                'nonceClaims':[{'chainId':r['chain_id'],'signer':r['signer'],'nonceRaw':str(r['nonce']),'active':r['active']} for r in nonces],
                'unsignedOnly':True}
        return self._transaction(owner,operation)

    def acquire(self, owner, intent_id, worker_id, *, lease_seconds=30):
        identifier,worker = _hash(intent_id),_worker(worker_id)
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= MAX_LEASE_SECONDS:
            _invalid()
        def operation(conn, owner):
            row = self._row(conn,owner,identifier)
            now = conn.execute('SELECT clock_timestamp() AS now').fetchone()['now']
            if row['state']=='cancelled' or row['fence']==MAX_FENCE:
                raise ExecutionStoreError('execution_state_conflict')
            if row['lease_until'] and row['lease_until']>now:
                if str(row['worker_id'])==worker:
                    return self._snapshot(row)
                raise ExecutionStoreError('execution_lease_busy')
            conn.execute("SELECT set_config('domino.execution_acquirer',%s,true)",(worker,))
            row = conn.execute('UPDATE intents SET fence=fence+1,worker_id=%s,lease_until=%s WHERE intent_id=%s RETURNING *',
                               (worker,now+timedelta(seconds=lease_seconds),identifier)).fetchone()
            return self._snapshot(row)
        return self._transaction(owner,operation)

    def renew(self, owner, intent_id, worker_id, fence, *, lease_seconds=30):
        identifier = _hash(intent_id)
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= MAX_LEASE_SECONDS:
            _invalid()
        def operation(conn,owner):
            row=self._row(conn,owner,identifier)
            self._fence(conn,identifier)
            if row['state']=='cancelled':
                raise ExecutionStoreError('execution_state_conflict')
            row=conn.execute('UPDATE intents SET lease_until=clock_timestamp()+make_interval(secs=>%s) WHERE intent_id=%s RETURNING *', (lease_seconds,identifier)).fetchone()
            return self._snapshot(row)
        return self._transaction(owner,operation,worker=worker_id,fence=fence)

    def reserve(self, owner, intent_id, worker_id, fence):
        identifier = _hash(intent_id)
        def operation(conn,owner):
            row=self._row(conn,owner,identifier)
            self._fence(conn,identifier)
            if row['state']=='reserved':
                return self._snapshot(row)
            if row['state']!='planned':
                raise ExecutionStoreError('execution_state_conflict')
            now=int(conn.execute('SELECT extract(epoch FROM clock_timestamp()) AS epoch').fetchone()['epoch'])
            plan=_model(models.ExecutionPlan,row['plan'])
            observation=_model(models.Observation,row['observation'])
            if now>int(plan.deadline):
                raise ExecutionStoreError('execution_expired')
            balances={b.lotId:b for b in observation.balances}
            for allocation in plan.allocations:
                lot=balances[allocation.lotId]
                stored=conn.execute('SELECT * FROM origins WHERE owner=%s AND lot_id=%s FOR UPDATE',(owner,allocation.lotId)).fetchone()
                if (not stored or stored['state']!='available' or stored['origin_id']!=lot.reconciliationId
                        or stored['source_id']!=lot.source.digest() or stored['currency']!=lot.currency
                        or (stored['kind']=='converted')!=lot.convertedCharged or stored['amount_raw']!=int(lot.amountRaw)):
                    raise ExecutionStoreError('execution_origin_unavailable')
                conn.execute('INSERT INTO lot_claims(owner,intent_id,lot_id,amount_raw) VALUES(%s,%s,%s,%s)',(owner,identifier,allocation.lotId,int(allocation.amountRaw)))
            accruals={a.source.digest():a for a in observation.accruals}
            for collection in plan.collections:
                conn.execute('INSERT INTO source_claims(owner,intent_id,source_id,checkpoint_id,amount_raw) VALUES(%s,%s,%s,%s,%s)',
                    (owner,identifier,collection.sourceId,accruals[collection.sourceId].checkpointId,int(collection.maxGrossRaw)))
            if plan.action==3:
                conn.execute('INSERT INTO successor_claims(owner,intent_id,successor_id) VALUES(%s,%s,%s)',(owner,identifier,plan.successor_id()))
            self._fence(conn,identifier)
            row=conn.execute("UPDATE intents SET state='reserved' WHERE intent_id=%s RETURNING *",(identifier,)).fetchone()
            return self._snapshot(row)
        return self._transaction(owner,operation,worker=worker_id,fence=fence)

    def reserve_nonce(self, owner, intent_id, worker_id, fence, *, signer, nonce_raw):
        identifier,signer,nonce=_hash(intent_id),_owner(signer),_raw(nonce_raw,2**64-2)
        def operation(conn,owner):
            row=self._row(conn,owner,identifier)
            self._fence(conn,identifier)
            if row['state']!='reserved':
                raise ExecutionStoreError('execution_state_conflict')
            if int(conn.execute('SELECT extract(epoch FROM clock_timestamp()) AS epoch').fetchone()['epoch'])>int(row['plan']['deadline']):
                raise ExecutionStoreError('execution_expired')
            if conn.execute("SELECT 1 FROM lot_claims c JOIN origins o USING(owner,lot_id) WHERE c.intent_id=%s AND c.active AND o.state<>'available'",(identifier,)).fetchone():
                raise ExecutionStoreError('execution_origin_unavailable')
            prior=conn.execute('SELECT * FROM nonce_claims WHERE owner=%s AND intent_id=%s',(owner,identifier)).fetchone()
            if prior:
                if prior['signer']!=signer or prior['nonce']!=nonce or not prior['active']:
                    raise ExecutionStoreError('execution_identity_conflict')
                return {'intentId':identifier,'chainId':4663,'signer':signer,'nonceRaw':str(nonce),'unsigned':True}
            conn.execute('INSERT INTO nonce_claims(owner,intent_id,chain_id,signer,nonce) VALUES(%s,%s,4663,%s,%s)',(owner,identifier,signer,nonce))
            return {'intentId':identifier,'chainId':4663,'signer':signer,'nonceRaw':str(nonce),'unsigned':True}
        return self._transaction(owner,operation,worker=worker_id,fence=fence)

    def cancel(self, owner, intent_id, worker_id, fence):
        identifier=_hash(intent_id)
        def operation(conn,owner):
            row=self._row(conn,owner,identifier)
            self._fence(conn,identifier)
            if row['state']=='cancelled':
                return self._snapshot(row)
            row=conn.execute("UPDATE intents SET state='cancelled' WHERE intent_id=%s RETURNING *",(identifier,)).fetchone()
            for table in ('lot_claims','source_claims','successor_claims','nonce_claims'):
                conn.execute(f'UPDATE {table} SET active=false WHERE owner=%s AND intent_id=%s AND active',(owner,identifier))
            # Keep the final fence/worker as evidence. Terminal state rejects any
            # new work; a lease expiring alone NEVER releases a reservation.
            return self._snapshot(row)
        return self._transaction(owner,operation,worker=worker_id,fence=fence)
