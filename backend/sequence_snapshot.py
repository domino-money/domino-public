"""Closed, read-only V1 sequence snapshot from the configured local RPC.

The request supplies only an owner and an optional NFT id. Contract addresses,
selectors, gas, block selection and the maximum number of reads are fixed here.
The ABI results are carried as named hex values so the browser can run its
existing local decoder and identity checks over one canonical snapshot.
"""
import json
from pathlib import Path
import re

from eth_abi import encode
from eth_hash.auto import keccak
from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator
from typing import Annotated

from discovery import CHAIN_ID, DataError, decode_result


CONTRACT_VERSION = '1.0.0-rc.1'
Address = Annotated[str, StringConstraints(strict=True, pattern=r'^0x[0-9a-f]{40}$')]
TokenId = Annotated[str, StringConstraints(strict=True, pattern=r'^(0|[1-9][0-9]{0,77})$')]
RELEASE_PATH = Path(__file__).resolve().parents[1] / 'docs/deployments/v1-robinhood-mainnet-2026-09-21/sequence-release.json'
FACTORY = '0x16bf6eaba7b31118627b277e97249720dfe1c7ff'
POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
ROLES = ('factory', 'implementation', 'poolManager', 'positionManager', 'stateView',
         'readHelper', 'engine', 'routing', 'priceGuard')
STATIC_CALLS = {
    'factory': ('implementation', 'implementationCodeHash', 'poolManager',
                'positionManager', 'stateView', 'serviceFeeRecipient'),
    'implementation': ('factory', 'implementation', 'implementationVersion',
                       'poolManager', 'positionManager', 'stateView',
                       'serviceFeeRecipient', 'readHelper', 'executionEngine',
                       'readHelperCodeHash', 'executionEngineCodeHash',
                       'poolManagerCodeHash', 'positionManagerCodeHash',
                       'stateViewCodeHash'),
    'positionManager': ('poolManager',),
    'stateView': ('poolManager',),
    'readHelper': ('positionManager', 'stateView'),
    'engine': ('factory', 'readHelper', 'routingHelper', 'priceGuard',
               'readHelperHash', 'routingHelperHash', 'priceGuardHash'),
    'priceGuard': ('publisher',),
}


class SequenceSnapshotRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    owner: Address
    tokenId: TokenId | None = None

    @model_validator(mode='after')
    def valid_token(self):
        if self.tokenId is not None and (int(self.tokenId) == 0 or int(self.tokenId) >= 2**256):
            raise ValueError('nonzero uint256 NFT id required')
        return self


def deployment():
    """Source-controlled, public deployment; never request- or env-selected."""
    data = json.loads(RELEASE_PATH.read_text())
    if data.get('chainId') != CHAIN_ID or data.get('contractVersion') != CONTRACT_VERSION:
        raise DataError('upstream_unavailable')
    d = data.get('deployment')
    if not isinstance(d, dict) or d.get('factory') != FACTORY or d.get('positionManager') != POSITION_MANAGER:
        raise DataError('upstream_unavailable')
    if any(not isinstance(d.get(role), str) or not re.fullmatch(r'0x[0-9a-f]{40}', d[role]) for role in ROLES):
        raise DataError('upstream_unavailable')
    return d


def _hex(value, maximum=200_002):
    if not isinstance(value, str) or len(value) > maximum or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', value):
        raise DataError('upstream_invalid_response')
    return value.lower()


def _batch(rpc, specs):
    """Bounded independent reads; no input can add a selector or destination."""
    output = []
    for start in range(0, len(specs), 8):
        group = specs[start:start + 8]
        if getattr(rpc, 'batch_reads', False):
            answers = rpc.batch([(method, params) for _, method, params in group])
        else:
            answers = [rpc.request(method, params) for _, method, params in group]
        output.extend((name, _hex(answer)) for (name, _, _), answer in zip(group, answers, strict=True))
    return dict(output)


def _call(rpc, name, target, signature, block, inputs=(), values=()):
    return name, 'eth_call', rpc.call_params(target, signature, inputs, values, block=block)


def _code(name, target, block):
    return name, 'eth_getCode', [target, block]


def _identity(d, owner, nonce):
    domain = keccak(b'DominoSequence(uint256 chainId,address factory,address owner,uint256 nonce)')
    sequence_id = keccak(encode(('bytes32', 'uint256', 'address', 'address', 'uint256'),
                                (domain, CHAIN_ID, d['factory'], owner, nonce)))
    runtime = bytes.fromhex('363d3d373d3d3d363d73' + d['implementation'][2:] + '5af43d82803e903d91602b57fd5bf3')
    init_hash = keccak(bytes.fromhex('3d602d80600a3d3981f3') + runtime)
    vault = keccak(b'\xff' + bytes.fromhex(d['factory'][2:]) + sequence_id + init_hash)[12:]
    return '0x' + sequence_id.hex(), '0x' + vault.hex()


def sequence_snapshot(rpc, owner, token_id=None):
    request = SequenceSnapshotRequest.model_validate({'owner': owner, 'tokenId': token_id})
    d = deployment()
    if rpc.request('eth_chainId', []) != hex(CHAIN_ID):
        raise DataError('chain_mismatch')
    header = rpc.request('eth_getBlockByNumber', ['finalized', False])
    if (not isinstance(header, dict) or not isinstance(header.get('number'), str)
            or not re.fullmatch(r'0x(?:0|[1-9a-f][0-9a-f]*)', header['number'])
            or not isinstance(header.get('hash'), str)
            or not re.fullmatch(r'0x[0-9a-fA-F]{64}', header['hash'])):
        raise DataError('upstream_invalid_response')
    number = int(header['number'], 16)
    if number > 2**53 - 1:
        raise DataError('upstream_invalid_response')
    block = hex(number)
    code_specs = [_code(role, d[role], block) for role in ROLES]
    code_specs += [_code('operator', d['operator'], block), _code('pricePublisher', d['pricePublisher'], block)]
    codes = _batch(rpc, code_specs)
    calls = {}
    for role, fields in STATIC_CALLS.items():
        results = _batch(rpc, [_call(rpc, name, d[role], name + '()', block) for name in fields])
        calls[role] = results
    nonce_raw = _hex(rpc.call_raw(d['factory'], 'nextOwnerNonce(address)', ['address'], [request.owner], block=block))
    nonce, = decode_result(['uint256'], nonce_raw)
    if nonce > 2**256 - 1:
        raise DataError('upstream_invalid_response')
    calls['factory']['nextOwnerNonce'] = nonce_raw
    recent = []
    for value in range(nonce - 1, max(-1, nonce - 9), -1):
        sequence_id, vault = _identity(d, request.owner, value)
        registered = _hex(rpc.call_raw(d['factory'], 'vaultForSequence(bytes32)', ['bytes32'],
                                       [bytes.fromhex(sequence_id[2:])], block=block))
        recent.append({'ownerNonce': str(value), 'sequenceId': sequence_id,
                       'vault': vault, 'vaultForSequence': registered})
    root = None
    if request.tokenId is not None:
        token = int(request.tokenId)
        owner_of = _hex(rpc.call_raw(d['positionManager'], 'ownerOf(uint256)', ['uint256'], [token], block=block))
        key_raw = _hex(rpc.call_raw(d['positionManager'], 'getPoolAndPositionInfo(uint256)', ['uint256'], [token], block=block))
        key, _ = decode_result(['(address,address,uint24,int24,address)', 'uint256'], key_raw)
        if len(key) != 5:
            raise DataError('upstream_invalid_response')
        currency0, currency1 = str(key[0]).lower(), str(key[1]).lower()
        predicted_id, predicted_vault = _identity(d, request.owner, nonce)
        root_calls = _batch(rpc, [
            _call(rpc, 'getApproved', d['positionManager'], 'getApproved(uint256)', block, ['uint256'], [token]),
            _call(rpc, 'predictVault', d['factory'], 'predictVault(address,uint256)', block,
                  ['address', 'uint256'], [request.owner, nonce]),
        ])
        root_codes = _batch(rpc, [_code('currency0', currency0, block),
                                  _code('currency1', currency1, block),
                                  _code('predictedVault', predicted_vault, block)])
        root = {'tokenId': request.tokenId, 'ownerOf': owner_of,
                'getPoolAndPositionInfo': key_raw, 'getApproved': root_calls['getApproved'],
                'predictVault': root_calls['predictVault'], 'predictedSequenceId': predicted_id,
                'predictedVault': predicted_vault, 'currency0': currency0,
                'currency1': currency1, 'code': root_codes}
    after = rpc.request('eth_getBlockByNumber', [block, False])
    if not isinstance(after, dict) or after.get('hash', '').lower() != header['hash'].lower():
        raise DataError('chain_changed')
    return {'schemaVersion': 1, 'contractVersion': CONTRACT_VERSION, 'chainId': CHAIN_ID,
            'owner': request.owner, 'tokenId': request.tokenId, 'blockNumber': number,
            'blockHash': header['hash'].lower(), 'code': codes, 'calls': calls,
            'recent': recent, 'root': root}


def validate_snapshot_response(route, body):
    if route != 'sequence-snapshot' or type(body) is not dict or set(body) != {
            'schemaVersion', 'contractVersion', 'chainId', 'owner', 'tokenId', 'blockNumber',
            'blockHash', 'code', 'calls', 'recent', 'root'}:
        raise ValueError('invalid_snapshot')
    if (body['schemaVersion'] != 1 or body['contractVersion'] != CONTRACT_VERSION or body['chainId'] != CHAIN_ID
            or not isinstance(body['owner'], str)
            or not re.fullmatch(r'0x[0-9a-f]{40}', body['owner'])
            or body['tokenId'] is not None and (not isinstance(body['tokenId'], str)
                                              or not re.fullmatch(r'[1-9][0-9]{0,77}', body['tokenId'])
                                              or int(body['tokenId']) >= 2**256)
            or type(body['blockNumber']) is not int or not 0 <= body['blockNumber'] <= 2**53-1
            or not isinstance(body['blockHash'], str)
            or not re.fullmatch(r'0x[0-9a-f]{64}', body['blockHash'])):
        raise ValueError('invalid_snapshot')
    code = body['code']
    if type(code) is not dict or set(code) != {*ROLES, 'operator', 'pricePublisher'}:
        raise ValueError('invalid_snapshot')
    if any(_hex(value) != value for value in code.values()):
        raise ValueError('invalid_snapshot')
    calls = body['calls']
    if type(calls) is not dict or set(calls) != set(STATIC_CALLS):
        raise ValueError('invalid_snapshot')
    for role, fields in STATIC_CALLS.items():
        expected = set(fields) | ({'nextOwnerNonce'} if role == 'factory' else set())
        if type(calls[role]) is not dict or set(calls[role]) != expected:
            raise ValueError('invalid_snapshot')
        if any(_hex(value, 16_386) != value for value in calls[role].values()):
            raise ValueError('invalid_snapshot')
    recent = body['recent']
    if type(recent) is not list or len(recent) > 8:
        raise ValueError('invalid_snapshot')
    for row in recent:
        if type(row) is not dict or set(row) != {'ownerNonce', 'sequenceId', 'vault', 'vaultForSequence'}:
            raise ValueError('invalid_snapshot')
        if (not isinstance(row['ownerNonce'], str) or not re.fullmatch(r'(0|[1-9][0-9]{0,77})', row['ownerNonce'])
                or int(row['ownerNonce']) >= 2**256 or
                not re.fullmatch(r'0x[0-9a-f]{64}', row['sequenceId']) or
                not re.fullmatch(r'0x[0-9a-f]{40}', row['vault']) or
                _hex(row['vaultForSequence'], 16_386) != row['vaultForSequence']):
            raise ValueError('invalid_snapshot')
    root = body['root']
    if body['tokenId'] is None:
        if root is not None:
            raise ValueError('invalid_snapshot')
    else:
        if type(root) is not dict or set(root) != {'tokenId', 'ownerOf', 'getPoolAndPositionInfo',
                'getApproved', 'predictVault', 'predictedSequenceId', 'predictedVault',
                'currency0', 'currency1', 'code'} or root['tokenId'] != body['tokenId']:
            raise ValueError('invalid_snapshot')
        for name in ('ownerOf', 'getPoolAndPositionInfo', 'getApproved', 'predictVault'):
            if _hex(root[name], 16_386) != root[name]:
                raise ValueError('invalid_snapshot')
        if (not re.fullmatch(r'0x[0-9a-f]{64}', root['predictedSequenceId'])
                or any(not re.fullmatch(r'0x[0-9a-f]{40}', root[name])
                       for name in ('predictedVault', 'currency0', 'currency1'))
                or type(root['code']) is not dict
                or set(root['code']) != {'currency0', 'currency1', 'predictedVault'}
                or any(_hex(value) != value for value in root['code'].values())):
            raise ValueError('invalid_snapshot')
