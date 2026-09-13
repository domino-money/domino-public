"""Closed authenticated read-only execution status. No signing/cancellation API."""
from types import SimpleNamespace
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError, model_validator
from authenticated_api import AuthenticatedGateway, create_authenticated_app
from session_models import ERROR_STATUS
from execution_store import _Store, ExecutionStoreError
from read_deadline import check_read_deadline

CONTRACT_VERSION='1.0.0-rc.1'
PREFIX='/internal/execution/v1/'
HEADER='X-Domino-Execution-Contract'
ERROR_STATUS_BY_CODE={**ERROR_STATUS,'execution_capacity_busy':429,'execution_store_unavailable':503,
                      'onboarding_rate_limited':429,'onboarding_capacity_busy':429}
MAX_BODY=2048
MAX_RESPONSE=131072

class ExecutionStatusError(Exception):
    def __init__(self,code):
        self.code=code if code in ERROR_STATUS_BY_CODE else 'upstream_unavailable'
        self.status=ERROR_STATUS_BY_CODE[self.code]
        super().__init__(self.code)

class Record(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True,regex_engine='python-re')
Hash=Annotated[str,Field(pattern=r'^0x[0-9a-f]{64}$(?![\s\S])',min_length=66,max_length=66)]
Address=Annotated[str,Field(pattern=r'^0x[0-9a-f]{40}$(?![\s\S])',min_length=42,max_length=42)]
Raw=Annotated[str,Field(pattern=r'^(0|[1-9][0-9]{0,77})$(?![\s\S])',max_length=78)]
State=Literal['planned','reserved','cancelled','signing','signed','submitted','broadcast_unknown','included','reconciled','reverted','attention','reorged']

class StatusRequest(Record):
    intentId:Hash
class ListRequest(Record):
    # Plain keyset position, not an authority bearer. Every query still binds
    # the authenticated owner; a foreign position reveals no foreign rows.
    afterIntentId:Hash|None=None
    limit:Annotated[StrictInt,Field(ge=1,le=20)]=10
class Attempt(Record):
    ordinal:Annotated[StrictInt,Field(ge=0,le=3)]
    transactionHash:Hash
class SourceAmounts(Record):
    sourceId:Hash
    currency:Address
    grossOriginalConsumedRaw:Raw
    chargedConsumedRaw:Raw
    serviceFeeRaw:Raw
    liquidityAddedRaw:Raw
    originalAfterRaw:Raw
    chargedAfterRaw:Raw
class Receipt(Record):
    transactionHash:Hash
    blockNumberRaw:Raw
    blockHash:Hash
    canonical:Literal[True]
    finalized:Literal[True]
    serviceFeeBps:Annotated[StrictInt,Field(ge=0,le=200)]
    serviceFeeRecipient:Address
    liquidityIncreaseRaw:Raw
    sources:Annotated[list[SourceAmounts],Field(min_length=1,max_length=128)]
    fullL2CostWei:None
class Status(Record):
    intentId:Hash
    sequenceHash:Hash
    state:State
    reason:Annotated[str,Field(pattern=r'^[a-z0-9_]{0,100}$(?![\s\S])')]
    signer:Address|None
    nonceRaw:Raw|None
    attempts:Annotated[list[Attempt],Field(max_length=4)]
    receipt:Receipt|None
    canCancel:bool
    @model_validator(mode='after')
    def coherent(self):
        if (self.canCancel!=(self.state in ('planned','reserved')) or
            (self.receipt is not None and self.state!='reconciled') or
            (self.state=='reconciled' and self.receipt is None) or
            (self.signer is None)!=(self.nonceRaw is None)):
            raise ValueError('execution_status_inconsistent')
        return self
class StatusResponse(Record):
    contractVersion:Literal[CONTRACT_VERSION]
    chainId:Literal[4663]
    owner:Address
    item:Status|None
    executionAvailable:Literal[False]
class ListResponse(Record):
    contractVersion:Literal[CONTRACT_VERSION]
    chainId:Literal[4663]
    owner:Address
    items:Annotated[list[Status],Field(max_length=20)]
    nextAfterIntentId:Hash|None
    executionAvailable:Literal[False]
REQUEST_MODELS={'status':StatusRequest,'list':ListRequest}
RESPONSE_MODELS={'status':StatusResponse,'list':ListResponse}
def validate_request(route,body):
    try:return REQUEST_MODELS[route].model_validate(body).model_dump(mode='json')
    except (KeyError,ValidationError,ValueError,TypeError):raise ExecutionStatusError('invalid_request') from None
def validate_response(route,body):
    try:return RESPONSE_MODELS[route].model_validate(body).model_dump(mode='json')
    except (KeyError,ValidationError,ValueError,TypeError):raise ExecutionStatusError('upstream_invalid_response') from None

class ExecutionStatusReader(_Store):
    role='domino_execution_reader'
    def list(self,owner,*,identifier=None,after=None,limit=10):
        def op(conn,owner):
            # This role has no UPDATE privilege and cannot SELECT envelope,
            # plan, observation, origin evidence or signed_bytes columns.
            rows=conn.execute('SELECT i.intent_id,i.sequence_hash,i.state AS intent_state,j.state,j.reason,j.signer,j.nonce '
                'FROM intents i LEFT JOIN journal j USING(owner,intent_id) WHERE i.owner=%s '
                'AND (%s::text IS NULL OR i.intent_id=%s) AND (%s::text IS NULL OR i.intent_id>%s) ORDER BY i.intent_id LIMIT %s',
                (owner,identifier,identifier,after,after,limit)).fetchall()
            result=[]
            for row in rows:
                identifier_=row['intent_id']
                attempts=conn.execute('SELECT ordinal,transaction_hash FROM attempts WHERE owner=%s AND intent_id=%s ORDER BY ordinal',(owner,identifier_)).fetchall()
                effect=conn.execute('SELECT receipt,canonical FROM effects WHERE owner=%s AND intent_id=%s',(owner,identifier_)).fetchone()
                state=row['state'] or row['intent_state']
                receipt=None
                if effect and effect['canonical'] and state=='reconciled':
                    raw=effect['receipt']; block=raw['block']
                    receipt={'transactionHash':raw['transactionHash'],'blockNumberRaw':str(block['number']),'blockHash':block['hash'],
                        'canonical':True,'finalized':True,'serviceFeeBps':raw['serviceFeeBps'],'serviceFeeRecipient':raw['serviceFeeRecipient'],
                        'liquidityIncreaseRaw':raw['liquidityIncreaseRaw'],'fullL2CostWei':None,
                        'sources':[{name:s[name] for name in SourceAmounts.model_fields} for s in raw['sources']]}
                result.append({'intentId':identifier_,'sequenceHash':row['sequence_hash'],'state':state,'reason':row['reason'] or '',
                    'signer':row['signer'],'nonceRaw':str(row['nonce']) if row['nonce'] is not None else None,
                    'attempts':[{'ordinal':a['ordinal'],'transactionHash':a['transaction_hash']} for a in attempts],
                    'receipt':receipt,'canCancel':row['state'] is None and state in ('planned','reserved')})
            return result
        return self._transaction(owner,op)

class ExecutionStatusService:
    def __init__(self,auth,reader):self.auth,self.reader=auth,reader
    def execute(self,route,body,*,client,session,csrf):
        request=validate_request(route,body);check_read_deadline()
        context=self.auth.begin(client,session,csrf);owner=context['owner']
        try:
            if route=='status':
                items=self.reader.list(owner,identifier=request['intentId'],limit=1)
                body={'item':items[0] if items else None}
            else:
                items=self.reader.list(owner,after=request['afterIntentId'],limit=request['limit']+1)
                more=len(items)>request['limit'];items=items[:request['limit']]
                body={'items':items,'nextAfterIntentId':items[-1]['intentId'] if more else None}
            # No store owner, bearer, cursor or client-selected signer is trusted
            # to supply the principal. Reauthentication follows the final read.
            self.auth.finish(context);check_read_deadline()
            result={'contractVersion':CONTRACT_VERSION,'chainId':4663,'owner':owner,'executionAvailable':False,**body}
            return validate_response(route,result)
        except ExecutionStoreError:raise ExecutionStatusError('execution_store_unavailable') from None

CONTRACT=SimpleNamespace(PREFIX=PREFIX,HEADER=HEADER,Error=ExecutionStatusError,CONTRACT_VERSION=CONTRACT_VERSION,
    MAX_BODY=MAX_BODY,MAX_RESPONSE=MAX_RESPONSE,REQUEST_MODELS=REQUEST_MODELS,CAPACITY_CODE='execution_capacity_busy',
    validate_request=validate_request,validate_response=validate_response)
class ExecutionStatusGateway(AuthenticatedGateway):
    def __init__(self,**kwargs):super().__init__(contract=CONTRACT,**kwargs)
def create_execution_status_app(gateway=None):
    return create_authenticated_app(gateway or ExecutionStatusGateway())
