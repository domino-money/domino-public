"""Domino V2 chain registry: the verified profiles in api-contracts/v2/chains.

F0 froze one JSON profile per chain (docs/v2/F0_INTERFACES.md). Every V2
service takes its chain's facts from here instead of constants of its own: the
Uniswap v3 and v4 deployments, Permit2, Multicall3, the deterministic deployer,
the wrapped native token, the charge currencies in rank order, what prices the
native currency in USD, the bridge fee and providers, and the block-time and
finality facts. A V2 service serves exactly one chain, the Elysium spec's
isolation principle: it selects its profile by name (`base-8453`) and every RPC
route it opens must prove that chain id (v2_rpc).

The native currency's USD (`gasPrice`) is one of two sources, never both:
- `chainlinkEthUsd`: the Chainlink ETH/USD feed, with its sequencer uptime feed
  where Chainlink publishes one (Robinhood, Base, Arbitrum: every profile before
  Elysium, meaning exactly what it meant);
- `poolNativeUsd`: on a chain Chainlink does not serve (Elysium's HYPE), the
  spot of the native currency against the chain's stable (its rank-1 charge
  currency) on the one pool the profile names, a v3 pool at its factory's
  CREATE2 address or a hookless v4 pool by its id, qualified as any pool price
  is (v2_chain_reads: its depth within the band reaches the floor).
A profile with no bridge provider is a chain S2 does not serve
(crosschain_common); one that names any names only providers pinned on that
chain (crosschain_pins.json): Relay and Across, or Relay alone on Elysium.

A chain may have one Uniswap version only (Elysium's mainnet shows v4 alone,
6 Nov 2026): the other is `null` in its profile, `dexes` names the versions it
has, its native pool must be of one of them, and every V2 service skips the
paths of the version it lacks. A request that names that version is refused
(`v2_dex_not_on_chain`), never answered empty.

Loading checks the whole directory and refuses a profile whole, never
defaulting a field: exact keys and types, EIP-55 checksums, the file name, the
rank order the fee rule depends on, the native and wrapped currencies, and
that every contract V2 consumes is in the profile's own on-chain verification
record, so its code hash can be checked at run time. Addresses are kept in
lower case, the backend's convention. A disabled profile (Elysium until its
mainnet is live) is listed as pending and never served. `load_registry` refuses
the directory for one bad profile, which is what the tests and CI hold the
repository to; the services' `default_registry` sets a bad profile aside
instead (`refused`), so a mistake in a new chain's file stops that chain alone
and never the chains already live.

The charge-currency selection rule itself belongs to the contracts (F2); this
module exposes the ranks it reads, not a second implementation of the rule.

Balance chains (api-contracts/v2/balance-chains: Ethereum and OP Mainnet, the
owner's decision of 6 Oct 2026) are not Domino chains: no V2 deployment, index,
plan or automation runs there, and only read-v6's chain-balances reads them,
when a request asks (v2_chain_reads). Their lighter profile names only what a
balance and its qualified USD read: Multicall3, the base currencies (the
stable at rank 1, ETH and its wrapped token; `chargeCurrencies`, named as in
the Domino profiles because the chain reads read both alike, though nothing is
charged there), the Chainlink ETH/USD feed and its sequencer's, and the Uniswap
v3 factory and v4 StateView the pools are read through. It is loaded whole or
refused whole by the same rules, every contract it consumes is in its own
verification record, and no balance chain may take a Domino chain's id or
name.
"""
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from fractions import Fraction
from functools import lru_cache
import json
from pathlib import Path
import re
from typing import Annotated, Any, Literal

from eth_abi import encode
from eth_hash.auto import keccak
from eth_utils import is_checksum_address
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictInt, ValidationError, model_validator

from discovery import DataError

ROOT = Path(__file__).resolve().parents[1]
PROFILE_DIRECTORY = ROOT / 'api-contracts/v2/chains'
BALANCE_PROFILE_DIRECTORY = ROOT / 'api-contracts/v2/balance-chains'
MAX_PROFILE_BYTES = 65536
ZERO = '0x' + '00' * 20
# DominoV2Types.DEX_V3 and DEX_V4: the `dex` of every PoolRef and PositionRef
# (pinned against the Solidity source in tests/test_v2_chains.py).
DEX_V3, DEX_V4 = 3, 4
# The Universal Router versions a profile may name, each with the registry's uint16 for it (REGISTRY_ROUTER: 2.1.2 is
# 212, v2_manifest.POLICIES' minimumUniversalRouterVersion). 2.0 and 2.1.1 were sunset on 21 Oct 2026. A version
# joins only once qualified: its deployment verified, its registry number at least 212, and the router legs the
# backend builds for it (v2_uniswap_api asks the Trading API for 2.1.2 legs alone). 2.1.2 is the only one in use.
UNIVERSAL_ROUTER_VERSIONS = {'2.1.2': 212}
# A profile's file stem when enabled: `<slug>-<chain id>`.
PROFILE_KEY = re.compile(r'([a-z][a-z0-9]{0,31})-([1-9][0-9]{0,18})')


def _checksummed(value):
    if not is_checksum_address(value):
        raise ValueError('address_not_checksummed')
    return value.lower()


def _contract(value):
    if value == ZERO:
        raise ValueError('zero_contract_address')
    return value


def _calendar_day(value):
    date.fromisoformat(value)
    return value


Address = Annotated[str, Field(pattern=r'^0x[0-9a-fA-F]{40}$'), AfterValidator(_checksummed)]
Contract = Annotated[Address, AfterValidator(_contract)]
CodeHash = Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$')]
Symbol = Annotated[str, Field(pattern=r'^[A-Za-z0-9.]{1,16}$')]
Decimals = Annotated[StrictInt, Field(ge=0, le=255)]
Text = Annotated[str, Field(min_length=1, max_length=2000)]
FeeKey = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,5})$')]
Slug = Annotated[str, Field(pattern=r'^[a-z][a-z0-9]{0,31}$')]


class Frozen(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)


class V3Deployment(Frozen):
    factory: Contract
    positionManager: Contract
    quoterV2: Contract
    swapRouter02: Contract
    poolInitCodeHash: CodeHash
    tickSpacingByFee: dict[FeeKey, Annotated[StrictInt, Field(ge=1, lt=16384)]]

    @model_validator(mode='after')
    def checked(self):
        if not self.tickSpacingByFee:
            raise ValueError('v3_fee_tiers_missing')
        return self


class V4Deployment(Frozen):
    poolManager: Contract
    positionManager: Contract
    stateView: Contract
    quoter: Contract


class UniversalRouter(Frozen):
    address: Contract
    # 2.0 and 2.1.1 are sunset on 21 October 2026; F0 pins 2.1.2 on every chain (UNIVERSAL_ROUTER_VERSIONS).
    version: Literal[tuple(UNIVERSAL_ROUTER_VERSIONS)]


class Uniswap(Frozen):
    """A chain's Uniswap: v3, v4 or both (a chain may have one only: `null` for the other, the key still present), and
    the Universal Router either way."""
    v3: V3Deployment | None
    v4: V4Deployment | None
    universalRouter: UniversalRouter

    @model_validator(mode='after')
    def checked(self):
        if self.v3 is None and self.v4 is None:
            raise ValueError('uniswap_deployment_missing')
        return self


class Deployer(Frozen):
    kind: Literal['createx']
    address: Contract
    codehash: CodeHash


class Token(Frozen):
    symbol: Symbol
    address: Contract
    decimals: Decimals


class ChargeCurrency(Frozen):
    rank: Annotated[StrictInt, Field(ge=1, le=255)]
    symbol: Symbol
    address: Address
    decimals: Decimals
    native: bool = False

    @model_validator(mode='after')
    def checked(self):
        if self.native != (self.address == ZERO):
            raise ValueError('native_charge_currency_is_the_zero_address')
        return self


class ChainlinkFeed(Frozen):
    proxy: Contract
    aggregator: Contract
    decimals: Annotated[StrictInt, Field(ge=0, le=36)]
    heartbeatSeconds: Annotated[StrictInt, Field(ge=1, le=7 * 86400)]
    deviationBps: Annotated[StrictInt, Field(ge=0, le=10000)]
    # Base and Arbitrum publish one; Chainlink publishes none for Robinhood.
    sequencerUptimeFeed: Contract | None


class GasPrice(Frozen):
    """The native currency priced by Chainlink's ETH/USD feed (every chain before Elysium)."""
    chainlinkEthUsd: ChainlinkFeed


class V3NativeUsd(Frozen):
    """A v3 pool of the wrapped native token and the chain's stable: its address, which must be the factory's CREATE2
    address for the pair and fee, and the fee, one of the profile's tiers (its tick spacing)."""
    dex: Literal[3]
    pool: Contract
    currency: Contract
    stable: Contract
    fee: Annotated[StrictInt, Field(ge=0, lt=1_000_000)]


class V4NativeUsd(Frozen):
    """A hookless v4 pool of the native currency (the zero address) or its wrapped token and the chain's stable, by its
    id, which must be the hash of that key: the fixed LP fee and the tick spacing are part of it."""
    dex: Literal[4]
    poolId: Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$')]
    currency: Address
    stable: Contract
    fee: Annotated[StrictInt, Field(ge=0, le=1_000_000)]
    tickSpacing: Annotated[StrictInt, Field(ge=1, le=32767)]


class PoolGasPrice(Frozen):
    """The native currency of a chain Chainlink does not serve, priced by the one pool the profile names."""
    poolNativeUsd: Annotated[V3NativeUsd | V4NativeUsd, Field(discriminator='dex')]


def _v3_pool_address(v3, token0, token1, fee):
    """v2_uniswap.v3_pool_address, on the profile's own facts (that module reads profiles, not the reverse)."""
    salt = keccak(encode(['address', 'address', 'uint24'], [token0, token1, fee]))
    digest = keccak(b'\xff' + bytes.fromhex(v3.factory[2:]) + salt + bytes.fromhex(v3.poolInitCodeHash[2:]))
    return '0x' + digest[12:].hex()


def _v4_pool_id(currency0, currency1, fee, spacing):
    """v2_uniswap.PoolRef.pool_id of a hookless key."""
    return '0x' + keccak(encode(['address', 'address', 'uint24', 'int24', 'address'],
                                [currency0, currency1, fee, spacing, ZERO])).hex()


class Bridge(Frozen):
    # No provider: S2 does not serve the chain. Each named provider must be pinned on it (crosschain_common).
    providers: Annotated[tuple[Literal['relay', 'across'], ...], Field(min_length=0, max_length=2)]
    appFeeBps: Annotated[StrictInt, Field(ge=0, le=10000)]

    @model_validator(mode='after')
    def checked(self):
        if len(set(self.providers)) != len(self.providers):
            raise ValueError('duplicate_bridge_provider')
        return self


class VerifiedContract(Frozen):
    name: Annotated[str, Field(min_length=1, max_length=160)]
    address: Address
    codehash: CodeHash | None
    absent: bool = False

    @model_validator(mode='after')
    def checked(self):
        # A checked absence (no ArbSys on Base) has no code hash; anything else has one.
        if self.absent != (self.codehash is None):
            raise ValueError('verified_codehash_or_absence')
        return self


class Verification(Frozen):
    block: Annotated[StrictInt, Field(ge=1, lt=2**63)]
    checkedAt: Annotated[str, Field(pattern=r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'), AfterValidator(_calendar_day)]
    contracts: Annotated[tuple[VerifiedContract, ...], Field(min_length=1, max_length=128)]

    @model_validator(mode='after')
    def checked(self):
        addresses = [contract.address for contract in self.contracts]
        if len(set(addresses)) != len(addresses):
            raise ValueError('duplicate_verified_address')
        return self


def _checked_currencies(profile):
    """The rules a profile's currencies keep, a Domino chain's and a balance chain's alike."""
    currencies = profile.chargeCurrencies
    ranks = [currency.rank for currency in currencies]
    # The fee rule reads the list in rank order: rank 1 first, then the
    # same or the next rank, so a reordered file cannot change a charge.
    if ranks[0] != 1 or any(b not in (a, a + 1) for a, b in zip(ranks, ranks[1:])):
        raise ValueError('charge_currency_ranks_out_of_order')
    if len({currency.address for currency in currencies}) != len(currencies):
        raise ValueError('duplicate_charge_currency')
    native = [currency for currency in currencies if currency.native]
    wrapped = [currency for currency in currencies if currency.address == profile.wrappedNative.address]
    if any(c.symbol != profile.nativeSymbol or c.decimals != 18 for c in native):
        raise ValueError('native_charge_currency_invalid')
    if profile.wrappedNative.decimals != 18 or any(c.decimals != 18 for c in wrapped):
        raise ValueError('wrapped_native_decimals_invalid')
    # Native and wrapped native are one currency to the fee rule.
    if native and wrapped and native[0].rank != wrapped[0].rank:
        raise ValueError('native_and_wrapped_ranks_differ')
    return native, wrapped


class ChainProfile(Frozen):
    """One enabled chain. Every address is checksummed in the file, lower case here."""
    schemaVersion: Literal[1]
    chainId: Annotated[StrictInt, Field(ge=1, lt=2**63)]
    slug: Slug
    name: Annotated[str, Field(min_length=1, max_length=64)]
    enabled: Literal[True]
    nativeSymbol: Symbol
    # Gas and block semantics differ by stack: Nitro's block.number is the
    # parent chain's, OP Stack has 2 s blocks plus 200 ms Flashblocks.
    stack: Literal['arbitrum-nitro', 'op-stack']
    # Nominal seconds per block, a profile fact for converting windows; block
    # production is not uniform, so a window that must hold uses timestamps.
    blockTimeSeconds: Annotated[Decimal, Field(gt=0, le=60)]
    uniswap: Uniswap
    permit2: Contract
    multicall3: Contract
    deployer: Deployer
    wrappedNative: Token
    chargeCurrencies: Annotated[tuple[ChargeCurrency, ...], Field(min_length=1, max_length=16)]
    gasPrice: GasPrice | PoolGasPrice
    bridge: Bridge
    finality: Text
    verification: Verification
    notes: tuple[Text, ...]
    sources: tuple[Text, ...]

    @model_validator(mode='after')
    def checked(self):
        currencies = self.chargeCurrencies
        _checked_currencies(self)
        records = {contract.address: contract for contract in self.verification.contracts}
        uniswap = self.uniswap
        # Only the versions the chain has: a v4-only chain records no v3 contract, and is asked for none.
        contracts = [*((uniswap.v3.factory, uniswap.v3.positionManager, uniswap.v3.quoterV2, uniswap.v3.swapRouter02)
                       if uniswap.v3 is not None else ()),
                     *((uniswap.v4.poolManager, uniswap.v4.positionManager, uniswap.v4.stateView, uniswap.v4.quoter)
                       if uniswap.v4 is not None else ()),
                     uniswap.universalRouter.address]
        if len(set(contracts)) != len(contracts):
            raise ValueError('uniswap_contracts_not_distinct')
        feed, pool = self.native_feed, self.native_pool
        if pool is not None:
            self._checked_native_pool(pool)
        consumed = [*contracts, self.permit2, self.multicall3, self.deployer.address, self.wrappedNative.address,
                    *([feed.proxy, *([feed.sequencerUptimeFeed] if feed.sequencerUptimeFeed else [])]
                      if feed is not None else []),
                    *([pool.pool] if pool is not None and pool.dex == DEX_V3 else []),
                    *(currency.address for currency in currencies if not currency.native)]
        if any(address not in records or records[address].absent for address in consumed):
            raise ValueError('consumed_contract_not_verified')
        if records[self.deployer.address].codehash != self.deployer.codehash:
            raise ValueError('deployer_codehash_mismatch')
        return self

    def _checked_native_pool(self, pool):
        """The pool pairs the native currency with the stable the chain reads price at US$ 1, and is the one its address
        or id names."""
        # The pool is read through its own version's contracts, so that version must be the chain's.
        if pool.dex not in self.dexes:
            raise ValueError('native_usd_pool_dex_not_on_chain')
        stable = min(self.chargeCurrencies, key=lambda currency: (currency.rank, currency.address))
        wrapped = self.wrappedNative.address
        currencies = (wrapped, ZERO) if pool.dex == DEX_V4 else (wrapped,)
        # A stable that is the wrapped token itself would price the native currency in itself.
        if pool.stable != stable.address or pool.currency not in currencies or pool.stable == wrapped:
            raise ValueError('native_usd_pool_invalid')
        low, high = sorted((pool.currency, pool.stable))
        if pool.dex == DEX_V3:
            if (self.v3_tick_spacing(pool.fee) is None
                    or pool.pool != _v3_pool_address(self.uniswap.v3, low, high, pool.fee)):
                raise ValueError('native_usd_pool_invalid')
        elif pool.poolId != _v4_pool_id(low, high, pool.fee, pool.tickSpacing):
            raise ValueError('native_usd_pool_invalid')

    @property
    def key(self):
        """The profile's file stem and the name a service is started with."""
        return f'{self.slug}-{self.chainId}'

    @property
    def dexes(self):
        """The Uniswap versions the chain has, ascending: (3, 4), or one of them alone."""
        return tuple(dex for dex, deployment in ((DEX_V3, self.uniswap.v3), (DEX_V4, self.uniswap.v4))
                     if deployment is not None)

    def require_dex(self, dex):
        """The chain's deployment of Uniswap `dex` (3 or 4); `v2_dex_not_on_chain` for a version the chain lacks."""
        return _required_dex(self.uniswap, dex)

    def position_manager(self, dex):
        """The position manager of Uniswap `dex` on this chain: v3's NonfungiblePositionManager or v4's
        PositionManager."""
        return self.require_dex(dex).positionManager

    @property
    def native_feed(self):
        """The Chainlink ETH/USD feed that prices the native currency, or None on a chain its pool prices."""
        return self.gasPrice.chainlinkEthUsd if isinstance(self.gasPrice, GasPrice) else None

    @property
    def native_pool(self):
        """The pool that prices the native currency (gasPrice.poolNativeUsd), or None on a chain Chainlink prices."""
        return self.gasPrice.poolNativeUsd if isinstance(self.gasPrice, PoolGasPrice) else None

    @property
    def block_time(self):
        return Fraction(self.blockTimeSeconds)

    def charge_rank(self, currency):
        """The currency's rank in this chain's charge list, or None if unlisted."""
        currency = currency.lower()
        return next((c.rank for c in self.chargeCurrencies if c.address == currency), None)

    def verified_codehash(self, contract):
        """The code hash the profile recorded on chain; None for a checked absence."""
        return _verified_codehash(self.verification, contract)

    def v3_tick_spacing(self, fee):
        """The standard tiers the profile lists; None means ask the factory (F0). A chain without v3 has no tier."""
        return self.require_dex(DEX_V3).tickSpacingByFee.get(str(fee))


def _required_dex(uniswap, dex):
    deployment = {DEX_V3: uniswap.v3, DEX_V4: uniswap.v4}.get(dex)
    if deployment is None:
        raise DataError('v2_dex_not_on_chain')
    return deployment


def _verified_codehash(verification, contract):
    contract = contract.lower()
    for record in verification.contracts:
        if record.address == contract:
            return record.codehash
    raise DataError('v2_contract_not_in_profile')


class PendingChain(Frozen):
    """A chain V2 will add (Elysium): listed with its conditions, never served."""
    schemaVersion: Literal[1]
    chainId: None
    slug: Slug
    name: Annotated[str, Field(min_length=1, max_length=64)]
    enabled: Literal[False]
    nativeSymbol: Symbol
    stack: Literal['arbitrum-nitro', 'op-stack']
    enableWhen: Annotated[tuple[Text, ...], Field(min_length=1)]
    testnet: dict[str, Any] | None = None
    notes: tuple[Text, ...] = ()


# --------------------------------------------------------------- balance chains
class BalanceV3(Frozen):
    """The v3 factory whose CREATE2 addresses the pools are read at (v2_uniswap.v3_pool_address), and its tiers."""
    factory: Contract
    poolInitCodeHash: CodeHash
    tickSpacingByFee: dict[FeeKey, Annotated[StrictInt, Field(ge=1, lt=16384)]]

    @model_validator(mode='after')
    def checked(self):
        if not self.tickSpacingByFee:
            raise ValueError('v3_fee_tiers_missing')
        return self


class BalanceV4(Frozen):
    """The v4 PoolManager, and the StateView its pools' state is read through."""
    poolManager: Contract
    stateView: Contract


class BalanceUniswap(Frozen):
    v3: BalanceV3
    v4: BalanceV4


class EthUsdFeed(Frozen):
    """The Chainlink ETH/USD proxy that prices ETH and WETH, and on an L2 the sequencer uptime feed that gates it."""
    proxy: Contract
    decimals: Annotated[StrictInt, Field(ge=0, le=36)]
    heartbeatSeconds: Annotated[StrictInt, Field(ge=1, le=7 * 86400)]
    sequencerUptimeFeed: Contract | None


class BalanceFeeds(Frozen):
    chainlinkEthUsd: EthUsdFeed


class BalanceChainProfile(Frozen):
    """A chain read-v6's chain-balances reads beside Domino's own, when asked; nothing else reads it. Every address is
    checksummed in the file, lower case here."""
    schemaVersion: Literal[1]
    kind: Literal['domino-v2-balance-chain']
    chainId: Annotated[StrictInt, Field(ge=1, lt=2**63)]
    slug: Slug
    name: Annotated[str, Field(min_length=1, max_length=64)]
    nativeSymbol: Symbol
    uniswap: BalanceUniswap
    multicall3: Contract
    wrappedNative: Token
    # The stable at rank 1, priced at US$ 1, then ETH and its wrapped token: the pools' partners when a token is priced.
    chargeCurrencies: Annotated[tuple[ChargeCurrency, ...], Field(min_length=1, max_length=16)]
    gasPrice: BalanceFeeds
    verification: Verification
    notes: tuple[Text, ...]
    sources: tuple[Text, ...]

    @model_validator(mode='after')
    def checked(self):
        native, wrapped = _checked_currencies(self)
        # One currency at rank 1, the stable the chain reads price at US$ 1, and ETH and WETH beside it. ETH and WETH
        # share a rank, so neither can be that one.
        if len([c for c in self.chargeCurrencies if c.rank == 1]) != 1 or not native or not wrapped:
            raise ValueError('balance_currencies_invalid')
        uniswap = self.uniswap
        contracts = [uniswap.v3.factory, uniswap.v4.poolManager, uniswap.v4.stateView]
        if len(set(contracts)) != len(contracts):
            raise ValueError('uniswap_contracts_not_distinct')
        feed = self.gasPrice.chainlinkEthUsd
        # The wrapped token is one of the currencies, as above.
        consumed = [*contracts, self.multicall3, feed.proxy,
                    *([feed.sequencerUptimeFeed] if feed.sequencerUptimeFeed else []),
                    *(currency.address for currency in self.chargeCurrencies if not currency.native)]
        records = {contract.address: contract for contract in self.verification.contracts}
        if any(address not in records or records[address].absent for address in consumed):
            raise ValueError('consumed_contract_not_verified')
        return self

    @property
    def key(self):
        """The profile's file stem, and the chain's name in the balance chain RPC file and its credentials."""
        return f'{self.slug}-{self.chainId}'

    @property
    def dexes(self):
        """A balance chain always has both versions read (its pools are priced through either)."""
        return (DEX_V3, DEX_V4)

    def require_dex(self, dex):
        """Its deployment of Uniswap `dex`, as a Domino chain's (ChainProfile.require_dex)."""
        return _required_dex(self.uniswap, dex)

    def verified_codehash(self, contract):
        """The code hash the profile recorded on chain; None for a checked absence."""
        return _verified_codehash(self.verification, contract)


@dataclass(frozen=True)
class RefusedProfile:
    """A profile a tolerant load set aside: its file stem (`elysium-999`, or a pending one's slug), the chain id that
    stem names if any, and the refusal's code. Its chain is never served."""
    key: str
    chain_id: int | None
    code: str

    @classmethod
    def of(cls, path, code):
        match = PROFILE_KEY.fullmatch(path.stem)
        return cls(path.stem, int(match.group(2)) if match else None, code)


@dataclass(frozen=True)
class ChainRegistry:
    chains: tuple  # ChainProfile (BalanceChainProfile in the balance registry), by chain id
    pending: tuple  # PendingChain
    refused: tuple = ()  # RefusedProfile: what a tolerant load (default_registry) set aside, by file name

    def chain(self, name):
        """An enabled chain by id (8453) or name (`base-8453`)."""
        for profile in self.chains:
            if name == profile.key or type(name) is int and name == profile.chainId:
                return profile
        if any(name == pending.slug for pending in self.pending):
            raise DataError('v2_chain_not_enabled')
        if any(name == refused.key or type(name) is int and name == refused.chain_id for refused in self.refused):
            raise DataError('v2_chain_profile_invalid')
        raise DataError('v2_chain_unknown')


def _json_document(path):
    raw = path.read_bytes()
    if len(raw) > MAX_PROFILE_BYTES:
        raise DataError('v2_chain_profile_invalid')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_json_key')
            result[key] = value
        return result

    def constant(_):
        raise ValueError('nonfinite_json_number')
    try:
        # Duplicate keys and non-finite numbers are refused here; pydantic then
        # validates the same text, keeping blockTimeSeconds an exact decimal.
        document = json.loads(raw, object_pairs_hook=unique, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise DataError('v2_chain_profile_invalid') from error
    if type(document) is not dict:
        raise DataError('v2_chain_profile_invalid')
    return raw, document


def _profile_document(path):
    raw, document = _json_document(path)
    if type(document.get('enabled')) is not bool:
        raise DataError('v2_chain_profile_invalid')
    return raw, document


def _loaded_profile(path):
    """(profile, enabled) for one file, or the refusal."""
    raw, document = _profile_document(path)
    kind = ChainProfile if document['enabled'] else PendingChain
    try:
        profile = kind.model_validate_json(raw)
    except ValidationError as error:
        # Profiles are public repository data: keep pydantic's detail.
        raise DataError('v2_chain_profile_invalid') from error
    expected = profile.key if document['enabled'] else profile.slug
    if path.name != expected + '.json':
        raise DataError('v2_chain_profile_file_name')
    return profile, document['enabled']


def load_registry(directory=PROFILE_DIRECTORY, *, tolerant=False):
    """Every profile in `directory`, checked. One refused refuses the directory; `tolerant` sets it aside instead
    (`refused`), and the other chains load as if it were absent. Duplicate ids or names, or no enabled chain at all,
    refuse the directory either way: no file can be blamed for them alone."""
    chains, pending, refused = [], [], []
    for path in sorted(Path(directory).glob('*.json')):
        try:
            profile, enabled = _loaded_profile(path)
        except DataError as error:
            if not tolerant:
                raise
            refused.append(RefusedProfile.of(path, str(error)))
            continue
        (chains if enabled else pending).append(profile)
    if not chains:
        raise DataError('v2_chain_profile_missing')
    ids = [profile.chainId for profile in chains]
    slugs = [profile.slug for profile in (*chains, *pending)]
    if len(set(ids)) != len(ids) or len(set(slugs)) != len(slugs):
        raise DataError('v2_chain_profile_duplicate')
    return ChainRegistry(tuple(sorted(chains, key=lambda profile: profile.chainId)), tuple(pending), tuple(refused))


@lru_cache(maxsize=1)
def default_registry():
    """The repository's profiles, loaded and checked once per process. Tolerant: a bad profile costs its own chain
    (`v2_chain_profile_invalid` when it is asked for), never the others'; tests/test_v2_chains.py loads the same
    directory strictly, so CI refuses the bad file before a release carries it."""
    return load_registry(tolerant=True)


def chain(name):
    return default_registry().chain(name)


def load_balance_registry(directory=BALANCE_PROFILE_DIRECTORY, domino=None):
    """The balance chains (BalanceChainProfile), by chain id, loaded whole or refused whole. None may be one of
    `domino`'s chains, by id or by name, so each chain is named in exactly one RPC file and one set of credentials."""
    domino = default_registry() if domino is None else domino
    chains = []
    for path in sorted(Path(directory).glob('*.json')):
        raw, _ = _json_document(path)
        try:
            profile = BalanceChainProfile.model_validate_json(raw)
        except ValidationError as error:
            raise DataError('v2_chain_profile_invalid') from error
        if path.name != profile.key + '.json':
            raise DataError('v2_chain_profile_file_name')
        chains.append(profile)
    if not chains:
        raise DataError('v2_chain_profile_missing')
    ids = [profile.chainId for profile in chains]
    slugs = [profile.slug for profile in chains]
    taken = {profile.chainId for profile in domino.chains}, {profile.slug for profile in (*domino.chains, *domino.pending)}
    if (len(set(ids)) != len(ids) or len(set(slugs)) != len(slugs) or set(ids) & taken[0]
            or set(slugs) & taken[1]):
        raise DataError('v2_chain_profile_duplicate')
    return ChainRegistry(tuple(sorted(chains, key=lambda profile: profile.chainId)), ())


@lru_cache(maxsize=1)
def default_balance_registry():
    """The repository's balance chain profiles, loaded and checked once per process."""
    return load_balance_registry()
