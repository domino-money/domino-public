"""One bounded execution/recovery step. All signing bytes stay inside signer.

The journal freezes cancellation *before* signing. No absent receipt, process
restart, lease expiry, send timeout or RPC failover can authorize a new nonce.
"""
from copy import deepcopy
import json

import psycopg
from psycopg.types.json import Jsonb
from eth_hash.auto import keccak
from eth_account import Account

import execution_models as m
import general_compound_receipts as g
from execution_store import _Store, _model, _hash, _raw, ExecutionStoreError, UnsignedExecutionStore
from execution_signer import ExecutionError, verify_signed

SIGNER_ROLE='domino_execution_signer'
TRANSIENT={'compound_receipt_unavailable','compound_finality_unavailable','compound_rpc_unavailable'}


def json_record(value):
    return json.loads(json.dumps(value,default=lambda x:x.model_dump(mode='json'),allow_nan=False))


class ExecutionJournal(_Store):
    role=SIGNER_ROLE

    def read(self,owner,identifier):
        identifier=_hash(identifier)
        def op(conn,owner):
            intent=conn.execute('SELECT * FROM intents WHERE owner=%s AND intent_id=%s',(owner,identifier)).fetchone()
            if intent is None:raise ExecutionStoreError('execution_not_found')
            j=conn.execute('SELECT * FROM journal WHERE intent_id=%s',(identifier,)).fetchone()
            attempts=conn.execute('SELECT * FROM attempts WHERE intent_id=%s ORDER BY ordinal',(identifier,)).fetchall()
            effect=conn.execute('SELECT * FROM effects WHERE intent_id=%s',(identifier,)).fetchone()
            return {'intent':intent,'journal':j,'attempts':attempts,'effect':effect}
        return self._transaction(owner,op)

    def status(self,owner,identifier):
        result=self.read(owner,identifier); j=result['journal']; effect=result['effect']
        return {'schemaVersion':1,'intentId':identifier,'sequenceId':result['intent']['plan']['sequence']['sequenceId'],
            'state':j['state'] if j else result['intent']['state'],'reason':j['reason'] if j else '',
            'signer':j['signer'] if j else None,'nonceRaw':str(j['nonce']) if j else None,
            'attempts':[{'ordinal':a['ordinal'],'transactionHash':a['transaction_hash']} for a in result['attempts']],
            'receipt':deepcopy(effect['receipt']) if effect and effect['canonical'] else None,
            'canCancel':not j and result['intent']['state'] in ('planned','reserved'),
            'executionAvailable':False}

    def prepare(self,owner,identifier,worker,fence,signer,*,restore_only=False):
        # Qualify before opening the write transaction. Rebuild again immediately
        # before signing; canonical chain guards remain authoritative at execution.
        item=self.read(owner,identifier)
        if item['journal']:
            return item
        if restore_only:
            raise ExecutionError('execution_restore_reconciliation_required')
        pending=g._quantity(signer.rpc.request('eth_getTransactionCount',[signer.address,'pending']))
        latest=g._quantity(signer.rpc.request('eth_getTransactionCount',[signer.address,'latest']))
        def op(conn,owner):
            row=self._row(conn,owner,identifier);self._fence(conn,identifier)
            if row['state']!='reserved':raise ExecutionError('execution_not_reserved')
            prior=conn.execute('SELECT * FROM journal WHERE intent_id=%s',(identifier,)).fetchone()
            if prior:return
            if conn.execute("SELECT 1 FROM journal j JOIN intents i USING(intent_id) WHERE i.sequence_hash=%s AND j.state IN ('attention','reorged')",(row['sequence_hash'],)).fetchone():
                raise ExecutionError('execution_sequence_attention')
            if conn.execute("SELECT 1 FROM lot_claims c JOIN origins o USING(owner,lot_id) WHERE c.intent_id=%s AND c.active AND o.state<>'available'",(identifier,)).fetchone():
                raise ExecutionError('execution_origin_unavailable')
            claim=conn.execute('SELECT * FROM nonce_claims WHERE intent_id=%s',(identifier,)).fetchone()
            conn.execute('INSERT INTO signer_heads(chain_id,signer,next_nonce) VALUES(4663,%s,%s) ON CONFLICT DO NOTHING',(signer.address,max(pending,latest)))
            head=conn.execute('SELECT next_nonce FROM signer_heads WHERE chain_id=4663 AND signer=%s FOR UPDATE',(signer.address,)).fetchone()
            nonce=int(claim['nonce']) if claim else max(int(head['next_nonce']),pending,latest)
            if claim and (claim['signer']!=signer.address or not claim['active'] or nonce<latest):
                raise ExecutionError('execution_nonce_ambiguous')
            if nonce>=2**64-1:raise ExecutionError('execution_nonce_exhausted')
            if not claim:
                # Global unique index also catches pre-journal reservations made
                # by another tenant. Conflict fails closed; never guesses a gap.
                conn.execute('INSERT INTO nonce_claims(owner,intent_id,chain_id,signer,nonce) VALUES(%s,%s,4663,%s,%s)',(owner,identifier,signer.address,nonce))
            envelope=signer.envelope({'plan':row['plan'],'observation':row['observation']},nonce)
            conn.execute('UPDATE signer_heads SET next_nonce=greatest(next_nonce,%s) WHERE chain_id=4663 AND signer=%s',(nonce+1,signer.address))
            self._fence(conn,identifier)
            conn.execute("INSERT INTO journal(owner,intent_id,state,signer,nonce,action,admission,envelope) VALUES(%s,%s,'signing',%s,%s,'compound_self_general_v3',%s,%s)",
                (owner,identifier,signer.address,nonce,Jsonb(signer.admission.model_dump(mode='json')),Jsonb(envelope)))
        self._transaction(owner,op,worker=worker,fence=fence)
        return self.read(owner,identifier)

    def state(self,owner,identifier,worker,fence,state,reason=''):
        if state not in ('signed','submitted','broadcast_unknown','included','reconciled','reverted','attention','reorged') or len(reason)>100 or any(c not in 'abcdefghijklmnopqrstuvwxyz_0123456789' for c in reason):
            raise ExecutionError('execution_invalid_state')
        def op(conn,owner):
            self._row(conn,owner,identifier);self._fence(conn,identifier)
            conn.execute('UPDATE journal SET state=%s,reason=%s,updated_at=clock_timestamp() WHERE intent_id=%s',(state,reason,identifier))
        self._transaction(owner,op,worker=worker,fence=fence)

    def persist_signed(self,owner,identifier,worker,fence,signer,*,replacement=False):
        def op(conn,owner):
            row=self._row(conn,owner,identifier);self._fence(conn,identifier)
            j=conn.execute('SELECT * FROM journal WHERE intent_id=%s FOR UPDATE',(identifier,)).fetchone()
            attempts=conn.execute('SELECT * FROM attempts WHERE intent_id=%s ORDER BY ordinal',(identifier,)).fetchall()
            if not j or j['signer']!=signer.address or j['admission']!=signer.admission.model_dump(mode='json'):
                raise ExecutionError('execution_signer_identity')
            if attempts and not replacement:return
            if replacement and (not attempts or len(attempts)>signer.policy.max_replacements):
                raise ExecutionError('execution_replacement_limit')
            if j['state'] not in ('signing','signed','submitted','broadcast_unknown'):
                raise ExecutionError('execution_state_conflict')
            # Replacement keeps nonce, recipient, gas, value and exact calldata.
            old=attempts[-1]['envelope'] if attempts else j['envelope']
            fee=old['maxFeePerGas']; priority=old['maxPriorityFeePerGas']
            if replacement:
                fee=max(fee+1,(fee*(10000+signer.policy.bump_bps)+9999)//10000)
                priority=max(priority+1,(priority*(10000+signer.policy.bump_bps)+9999)//10000)
            rebuilt=signer.envelope({'plan':row['plan'],'observation':row['observation']},int(j['nonce']),fee=fee,priority=priority)
            if {k:v for k,v in rebuilt.items() if k not in ('maxFeePerGas','maxPriorityFeePerGas')}!={k:v for k,v in j['envelope'].items() if k not in ('maxFeePerGas','maxPriorityFeePerGas')}:
                raise ExecutionError('execution_envelope_changed')
            raw,digest=signer.sign({'plan':row['plan'],'observation':row['observation']},rebuilt)
            self._fence(conn,identifier)
            conn.execute('INSERT INTO attempts(owner,intent_id,ordinal,envelope,transaction_hash,signed_bytes,fence) VALUES(%s,%s,%s,%s,%s,%s,%s)',
                (owner,identifier,len(attempts),Jsonb(rebuilt),digest,raw,fence))
            conn.execute("UPDATE journal SET state='signed',reason='',updated_at=clock_timestamp() WHERE intent_id=%s",(identifier,))
        # If the commit fails after signing, the previously committed signing
        # journal remains. A retry signs the same preimage; cancel stays blocked.
        self._transaction(owner,op,worker=worker,fence=fence)

    def record_effect(self,owner,identifier,worker,fence,result):
        result=json_record(result)
        if result.get('intentId')!=identifier or result.get('canonical') is not True or result.get('finalized') is not True:
            raise ExecutionError('execution_invalid_effect')
        def op(conn,owner):
            intent=self._row(conn,owner,identifier);self._fence(conn,identifier)
            if not conn.execute('SELECT 1 FROM attempts WHERE intent_id=%s AND transaction_hash=%s',(identifier,result['transactionHash'])).fetchone():
                raise ExecutionError('execution_effect_unknown_attempt')
            old=conn.execute('SELECT * FROM effects WHERE intent_id=%s FOR UPDATE',(identifier,)).fetchone()
            if old and old['canonical']:
                if old['receipt']!=result:raise ExecutionError('execution_effect_conflict')
                return
            if old and old['transaction_hash']!=result['transactionHash']:
                raise ExecutionError('execution_effect_conflict')
            block=result['block']
            if old:
                conn.execute('UPDATE effects SET canonical=true,block_number=%s,block_hash=%s,receipt=%s WHERE intent_id=%s',
                    (block['number'],block['hash'],Jsonb(result),identifier))
            else:
                conn.execute('INSERT INTO effects(owner,intent_id,transaction_hash,block_number,block_hash,canonical,receipt) VALUES(%s,%s,%s,%s,%s,true,%s)',
                    (owner,identifier,result['transactionHash'],block['number'],block['hash'],Jsonb(result)))
            self._settle(conn,owner,identifier,intent,result)
            conn.execute("UPDATE journal SET state='reconciled',reason='',updated_at=clock_timestamp() WHERE intent_id=%s",(identifier,))
        self._transaction(owner,op,worker=worker,fence=fence)

    @staticmethod
    def _settle(conn,owner,identifier,intent,result):
        """Atomically preserve realized origins, exact debits and unspent rest.

        Original allocations were proved exactly by E1; collection caps may
        exceed actual consumed fees. Remaining earned fees are not charged.
        """
        proof=result.get('e1Proof')
        if not proof or not proof.get('projection'):
            raise ExecutionError('execution_effect_unqualified')
        observation=_model(m.Observation,intent['observation'])
        sources={a.source.digest():a.source for a in observation.accruals}
        initial={b.lotId:int(b.amountRaw) for b in observation.balances}
        for raw in result['collections']:
            credit=_model(m.FeeCredit,raw);source=sources[credit.source];lot=credit.credit_id()
            initial[lot]=int(credit.amountRaw)
            previous=conn.execute('SELECT amount_raw,source_id,currency,transaction_hash,event_index FROM origins WHERE owner=%s AND lot_id=%s FOR UPDATE',(owner,lot)).fetchone()
            if previous:
                if (previous['amount_raw'],previous['source_id'],previous['currency'],previous['transaction_hash'],previous['event_index'])!=(int(credit.amountRaw),credit.source,source.currency,credit.transactionHash,credit.eventIndex):
                    raise ExecutionError('execution_effect_conflict')
            else:
                conn.execute("INSERT INTO origins(origin_id,owner,sequence_hash,source_id,lot_id,currency,kind,transaction_hash,event_index,amount_raw,state,source_record,evidence) VALUES(%s,%s,%s,%s,%s,%s,'original',%s,%s,%s,'available',%s,%s)",
                    (lot,owner,observation.sequence.digest(),credit.source,lot,source.currency,credit.transactionHash,credit.eventIndex,int(credit.amountRaw),
                     Jsonb(source.model_dump(mode='json')),Jsonb({'sequence':observation.sequence.model_dump(mode='json'),'credit':credit.model_dump(mode='json')})))
        for remaining in proof['projection']['remainingLots']:
            lot=remaining['lotId'];spent=initial[lot]-int(remaining['amountRaw'])
            if spent<=0:continue
            prior=conn.execute('SELECT amount_raw FROM spends WHERE intent_id=%s AND lot_id=%s',(identifier,lot)).fetchone()
            if prior and prior['amount_raw']!=spent:raise ExecutionError('execution_effect_conflict')
            if not prior:conn.execute('INSERT INTO spends(owner,intent_id,lot_id,amount_raw) VALUES(%s,%s,%s,%s)',(owner,identifier,lot,spent))
        for table in ('lot_claims','source_claims'):
            conn.execute(f'UPDATE {table} SET active=false WHERE owner=%s AND intent_id=%s AND active',(owner,identifier))

    def release_reverted(self,owner,identifier,worker,fence):
        def op(conn,owner):
            self._row(conn,owner,identifier);self._fence(conn,identifier)
            j=conn.execute('SELECT state FROM journal WHERE intent_id=%s',(identifier,)).fetchone()
            if not j or j['state']!='reverted':raise ExecutionError('execution_state_conflict')
            for table in ('lot_claims','source_claims'):
                conn.execute(f'UPDATE {table} SET active=false WHERE owner=%s AND intent_id=%s AND active',(owner,identifier))
        self._transaction(owner,op,worker=worker,fence=fence)

    def invalidate_effect(self,owner,identifier,worker,fence):
        def op(conn,owner):
            self._row(conn,owner,identifier);self._fence(conn,identifier)
            conn.execute('UPDATE effects SET canonical=false WHERE intent_id=%s',(identifier,))
            conn.execute("UPDATE journal SET state='reorged',reason='execution_canonical_receipt_lost',updated_at=clock_timestamp() WHERE intent_id=%s",(identifier,))
        self._transaction(owner,op,worker=worker,fence=fence)


class ExecutionRunner:
    """Explicit step, no unbounded polling or automatic replacement/failover.

    Run inside the signer process; an untrusted scheduler sends owner/intent
    identifiers only. Admission and gas policy come from private configuration.
    """
    def __init__(self,settings,signer,*,restore_only=True):
        self.store=UnsignedExecutionStore(settings)
        self.journal=ExecutionJournal(settings)
        self.signer=signer
        self.restore_only=restore_only

    def step(self,owner,identifier,worker,*,replace=False):
        lease=self.store.acquire(owner,identifier,worker,lease_seconds=300)
        fence=lease['fence']
        data=self.journal.read(owner,identifier)
        if not data['journal']:
            self.journal.prepare(owner,identifier,worker,fence,self.signer,restore_only=self.restore_only)
            self.journal.persist_signed(owner,identifier,worker,fence,self.signer)
        elif data['journal']['state']=='signing':
            self.journal.persist_signed(owner,identifier,worker,fence,self.signer)
        data=self.journal.read(owner,identifier)
        j=data['journal']; rpc=self.signer.rpc
        if g._quantity(rpc.request('eth_chainId',[]))!=4663:raise ExecutionError('execution_wrong_chain')
        # Every recorded attempt is checked: an earlier replacement can win.
        for attempt in data['attempts']:
            receipt=rpc.request('eth_getTransactionReceipt',[attempt['transaction_hash']])
            if receipt is None:continue
            block=g._header(rpc.request('eth_getBlockByNumber',[receipt['blockNumber'],False]))
            if block['hash']!=g._hash(receipt['blockHash']):continue
            if (g._hash(receipt['transactionHash'])!=attempt['transaction_hash'] or
                g._address(receipt['from'])!=j['signer'] or g._address(receipt['to'])!=attempt['envelope']['to']):
                raise ExecutionError('execution_receipt_identity')
            final=g._header(rpc.request('eth_getBlockByNumber',['finalized',False]))
            self._verify_inclusion(rpc,attempt,j,receipt,block,final)
            if final['number']<block['number']:
                self.journal.state(owner,identifier,worker,fence,'included')
                return self.journal.status(owner,identifier)
            if g._quantity(receipt['status'])==0:
                self.journal.state(owner,identifier,worker,fence,'reverted','execution_transaction_reverted')
                self.journal.release_reverted(owner,identifier,worker,fence)
                return self.journal.status(owner,identifier)
            cp, _ = self._stored_compound(data)
            try:
                result=g.CompoundReceiptReconciler(rpc).reconcile(cp,self.signer.admission,attempt['transaction_hash'],
                    e1_plan=_model(m.ExecutionPlan,data['intent']['plan']),observation=_model(m.Observation,data['intent']['observation']))
            except ValueError as error:
                code=str(error)
                self.journal.state(owner,identifier,worker,fence,'included' if code in TRANSIENT else 'attention',
                    'execution_receipt_pending' if code in TRANSIENT else 'execution_receipt_unqualified')
                return self.journal.status(owner,identifier)
            self.journal.record_effect(owner,identifier,worker,fence,result)
            return self.journal.status(owner,identifier)
        if data['effect'] and data['effect']['canonical']:
            self.journal.invalidate_effect(owner,identifier,worker,fence)
            return self.journal.status(owner,identifier)
        if j['state']=='included':
            self.journal.state(owner,identifier,worker,fence,'reorged','execution_canonical_receipt_lost')
        if j['state'] in ('attention','reorged','reverted','included','reconciled'):
            return self.journal.status(owner,identifier)
        pending=g._quantity(rpc.request('eth_getTransactionCount',[j['signer'],'pending']))
        latest=g._quantity(rpc.request('eth_getTransactionCount',[j['signer'],'latest']))
        if latest>int(j['nonce']):
            self.journal.state(owner,identifier,worker,fence,'attention','execution_nonce_consumed_without_receipt')
            return self.journal.status(owner,identifier)
        if replace:
            if self.restore_only:raise ExecutionError('execution_restore_reconciliation_required')
            self.journal.persist_signed(owner,identifier,worker,fence,self.signer,replacement=True)
            data=self.journal.read(owner,identifier)
        attempt=data['attempts'][-1]
        # Restoration never invents a new transaction. Exact recorded bytes can
        # be re-sent only after independent requalification of the same intent.
        try:
            self.signer.qualify(data['intent']['plan'],data['intent']['observation'])
        except ValueError:
            self.journal.state(owner,identifier,worker,fence,'attention','execution_revalidation_failed')
            return self.journal.status(owner,identifier)
        raw=bytes(attempt['signed_bytes'])
        verify_signed(raw,attempt['envelope'],j['signer'],attempt['transaction_hash'])
        # Hold the intent row and live fence through broadcast. Takeover cannot
        # race a stale worker past this boundary. A timeout is always ambiguous.
        def send(conn,owner):
            self.journal._row(conn,owner,identifier);self.journal._fence(conn,identifier)
            if not conn.execute('SELECT 1 FROM attempts WHERE transaction_hash=%s',(attempt['transaction_hash'],)).fetchone():
                raise ExecutionError('execution_unpersisted_attempt')
            try:
                reply=rpc.request('eth_sendRawTransaction',['0x'+raw.hex()])
                state='submitted' if g._hash(reply)==attempt['transaction_hash'] else 'broadcast_unknown'
            except Exception:
                state='broadcast_unknown'
            conn.execute('UPDATE journal SET state=%s,reason=%s,updated_at=clock_timestamp() WHERE intent_id=%s',
                (state,'' if state=='submitted' else 'execution_broadcast_ambiguous',identifier))
        self.journal._transaction(owner,send,worker=worker,fence=fence)
        return self.journal.status(owner,identifier)

    @staticmethod
    def _verify_inclusion(rpc,attempt,j,receipt,block,final):
        tx=rpc.request('eth_getTransactionByHash',[attempt['transaction_hash']])
        raw=rpc.request('eth_getBlockByNumber',[hex(block['number']),False])
        index=g._quantity(receipt.get('transactionIndex'))
        transactions=raw.get('transactions')
        e=attempt['envelope']
        if (type(tx) is not dict or g._header(raw)!=block or type(transactions) is not list
                or len(transactions)>g.MAX_TRANSACTIONS or index>=len(transactions)
                or g._hash(transactions[index])!=attempt['transaction_hash']
                or g._hash(tx.get('hash'))!=attempt['transaction_hash']
                or g._hash(tx.get('blockHash'))!=block['hash'] or g._quantity(tx.get('blockNumber'))!=block['number']
                or g._quantity(tx.get('transactionIndex'))!=index or g._quantity(tx.get('chainId'))!=4663
                or g._address(tx.get('from'))!=j['signer'] or g._address(tx.get('to'))!=e['to']
                or g._quantity(tx.get('nonce'))!=e['nonce'] or g._quantity(tx.get('value'))!=0
                or '0x'+g._hex(tx.get('input')).hex()!=e['data']
                or (final['number']==block['number'] and final!=block)):
            raise ExecutionError('execution_receipt_identity')

    @staticmethod
    def _stored_compound(data):
        from eth_abi import decode
        raw=bytes.fromhex(data['journal']['envelope']['data'][2:])
        values=decode([g.PLAN_TYPE],raw[4:])[0]
        record={name:'0x'+value.hex() if typ=='bytes32' else str(value) for (name,typ),value in zip(g.CompoundPlan.ABI,values)}
        compound=g.CompoundPlan.model_validate(record)
        if compound.calldata()!=data['journal']['envelope']['data']:
            raise ExecutionError('execution_envelope_changed')
        return compound,data['intent']
