#!/usr/bin/env python3
"""Refresh backend/data/token-lists/uniswap-default.json, the curated list behind read-v6's chain-tokens.

The owner's decision of 5 Oct 2026, extended to Elysium on 9 Nov 2026: token search on Base, Arbitrum One and
Elysium starts from the Uniswap Labs Default token list (https://tokens.uniswap.org) and learns from use (backend/v2_chain_reads.py). The list is GPL-3.0
(github.com/Uniswap/default-token-list): the subset keeps its provenance (URL, version, timestamp, the SHA-256 of
the exact bytes read) and ships with the license beside it (backend/THIRD_PARTY_NOTICES.md).

Symbols and names are untrusted text. An entry the read API could not serve as it is (an address or decimals out of
shape, a symbol or name that is empty, too long, padded or not printable) is left out and counted.

    python3 scripts/update-uniswap-token-list.py                 # read tokens.uniswap.org, write the subset
    python3 scripts/update-uniswap-token-list.py --source FILE   # the same, from a saved copy of those bytes
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.request

URL = 'https://tokens.uniswap.org'
REPOSITORY = 'https://github.com/Uniswap/default-token-list'
OUT = Path(__file__).resolve().parents[1] / 'backend/data/token-lists/uniswap-default.json'
LICENSE_FILE = 'LICENSE-uniswap-default-token-list'
CHAINS = (8453, 42161, 99901)
MAX_BYTES = 8 * 1024 * 1024
MAX_SYMBOL, MAX_NAME = 40, 64


def text(value, limit):
    return (isinstance(value, str) and 0 < len(value) <= limit and value == value.strip() and value.isprintable())


def entry(token):
    """The served fields of one list entry, or None when the read API could not serve it as it is."""
    if not isinstance(token, dict) or token.get('chainId') not in CHAINS:
        return None
    address, decimals = token.get('address'), token.get('decimals')
    if (not isinstance(address, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', address)
            or type(decimals) is not int or not 0 <= decimals <= 255
            or not text(token.get('symbol'), MAX_SYMBOL) or not text(token.get('name'), MAX_NAME)):
        return None
    return {'chainId': token['chainId'], 'address': address.lower(), 'symbol': token['symbol'],
            'name': token['name'], 'decimals': decimals}


def subset(raw):
    document = json.loads(raw)
    version = document.get('version') or {}
    if (document.get('name') != 'Uniswap Labs Default' or not isinstance(document.get('tokens'), list)
            or not all(type(version.get(part)) is int for part in ('major', 'minor', 'patch'))
            or not isinstance(document.get('timestamp'), str)):
        raise ValueError('not_the_uniswap_default_list')
    wanted = [token for token in document['tokens'] if isinstance(token, dict) and token.get('chainId') in CHAINS]
    kept = {}
    for token in wanted:
        served = entry(token)
        if served is not None:
            kept.setdefault((served['chainId'], served['address']), served)  # the first entry of an address wins
    tokens = [kept[key] for key in sorted(kept)]
    return {'schemaVersion': 1, 'kind': 'domino-token-list-subset',
            'source': {'name': document['name'], 'url': URL, 'repository': REPOSITORY, 'license': 'GPL-3.0',
                       'licenseFile': LICENSE_FILE,
                       'version': '{major}.{minor}.{patch}'.format(**version), 'timestamp': document['timestamp'],
                       'sha256': hashlib.sha256(raw).hexdigest()},
            'chains': list(CHAINS), 'omitted': len(wanted) - len(tokens), 'tokens': tokens}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', type=Path, help='a saved copy of the list, byte for byte')
    args = parser.parse_args(argv)
    if args.source is not None:
        raw = args.source.read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=30) as response:
            raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        parser.exit(1, 'token list too large\n')
    document = subset(raw)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(document, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    counts = {chain: sum(1 for token in document['tokens'] if token['chainId'] == chain) for chain in CHAINS}
    print(f"{document['source']['version']} ({document['source']['timestamp']}), sha256 {document['source']['sha256']}: "
          f"{counts} kept, {document['omitted']} left out")
    return 0


if __name__ == '__main__':
    sys.exit(main())
