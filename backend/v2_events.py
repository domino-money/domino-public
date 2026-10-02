"""Domino V2 events: what each deployed component may emit, and strict decoding.

The F0 freeze exported every interface's ABI to api-contracts/v2/abi, events
included. The catalog is built from those exports, per emitter kind, so the
indexer decodes exactly the events the frozen surfaces declare. One event is
an implementation event outside the exports: F1b's
DominoSwapExecutor.SwapLegExecuted, a receipt line the zap, the vault (through
its swap module, reached by DELEGATECALL) and the auto-exit module emit. It is
declared here once and pinned to the Solidity source by
tests/test_v2_events.py and to the compiled artifacts by the EVM test.

Which addresses emit what:
- the registry, the price anchor, each vault factory, each zap and the
  auto-exit module are deployment components (v2_manifest);
- every vault is an EIP-1167 clone the factory created (VaultCreated). The
  implementation, its executor and the swap module run by DELEGATECALL inside
  the clone, so their events carry the clone's address. The implementations,
  the executors, the swap module and the v4 zap's steps never emit on their own.

Decoding is strict, as the V1 indexers decode: the topic count must match the
indexed inputs, an indexed address or small integer must have clean high bits,
and the data must be the canonical ABI encoding of the other inputs (decoded
and encoded again to the same bytes). A known event from an emitter that the
frozen surfaces do not let emit it is refused: the model of the contracts would
be wrong, and the indexer stops for the operator rather than guess.

Every integer is kept as a Python int; `json_args` turns a decoded event into
JSON with every integer as a decimal string, addresses and hashes in lower case.
"""
from dataclasses import dataclass
from functools import lru_cache
import json
from pathlib import Path
import re
from types import MappingProxyType

from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import DataError, address, bytes32, quantity

ROOT = Path(__file__).resolve().parents[1]
ABI_DIRECTORY = ROOT / 'api-contracts/v2/abi'
MAX_EXPORT_BYTES = 1_000_000
# A Domino event's data is a few hundred bytes; a registry change carries its
# ABI-encoded argument. Anything far larger is not one of ours.
MAX_LOG_DATA_BYTES = 16_384

# DominoSwapExecutor.SwapLegExecuted (F1b, contracts/src/v2/route/DominoSwapExecutor.sol).
SWAP_LEG_EXECUTED = MappingProxyType({
    'type': 'event', 'name': 'SwapLegExecuted', 'anonymous': False,
    'inputs': (
        {'name': 'kind', 'type': 'uint8', 'indexed': True},
        {'name': 'tokenIn', 'type': 'address', 'indexed': True},
        {'name': 'tokenOut', 'type': 'address', 'indexed': True},
        {'name': 'venue', 'type': 'address', 'indexed': False},
        {'name': 'amountIn', 'type': 'uint256', 'indexed': False},
        {'name': 'amountOut', 'type': 'uint256', 'indexed': False},
    )})
IMPLEMENTATION_EVENTS = {'SwapLegExecuted': SWAP_LEG_EXECUTED}

# Emitter kinds and the exported interfaces whose events each may emit.
EMITTERS = MappingProxyType({
    'registry': ('IDominoRegistry',),
    'price_anchor': ('IDominoPriceAnchor',),
    'vault_factory': ('IDominoVaultFactory',),
    'vault': ('IDominoVault', 'IDominoVaultExecution', 'IDominoVaultLedger', 'IDominoFeeEvents',
              'SwapLegExecuted'),
    'zap': ('IDominoPositionActions', 'IDominoZap', 'IDominoFeeEvents', 'SwapLegExecuted'),
    'auto_exit': ('IDominoAutoExit', 'IDominoAutoExitExtension', 'IDominoFeeEvents', 'SwapLegExecuted'),
})


@dataclass(frozen=True)
class Parameter:
    name: str
    type: str  # canonical, tuples spelled out
    indexed: bool
    components: tuple  # of Parameter, for tuples


@dataclass(frozen=True)
class Event:
    name: str
    signature: str
    topic0: str
    inputs: tuple  # of Parameter


def _parameter(item, *, indexed=None):
    kind = item['type']
    if not isinstance(item.get('name'), str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', item['name']):
        raise ValueError('unnamed_event_parameter')
    components = ()
    if kind.startswith('tuple'):
        if kind != 'tuple':
            raise ValueError('unsupported_event_parameter')  # no arrays of tuples in V2 events
        components = tuple(_parameter(child, indexed=False) for child in item['components'])
        canonical = '(' + ','.join(c.type for c in components) + ')'
    else:
        if not re.fullmatch(r'(address|bool|bytes|bytes32|u?int(8|16|24|32|64|96|128|160|256))', kind):
            raise ValueError('unsupported_event_parameter')
        canonical = kind
    flag = item.get('indexed', False) if indexed is None else indexed
    if type(flag) is not bool or (flag and (components or kind == 'bytes')):
        raise ValueError('unsupported_indexed_parameter')
    return Parameter(item['name'], canonical, flag, components)


def event_from_abi(item):
    if item.get('type') != 'event' or item.get('anonymous', False) is not False:
        raise ValueError('not_a_named_event')
    inputs = tuple(_parameter(child) for child in item['inputs'])
    signature = f"{item['name']}({','.join(p.type for p in inputs)})"
    if sum(p.indexed for p in inputs) > 3:
        raise ValueError('too_many_indexed')
    return Event(item['name'], signature, '0x' + keccak(signature.encode()).hex(), inputs)


@lru_cache(maxsize=None)
def interface_events(name, directory=ABI_DIRECTORY):
    """The events one exported interface declares, by name (none is overloaded)."""
    if name in IMPLEMENTATION_EVENTS:
        return MappingProxyType({name: event_from_abi(IMPLEMENTATION_EVENTS[name])})
    if not isinstance(name, str) or not re.fullmatch(r'I[A-Za-z0-9]{1,64}', name):
        raise DataError('v2_abi_interface_unknown')
    try:
        raw = (Path(directory) / f'{name}.json').read_bytes()
        if len(raw) > MAX_EXPORT_BYTES:
            raise ValueError('oversized_export')
        events = {}
        for item in json.loads(raw)['abi']:
            if item.get('type') != 'event':
                continue
            event = event_from_abi(item)
            if event.name in events:
                raise ValueError('overloaded_event')
            events[event.name] = event
    except FileNotFoundError:
        raise DataError('v2_abi_interface_unknown') from None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise DataError('v2_abi_export_invalid') from error
    return MappingProxyType(events)


@dataclass(frozen=True)
class Catalog:
    """Per emitter kind: topic0 -> Event."""
    by_kind: MappingProxyType

    def topics(self):
        """Every topic0 any component may emit, sorted: the eth_getLogs topic filter."""
        return sorted({topic for events in self.by_kind.values() for topic in events})

    def event(self, kind, topic0):
        events = self.by_kind.get(kind)
        if events is None:
            raise DataError('v2_unknown_emitter_kind')
        found = events.get(topic0)
        if found is None:
            known = any(topic0 in other for other in self.by_kind.values())
            raise DataError('v2_unexpected_event' if known else 'v2_unknown_event')
        return found


@lru_cache(maxsize=None)
def catalog(directory=ABI_DIRECTORY):
    by_kind = {}
    for kind, interfaces in EMITTERS.items():
        events = {}
        for name in interfaces:
            for event in interface_events(name, directory).values():
                previous = events.get(event.topic0)
                if previous is not None and previous != event:
                    raise DataError('v2_event_topic_collision')
                events[event.topic0] = event
        by_kind[kind] = MappingProxyType(events)
    return Catalog(MappingProxyType(by_kind))


# ------------------------------------------------------------------ decoding
_INT = re.compile(r'(u?)int(\d+)')


def _topic_value(parameter, topic):
    word = bytes.fromhex(bytes32(topic)[2:])
    kind = parameter.type
    if kind == 'address':
        if word[:12] != bytes(12):
            raise DataError('v2_event_topic_not_canonical')
        return '0x' + word[12:].hex()
    if kind == 'bytes32':
        return '0x' + word.hex()
    if kind == 'bool':
        if word not in (bytes(32), bytes(31) + b'\x01'):
            raise DataError('v2_event_topic_not_canonical')
        return word[-1] == 1
    match = _INT.fullmatch(kind)
    if match is None:
        raise DataError('v2_event_topic_not_canonical')
    bits, value = int(match.group(2)), int.from_bytes(word, 'big')
    if match.group(1) == 'u':
        if value >> bits:
            raise DataError('v2_event_topic_not_canonical')
        return value
    if value >> 255:
        value -= 1 << 256
    if not -(1 << (bits - 1)) <= value < (1 << (bits - 1)):
        raise DataError('v2_event_topic_not_canonical')
    return value


def _shape(parameter, value):
    """eth_abi values to plain Python: dicts for tuples, '0x…' text for bytes."""
    if parameter.components:
        return {child.name: _shape(child, item) for child, item in zip(parameter.components, value)}
    if parameter.type == 'address':
        return address(value)
    if parameter.type in ('bytes', 'bytes32'):
        return '0x' + bytes(value).hex()
    return value


def _encodable(parameter, value):
    if parameter.components:
        return tuple(_encodable(child, value[child.name]) for child in parameter.components)
    if parameter.type in ('bytes', 'bytes32'):
        return bytes.fromhex(value[2:])
    return value


def decode_args(event, topics, data):
    """The event's arguments by name, from a log's topics and data, or refuse."""
    if not isinstance(topics, list) or not isinstance(data, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', data):
        raise DataError('v2_invalid_log')
    if len(data) > 2 + 2 * MAX_LOG_DATA_BYTES:
        raise DataError('v2_event_data_too_large')
    indexed = [p for p in event.inputs if p.indexed]
    plain = [p for p in event.inputs if not p.indexed]
    if len(topics) != 1 + len(indexed) or bytes32(topics[0]) != event.topic0:
        raise DataError('v2_event_topics_mismatch')
    values = {p.name: _topic_value(p, topic) for p, topic in zip(indexed, topics[1:])}
    raw = bytes.fromhex(data[2:])
    types = [p.type for p in plain]
    try:
        decoded = decode(types, raw) if types else ()
    except Exception:
        raise DataError('v2_event_data_invalid') from None
    if not types and raw:
        raise DataError('v2_event_data_not_canonical')
    for parameter, value in zip(plain, decoded):
        values[parameter.name] = _shape(parameter, value)
    if types and encode(types, [_encodable(p, values[p.name]) for p in plain]) != raw:
        raise DataError('v2_event_data_not_canonical')
    return {p.name: values[p.name] for p in event.inputs}


@dataclass(frozen=True)
class DecodedLog:
    block_number: int
    block_hash: str
    tx_hash: str
    tx_index: int
    log_index: int
    address: str
    emitter: str  # the emitter kind
    event: str
    args: dict


def decode_log(cat, raw, emitter_of):
    """One eth_getLogs entry. `emitter_of(address)` is the emitter kind of a
    followed address, or None for any other address (refused)."""
    if not isinstance(raw, dict) or raw.get('removed') is not False:
        raise DataError('v2_invalid_log')
    emitter = address(raw.get('address'))
    kind = emitter_of(emitter)
    if kind is None:
        raise DataError('v2_log_from_unfollowed_address')
    topics = raw.get('topics')
    if not isinstance(topics, list) or not topics:
        raise DataError('v2_invalid_log')
    event = cat.event(kind, bytes32(topics[0]))
    args = decode_args(event, topics, raw.get('data'))
    return DecodedLog(quantity(raw.get('blockNumber')), bytes32(raw.get('blockHash')),
                      bytes32(raw.get('transactionHash')), quantity(raw.get('transactionIndex')),
                      quantity(raw.get('logIndex')), emitter, kind, event.name, args)


def json_args(value):
    """Decoded arguments as JSON: integers as decimal strings, bools kept."""
    if isinstance(value, dict):
        return {key: json_args(item) for key, item in value.items()}
    if isinstance(value, bool) or isinstance(value, str):
        return value
    if isinstance(value, int):
        return str(value)
    raise DataError('v2_event_value_unsupported')


# Who an event concerns, for the read side: (owner, vault, token id, ref).
# `owner` is the wallet the event is about; `vault` the vault it belongs to;
# `ref` the intent, plan or mandate hash that binds a receipt's events.
def event_keys(log):
    a, kind, name = log.args, log.emitter, log.event
    owner = vault = token_id = ref = None
    if kind == 'vault':
        vault = log.address
        token_id = a.get('tokenId', a.get('parentTokenId', a.get('rootTokenId')))
        if name == 'Swapped':
            token_id = a['source']
        if name == 'Initialized':
            owner = a['owner']
        if name == 'Executed':
            ref = a['planHash']
        if name == 'FeeCharged':
            owner, ref = a['payer'], a['ref']
    elif kind == 'vault_factory':
        owner, vault, token_id = a['owner'], a['vault'], a['rootTokenId']
    elif kind == 'zap':
        owner = a.get('owner', a.get('payer', a.get('recipient')))
        token_id = a.get('tokenId')
        ref = a.get('intentHash', a.get('ref'))
    elif kind == 'auto_exit':
        owner = a.get('owner', a.get('payer'))
        ref = a.get('mandateHash', a.get('ref'))
        vault, token_id = a.get('vault'), a.get('tokenId')
        if name == 'MandateExecuted':
            owner = a['recipient']  # the module delivers to the mandate's owner, always
    if name == 'FeeCharged' and kind != 'vault':
        owner = a['payer']
    return owner, vault, token_id, ref
