"""The S1 plan's wire forms: zap call data, routes hash, intent hash and the typed data a wallet signs.

Everything here is computed from the F0/F2 exports, never re-declared:
- the zap's functions come from api-contracts/v2/abi (IDominoPositionActions,
  IDominoZap) through v2_abi, so a call is encoded with the exported tuple
  types and selectors;
- the EIP-712 types and typehashes come from api-contracts/v2/eip712.json
  (generated from DominoV2Types.sol and DominoV2RelayTypes.sol), and the
  hashes below reproduce api-contracts/v2/eip712-goldens.json
  (tests/test_v2_plan_codec.py).

JSON forms (what the API returns and the app signs) follow the goldens: uint8,
uint16, uint24, int24 and bool as JSON numbers and booleans; every wider
integer (amounts, liquidity, token ids, nonces, deadlines, prices) as a
decimal string; addresses lower case; bytes and bytes32 as 0x hex.

Three ways to consent (docs/v2/F2_ZAP.md, "Consent"):
- direct: the owner sends create/increase/changeRange/exit; intent.nonce is
  not read (0 here) but is part of the intent hash;
- permit2: createWithPermit/increaseWithPermit with a PermitBatchWitness-
  TransferFrom signature, the intent as witness, permit.nonce = intent.nonce;
- relayed: changeRangeWithSignature/exitWithSignature with a
  RelayedPositionAction signature on the Domino domain (no relayer exists at
  launch: the path is built and tested, not offered by the app).
"""
from functools import lru_cache
import json
from pathlib import Path

from eth_abi import decode, encode
from eth_hash.auto import keccak

from v2_abi import function

ROOT = Path(__file__).resolve().parents[1]
EIP712_EXPORT = ROOT / 'api-contracts/v2/eip712.json'
ZERO = '0x' + '00' * 20
PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
ACTIONS = {'create': 1, 'increase': 2, 'changeRange': 3, 'exit': 4}
LEG_UNIVERSAL_ROUTER, LEG_V3_POOL, LEG_V4_POOL = 1, 2, 3
POOL_REF_TYPE = '(uint8,address,address,uint24,int24,address)'
LEG_TYPE = '(uint8,address,address,address,uint128,uint128,bytes)'
TOKEN_PERMISSIONS_TYPE = 'TokenPermissions(address token,uint256 amount)'
EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
PERMIT2_DOMAIN_TYPE = 'EIP712Domain(string name,uint256 chainId,address verifyingContract)'
U128 = (1 << 128) - 1
U160 = (1 << 160) - 1
U256 = (1 << 256) - 1

# Which zap function each action and consent path calls (IDominoPositionActions / IDominoZap).
FUNCTIONS = {
    ('create', 'direct'): ('IDominoPositionActions', 'create'),
    ('create', 'permit2'): ('IDominoPositionActions', 'createWithPermit'),
    ('increase', 'direct'): ('IDominoPositionActions', 'increase'),
    ('increase', 'permit2'): ('IDominoPositionActions', 'increaseWithPermit'),
    ('changeRange', 'direct'): ('IDominoPositionActions', 'changeRange'),
    ('changeRange', 'relayed'): ('IDominoZap', 'changeRangeWithSignature'),
    ('exit', 'direct'): ('IDominoPositionActions', 'exit'),
    ('exit', 'relayed'): ('IDominoZap', 'exitWithSignature'),
}


class CodecError(ValueError):
    """A plan that cannot be encoded as the zap's types (a fixed code)."""


def hexed(value):
    return '0x' + bytes(value).hex()


def _address(value):
    if not isinstance(value, str) or len(value) != 42 or not value.startswith('0x'):
        raise CodecError('plan_address_invalid')
    int(value[2:], 16)
    return value.lower()


def _uint(value, maximum):
    number = int(value) if isinstance(value, str) else value
    if type(number) is not int or not 0 <= number <= maximum:
        raise CodecError('plan_integer_invalid')
    return number


def _bytes(value):
    if not isinstance(value, str) or not value.startswith('0x') or len(value) % 2:
        raise CodecError('plan_bytes_invalid')
    return bytes.fromhex(value[2:])


@lru_cache(maxsize=1)
def eip712_export():
    """api-contracts/v2/eip712.json, with each typehash checked against its encoded type."""
    export = json.loads(EIP712_EXPORT.read_text())
    for name, encoded in export['encodedTypes'].items():
        if hexed(keccak(encoded.encode())) != export['typehashes'][name]:
            raise CodecError('eip712_export_inconsistent')
    if hexed(keccak(export['permit2']['fullType'].encode())) != export['permit2']['fullTypehash']:
        raise CodecError('eip712_export_inconsistent')
    return export


def _typehash(name):
    return bytes.fromhex(eip712_export()['typehashes'][name][2:])


# ------------------------------------------------------------------ tuples

def pool_tuple(pool):
    return (_uint(pool['dex'], 255), _address(pool['currency0']), _address(pool['currency1']),
            _uint(pool['fee'], 2**24 - 1), int(pool['tickSpacing']), _address(pool['hooks']))


def leg_tuple(leg):
    return (_uint(leg['kind'], 255), _address(leg['router']), _address(leg['tokenIn']), _address(leg['tokenOut']),
            _uint(leg['amountIn'], U128), _uint(leg['minAmountOut'], U128), _bytes(leg['data']))


def intent_tuple(intent):
    return (_uint(intent['action'], 255), pool_tuple(intent['pool']), _uint(intent['tokenId'], U256),
            int(intent['tickLower']), int(intent['tickUpper']), _uint(intent['minLiquidity'], U128),
            _uint(intent['feeBps'], 2**16 - 1), _address(intent['feeToken']), _bytes(intent['routesHash']),
            _address(intent['recipient']), _uint(intent['nonce'], U256), _uint(intent['deadline'], 2**64 - 1))


def token_amount_tuple(item):
    return (_address(item['token']), _uint(item['amount'], U128))


def plan_tuple(action, plan):
    """The plan struct of `action` in its ABI field order (IDominoPositionActions)."""
    intent = intent_tuple(plan['intent'])
    legs = [leg_tuple(leg) for leg in plan['legs']]
    if action == 'create':
        return (intent, [token_amount_tuple(i) for i in plan['inputs']], legs, _uint(plan['amount0Max'], U128),
                _uint(plan['amount1Max'], U128), _uint(plan['initSqrtPriceX96'], U160))
    if action == 'increase':
        return (intent, [token_amount_tuple(i) for i in plan['inputs']], legs, _uint(plan['amount0Max'], U128),
                _uint(plan['amount1Max'], U128))
    if action == 'changeRange':
        return (intent, _uint(plan['liquidityToRemove'], U128), _uint(plan['amount0MinRemoved'], U128),
                _uint(plan['amount1MinRemoved'], U128), legs, _uint(plan['amount0Max'], U128),
                _uint(plan['amount1Max'], U128), bool(plan['burnOld']))
    if action == 'exit':
        return (intent, _uint(plan['liquidityToRemove'], U128), _uint(plan['amount0MinRemoved'], U128),
                _uint(plan['amount1MinRemoved'], U128), legs, bool(plan['burn']))
    raise CodecError('plan_action_invalid')


def permit_tuple(permit):
    return ([(_address(p['token']), _uint(p['amount'], U256)) for p in permit['permitted']],
            _uint(permit['nonce'], U256), _uint(permit['deadline'], U256))


# ------------------------------------------------------------------ hashes

def routes_hash(legs):
    """keccak256(abi.encode(SwapLeg[])), DominoV2Types.routesHash."""
    return hexed(keccak(encode([LEG_TYPE + '[]'], [[leg_tuple(leg) for leg in legs]])))


def domain_separator(chain_id, verifying_contract):
    """The Domino domain: name Domino, version 2, the chain, the zap."""
    return keccak(encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
                         [keccak(EIP712_DOMAIN_TYPE.encode()), keccak(b'Domino'), keccak(b'2'), chain_id,
                          _address(verifying_contract)]))


def permit2_domain_separator(chain_id):
    """Permit2's domain has no version."""
    return keccak(encode(['bytes32', 'bytes32', 'uint256', 'address'],
                         [keccak(PERMIT2_DOMAIN_TYPE.encode()), keccak(b'Permit2'), chain_id, PERMIT2]))


def hash_pool_ref(pool):
    return keccak(encode(['bytes32', 'uint8', 'address', 'address', 'uint24', 'int24', 'address'],
                         [_typehash('PoolRef'), *pool_tuple(pool)]))


def hash_intent(intent):
    """DominoV2Types.hashPositionIntent: the intent's EIP-712 struct hash."""
    t = intent_tuple(intent)
    return keccak(encode(['bytes32', 'uint8', 'bytes32', 'uint256', 'int24', 'int24', 'uint128', 'uint16', 'address',
                          'bytes32', 'address', 'uint256', 'uint64'],
                         [_typehash('PositionIntent'), t[0], hash_pool_ref(intent['pool']), *t[2:]]))


def _digest(separator, struct_hash):
    return hexed(keccak(b'\x19\x01' + separator + struct_hash))


def intent_hash(chain_id, zap, intent):
    """The intent's EIP-712 digest on the Domino domain of `zap`: what every
    receipt event and FeeCharged.ref carry, the same in all three paths."""
    return _digest(domain_separator(chain_id, zap), hash_intent(intent))


def relayed_fields(action, plan):
    """The RelayedPositionAction of a change-range or exit plan (an exit signs both caps as zero)."""
    if action == 'changeRange':
        caps, burn = (plan['amount0Max'], plan['amount1Max']), plan['burnOld']
    elif action == 'exit':
        caps, burn = ('0', '0'), plan['burn']
    else:
        raise CodecError('plan_relayed_action_invalid')
    return {'intent': plan['intent'], 'liquidityToRemove': plan['liquidityToRemove'],
            'amount0MinRemoved': plan['amount0MinRemoved'], 'amount1MinRemoved': plan['amount1MinRemoved'],
            'amount0Max': str(caps[0]), 'amount1Max': str(caps[1]), 'burn': bool(burn)}


def hash_relayed(relayed):
    return keccak(encode(['bytes32', 'bytes32', 'uint128', 'uint128', 'uint128', 'uint128', 'uint128', 'bool'],
                         [_typehash('RelayedPositionAction'), hash_intent(relayed['intent']),
                          _uint(relayed['liquidityToRemove'], U128), _uint(relayed['amount0MinRemoved'], U128),
                          _uint(relayed['amount1MinRemoved'], U128), _uint(relayed['amount0Max'], U128),
                          _uint(relayed['amount1Max'], U128), bool(relayed['burn'])]))


def relayed_digest(chain_id, zap, relayed):
    return _digest(domain_separator(chain_id, zap), hash_relayed(relayed))


def permit2_digest(chain_id, spender, permit, intent):
    """Permit2's PermitBatchWitnessTransferFrom digest with the intent as witness,
    as SignatureTransfer.permitWitnessTransferFrom recomputes it."""
    permissions = b''.join(keccak(encode(['bytes32', 'address', 'uint256'],
                                         [keccak(TOKEN_PERMISSIONS_TYPE.encode()), token, amount]))
                           for token, amount in permit_tuple(permit)[0])
    full = bytes.fromhex(eip712_export()['permit2']['fullTypehash'][2:])
    struct = keccak(encode(['bytes32', 'bytes32', 'address', 'uint256', 'uint256', 'bytes32'],
                           [full, keccak(permissions), _address(spender), _uint(permit['nonce'], U256),
                            _uint(permit['deadline'], U256), hash_intent(intent)]))
    return _digest(permit2_domain_separator(chain_id), struct)


# -------------------------------------------------------------- typed data

def _types(*names):
    export = eip712_export()
    every = {**export['types'], **export['permit2']['types']}
    return {name: [dict(field) for field in every[name]] for name in names}


def permit2_typed_data(chain_id, spender, permit, intent):
    """eth_signTypedData_v4 for createWithPermit/increaseWithPermit (F7 §2.5.2)."""
    return {
        'types': {'EIP712Domain': [dict(f) for f in eip712_export()['permit2']['domain']['fields']],
                  **_types('PermitBatchWitnessTransferFrom', 'TokenPermissions', 'PositionIntent', 'PoolRef')},
        'primaryType': 'PermitBatchWitnessTransferFrom',
        'domain': {'name': 'Permit2', 'chainId': chain_id,
                   'verifyingContract': eip712_export()['permit2']['domain']['verifyingContract']},
        'message': {'permitted': [{'token': p['token'], 'amount': str(p['amount'])} for p in permit['permitted']],
                    'spender': _address(spender), 'nonce': str(permit['nonce']), 'deadline': str(permit['deadline']),
                    'witness': intent},
    }


def relayed_typed_data(chain_id, zap, relayed):
    """eth_signTypedData_v4 for changeRangeWithSignature/exitWithSignature (F7 §2.5.3)."""
    return {
        'types': {'EIP712Domain': [dict(f) for f in eip712_export()['domain']['fields']],
                  **_types('RelayedPositionAction', 'PositionIntent', 'PoolRef')},
        'primaryType': 'RelayedPositionAction',
        'domain': {'name': 'Domino', 'version': '2', 'chainId': chain_id, 'verifyingContract': _address(zap)},
        'message': relayed,
    }


# ------------------------------------------------------------------- calls

def zap_function(action, consent):
    try:
        interface, name = FUNCTIONS[(action, consent)]
    except KeyError:
        raise CodecError('plan_consent_invalid') from None
    return function(interface, name)


def call_data(action, consent, plan, *, permit=None, signature=None):
    """The zap call; the permit and relayed paths need the wallet's signature."""
    fn = zap_function(action, consent)
    args = [plan_tuple(action, plan)]
    if consent == 'permit2':
        args += [permit_tuple(permit), _bytes(signature)]
    elif consent == 'relayed':
        args.append(_bytes(signature))
    return fn.calldata(*args)


def direct_value(plan):
    """msg.value of a direct create/increase: exactly the native inputs."""
    return sum(int(item['amount']) for item in plan.get('inputs', ()) if item['token'].lower() == ZERO)


ACTION_RESULT = '(uint256,uint128,uint256,uint256,address,uint256)'


def decode_action_result(raw):
    """IDominoPositionActions.ActionResult from a call's return data."""
    (token_id, liquidity, amount0, amount1, fee_token, fee_amount), = decode([ACTION_RESULT], raw)
    return {'tokenId': str(token_id), 'liquidity': str(liquidity), 'amount0': str(amount0), 'amount1': str(amount1),
            'feeToken': fee_token.lower(), 'feeAmount': str(fee_amount)}


def selector(signature):
    return hexed(keccak(signature.encode())[:4])
