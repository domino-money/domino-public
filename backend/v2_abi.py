"""The frozen Domino V2 ABI exports, as call encoders and decoders.

F0 exported every interface V2 uses to api-contracts/v2/abi, including the
minimal Uniswap v3/v4 and Permit2 declarations whose selectors are pinned
against the deployed contracts. The backend builds its calls from those files
and never re-declares an interface. Loading rebuilds each function's canonical
signature from the exported ABI and requires it to match the compiler's own
selector list in the same file, so a stale or hand-edited export is refused.
"""
from dataclasses import dataclass
from functools import lru_cache
import json
from pathlib import Path
import re
from types import MappingProxyType

from eth_abi import encode
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
