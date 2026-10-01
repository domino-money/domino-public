#!/usr/bin/env python3
"""Domino V2 EIP-712 exports, computed independently of Solidity.

The type strings live in contracts/src/v2/DominoV2Types.sol. This script reads
them from that file, rebuilds the EIP-712 type definitions, and computes the
typehashes, domain separators and digests of fixed fixtures with eth_account
(a second implementation). It writes:

- api-contracts/v2/eip712.json          types, type strings, typehashes, domains
- api-contracts/v2/eip712-goldens.json  fixtures and their digests
- contracts/test/v2/DominoV2Goldens.sol the same values for the Solidity tests

Run with --check to fail on drift instead of writing. Requires the backend
dependencies (eth-account, eth-abi, eth-hash).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from eth_abi import encode
from eth_account.messages import _hash_eip191_message, encode_typed_data
from eth_hash.auto import keccak

ROOT = Path(__file__).resolve().parents[2]
TYPES_SOL = ROOT / 'contracts/src/v2/DominoV2Types.sol'
OUT_TYPES = ROOT / 'api-contracts/v2/eip712.json'
OUT_GOLDENS = ROOT / 'api-contracts/v2/eip712-goldens.json'
OUT_SOL = ROOT / 'contracts/test/v2/DominoV2Goldens.sol'

PRIMARY = ('PoolRef', 'PriceObservation', 'PositionIntent', 'ExitMandate')
CONSTANT_NAMES = {
    'PoolRef': 'POOL_REF_TYPE',
    'PriceObservation': 'PRICE_OBSERVATION_TYPE',
    'PositionIntent': 'POSITION_INTENT_TYPE',
    'ExitMandate': 'EXIT_MANDATE_TYPE',
}
PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
PERMIT2_BATCH_STUB = (
    'PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,'
)
TOKEN_PERMISSIONS = 'TokenPermissions(address token,uint256 amount)'

# Fixtures: deterministic values that exercise sign extension (negative ticks),
# the native currency (address 0) and wide integers.
DOMAIN = {'name': 'Domino', 'version': '2', 'chainId': 4663,
          'verifyingContract': '0x000000000000000000000000000000000000d0d0'}
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
OWNER = '0x0000000000000000000000000000000000000b0b'
POOL = {'dex': 4, 'currency0': '0x0000000000000000000000000000000000000000', 'currency1': USDG,
        'fee': 3000, 'tickSpacing': 60, 'hooks': '0x0000000000000000000000000000000000000000'}
LEG = {'kind': 1, 'router': '0x00000000000000000000000000000000000000aa', 'tokenIn': USDG,
       'tokenOut': '0x0000000000000000000000000000000000000000', 'amountIn': 500000000,
       'minAmountOut': 123, 'data': '0xdeadbeef'}
OBSERVATION = {'pool': POOL, 'sqrtPriceX96': 4339505179874779672736325173248,
               'observedAt': 1790870000, 'validUntil': 1790870060, 'nonce': 7}
MANDATE = {'owner': OWNER, 'vault': '0x000000000000000000000000000000000000cafe', 'tokenId': 3409682,
           'triggerBelowSqrtPriceX96': 79228162514264337593543950336, 'triggerAboveSqrtPriceX96': 0,
           'receiveMode': 1, 'convertTo': USDG, 'maxSlippageBps': 100, 'validUntil': 1798646400, 'nonce': 1}
PERMIT = {'permitted': [{'token': USDG, 'amount': 1000000000}], 'nonce': 99, 'deadline': 1790871000}

TYPE_RE = re.compile(r'^\s*(\w+)\((.*)\)$')


def read_type_strings(source: str) -> dict[str, str]:
    found = {}
    for name, constant in CONSTANT_NAMES.items():
        match = re.search(r'string internal constant ' + constant + r'\s*=\s*"([^"]+)";', source)
        if not match:
            raise SystemExit(f'type string {constant} not found in {TYPES_SOL}')
        found[name] = match.group(1)
    return found


def fields(type_string: str) -> list[dict[str, str]]:
    match = TYPE_RE.match(type_string)
    if not match:
        raise SystemExit(f'malformed type string: {type_string}')
    out = []
    for member in match.group(2).split(','):
        kind, name = member.strip().split(' ')
        out.append({'name': name, 'type': kind})
    return out


def encode_type(primary: str, types: dict[str, list[dict[str, str]]]) -> str:
    """EIP-712 encodeType: primary first, referenced struct types sorted."""
    seen: set[str] = set()

    def walk(name: str) -> None:
        for member in types[name]:
            base = member['type'].rstrip('[]')
            if base in types and base not in seen:
                seen.add(base)
                walk(base)
    walk(primary)
    seen.discard(primary)

    def render(name: str) -> str:
        return name + '(' + ','.join(f"{m['type']} {m['name']}" for m in types[name]) + ')'
    return render(primary) + ''.join(render(name) for name in sorted(seen))


def reachable(primary: str, types: dict[str, list[dict[str, str]]]) -> dict[str, list[dict[str, str]]]:
    """The primary type and every struct type it references (eth_account derives
    the primary type from the graph, so unrelated roots must be left out)."""
    found = {primary: types[primary]}
    pending = [primary]
    while pending:
        for member in types[pending.pop()]:
            base = member['type'].rstrip('[]')
            if base in types and base not in found:
                found[base] = types[base]
                pending.append(base)
    return found


def hexed(value: bytes) -> str:
    return '0x' + value.hex()


def routes_hash(legs: list[dict]) -> str:
    rows = [(leg['kind'], leg['router'], leg['tokenIn'], leg['tokenOut'], leg['amountIn'], leg['minAmountOut'],
             bytes.fromhex(leg['data'][2:])) for leg in legs]
    return hexed(keccak(encode(['(uint8,address,address,address,uint128,uint128,bytes)[]'], [rows])))


def build() -> tuple[dict, dict, str]:
    source = TYPES_SOL.read_text()
    strings = read_type_strings(source)
    types = {name: fields(text) for name, text in strings.items()}
    for name, text in strings.items():
        expected = f"{name}({','.join(m['type'] + ' ' + m['name'] for m in types[name])})"
        if text != expected:
            raise SystemExit(f'type string for {name} is not canonical')
    encoded = {name: encode_type(name, types) for name in PRIMARY}
    typehashes = {name: hexed(keccak(encoded[name].encode())) for name in PRIMARY}

    domain_types = [{'name': 'name', 'type': 'string'}, {'name': 'version', 'type': 'string'},
                    {'name': 'chainId', 'type': 'uint256'}, {'name': 'verifyingContract', 'type': 'address'}]
    witness_type_string = ('PositionIntent witness)' + ''.join(
        f"{n}({','.join(m['type'] + ' ' + m['name'] for m in types[n])})" for n in ('PoolRef', 'PositionIntent'))
        + TOKEN_PERMISSIONS)

    intent = {'action': 1, 'pool': POOL, 'tokenId': 0, 'tickLower': -201060, 'tickUpper': -198060,
              'minLiquidity': 123456789012345678, 'feeBps': 65, 'feeToken': USDG,
              'routesHash': routes_hash([LEG]), 'recipient': OWNER, 'nonce': 42, 'deadline': 1790871000}

    def signable(primary: str, message: dict, extra_types: dict | None = None, domain=None, domain_fields=None):
        every = {**types, **(extra_types or {})}
        full = {'types': {'EIP712Domain': domain_fields or domain_types, **reachable(primary, every)},
                'primaryType': primary, 'domain': domain or DOMAIN, 'message': message}
        return encode_typed_data(full_message=full)

    def digest(primary: str, message: dict, extra_types: dict | None = None, domain=None, domain_fields=None):
        return hexed(_hash_eip191_message(signable(primary, message, extra_types, domain, domain_fields)))

    def struct_hash(primary: str, message: dict) -> str:
        return hexed(signable(primary, message).body)

    domain_separator = hexed(signable('PoolRef', POOL).header)

    permit2_domain = {'name': 'Permit2', 'chainId': DOMAIN['chainId'], 'verifyingContract': PERMIT2}
    permit2_domain_fields = [{'name': 'name', 'type': 'string'}, {'name': 'chainId', 'type': 'uint256'},
                             {'name': 'verifyingContract', 'type': 'address'}]
    permit2_types = {
        'PermitBatchWitnessTransferFrom': [
            {'name': 'permitted', 'type': 'TokenPermissions[]'}, {'name': 'spender', 'type': 'address'},
            {'name': 'nonce', 'type': 'uint256'}, {'name': 'deadline', 'type': 'uint256'},
            {'name': 'witness', 'type': 'PositionIntent'}],
        'TokenPermissions': [{'name': 'token', 'type': 'address'}, {'name': 'amount', 'type': 'uint256'}],
    }
    permit_message = {**PERMIT, 'spender': DOMAIN['verifyingContract'], 'witness': intent}
    permit2_full_type = PERMIT2_BATCH_STUB + witness_type_string
    full_permit_types = {**types, **permit2_types}
    if encode_type('PermitBatchWitnessTransferFrom', full_permit_types) != permit2_full_type:
        raise SystemExit('Permit2 witness type string does not match the EIP-712 encoding wallets sign')

    exports = {
        'version': 1,
        'source': 'contracts/src/v2/DominoV2Types.sol',
        'domain': {'name': 'Domino', 'version': '2', 'fields': domain_types,
                   'verifyingContract': 'each signing contract on its own chain'},
        'types': types,
        'typeStrings': strings,
        'encodedTypes': encoded,
        'typehashes': typehashes,
        'permit2': {'domain': {'name': 'Permit2', 'fields': permit2_domain_fields, 'verifyingContract': PERMIT2},
                    'witnessType': 'PositionIntent', 'witnessTypeString': witness_type_string,
                    'fullType': permit2_full_type,
                    'fullTypehash': hexed(keccak(permit2_full_type.encode())),
                    'types': permit2_types},
        'routesHash': {'abi': '(uint8,address,address,address,uint128,uint128,bytes)[]',
                       'rule': 'keccak256(abi.encode(SwapLeg[] legs))'},
    }
    goldens = {
        'domain': DOMAIN,
        'domainSeparator': domain_separator,
        'fixtures': {'PoolRef': POOL, 'PriceObservation': OBSERVATION, 'PositionIntent': intent,
                     'ExitMandate': MANDATE, 'SwapLeg': [LEG], 'Permit2': permit_message},
        'routesHash': intent['routesHash'],
        'structHashes': {'PoolRef': struct_hash('PoolRef', POOL),
                         'PriceObservation': struct_hash('PriceObservation', OBSERVATION),
                         'PositionIntent': struct_hash('PositionIntent', intent),
                         'ExitMandate': struct_hash('ExitMandate', MANDATE)},
        'digests': {'PriceObservation': digest('PriceObservation', OBSERVATION),
                    'PositionIntent': digest('PositionIntent', intent),
                    'ExitMandate': digest('ExitMandate', MANDATE),
                    'Permit2BatchWitness': digest('PermitBatchWitnessTransferFrom', permit_message,
                                                  permit2_types, permit2_domain, permit2_domain_fields)},
    }
    return exports, goldens, solidity(exports, goldens)


def solidity(exports: dict, goldens: dict) -> str:
    def const(name: str, value: str) -> str:
        return f'    bytes32 internal constant {name} = {value};\n'
    lines = [
        '// SPDX-License-Identifier: MIT\n',
        'pragma solidity 0.8.26;\n\n',
        '// Generated by scripts/v2/eip712_exports.py from contracts/src/v2/DominoV2Types.sol.\n',
        '// Do not edit: run the script, and the backend test checks it is current.\n',
        'library DominoV2Goldens {\n',
        const('POOL_REF_TYPEHASH', exports['typehashes']['PoolRef']),
        const('PRICE_OBSERVATION_TYPEHASH', exports['typehashes']['PriceObservation']),
        const('POSITION_INTENT_TYPEHASH', exports['typehashes']['PositionIntent']),
        const('EXIT_MANDATE_TYPEHASH', exports['typehashes']['ExitMandate']),
        const('PERMIT2_BATCH_WITNESS_TYPEHASH', exports['permit2']['fullTypehash']),
        const('DOMAIN_SEPARATOR', goldens['domainSeparator']),
        const('ROUTES_HASH', goldens['routesHash']),
        const('POOL_REF_STRUCT_HASH', goldens['structHashes']['PoolRef']),
        const('PRICE_OBSERVATION_DIGEST', goldens['digests']['PriceObservation']),
        const('POSITION_INTENT_DIGEST', goldens['digests']['PositionIntent']),
        const('EXIT_MANDATE_DIGEST', goldens['digests']['ExitMandate']),
        const('PERMIT2_BATCH_WITNESS_DIGEST', goldens['digests']['Permit2BatchWitness']),
        '}\n',
    ]
    return ''.join(lines)


def render_json(value: dict) -> str:
    return json.dumps(value, indent=2, sort_keys=False) + '\n'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--check', action='store_true', help='fail when a committed export is stale')
    args = parser.parse_args()
    exports, goldens, sol = build()
    outputs = {OUT_TYPES: render_json(exports), OUT_GOLDENS: render_json(goldens), OUT_SOL: sol}
    stale = [str(path.relative_to(ROOT)) for path, text in outputs.items()
             if not path.exists() or path.read_text() != text]
    if args.check:
        if stale:
            print('Stale V2 EIP-712 exports: ' + ', '.join(stale), file=sys.stderr)
            return 1
        print('V2 EIP-712 exports are current.')
        return 0
    for path, text in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    print('Wrote ' + ', '.join(str(p.relative_to(ROOT)) for p in outputs))
    return 0


if __name__ == '__main__':
    sys.exit(main())
