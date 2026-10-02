"""The frozen Domino V2 ABI exports, as call encoders and decoders.

F0 exported every interface V2 uses to api-contracts/v2/abi, including the
minimal Uniswap v3/v4 and Permit2 declarations whose selectors are pinned
against the deployed contracts. The backend builds its calls from those files
and never re-declares an interface. Loading rebuilds each function's canonical
signature from the exported ABI and requires it to match the compiler's own
selector list in the same file, so a stale or hand-edited export is refused.

Events (`event`) are read from the same exports: the topic is the keccak of
the canonical signature rebuilt from the exported ABI, and a log decodes only
against its own topic and shape.
"""
from dataclasses import dataclass
from functools import lru_cache
import json
from pathlib import Path
import re
from types import MappingProxyType

from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import DataError, decode_result

ROOT = Path(__file__).resolve().parents[1]
ABI_DIRECTORY = ROOT / 'api-contracts/v2/abi'
MAX_EXPORT_BYTES = 1_000_000


@dataclass(frozen=True)
class Function:
    interface: str
    name: str
    signature: str
    selector: str
    inputs: tuple
    outputs: tuple
    view: bool

    def calldata(self, *values):
        return self.selector + encode(list(self.inputs), list(values)).hex()

    def decode(self, raw):
        return decode_result(list(self.outputs), raw)


def _canonical(parameter):
    kind = parameter['type']
    if kind.startswith('tuple'):
        return '(' + ','.join(_canonical(item) for item in parameter['components']) + ')' + kind[len('tuple'):]
    return kind


@lru_cache(maxsize=None)
def interface(name, directory=ABI_DIRECTORY):
    """The functions of one exported interface, by name (none is overloaded)."""
    if not isinstance(name, str) or not re.fullmatch(r'I[A-Za-z0-9]{1,64}', name):
        raise DataError('v2_abi_interface_unknown')
    path = Path(directory) / f'{name}.json'
    try:
        raw = path.read_bytes()
        if len(raw) > MAX_EXPORT_BYTES:
            raise ValueError('oversized_export')
        export = json.loads(raw)
        exported, abi = export['functions'], export['abi']
        functions = {}
        for item in abi:
            if item['type'] != 'function':
                continue
            inputs = tuple(_canonical(parameter) for parameter in item['inputs'])
            signature = f"{item['name']}({','.join(inputs)})"
            selector = '0x' + keccak(signature.encode()).hex()[:8]
            if exported.get(signature) != selector or item['name'] in functions:
                raise ValueError('export_selector_mismatch')
            functions[item['name']] = Function(
                name, item['name'], signature, selector, inputs,
                tuple(_canonical(parameter) for parameter in item['outputs']),
                item['stateMutability'] in ('view', 'pure'))
        if set(exported) != {function.signature for function in functions.values()}:
            raise ValueError('export_selector_mismatch')
    except FileNotFoundError:
        raise DataError('v2_abi_interface_unknown') from None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise DataError('v2_abi_export_invalid') from error
    return MappingProxyType(functions)


def function(interface_name, name):
    try:
        return interface(interface_name)[name]
    except KeyError:
        raise DataError('v2_abi_function_unknown') from None


@dataclass(frozen=True)
class Event:
    interface: str
    name: str
    signature: str
    topic: str
    inputs: tuple  # (name, canonical type, indexed)

    def decode(self, log):
        """A log's arguments by name. A log of another event, or of another
        shape (topics, data), is refused. Indexed arguments are value types."""
        try:
            topics, data = log['topics'], log['data']
            indexed = [item for item in self.inputs if item[2]]
            plain = [item for item in self.inputs if not item[2]]
            if (not topics or topics[0].lower() != self.topic or len(topics) != 1 + len(indexed)
                    or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', data)):
                raise ValueError('event_mismatch')
            values = {}
            for (name, kind, _), topic in zip(indexed, topics[1:]):
                values[name] = decode([kind], bytes.fromhex(topic[2:]))[0]
            raw = bytes.fromhex(data[2:])
            decoded = decode([kind for _, kind, _ in plain], raw)
            if encode([kind for _, kind, _ in plain], list(decoded)) != raw:
                raise ValueError('event_data_not_canonical')
            values.update(zip((name for name, _, _ in plain), decoded))
            return values
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            raise DataError('v2_abi_event_mismatch') from error


_VALUE_TYPE = re.compile(r'(?:u?int[0-9]{0,3}|address|bool|bytes(?:[1-9]|[12][0-9]|3[0-2]))')


@lru_cache(maxsize=None)
def events(name, directory=ABI_DIRECTORY):
    """The events of one exported interface, by name."""
    if not isinstance(name, str) or not re.fullmatch(r'I[A-Za-z0-9]{1,64}', name):
        raise DataError('v2_abi_interface_unknown')
    try:
        raw = (Path(directory) / f'{name}.json').read_bytes()
        if len(raw) > MAX_EXPORT_BYTES:
            raise ValueError('oversized_export')
        found = {}
        for item in json.loads(raw)['abi']:
            if item['type'] != 'event':
                continue
            inputs = tuple((p['name'], _canonical(p), bool(p['indexed'])) for p in item['inputs'])
            if any(indexed and not _VALUE_TYPE.fullmatch(kind) for _, kind, indexed in inputs) or item['name'] in found:
                raise ValueError('unsupported_event')
            signature = f"{item['name']}({','.join(kind for _, kind, _ in inputs)})"
            found[item['name']] = Event(name, item['name'], signature, '0x' + keccak(signature.encode()).hex(), inputs)
    except FileNotFoundError:
        raise DataError('v2_abi_interface_unknown') from None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise DataError('v2_abi_export_invalid') from error
    return MappingProxyType(found)


def event(interface_name, name):
    try:
        return events(interface_name)[name]
    except KeyError:
        raise DataError('v2_abi_event_unknown') from None
