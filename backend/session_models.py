"""Fixed wallet-session boundary; no financial or tenant authority is accepted."""
from datetime import datetime, timezone
import re
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, RootModel, StrictInt, field_validator

CONTRACT_VERSION = '3.0.0-rc.4'
CHAIN_ID = 4663
POLICY_VERSION = 'eoa_or_7702_v1'
MAX_BODY = 8192
ERROR_STATUS = {
    'invalid_request':400, 'session_required':401, 'preauth_required':401,
    'invalid_signature':401, 'challenge_invalid':401, 'origin_not_allowed':403,
    'csrf_invalid':403, 'account_unsupported':403, 'route_not_available':404,
    'method_not_allowed':405, 'session_exists':409, 'request_too_large':413,
    'json_required':415, 'session_rate_limited':429, 'session_capacity_busy':429,
    'upstream_invalid_response':502, 'upstream_contract_mismatch':502,
    'session_store_unavailable':503, 'account_check_unavailable':503,
    'upstream_unavailable':503, 'request_timeout':504, 'upstream_timeout':504,
}
ERROR_STATUS_BY_CODE = ERROR_STATUS
ROUTES = frozenset(('bootstrap','challenge','verify','me','refresh','logout'))
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}\Z')
ADDRESS = re.compile(r'0x[0-9a-fA-F]{40}\Z')
DELEGATION = re.compile(r'0xef0100([0-9a-f]{40})\Z')
ZERO_ADDRESS = '0x' + '0'*40


class SessionError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_STATUS else 'upstream_unavailable'
        self.status = ERROR_STATUS[self.code]
        super().__init__(self.code)


def token(value, *, required=None):
    if value is None:
        if required:raise SessionError(required)
        return None
    if not isinstance(value,str) or not TOKEN.fullmatch(value):
        raise SessionError('invalid_request')
    return value


def utc(value):
    return value.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')


def validate_body(route, value):
    expected={'challenge':{'address','chainId'},'verify':{'challengeId','message','signature'}}.get(route,set())
    if route not in ROUTES or not isinstance(value,dict) or set(value)!=expected:
        raise SessionError('invalid_request')
    if route=='challenge':
        if (not isinstance(value['address'],str) or not ADDRESS.fullmatch(value['address']) or
                type(value['chainId']) is not int or value['chainId']!=CHAIN_ID):
            raise SessionError('invalid_request')
    if route=='verify':
        try:
            if (not isinstance(value['challengeId'],str) or not re.fullmatch(r'[0-9a-f]{32}',value['challengeId']) or
                    not isinstance(value['message'],str) or not 1<=len(value['message'].encode('utf-8'))<=2048 or
                    not isinstance(value['signature'],str) or not re.fullmatch(r'0x[0-9a-fA-F]{130}',value['signature'])):
                raise ValueError()
        except (ValueError,UnicodeError):
            raise SessionError('invalid_request') from None
    return value


def account_code(code):
    """What an account's code at a pinned block says it is, or None.

    Empty code is a plain EOA. EIP-7702 writes exactly the 23-byte designator
    0xef0100 || delegate; the account's own key still signs for it, so a SIWE
    signature keeps proving control. Any other code is a contract account, and
    a designator naming the zero address cannot exist (EIP-7702 clears the code
    instead), so neither is an EOA here.
    """
    if code=='0x':
        return {'method':'plain_eoa'}
    # Hex digits in either case, never a 0X prefix.
    match=DELEGATION.fullmatch(code[:2]+code[2:].lower()) if isinstance(code,str) else None
    if match is None or int(match.group(1),16)==0:
        return None
    return {'method':'eip7702_delegated','delegate':'0x'+match.group(1)}


def validate_account(value):
    keys={'method','blockNumber','blockHash'}|({'delegate'} if isinstance(value,dict)
                                                 and value.get('method')=='eip7702_delegated' else set())
    if (not isinstance(value,dict) or set(value)!=keys or
            value['method'] not in ('plain_eoa','eip7702_delegated') or not isinstance(value['blockNumber'],str) or
            not re.fullmatch(r'(0|[1-9][0-9]{0,19})',value['blockNumber']) or
            not isinstance(value['blockHash'],str) or not re.fullmatch(r'0x[0-9a-f]{64}',value['blockHash']) or
            ('delegate' in keys and (not isinstance(value['delegate'],str) or
                                     not re.fullmatch(r'0x[0-9a-f]{40}',value['delegate']) or
                                     value['delegate']==ZERO_ADDRESS))):
        raise SessionError('account_check_unavailable')
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


def _timestamp(value):
    datetime.fromisoformat(value.replace('Z','+00:00'))
    return value


def _message(value):
    try:
        if not 1<=len(value.encode('utf-8'))<=2048:raise ValueError('message_byte_limit')
    except UnicodeError:
        raise ValueError('invalid_utf8') from None
    return value


Token = Annotated[str, Field(pattern=r'^[A-Za-z0-9_-]{43}$')]
Timestamp = Annotated[str, Field(pattern=r'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$'), AfterValidator(_timestamp)]
Message = Annotated[str, Field(min_length=1, max_length=2048), AfterValidator(_message)]
Chain = Annotated[StrictInt, Field(ge=CHAIN_ID, le=CHAIN_ID)]


class EmptyRequest(StrictModel):
    pass


class ChallengeRequest(StrictModel):
    address: Annotated[str, Field(pattern=r'^0x[0-9a-fA-F]{40}$')]
    chainId: Chain


class VerifyRequest(StrictModel):
    challengeId: Annotated[str, Field(pattern=r'^[0-9a-f]{32}$')]
    message: Message
    signature: Annotated[str, Field(pattern=r'^0x[0-9a-fA-F]{130}$')]


class BootstrapResult(StrictModel):
    status: Literal['challenge_required']
    csrfToken: Token
    expiresAt: Timestamp


class ChallengeResult(StrictModel):
    challengeId: Annotated[str, Field(pattern=r'^[0-9a-f]{32}$')]
    message: Message
    expiresAt: Timestamp


class Owner(StrictModel):
    address: Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$')]
    chainId: Chain


def _delegate(value):
    if value==ZERO_ADDRESS:raise ValueError('zero_delegate')
    return value


class PlainEoaValidation(StrictModel):
    method: Literal['plain_eoa']
    blockNumber: Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,19})$')]
    blockHash: Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$')]


class DelegatedEoaValidation(StrictModel):
    """An EOA carrying an EIP-7702 designator; its own key still signs."""
    method: Literal['eip7702_delegated']
    blockNumber: Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,19})$')]
    blockHash: Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$')]
    delegate: Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$'), AfterValidator(_delegate)]


class AccountValidation(RootModel[Annotated[PlainEoaValidation | DelegatedEoaValidation, Field(discriminator='method')]]):
    model_config = ConfigDict(strict=True)


class AuthenticatedResult(StrictModel):
    authenticated: Literal[True]
    owner: Owner
    expiresAt: Timestamp
    csrfToken: Token
    validation: AccountValidation

    @field_validator('authenticated', mode='before')
    @classmethod
    def strict_bool(cls,value):
        if type(value) is not bool:raise ValueError('boolean_required')
        return value


class LogoutResult(StrictModel):
    authenticated: Literal[False]

    @field_validator('authenticated', mode='before')
    @classmethod
    def strict_bool(cls,value):
        if type(value) is not bool:raise ValueError('boolean_required')
        return value


REQUEST_MODELS = {'bootstrap': EmptyRequest, 'challenge': ChallengeRequest,
                  'verify': VerifyRequest, 'me': EmptyRequest, 'refresh': EmptyRequest, 'logout': EmptyRequest}
RESPONSE_MODELS = {'bootstrap': BootstrapResult, 'challenge': ChallengeResult,
                   'verify': AuthenticatedResult, 'me': AuthenticatedResult, 'refresh': AuthenticatedResult,
                   'logout': LogoutResult}
