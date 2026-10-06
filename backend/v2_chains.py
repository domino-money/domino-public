"""Domino V2 chain registry: the verified profiles in api-contracts/v2/chains.

F0 froze one JSON profile per chain (docs/v2/F0_INTERFACES.md). Every V2
service takes its chain's facts from here instead of constants of its own: the
Uniswap v3 and v4 deployments, Permit2, Multicall3, the deterministic deployer,
the wrapped native token, the charge currencies in rank order, the Chainlink
ETH/USD feed that prices gas, the bridge fee, and the block-time and finality
facts. A V2 service serves exactly one chain, the Elysium spec's isolation
principle: it selects its profile by name (`base-8453`) and every RPC route it
opens must prove that chain id (v2_rpc).

Loading checks the whole directory and refuses a profile whole, never
defaulting a field: exact keys and types, EIP-55 checksums, the file name, the
rank order the fee rule depends on, the native and wrapped currencies, and
that every contract V2 consumes is in the profile's own on-chain verification
record, so its code hash can be checked at run time. Addresses are kept in
lower case, the backend's convention. A disabled profile (Elysium until its
mainnet is live) is listed as pending and never served.

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
from typing import Annotated, Any, Literal

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
    # 2.0 and 2.1.1 are sunset on 21 October 2026; F0 pins 2.1.2 on every chain.
    version: Literal['2.1.2']


class Uniswap(Frozen):
    v3: V3Deployment
    v4: V4Deployment
    universalRouter: UniversalRouter


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
    chainlinkEthUsd: ChainlinkFeed


class Bridge(Frozen):
    providers: Annotated[tuple[Literal['relay', 'across'], ...], Field(min_length=1, max_length=2)]
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
    gasPrice: GasPrice
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
        contracts = [uniswap.v3.factory, uniswap.v3.positionManager, uniswap.v3.quoterV2,
                     uniswap.v3.swapRouter02, uniswap.v4.poolManager, uniswap.v4.positionManager,
                     uniswap.v4.stateView, uniswap.v4.quoter, uniswap.universalRouter.address]
        if len(set(contracts)) != len(contracts):
            raise ValueError('uniswap_contracts_not_distinct')
        feed = self.gasPrice.chainlinkEthUsd
        consumed = [*contracts, self.permit2, self.multicall3, self.deployer.address,
                    self.wrappedNative.address, feed.proxy,
                    *([feed.sequencerUptimeFeed] if feed.sequencerUptimeFeed else []),
                    *(currency.address for currency in currencies if not currency.native)]
        if any(address not in records or records[address].absent for address in consumed):
            raise ValueError('consumed_contract_not_verified')
        if records[self.deployer.address].codehash != self.deployer.codehash:
            raise ValueError('deployer_codehash_mismatch')
        return self

    @property
    def key(self):
        """The profile's file stem and the name a service is started with."""
        return f'{self.slug}-{self.chainId}'

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
        """The standard tiers the profile lists; None means ask the factory (F0)."""
        return self.uniswap.v3.tickSpacingByFee.get(str(fee))


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

    def verified_codehash(self, contract):
        """The code hash the profile recorded on chain; None for a checked absence."""
        return _verified_codehash(self.verification, contract)


@dataclass(frozen=True)
class ChainRegistry:
    chains: tuple  # ChainProfile (BalanceChainProfile in the balance registry), by chain id
    pending: tuple  # PendingChain

    def chain(self, name):
        """An enabled chain by id (8453) or name (`base-8453`)."""
        for profile in self.chains:
            if name == profile.key or type(name) is int and name == profile.chainId:
                return profile
        if any(name == pending.slug for pending in self.pending):
            raise DataError('v2_chain_not_enabled')
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


def load_registry(directory=PROFILE_DIRECTORY):
    chains, pending = [], []
    for path in sorted(Path(directory).glob('*.json')):
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
        (chains if document['enabled'] else pending).append(profile)
    if not chains:
        raise DataError('v2_chain_profile_missing')
    ids = [profile.chainId for profile in chains]
    slugs = [profile.slug for profile in (*chains, *pending)]
    if len(set(ids)) != len(ids) or len(set(slugs)) != len(slugs):
        raise DataError('v2_chain_profile_duplicate')
    return ChainRegistry(tuple(sorted(chains, key=lambda profile: profile.chainId)), tuple(pending))


@lru_cache(maxsize=1)
def default_registry():
    """The repository's profiles, loaded and checked once per process."""
    return load_registry()


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
