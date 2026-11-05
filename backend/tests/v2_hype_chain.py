"""A synthetic HYPE-native chain without Chainlink: what an enabled Elysium profile will look like, as a test fixture.

Kinetiq's Elysium mainnet (Arbitrum Nitro, native HYPE, wrapped WHYPE) has no chain id, RPC or Uniswap deployment yet,
so no enabled profile can be committed (api-contracts/v2/chains/elysium.json stays pending). This builds one from its
testnet facts as that file records them on 1 Oct 2026 (TESTNET: Permit2, Multicall3, WHYPE and its decimals, the
chain id 99801; tests/test_v2_chains.py holds them to the file while it is there) and, where the testnet has none,
from Arbitrum One's profile (Uniswap, CreateX: synthetic stand-ins), with:
- the native currency HYPE and its wrapped token WHYPE, beside a synthetic USDC as the rank-1 stable;
- no Chainlink feed: `gasPrice.poolNativeUsd` names the WHYPE/USDC pool HYPE is priced in (v3 at its factory's
  CREATE2 address, or a hookless v4 pool of native HYPE by its id);
- no bridge provider: S2 is off on it.
Nothing here is a fact about Elysium's mainnet; the file name, slug and id only rehearse the shape of the day it is.
"""
import copy

from eth_abi import encode
from eth_hash.auto import keccak
from eth_utils import to_checksum_address

from v2_fixtures import documents, write_registry

CHAIN_ID = 99801  # TESTNET's
FILE = f'elysium-{CHAIN_ID}.json'
KEY = f'elysium-{CHAIN_ID}'
ZERO = '0x' + '00' * 20


def synthetic(label):
    """A checksummed address no real contract holds on purpose: the last 20 bytes of keccak256(label)."""
    return to_checksum_address('0x' + keccak(label.encode())[12:].hex())


def code_hash(label):
    return '0x' + keccak(b'code:' + label.encode()).hex()


# api-contracts/v2/chains/elysium.json's `testnet` and `stack`, kept here so the fixture outlives that pending file.
TESTNET = {'chainId': 99801, 'stack': 'arbitrum-nitro', 'permit2': '0x000000000022D473030F116dDEE9F6B43aC78BA3',
           'multicall3': '0xcA11bde05977b3631167028862bE2a173976CA11', 'checkedAt': '2026-10-01',
           'wrappedNative': {'symbol': 'WHYPE', 'address': '0xCD57F65c2B0e5881CFC2E609F7CD53b746E1F234', 'decimals': 18}}
WHYPE = TESTNET['wrappedNative']['address']
USDC = synthetic('synthetic elysium USDC')
POOL_FEE, POOL_SPACING = 500, 10


def v3_pool(factory, init_code_hash, token_a, token_b, fee):
    low, high = sorted((token_a.lower(), token_b.lower()))
    salt = keccak(encode(['address', 'address', 'uint24'], [low, high, fee]))
    digest = keccak(b'\xff' + bytes.fromhex(factory[2:]) + salt + bytes.fromhex(init_code_hash[2:]))
    return to_checksum_address('0x' + digest[12:].hex())


def v4_pool_id(currency_a, currency_b, fee, spacing):
    low, high = sorted((currency_a.lower(), currency_b.lower()))
    return '0x' + keccak(encode(['address', 'address', 'uint24', 'int24', 'address'],
                                [low, high, fee, spacing, ZERO])).hex()


def document(*, v4=False):
    """The synthetic enabled profile: HYPE native, WHYPE wrapped, USDC at rank 1, priced by its WHYPE/USDC pool (v3) or
    its native HYPE/USDC pool (v4), no bridge."""
    arbitrum = copy.deepcopy(documents()['arbitrum-42161.json'])
    testnet = TESTNET
    uniswap = arbitrum['uniswap']
    keep = {uniswap['v3'][name] for name in ('factory', 'positionManager', 'quoterV2', 'swapRouter02')} | {
        uniswap['v4'][name] for name in ('poolManager', 'positionManager', 'stateView', 'quoter')} | {
        uniswap['universalRouter']['address'], testnet['permit2'], testnet['multicall3'],
        arbitrum['deployer']['address']}
    records = [record for record in arbitrum['verification']['contracts'] if record['address'] in keep]
    records += [{'name': 'WHYPE (testnet address)', 'address': WHYPE, 'codehash': code_hash('WHYPE')},
                {'name': 'USDC (synthetic)', 'address': USDC, 'codehash': code_hash('USDC')}]
    if v4:
        source = {'dex': 4, 'poolId': v4_pool_id(ZERO, USDC, POOL_FEE, POOL_SPACING), 'currency': ZERO,
                  'stable': USDC, 'fee': POOL_FEE, 'tickSpacing': POOL_SPACING}
    else:
        pool = v3_pool(uniswap['v3']['factory'], uniswap['v3']['poolInitCodeHash'], WHYPE, USDC, POOL_FEE)
        records.append({'name': 'v3 pool WHYPE/USDC fee 500 (synthetic)', 'address': pool,
                        'codehash': code_hash('pool')})
        source = {'dex': 3, 'pool': pool, 'currency': WHYPE, 'stable': USDC, 'fee': POOL_FEE}
    return {
        'schemaVersion': 1, 'chainId': CHAIN_ID, 'slug': 'elysium', 'name': 'Elysium (synthetic test fixture)',
        'enabled': True, 'nativeSymbol': 'HYPE', 'stack': TESTNET['stack'], 'blockTimeSeconds': 0.25,
        'uniswap': uniswap, 'permit2': testnet['permit2'], 'multicall3': testnet['multicall3'],
        'deployer': arbitrum['deployer'], 'wrappedNative': dict(testnet['wrappedNative']),
        'chargeCurrencies': [{'rank': 1, 'symbol': 'USDC', 'address': USDC, 'decimals': 6},
                             {'rank': 2, 'symbol': 'HYPE', 'address': ZERO, 'decimals': 18, 'native': True},
                             {'rank': 2, 'symbol': 'WHYPE', 'address': WHYPE, 'decimals': 18}],
        'gasPrice': {'poolNativeUsd': source},
        'bridge': {'providers': [], 'appFeeBps': 35},
        'finality': 'Synthetic: Nitro soft confirmation; finalized follows the parent chain batch.',
        'verification': {'block': 1, 'checkedAt': testnet['checkedAt'], 'contracts': records},
        'notes': ['Synthetic test fixture from Elysium testnet facts; not a profile.'],
        'sources': [],
    }


def docs(*, v4=False, change=None):
    """The repository's profiles with Elysium enabled as on its first day: its file (pending today, enabled once its
    mainnet is) gives way to this one."""
    out = {name: document for name, document in documents().items() if document.get('slug') != 'elysium'}
    out[FILE] = document(v4=v4)
    if change is not None:
        change(out[FILE])
    return out


def registry(directory, **options):
    """The four enabled chains, loaded from `directory`."""
    return write_registry(directory, docs(**options))
