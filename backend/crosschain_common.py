"""Shared, provider-neutral pieces of the cross-chain deposit service (S2, #283 F5).

The deposit from another chain is a plain bridge to the user's own wallet through
the Relay or Across API, with the provider's own app fee (35 bps, owner decision
of 1 October 2026). Nothing here signs or sends: the service returns unsigned
transactions for the user's wallet, after checking every byte it can against the
request and against the contracts pinned in crosschain_pins.json.

Destination chains and tokens are read directly from the V2 chain profiles
(api-contracts/v2/chains). That reading belongs on F6's chain registry once it
exists; nothing else in this module depends on how the profiles are stored.
"""
from collections import OrderedDict
import json
from pathlib import Path
import re
import threading

from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import DataError

ROOT = Path(__file__).resolve().parents[1]
PINS_PATH = Path(__file__).resolve().parent / 'crosschain_pins.json'
PROFILES_PATH = ROOT / 'api-contracts' / 'v2' / 'chains'
ZERO = '0x' + '00' * 20
UINT256_MAX = (1 << 256) - 1
PROVIDERS = ('relay', 'across')
# The convenience fee, in basis points: the provider's app fee (F0 tariffs).
APP_FEE_BPS = 35
# Trailing calldata bytes a provider may append after the ABI arguments. Across
# appends 0x73c0de, or 0x1dc0de and the 2-byte integrator id; contracts ignore them.
MAX_CALLDATA_SUFFIX = 16
MAX_CALLDATA_BYTES = 16384
MAX_CHAIN_ID = 2**53 - 1


def address(value, code='invalid_address'):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', value):
        raise DataError(code)
    return value.lower()


def bytes32(value, code='invalid_bytes32'):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', value):
        raise DataError(code)
    return value.lower()


def raw(value, code='invalid_amount', *, positive=False, maximum=UINT256_MAX):
    """A canonical decimal integer string within uint256; ints only where the provider sends JSON numbers."""
    if isinstance(value, str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,77})', value):
        value = int(value)
    if type(value) is not int or not (1 if positive else 0) <= value <= maximum:
        raise DataError(code)
    return value


def chain_id(value, code='invalid_chain_id'):
    if isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,15}', value):
        value = int(value)
    if type(value) is not int or not 1 <= value <= MAX_CHAIN_ID:
        raise DataError(code)
    return value


def hexdata(value, code='invalid_calldata', *, maximum=MAX_CALLDATA_BYTES):
    if (not isinstance(value, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', value)
            or len(value) > 2 + 2 * maximum):
        raise DataError(code)
    return value.lower()


def usd(value):
    """A provider-reported USD amount as a fixed-point string, or None; never used to choose a route."""
    if isinstance(value, str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,36})?', value):
        return value
    return None


def bps_of(amount, bps):
    return amount * bps // 10000


def selector(signature):
    return '0x' + keccak(signature.encode()).hex()[:8]


def encode_call(signature, types, values):
    return '0x' + (keccak(signature.encode())[:4] + encode(list(types), list(values))).hex()


def decode_call(data, signature, types, code):
    """Decode calldata for exactly this function; reject non-canonical encodings.

    The arguments must re-encode to the same bytes, so what the contract decodes
    is what was checked here. Only a short, ignored suffix may follow them.
    """
    data = hexdata(data, code)
    if not data.startswith(selector(signature)):
        raise DataError(code)
    body = bytes.fromhex(data[10:])
    try:
        values = decode(list(types), body)
        canonical = encode(list(types), list(values))
    except Exception:
        raise DataError(code) from None
    if body[:len(canonical)] != canonical or len(body) - len(canonical) > MAX_CALLDATA_SUFFIX:
        raise DataError(code)
    return values


def word_address(value, code):
    """A bytes32 that holds a left-padded EVM address."""
    if not isinstance(value, bytes) or len(value) != 32 or value[:12] != b'\0' * 12:
        raise DataError(code)
    return '0x' + value[12:].hex()


def fingerprint(identity):
    import hashlib
    return hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


class Memo:
    """A small bounded, thread-safe memo for results that cannot change (a settled fill, a final fee record).

    It keeps a filled deposit that the app asks about again from costing another
    billed RPC read or another provider call.
    """
    def __init__(self, size=1024):
        self.size, self._rows, self._lock = size, OrderedDict(), threading.Lock()

    def get(self, key):
        with self._lock:
            if key in self._rows:
                self._rows.move_to_end(key)
                return self._rows[key]
        return None

    def put(self, key, value):
        with self._lock:
            self._rows[key] = value
            self._rows.move_to_end(key)
            while len(self._rows) > self.size:
                self._rows.popitem(last=False)


def load_pins(path=PINS_PATH):
    """The reviewed provider targets, lower-cased, keyed by integer chain id."""
    data = json.loads(Path(path).read_text())
    if data.get('schemaVersion') != 1:
        raise DataError('invalid_crosschain_pins')
    chains = {}
    for key, entry in data['chains'].items():
        cid = chain_id(key, 'invalid_crosschain_pins')
        row = {'name': entry['name'], 'nativeSymbol': entry['nativeSymbol']}
        if 'relay' in entry:
            row['relay'] = {'slug': entry['relay']['slug'],
                            'depository': address(entry['relay']['depository'], 'invalid_crosschain_pins')}
        if 'across' in entry:
            across = entry['across']
            row['across'] = {name: address(across[name], 'invalid_crosschain_pins')
                             for name in ('spokePool', 'spokePoolPeriphery', 'wrappedNative') if name in across}
        chains[cid] = row
    destinations = {}
    for key, entry in data['destinations'].items():
        across = entry['across']
        destinations[chain_id(key, 'invalid_crosschain_pins')] = {'across': {
            'spokePool': address(across['spokePool'], 'invalid_crosschain_pins'),
            'eventEmitter': address(across['eventEmitter'], 'invalid_crosschain_pins'),
            'multicallHandlers': tuple(address(value, 'invalid_crosschain_pins') for value in across['multicallHandlers'])}}
    return {'chains': chains, 'destinations': destinations}


def load_destinations(path=PROFILES_PATH):
    """Enabled V2 chains S2 serves and the tokens a deposit may deliver there: the charge currencies (stable, ETH,
    WETH). A profile whose bridge names no provider is a chain S2 does not serve (Elysium until its bridges are known):
    no destination, and nothing else here is read from it; one that names any must name both, at the app fee."""
    result = {}
    for file in sorted(Path(path).glob('*.json')):
        profile = json.loads(file.read_text())
        if not profile.get('enabled'):
            continue
        bridge = profile.get('bridge')
        if type(bridge) is not dict or bridge.get('appFeeBps') != APP_FEE_BPS:
            raise DataError('invalid_chain_profile')
        if bridge.get('providers') == []:
            continue  # S2 is off on this chain
        cid = chain_id(profile['chainId'], 'invalid_chain_profile')
        tokens = {}
        for currency in profile['chargeCurrencies']:
            token = address(currency['address'], 'invalid_chain_profile')
            tokens[token] = {'symbol': currency['symbol'], 'decimals': currency['decimals'],
                             'native': bool(currency.get('native')), 'rank': currency['rank']}
        result[cid] = {'slug': profile['slug'], 'name': profile['name'], 'tokens': tokens,
                       'wrappedNative': address(profile['wrappedNative']['address'], 'invalid_chain_profile'),
                       'bridge': profile['bridge']}
    if not result:
        raise DataError('invalid_chain_profile')
    for row in result.values():
        if row['bridge'].get('appFeeBps') != APP_FEE_BPS or set(row['bridge'].get('providers', ())) != set(PROVIDERS):
            raise DataError('invalid_chain_profile')
    return result
