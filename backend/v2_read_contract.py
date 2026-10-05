"""read-v6: the Domino V2 wallet reads for the app (F7), across chains.

Two stored routes, served by the local reader (read_api) and, once the bridge
side enables them, by the gateway: no RPC at request time, one read-only
snapshot of the V2 index (v2_index_store) per answer. Three chain reads beside
them (chain-pools, chain-balances, chain-tokens) read the chains when asked
(v2_chain_reads); their models close this module.

- portfolio: per chain, how fresh and how final the index is, the registry's
  halt and admitted operators; the wallet's V2 vaults (custody with the disarm
  reason, members with their lots, reserves, pause, policy, limits, totals);
  the positions it holds or its vaults manage, as last read; its auto-exit
  mandates with what currently blocks them; undelivered auto-exit credit; and,
  per vault and mandate, why the chain's automation last said it waits.
- activity: the wallet's receipts, newest first, paged: S1 actions with the
  tariff, the swap legs, the position steps and the refunds; vault creation,
  executions (fees collected, swaps, the compound and the tariff), owner and
  custody events; auto-exits with the fee, the conversion and the delivery;
  mandate registration and revocation; credits claimed. Each names its
  transaction, block, finality and, once read, the gas it paid.

The shapes follow read-v1's conventions the app already uses (app spec F7
§6.2, §6.3): a read's `snapshot` is `{number, hash, timestamp}` and its
`freshness` is `{ageSeconds, status: fresh|stale}`; anything unavailable says
so with a reason.

What it never says. No USD anywhere, no APR, no price (`price` is null with
its reason): raw integer strings in each token's own units, with the token's
untrusted metadata beside them (decimals are null when unread, never
guessed). Zero is only ever a measured zero. A chain the index has not reached
is `unavailable`, one whose index is behind is `stale`, and the answer is then
`partial`. A state not read yet is `not_read`, a failed read `unavailable`.

The read API does not authenticate wallets: everything here is public chain
data, readable for any address, and the reader refuses browser origins.
Errors are read-v1's codes (read_contract.ERROR_STATUS_BY_CODE).
"""
import re
from typing import Annotated, Literal, Union

from pydantic import AfterValidator, Field, StrictBool, StrictInt, model_validator

from read_contract import WireModel

CONTRACT_VERSION = '1.1.0-rc.1'
ROUTES = ('portfolio', 'activity', 'chain-pools', 'chain-balances', 'chain-tokens')
# The routes that read stored data only; chain-pools and chain-balances read the chains at request time
# (v2_chain_reads) and take the reader's provider lane.
STORED_ROUTES = ('portfolio', 'activity', 'chain-tokens')
# The enabled V2 chains (api-contracts/v2/chains), ascending; a constant so the
# reader never loads the profiles to start. tests/test_read_v6_contract.py
# holds it to the registry.
CHAIN_IDS = (4663, 8453, 42161)
MAX_VAULTS, MAX_POSITIONS, MAX_MANDATES, MAX_CREDITS, MAX_TOKENS = 50, 100, 100, 50, 300
MAX_ITEMS, DEFAULT_ITEMS = 50, 20
MAX_LEGS, MAX_STEPS, MAX_LINES, MAX_EVENTS, MAX_MEMBERS = 8, 8, 16, 32, 256
# A chain is current while its head was observed within HEAD_MAX_AGE_SECONDS
# and the index is within MAX_LAG_SECONDS of that head; a position or vault
# read is stale once an event touched it after the read, or after STALE_SECONDS.
HEAD_MAX_AGE_SECONDS, MAX_LAG_SECONDS, STALE_SECONDS = 180, 120, 7200
CHAIN_STATUSES = ('current', 'stale', 'unavailable')
CHAIN_REASONS = ('deployment_not_registered', 'never_indexed', 'head_not_observed_recently',
                 'indexer_behind_head')
LIMITATIONS = ('usd_from_qualified_sources_only', 'token_metadata_untrusted', 'positions_known_to_domino_only',
               'state_as_of_last_read', 'no_execution_or_signing')
# The live chain reads' own: USD only where qualified, untrusted metadata, state as of the block read, nothing
# executed.
LIVE_LIMITATIONS = ('usd_from_qualified_sources_only', 'token_metadata_untrusted', 'state_as_of_last_read',
                    'no_execution_or_signing')
# Qualified USD (0xdecimal's item 4; the owner's decision #22 of 2 Oct 2026 and answers of 5 Oct 2026,
# v2_chain_reads): the chain's stable at US$ 1, ETH and WETH at the profile's Chainlink ETH/USD within its heartbeat
# (and past the sequencer's grace where it has an uptime feed), any other token at its deepest pool against those
# holding at least PRICE_FLOOR_USD within PRICE_BAND_PERCENT of its price.
PRICE_SOURCES = ('chain_stable', 'chainlink_eth_usd', 'pool')
PRICE_REASONS = ('no_qualified_price_source', 'price_read_failed', 'pricing_limit_reached', 'decimals_unknown',
                 'eth_usd_stale', 'sequencer_down', 'no_pool', 'pool_depth_below_floor', 'pool_depth_unmeasurable',
                 'price_below_precision')
MARKET_REASONS = ('no_qualified_reference', 'price_read_failed', 'eth_usd_stale', 'sequencer_down',
                  'pool_depth_unmeasurable')
PRICE_FLOOR_USD, PRICE_BAND_PERCENT = '10000.000000', 10
# Each chain's stable, wrapped native token and Chainlink ETH/USD feed, from its profile (api-contracts/v2/chains;
# test_read_v6_contract holds them equal).
PRICE_PROFILES = {
    4663: {'stable': '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'wrapped': '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
           'feed': '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9', 'heartbeatSeconds': 86400},
    8453: {'stable': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'wrapped': '0x4200000000000000000000000000000000000006',
           'feed': '0x50015f8b17fb2c290dde41fdc246ed0dcee93a8b', 'heartbeatSeconds': 1200},
    42161: {'stable': '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'wrapped': '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
            'feed': '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612', 'heartbeatSeconds': 1755},
}
SEARCH_CHAIN_IDS = (8453, 42161)
MAX_CHAIN_POOLS, MAX_POOL_TOKENS, MAX_BALANCE_TOKENS, MAX_SEARCH_TOKENS = 32, 8, 24, 24
MAX_QUERY, DEFAULT_SEARCH_TOKENS, LIVE_FRESH_SECONDS = 96, 20, 60
# Where a known token comes from, in the order matches rank (v2_chain_reads.SOURCES).
TOKEN_SOURCES = ('profile', 'uniswap_default_list', 'v2_activity', 'looked_up')
DISARM_REASONS = {1: 'unsubscribed_or_transferred', 2: 'changed_outside_domino', 3: 'burned', 4: 'custody_lost',
                  5: 'v3_checkpoint_mismatch', 6: 'auto_exit', 7: 'exit_all'}
# What keeps an active mandate from executing now, beyond its trigger (F4
# "Execution", app spec §4.5). None of these is the price: an empty list means
# the mandate waits for its trigger.
BLOCKERS = ('expired', 'vault_not_domino', 'module_disabled', 'automation_halted', 'custody_lost',
            'custody_unread', 'not_in_vault')
# Why a vault or a mandate waits (owner, 2 Oct 2026; app spec §4.9, §9 item
# 24): each chain's automation writes its latest decision per subject to a file
# the chain's indexer reads into the index (v2_waiting). It is `reporting` while
# that file's pass is at most WAITING_STALE_SECONDS older than the answer, then `stale`.
WAITING_STATUSES = ('reporting', 'stale', 'unavailable', 'not_configured')
WAITING_STALE_SECONDS = 600
# Every custom error contracts/src/v2 declares (tests/test_read_v6_contract.py
# holds the list to the sources). The automation records a presimulation that
# reverted as `reverted_` and the error's name in snake case; `error` gives the
# name back, for the app's copy (§4.9), only when it is one of these.
V2_ERRORS = (
    'ApprovalFailed', 'AutomationHalted', 'AutomationUnavailable', 'BelowMinimum', 'ChangeNotReady',
    'DeliveryMismatch', 'DirectCall', 'ExitModuleNotEnabled', 'FeeMismatch', 'FeeNotBacked', 'FeeRecipientUnavailable',
    'FeeTransferMismatch', 'ForeignSubscriber', 'HookedPool', 'InsufficientLiquidity', 'InsufficientReserves',
    'InvalidAmount', 'InvalidAnchor', 'InvalidChange', 'InvalidConfig', 'InvalidConfiguration', 'InvalidExecution',
    'InvalidFeeConfig', 'InvalidFeeMode', 'InvalidFloor', 'InvalidInit', 'InvalidInstruction', 'InvalidLimits',
    'InvalidMandate', 'InvalidObservation', 'InvalidPlan', 'InvalidPolicy', 'InvalidPool', 'InvalidPosition',
    'InvalidPrice', 'InvalidPriceOrLiquidity', 'InvalidRange', 'InvalidRecipient', 'InvalidRoute',
    'InvalidRouteConfig', 'InvalidSignature', 'InvalidSqrtPrice', 'InvalidTick', 'InvalidZapConfig', 'ManagerMismatch',
    'MandateAlreadyRegistered', 'MandateNotActive', 'NonceAlreadyUsed', 'NonceUsed', 'NotEnoughLiquidity',
    'NothingToClaim', 'ObservationExpired', 'ObservationRevoked', 'OpenDelta', 'PartialBurn', 'PlanExpired',
    'PoolNotInitialized', 'PoolUnavailable', 'PositionPoolMismatch', 'PriceOverflow', 'ReentrantCall', 'RootOpen',
    'SafeCastOverflow', 'SettlementMismatch', 'SpotOutsideBand', 'StaleNonce', 'StepUnavailable', 'SuccessorActive',
    'SwapEffectMismatch', 'TokenCallFailed', 'TooSoon', 'TransferFailed', 'TriggerNotReached', 'TwapUnavailable',
    'TwapWindowTooLong', 'TwapWindowTooShort', 'Unauthorized', 'UnexpectedCallback', 'UnexpectedNonce',
    'VaultOwnerChanged', 'WrappedError')
ZERO = '0x' + '0' * 40
U256 = 2**256 - 1
I255 = 2**255

Address = Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$', min_length=42, max_length=42)]
Hash = Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$', min_length=66, max_length=66)]
UInt = Annotated[StrictInt, Field(ge=0, le=2**53 - 1)]
ChainId = Literal[CHAIN_IDS]
Dex = Literal[3, 4]
Bps = Annotated[StrictInt, Field(ge=0, le=10_000)]
Code = Annotated[str, Field(pattern=r'^[a-z0-9_]{1,80}$')]
ReasonCode = Annotated[str, Field(pattern=r'^[a-z0-9_]{1,100}$')]
ErrorName = Literal[V2_ERRORS]
_ERROR_BY_REASON = {'reverted_' + re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower(): name for name in V2_ERRORS}


def error_of(reason):
    """The V2 contract error a `reverted_<snake case>` reason names, or None."""
    return _ERROR_BY_REASON.get(reason)


def _raw(value):
    if int(value) > U256:
        raise ValueError('raw_out_of_range')
    return value


def _signed(value):
    if not -I255 <= int(value) < I255:
        raise ValueError('signed_raw_out_of_range')
    return value


Raw = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,77})$', max_length=78,
                           json_schema_extra={'x-maximum-raw': str(U256)}), AfterValidator(_raw)]
SignedRaw = Annotated[str, Field(pattern=r'^(0|-?[1-9][0-9]{0,76})$', max_length=78), AfterValidator(_signed)]
RawPair = Annotated[list[Raw], Field(min_length=2, max_length=2)]
Symbol = Annotated[str, Field(min_length=1, max_length=40)]
Tick = Annotated[StrictInt, Field(ge=-887272, le=887272)]


class BlockRef(WireModel):
    """A block, shaped as read-v1's snapshot: what a read or an event is true at."""
    number: UInt
    hash: Hash
    timestamp: UInt


class Freshness(WireModel):
    ageSeconds: UInt
    status: Literal['fresh', 'stale']


class TxRef(WireModel):
    hash: Hash
    snapshot: BlockRef


class PoolRef(WireModel):
    dex: Dex
    currency0: Address
    currency1: Address
    fee: Annotated[StrictInt, Field(ge=0, le=0x800000)]
    tickSpacing: Annotated[StrictInt, Field(ge=1, le=32767)]
    hooks: Address

    @model_validator(mode='after')
    def ordered(self):
        if self.currency0 >= self.currency1 or (self.dex == 3 and self.hooks != ZERO):
            raise ValueError('pool_ref')
        return self


UsdPrice = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,23})\.[0-9]{18}$', max_length=43)]
Usd = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,23})\.[0-9]{6}$', max_length=31)]


def fixed(text):
    """A wire decimal as an integer of its smallest unit."""
    return int(text.replace('.', ''))


class EthUsd(WireModel):
    """The Chainlink ETH/USD round behind a price: the profile's feed (its proxy), the answer and its time."""
    feed: Address
    usd: UsdPrice
    roundId: Raw
    updatedAt: UInt


class TokenPrice(WireModel):
    """A qualified USD price: the chain's stable, the feed's ETH, or a pool's spot against one of them at the block read,
    with the pool and its depth within the band."""
    usd: UsdPrice
    source: Literal[PRICE_SOURCES]
    snapshot: BlockRef | None
    ethUsd: EthUsd | None
    pool: PoolRef | None
    depthUsd: Usd | None

    @model_validator(mode='after')
    def consistent(self):
        stable, from_pool = self.source == 'chain_stable', self.source == 'pool'
        if (stable == (self.snapshot is not None) or from_pool != (self.pool is not None)
                or from_pool != (self.depthUsd is not None) or fixed(self.usd) == 0):
            raise ValueError('price_shape')
        if stable and (fixed(self.usd) != 10 ** 18 or self.ethUsd is not None):
            raise ValueError('price_stable')
        if self.source == 'chainlink_eth_usd' and (self.ethUsd is None or self.ethUsd.usd != self.usd):
            raise ValueError('price_eth_usd')
        if self.ethUsd is not None and self.ethUsd.updatedAt > self.snapshot.timestamp:
            raise ValueError('price_eth_usd')
        if from_pool and (self.pool.hooks != ZERO or fixed(self.depthUsd) < fixed(PRICE_FLOOR_USD)):
            raise ValueError('price_pool')
        return self


def priced(chain_id, token, price, reason):
    """A token's price or the reason it has none, as its chain's profile allows: the stable from itself, ETH and WETH
    from the feed within its heartbeat, any other token from a pool against one of those."""
    if (price is None) == (reason is None):
        raise ValueError('price_reason')
    if price is None:
        return
    profile = PRICE_PROFILES[chain_id]
    eth = (ZERO, profile['wrapped'])
    if (price.source == 'chain_stable') != (token == profile['stable']) or (price.source == 'chainlink_eth_usd') != (
            token in eth):
        raise ValueError('price_source')
    if price.pool is not None:
        pair = (price.pool.currency0, price.pool.currency1)
        partner = pair[1] if pair[0] == token else pair[0] if pair[1] == token else None
        if partner not in (profile['stable'], *eth) or (price.ethUsd is not None) != (partner in eth):
            raise ValueError('price_pool')
    if price.ethUsd is not None and (price.ethUsd.feed != profile['feed'] or
                                     price.snapshot.timestamp - price.ethUsd.updatedAt > profile['heartbeatSeconds']):
        raise ValueError('price_eth_usd')


class IndexedToken(WireModel):
    chainId: ChainId
    address: Address
    status: Literal['available', 'partial', 'unavailable', 'not_read']
    decimals: Annotated[StrictInt, Field(ge=0, le=255)] | None
    symbol: Symbol | None
    price: TokenPrice | None
    priceReason: Literal[PRICE_REASONS] | None

    @model_validator(mode='after')
    def consistent(self):
        if self.symbol is not None and not self.symbol.isprintable():
            raise ValueError('unsafe_symbol')
        priced(self.chainId, self.address, self.price, self.priceReason)
        if self.status == 'available' and (self.decimals is None or self.symbol is None):
            raise ValueError('token_status')
        if self.status in ('unavailable', 'not_read') and (self.decimals is not None or self.symbol is not None):
            raise ValueError('token_status')
        return self


# ------------------------------------------------------------------ chains
class Deployment(WireModel):
    manifestSha256: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]
    startBlock: UInt


class Head(WireModel):
    number: UInt
    timestamp: UInt
    observedAt: UInt


class IndexFailure(WireModel):
    code: Code
    at: UInt


class WaitingReport(WireModel):
    """The chain's automation's last pass, as its waiting file says: the head
    it decided at. `not_configured`: the chain's indexer reads no automation
    file; `unavailable`: its last read found the file missing or malformed."""
    status: Literal[WAITING_STATUSES]
    block: UInt | None
    timestamp: UInt | None
    ageSeconds: UInt | None

    @model_validator(mode='after')
    def consistent(self):
        read = self.status in ('reporting', 'stale')
        if any((value is not None) != read for value in (self.block, self.timestamp, self.ageSeconds)):
            raise ValueError('waiting_report')
        if read and (self.status == 'stale') != (self.ageSeconds > WAITING_STALE_SECONDS):
            raise ValueError('waiting_report_age')
        return self


class ChainStatus(WireModel):
    chainId: ChainId
    status: Literal[CHAIN_STATUSES]
    reason: Literal[CHAIN_REASONS] | None
    deployment: Deployment | None
    indexedThrough: BlockRef | None
    # The chain's finalized block as the indexer last observed it; items at or
    # below it are final.
    finalizedThrough: BlockRef | None
    head: Head | None
    lagBlocks: UInt | None
    lagSeconds: UInt | None
    lastError: IndexFailure | None
    automationHalted: StrictBool | None
    operatorsAdmitted: UInt | None
    waitingReasons: WaitingReport

    @model_validator(mode='after')
    def consistent(self):
        indexed = self.indexedThrough is not None
        if (self.status == 'current') != (self.reason is None):
            raise ValueError('chain_reason')
        if (self.deployment is None) != (self.reason == 'deployment_not_registered'):
            raise ValueError('chain_deployment')
        if indexed == (self.reason in ('deployment_not_registered', 'never_indexed')):
            raise ValueError('chain_indexed')
        if (self.lagBlocks is None) != (not indexed or self.head is None):
            raise ValueError('chain_lag')
        if (self.lagSeconds is None) != (self.lagBlocks is None):
            raise ValueError('chain_lag')
        if (self.automationHalted is None) == indexed or (self.operatorsAdmitted is None) == indexed:
            raise ValueError('chain_registry')
        if self.finalizedThrough is not None and self.deployment is None:
            raise ValueError('chain_finality')
        return self


# ------------------------------------------------------------------ vaults
class Policy(WireModel):
    mode: Literal['simple', 'domino']
    triggerDistanceBps: Bps
    maxOverlapBps: Bps
    minimumIntervalSeconds: Annotated[StrictInt, Field(ge=0, le=2**32 - 1)]
    maxPositions: Annotated[StrictInt, Field(ge=0, le=255)]


class Limits(WireModel):
    maxSlippageBps: Bps
    maxPriceImpactBps: Bps
    maxObservationAgeSeconds: Annotated[StrictInt, Field(ge=0, le=2**32 - 1)]
    upsideBps: Annotated[StrictInt, Field(ge=0, le=2**32 - 1)]


class Lot(WireModel):
    token: Address
    uncharged: Raw
    charged: Raw


class MemberState(WireModel):
    """IDominoVaultLedger.member and its two lots, as read."""
    tokenId: Raw
    active: StrictBool
    parentTokenId: Raw | None
    successorTokenId: Raw | None
    tickLower: Tick
    tickUpper: Tick
    lots: Annotated[list[Lot], Field(min_length=2, max_length=2)]


class Reserve(WireModel):
    token: Address
    total: Raw
    idle: Raw

    @model_validator(mode='after')
    def idle_part(self):
        if int(self.idle) > int(self.total):
            raise ValueError('reserve_idle')
        return self


class VaultRead(WireModel):
    status: Literal['read']
    snapshot: BlockRef
    freshness: Freshness
    pool: PoolRef
    quoteCurrency: Address
    policy: Policy
    limits: Limits
    paused: StrictBool
    rootArmed: StrictBool
    stateNonce: Raw
    exitModule: Address | None
    lastExecutionAt: Raw
    members: Annotated[list[MemberState], Field(min_length=1, max_length=MAX_MEMBERS)]
    reserves: Annotated[list[Reserve], Field(min_length=2, max_length=2)]

    @model_validator(mode='after')
    def consistent(self):
        tokens = [self.pool.currency0, self.pool.currency1]
        if [r.token for r in self.reserves] != tokens or any([lot.token for lot in m.lots] != tokens
                                                             for m in self.members):
            raise ValueError('vault_tokens')
        return self


class StateUnavailable(WireModel):
    status: Literal['unavailable']
    snapshot: BlockRef
    freshness: Freshness
    reason: Code


class StateNotRead(WireModel):
    status: Literal['not_read']


VaultState = Annotated[Union[VaultRead, StateUnavailable, StateNotRead], Field(discriminator='status')]
DisarmReason = Literal[tuple(DISARM_REASONS.values())]


class Member(WireModel):
    """A member's life from the vault's events."""
    tokenId: Raw
    role: Literal['root', 'successor']
    parentTokenId: Raw | None
    status: Literal['armed', 'disarmed', 'active', 'withdrawn', 'exited']
    disarmReason: DisarmReason | None

    @model_validator(mode='after')
    def consistent(self):
        root = self.role == 'root'
        if root != (self.parentTokenId is None):
            raise ValueError('member_parent')
        if root and self.status not in ('armed', 'disarmed', 'exited'):
            raise ValueError('member_status')
        if not root and self.status not in ('active', 'withdrawn', 'exited'):
            raise ValueError('member_status')
        if (self.status == 'disarmed') != (self.disarmReason is not None):
            raise ValueError('member_disarm')
        return self


class Custody(WireModel):
    """The root's custody. `armed` is the vault's live rootArmed() as last read.
    A reason comes from the last RootDisarmed after the last RootRearmed
    (`event`), or, with no such event, from the live read alone (`live_read`:
    the owner approved another app on v4, or moved it, without a notification)."""
    armed: StrictBool | None
    reason: DisarmReason | None
    source: Literal['event', 'live_read'] | None
    since: TxRef | None

    @model_validator(mode='after')
    def consistent(self):
        if (self.reason is None) != (self.source is None) or (self.since is not None) != (self.source == 'event'):
            raise ValueError('custody_source')
        if self.armed and self.source == 'live_read':
            raise ValueError('custody_live')
        return self


class WaitingRevert(WireModel):
    """The last presimulation that reverted, kept until one passes."""
    reason: ReasonCode
    error: ErrorName | None
    at: UInt
    block: UInt

    @model_validator(mode='after')
    def named(self):
        if self.error != error_of(self.reason):
            raise ValueError('waiting_error')
        return self


class Waiting(WireModel):
    """Why the automation's last pass did not act on this vault or mandate, or
    that it would (`eligible`, `triggered`): its fixed code (`too_soon`,
    `gas_not_covered`, `owner_benefit_insufficient`, `earnings_evidence_missing`,
    `vault_paused`, `root_disarmed`, `trigger_not_reached`,
    `v2_observation_unstable`, `reverted_<error>`, ...; any other code is shown
    as such), at the head of that pass (`checkedAt`, `checkedBlock`). `since`
    and `sinceBlock` are the time and block of the first pass that gave this
    reason, as the automation records them: kept while the reason holds, reset
    when it changes."""
    reason: ReasonCode
    error: ErrorName | None
    since: UInt
    sinceBlock: UInt
    checkedAt: UInt
    checkedBlock: UInt
    lastRevert: WaitingRevert | None

    @model_validator(mode='after')
    def consistent(self):
        if self.error != error_of(self.reason):
            raise ValueError('waiting_error')
        if self.since > self.checkedAt or self.sinceBlock > self.checkedBlock:
            raise ValueError('waiting_since')
        return self


class LastExecution(WireModel):
    tx: TxRef
    planHash: Hash
    action: Literal['compound', 'mint']


class VaultTotals(WireModel):
    executions: UInt
    compounds: UInt
    feesCompounded: RawPair
    serviceFees: RawPair


class Vault(WireModel):
    chainId: ChainId
    address: Address
    factory: Address
    dex: Dex
    owner: Address
    rootTokenId: Raw
    ownerNonce: Raw
    created: TxRef
    state: VaultState
    custody: Custody
    pausedBy: Literal['owner', 'operator', 'unknown'] | None
    members: Annotated[list[Member], Field(min_length=1, max_length=MAX_MEMBERS)]
    autoExitEnabled: StrictBool
    lastExecution: LastExecution | None
    totals: VaultTotals
    waiting: Waiting | None

    @model_validator(mode='after')
    def consistent(self):
        read = self.state.status == 'read'
        if read and self.custody.armed != self.state.rootArmed or not read and self.custody.armed is not None:
            raise ValueError('vault_custody')
        if (self.pausedBy is not None) != (read and self.state.paused):
            raise ValueError('vault_paused')
        return self


# --------------------------------------------------------------- positions
class PositionCustody(WireModel):
    approved: Address | None
    subscriber: Address | None


class PositionLive(WireModel):
    status: Literal['live']
    snapshot: BlockRef
    freshness: Freshness
    owner: Address
    custody: PositionCustody
    pool: PoolRef
    tickLower: Tick
    tickUpper: Tick
    liquidity: Raw
    sqrtPriceX96: Raw
    tick: Tick
    inRange: StrictBool
    feesOwed: RawPair
    principalAtSpot: RawPair

    @model_validator(mode='after')
    def consistent(self):
        if self.tickLower >= self.tickUpper or self.inRange != (self.tickLower <= self.tick < self.tickUpper):
            raise ValueError('position_range')
        if self.pool.dex == 3 and self.custody.subscriber is not None:
            raise ValueError('v3_subscriber')
        return self


PositionState = Annotated[Union[PositionLive, StateUnavailable, StateNotRead], Field(discriminator='status')]


class VaultLink(WireModel):
    address: Address
    role: Literal['root', 'successor']


class Position(WireModel):
    chainId: ChainId
    dex: Dex
    positionManager: Address
    tokenId: Raw
    vault: VaultLink | None
    firstSeenBlock: UInt
    state: PositionState

    @model_validator(mode='after')
    def consistent(self):
        if self.state.status == 'live' and self.state.pool.dex != self.dex:
            raise ValueError('position_dex')
        return self


# ---------------------------------------------------------------- mandates
class MandateTerms(WireModel):
    triggerBelowSqrtPriceX96: Raw | None
    triggerAboveSqrtPriceX96: Raw | None
    receive: Literal['both', 'converted']
    convertTo: Address | None
    maxSlippageBps: Bps

    @model_validator(mode='after')
    def consistent(self):
        if self.triggerBelowSqrtPriceX96 is None and self.triggerAboveSqrtPriceX96 is None:
            raise ValueError('mandate_trigger')
        if (self.receive == 'converted') != (self.convertTo is not None):
            raise ValueError('mandate_receive')
        return self


class MandateExecution(WireModel):
    tx: TxRef
    anchorSqrtPriceX96: Raw
    delivered: RawPair


class Mandate(WireModel):
    chainId: ChainId
    mandateHash: Hash
    module: Address
    owner: Address
    vault: Address
    vaultIsDomino: StrictBool
    tokenId: Raw
    position: Literal['root', 'successor', 'unknown']
    validUntil: UInt
    registered: TxRef
    status: Literal['active', 'revoked', 'executed']
    expired: StrictBool
    moduleEnabled: StrictBool | None
    blockedBy: Annotated[list[Literal[BLOCKERS]], Field(max_length=len(BLOCKERS))]
    terms: MandateTerms | None
    revoked: TxRef | None
    executed: MandateExecution | None
    # Only while active: an ended mandate's status says why it does not run.
    waiting: Waiting | None

    @model_validator(mode='after')
    def consistent(self):
        if (self.status == 'revoked') != (self.revoked is not None) or \
                (self.status == 'executed') != (self.executed is not None):
            raise ValueError('mandate_status')
        if self.waiting is not None and self.status != 'active':
            raise ValueError('mandate_waiting')
        if self.expired and self.status != 'active' or self.status != 'active' and self.blockedBy:
            raise ValueError('mandate_status')
        if self.vaultIsDomino != (self.moduleEnabled is not None):
            raise ValueError('mandate_module')
        order = [b for b in BLOCKERS if b in self.blockedBy]
        if order != list(self.blockedBy) or self.expired != ('expired' in self.blockedBy):
            raise ValueError('mandate_blockers')
        if ('module_disabled' in self.blockedBy) != (self.moduleEnabled is False and self.status == 'active'):
            raise ValueError('mandate_blockers')
        if ('vault_not_domino' in self.blockedBy) != (not self.vaultIsDomino and self.status == 'active'):
            raise ValueError('mandate_blockers')
        if not self.vaultIsDomino and self.position != 'unknown':
            raise ValueError('mandate_position')
        return self


class Credit(WireModel):
    chainId: ChainId
    module: Address
    token: Address
    unclaimed: Raw


class Truncated(WireModel):
    vaults: StrictBool
    positions: StrictBool
    mandates: StrictBool


class Envelope(WireModel):
    schemaVersion: Literal[1]
    contractVersion: Literal[CONTRACT_VERSION]
    wallet: Address
    servedAt: UInt
    coverage: Literal['complete', 'partial']
    chains: Annotated[list[ChainStatus], Field(min_length=len(CHAIN_IDS), max_length=len(CHAIN_IDS))]
    tokens: Annotated[list[IndexedToken], Field(max_length=MAX_TOKENS)]
    limitations: Annotated[list[Literal[LIMITATIONS]], Field(min_length=len(LIMITATIONS), max_length=len(LIMITATIONS))]
    suggested: Literal[False]
    executionAvailable: Literal[False]

    @model_validator(mode='after')
    def envelope(self):
        if [chain.chainId for chain in self.chains] != list(CHAIN_IDS):
            raise ValueError('chains_order')
        if (self.coverage == 'complete') != all(chain.status == 'current' for chain in self.chains):
            raise ValueError('coverage')
        if list(self.limitations) != list(LIMITATIONS):
            raise ValueError('limitations')
        keys = [(token.chainId, token.address) for token in self.tokens]
        if keys != sorted(set(keys)):
            raise ValueError('tokens_order')
        return self


class PortfolioResponse(Envelope):
    mode: Literal['stored_v2_portfolio']
    vaults: Annotated[list[Vault], Field(max_length=MAX_VAULTS)]
    positions: Annotated[list[Position], Field(max_length=MAX_POSITIONS)]
    mandates: Annotated[list[Mandate], Field(max_length=MAX_MANDATES)]
    credits: Annotated[list[Credit], Field(max_length=MAX_CREDITS)]
    truncated: Truncated

    @model_validator(mode='after')
    def owned(self):
        if any(vault.owner != self.wallet for vault in self.vaults):
            raise ValueError('vault_owner')
        if any(mandate.owner != self.wallet for mandate in self.mandates):
            raise ValueError('mandate_owner')
        reporting = {chain.chainId: chain.waitingReasons.status in ('reporting', 'stale') for chain in self.chains}
        if any(entry.waiting is not None and not reporting[entry.chainId] for entry in (*self.vaults, *self.mandates)):
            raise ValueError('waiting_without_report')
        halted = {chain.chainId: chain.automationHalted for chain in self.chains}
        for mandate in self.mandates:
            if mandate.expired != (mandate.status == 'active' and mandate.validUntil < self.servedAt):
                raise ValueError('mandate_expiry')
            if ('automation_halted' in mandate.blockedBy) != (mandate.status == 'active' and mandate.vaultIsDomino
                                                              and halted[mandate.chainId] is True):
                raise ValueError('mandate_halt')
        return self


# ---------------------------------------------------------------- activity
class Gas(WireModel):
    """The receipt's own fields, as the chain reports them: gas used times the
    effective price is the execution fee; on OP Stack the receipt's L1 data
    fee is separate. No total is claimed: a stack may charge what the receipt
    does not state (an operator fee)."""
    sender: Address
    status: Literal['success']
    gasUsed: Raw
    effectiveGasPriceWei: Raw
    l1FeeWei: Raw | None


class Tx(TxRef):
    gas: Gas | None
    finality: Literal['finalized', 'unfinalized']


class Leg(WireModel):
    kind: Literal['universal_router', 'v3_pool', 'v4_pool']
    tokenIn: Address
    tokenOut: Address
    venue: Address
    amountIn: Raw
    amountOut: Raw


class Tariff(WireModel):
    kind: Literal['assisted_swap', 'automation', 'auto_exit']
    rateBps: Literal[20, 65, 200, 400] | None
    token: Address
    amount: Raw
    deferred: Raw

    @model_validator(mode='after')
    def deferred_part(self):
        if int(self.deferred) > int(self.amount):
            raise ValueError('tariff_deferred')
        expected = {'assisted_swap': (65,), 'auto_exit': (20,), 'automation': (200, 400, None)}[self.kind]
        if self.rateBps not in expected:
            raise ValueError('tariff_rate')
        return self


class Amount(WireModel):
    token: Address
    amount: Raw


class Refund(Amount):
    recipient: Address


class Step(WireModel):
    tokenId: Raw
    pool: PoolRef
    liquidityDelta: SignedRaw
    amount0: SignedRaw
    amount1: SignedRaw


class ItemBase(WireModel):
    id: Annotated[str, Field(pattern=r'^[1-9][0-9]{0,18}:[0-9]{1,19}:[0-9]{1,10}$', max_length=52)]
    chainId: ChainId
    tx: Tx


class S1Action(ItemBase):
    kind: Literal['s1_action']
    zap: Address
    intentHash: Hash
    action: Literal['create', 'increase', 'change_range', 'exit']
    owner: Address
    recipient: Address
    tokenId: Raw
    previousTokenId: Raw | None
    liquidity: Raw
    inputs: Annotated[list[Amount], Field(max_length=MAX_LINES)]
    legs: Annotated[list[Leg], Field(max_length=MAX_LEGS)]
    steps: Annotated[list[Step], Field(min_length=1, max_length=MAX_STEPS)]
    refunds: Annotated[list[Refund], Field(max_length=MAX_LINES)]
    tariffs: Annotated[list[Tariff], Field(max_length=1)]

    @model_validator(mode='after')
    def consistent(self):
        # No swap, no fee (F1b); a fee that rounds to zero is never charged.
        if (self.tariffs and not self.legs) or any(t.kind != 'assisted_swap' for t in self.tariffs):
            raise ValueError('s1_tariff')
        if (self.action == 'create') != (self.previousTokenId is None):
            raise ValueError('s1_previous')
        return self


class Compounded(WireModel):
    tokenId: Raw
    liquidityAdded: Raw
    fees0: Raw
    fees1: Raw
    serviceFee0: Raw
    serviceFee1: Raw


class FeesCollected(WireModel):
    tokenId: Raw
    amount0: Raw
    amount1: Raw


class Swap(WireModel):
    source: Raw
    zeroForOne: StrictBool
    amountIn: Raw
    amountOut: Raw


class Successor(WireModel):
    parentTokenId: Raw
    tokenId: Raw


class VaultExecution(ItemBase):
    kind: Literal['vault_execution']
    vault: Address
    planHash: Hash
    action: Literal['compound', 'mint']
    stateNonce: Raw
    feesCollected: Annotated[list[FeesCollected], Field(max_length=MAX_LINES)]
    swaps: Annotated[list[Swap], Field(max_length=MAX_LINES)]
    legs: Annotated[list[Leg], Field(max_length=MAX_LEGS)]
    compounded: Compounded
    successor: Successor | None
    tariffs: Annotated[list[Tariff], Field(max_length=2)]

    @model_validator(mode='after')
    def consistent(self):
        if (self.action == 'mint') != (self.successor is not None) or any(t.kind != 'automation' for t in self.tariffs):
            raise ValueError('vault_execution')
        return self


class AutoExit(ItemBase):
    kind: Literal['auto_exit']
    module: Address
    mandateHash: Hash
    vault: Address
    tokenId: Raw
    member: Literal['root', 'successor']
    anchorSqrtPriceX96: Raw
    recipient: Address
    withdrawn: RawPair
    delivered: RawPair
    deferred: Annotated[list[Amount], Field(max_length=2)]
    reservesReturned: Annotated[list[Amount], Field(max_length=2)]
    legs: Annotated[list[Leg], Field(max_length=MAX_LEGS)]
    tariffs: Annotated[list[Tariff], Field(max_length=2)]

    @model_validator(mode='after')
    def consistent(self):
        if any(t.kind != 'auto_exit' for t in self.tariffs):
            raise ValueError('auto_exit_tariff')
        return self


class VaultCreated(ItemBase):
    kind: Literal['vault_created']
    vault: Address
    factory: Address
    dex: Dex
    owner: Address
    rootTokenId: Raw
    ownerNonce: Raw
    policy: Policy
    limits: Limits


class VaultEventBase(WireModel):
    """A vault event outside an execution, an exit or the creation."""
    stateNonce: Raw | None


class PolicyChanged(VaultEventBase):
    event: Literal['PolicyChanged']
    policy: Policy


class LimitsChanged(VaultEventBase):
    event: Literal['LimitsChanged']
    limits: Limits


class AutomationPaused(VaultEventBase):
    event: Literal['AutomationPaused']
    actor: Address


class AutomationResumed(VaultEventBase):
    event: Literal['AutomationResumed']


class RootDisarmed(VaultEventBase):
    event: Literal['RootDisarmed']
    reason: DisarmReason


class RootRearmed(VaultEventBase):
    event: Literal['RootRearmed']


class RootCheckpointed(VaultEventBase):
    event: Literal['RootCheckpointed']
    liquidity: Raw


class ReservesWithdrawn(VaultEventBase):
    event: Literal['ReservesWithdrawn']
    token: Address
    amount: Raw


class ChildWithdrawn(VaultEventBase):
    event: Literal['ChildWithdrawn']
    tokenId: Raw


class TokenRecovered(VaultEventBase):
    event: Literal['TokenRecovered']
    token: Address
    amount: Raw


class PositionRecovered(VaultEventBase):
    event: Literal['PositionRecovered']
    tokenId: Raw


class ExitModuleSet(VaultEventBase):
    event: Literal['ExitModuleSet']
    module: Address | None


VaultEventEntry = Annotated[Union[PolicyChanged, LimitsChanged, AutomationPaused, AutomationResumed, RootDisarmed,
                                  RootRearmed, RootCheckpointed, ReservesWithdrawn, ChildWithdrawn, TokenRecovered,
                                  PositionRecovered, ExitModuleSet], Field(discriminator='event')]


class VaultEvent(ItemBase):
    kind: Literal['vault_event']
    vault: Address
    events: Annotated[list[VaultEventEntry], Field(min_length=1, max_length=MAX_EVENTS)]


class ReservesReturned(ItemBase):
    """A closed vault's reserves paid to its owner by a returnReserves() someone else sent: the automation's operator
    sends one once the root is closed and no successor is active, and the call is open to anyone. The owner's own
    withdrawals (withdrawReserves, exitAll) stay vault_event."""
    kind: Literal['reserves_returned']
    vault: Address
    returnedBy: Address
    byOperator: StrictBool
    stateNonce: Raw
    reservesReturned: Annotated[list[Amount], Field(min_length=1, max_length=2)]

    @model_validator(mode='after')
    def consistent(self):
        # Who returned them is the transaction's sender: an item without it is never one.
        if self.tx.gas is None or self.tx.gas.sender != self.returnedBy:
            raise ValueError('returned_by')
        tokens = [line.token for line in self.reservesReturned]
        if len(set(tokens)) != len(tokens):
            raise ValueError('returned_tokens')
        return self


class AutoExitEvent(ItemBase):
    kind: Literal['auto_exit_event']
    module: Address
    event: Literal['MandateRegistered', 'MandateRevoked', 'NonceCancelled', 'Claimed']
    mandateHash: Hash | None
    vault: Address | None
    tokenId: Raw | None
    validUntil: UInt | None
    nonce: Raw | None
    token: Address | None
    recipient: Address | None
    amount: Raw | None

    @model_validator(mode='after')
    def shape(self):
        present = {name for name in ('mandateHash', 'vault', 'tokenId', 'validUntil', 'nonce', 'token', 'recipient',
                                     'amount') if getattr(self, name) is not None}
        expected = {'MandateRegistered': {'mandateHash', 'vault', 'tokenId', 'validUntil'},
                    'MandateRevoked': {'mandateHash', 'vault'}, 'NonceCancelled': {'nonce'},
                    'Claimed': {'token', 'recipient', 'amount'}}[self.event]
        if present != expected:
            raise ValueError('auto_exit_event_shape')
        return self


class ZapEvent(ItemBase):
    kind: Literal['zap_event']
    zap: Address
    event: Literal['NoncesInvalidated']
    owner: Address
    word: Raw
    mask: Raw


ActivityItem = Annotated[Union[S1Action, VaultExecution, AutoExit, VaultCreated, VaultEvent, ReservesReturned,
                               AutoExitEvent, ZapEvent], Field(discriminator='kind')]
Cursor = Annotated[str, Field(pattern=r'^[0-9]{1,19}\.[1-9][0-9]{0,18}\.[0-9]{1,19}\.[0-9]{1,10}$', max_length=64)]


class ActivityResponse(Envelope):
    mode: Literal['stored_v2_activity']
    items: Annotated[list[ActivityItem], Field(max_length=MAX_ITEMS)]
    nextCursor: Cursor | None

    @model_validator(mode='after')
    def ordered(self):
        ids = [item.id for item in self.items]
        if len(set(ids)) != len(ids):
            raise ValueError('items_unique')
        keys = [(item.tx.snapshot.timestamp, item.chainId, item.tx.snapshot.number, int(item.id.rsplit(':', 1)[1]))
                for item in self.items]
        if keys != sorted(keys, reverse=True):
            raise ValueError('items_order')
        finalized = {chain.chainId: chain.finalizedThrough for chain in self.chains}
        for item in self.items:
            chain, block, _ = item.id.split(':')
            if int(chain) != item.chainId or int(block) != item.tx.snapshot.number:
                raise ValueError('item_id')
            final = finalized[item.chainId]
            if (item.tx.finality == 'finalized') != (final is not None and item.tx.snapshot.number <= final.number):
                raise ValueError('item_finality')
            if item.kind == 'reserves_returned' and item.returnedBy == self.wallet:
                raise ValueError('returned_by_owner')  # the owner's own are vault_event
        return self


# ------------------------------------------------------------ chain reads
Pips = Annotated[StrictInt, Field(ge=0, le=1_000_000)]


def _live_limitations(limitations):
    if list(limitations) != list(LIVE_LIMITATIONS):
        raise ValueError('limitations')


def _fresh(served_at, snapshot, freshness):
    age = max(0, served_at - snapshot.timestamp)
    if freshness.ageSeconds != age or (freshness.status == 'fresh') != (age <= LIVE_FRESH_SECONDS):
        raise ValueError('freshness')


class LiveToken(WireModel):
    """A token's metadata as read at the block: untrusted text, decimals null when unread, never guessed; its USD
    price, or why it has none."""
    address: Address
    symbol: Symbol | None
    decimals: Annotated[StrictInt, Field(ge=0, le=255)] | None
    status: Literal['available', 'partial', 'unavailable']
    price: TokenPrice | None
    priceReason: Literal[PRICE_REASONS] | None

    @model_validator(mode='after')
    def consistent(self):
        if self.symbol is not None and not self.symbol.isprintable():
            raise ValueError('unsafe_symbol')
        read = (self.decimals is not None) + (self.symbol is not None)
        if read != {'available': 2, 'partial': 1, 'unavailable': 0}[self.status]:
            raise ValueError('token_status')
        return self


class SwapFees(WireModel):
    """What a swap pays in each direction, in pips of its input: v4's protocol fee taken before the LP fee."""
    zeroForOne: Pips
    oneForZero: Pips


class PoolMarket(WireModel):
    """The pool's depth in USD within the band: what it releases of `reference`, the token's partner, as the token is
    sold into it until its price falls by PRICE_BAND_PERCENT. No TVL, volume or APR."""
    status: Literal['measured', 'unavailable']
    reference: Address | None
    depthUsd: Usd | None
    reason: Literal[MARKET_REASONS] | None

    @model_validator(mode='after')
    def consistent(self):
        measured = self.status == 'measured'
        if measured != (self.reference is not None) or measured != (self.depthUsd is not None) or measured == (
                self.reason is not None):
            raise ValueError('market_status')
        return self


class LivePool(WireModel):
    pool: PoolRef
    id: Hash | None
    address: Address | None
    sqrtPriceX96: Raw
    tick: Tick
    liquidity: Raw
    lpFeePips: Pips
    protocolFee: Annotated[StrictInt, Field(ge=0, le=0xFFFFFF)]
    swapFeePips: SwapFees
    market: PoolMarket

    @model_validator(mode='after')
    def consistent(self):
        v4 = self.pool.dex == 4
        if v4 != (self.id is not None) or v4 == (self.address is not None) or self.pool.hooks != ZERO:
            raise ValueError('pool_identity')
        if self.lpFeePips != self.pool.fee or int(self.liquidity) == 0 or int(self.sqrtPriceX96) == 0:
            raise ValueError('pool_state')
        if v4:
            sides = (self.protocolFee & 0xFFF, self.protocolFee >> 12)
            if any(side > 1000 for side in sides):
                raise ValueError('pool_protocol_fee')
            fees = tuple(self.lpFeePips if side == 0 else side + self.lpFeePips - side * self.lpFeePips // 1_000_000
                         for side in sides)
        else:
            if self.protocolFee > 0xFF:
                raise ValueError('pool_protocol_fee')
            fees = (self.lpFeePips, self.lpFeePips)
        if (self.swapFeePips.zeroForOne, self.swapFeePips.oneForZero) != fees:
            raise ValueError('pool_swap_fees')
        return self


class ChainPoolsResponse(WireModel):
    """chain-pools: the token's pools against the chain's base currencies (or the paired token), Uniswap's standard
    hookless keys and the enabled v3 tiers, read at one block; listed when priced and holding liquidity."""
    schemaVersion: Literal[1]
    contractVersion: Literal[CONTRACT_VERSION]
    mode: Literal['live_chain_pools']
    chainId: ChainId
    token: Address
    pairedToken: Address | None
    servedAt: UInt
    snapshot: BlockRef
    freshness: Freshness
    tokens: Annotated[list[LiveToken], Field(min_length=1, max_length=MAX_POOL_TOKENS)]
    pools: Annotated[list[LivePool], Field(max_length=MAX_CHAIN_POOLS)]
    truncated: StrictBool
    coverage: Literal['standard_hookless_pools']
    limitations: Annotated[list[Literal[LIVE_LIMITATIONS]], Field(min_length=len(LIVE_LIMITATIONS),
                                                                 max_length=len(LIVE_LIMITATIONS))]
    executionAvailable: Literal[False]

    @model_validator(mode='after')
    def consistent(self):
        _live_limitations(self.limitations)
        _fresh(self.servedAt, self.snapshot, self.freshness)
        addresses = [token.address for token in self.tokens]
        if (addresses != sorted(set(addresses)) or self.token not in addresses or self.pairedToken == self.token
                or (self.pairedToken is not None and self.pairedToken not in addresses)):
            raise ValueError('pool_tokens')
        keys = set()
        for item in self.pools:
            pair = (item.pool.currency0, item.pool.currency1)
            if self.token not in pair or (self.pairedToken is not None and self.pairedToken not in pair):
                raise ValueError('pool_pair')
            if not set(pair) <= set(addresses):
                raise ValueError('pool_tokens')
            key = (item.pool.dex, *pair, item.pool.fee, item.pool.tickSpacing)
            if key in keys:
                raise ValueError('pool_duplicate')
            keys.add(key)
            profile = PRICE_PROFILES[self.chainId]
            reference = item.market.reference
            if reference is not None and (reference not in pair or reference == self.token or reference not in (
                    profile['stable'], ZERO, profile['wrapped'])):
                raise ValueError('market_reference')
        for token in self.tokens:
            priced(self.chainId, token.address, token.price, token.priceReason)
        return self


class TokenBalance(WireModel):
    """A balance as read, its token's USD price or why it has none, and its value at that price, rounded down."""
    address: Address
    symbol: Symbol | None
    decimals: Annotated[StrictInt, Field(ge=0, le=255)] | None
    balanceRaw: Raw | None
    status: Literal['read', 'unavailable']
    price: TokenPrice | None
    priceReason: Literal[PRICE_REASONS] | None
    valueUsd: Usd | None

    @model_validator(mode='after')
    def consistent(self):
        if self.symbol is not None and not self.symbol.isprintable():
            raise ValueError('unsafe_symbol')
        if (self.status == 'read') != (self.balanceRaw is not None):
            raise ValueError('balance_status')
        valued = self.balanceRaw is not None and self.decimals is not None and self.price is not None
        if valued != (self.valueUsd is not None) or (valued and fixed(self.valueUsd) != int(
                self.balanceRaw) * fixed(self.price.usd) // 10 ** (self.decimals + 12)):
            raise ValueError('balance_value')
        return self


class ChainBalances(WireModel):
    """One chain's balances; `totalUsd` once every balance above zero has a value."""
    chainId: ChainId
    status: Literal['current', 'unavailable']
    reason: Literal['chain_not_configured', 'chain_read_failed'] | None
    snapshot: BlockRef | None
    totalUsd: Usd | None
    balances: Annotated[list[TokenBalance], Field(min_length=1, max_length=MAX_BALANCE_TOKENS)]

    @model_validator(mode='after')
    def consistent(self):
        current = self.status == 'current'
        if current != (self.snapshot is not None) or current == (self.reason is not None):
            raise ValueError('balances_status')
        if not current and any(balance.status != 'unavailable' for balance in self.balances):
            raise ValueError('balances_status')
        addresses = [balance.address for balance in self.balances]
        if len(addresses) != len(set(addresses)):
            raise ValueError('balances_duplicate')
        for balance in self.balances:
            priced(self.chainId, balance.address, balance.price, balance.priceReason)
        values = [balance.valueUsd for balance in self.balances if balance.balanceRaw != '0']
        if (self.totalUsd is not None) != (None not in values) or (
                self.totalUsd is not None and fixed(self.totalUsd) != sum(fixed(value) for value in values)):
            raise ValueError('balances_total')
        return self


class ChainBalancesResponse(WireModel):
    """chain-balances: a wallet's native and token balances on each chain asked, one block per chain."""
    schemaVersion: Literal[1]
    contractVersion: Literal[CONTRACT_VERSION]
    mode: Literal['live_chain_balances']
    wallet: Address
    servedAt: UInt
    coverage: Literal['complete', 'partial']
    chains: Annotated[list[ChainBalances], Field(min_length=1, max_length=len(CHAIN_IDS))]
    totalUsd: Usd | None
    limitations: Annotated[list[Literal[LIVE_LIMITATIONS]], Field(min_length=len(LIVE_LIMITATIONS),
                                                                 max_length=len(LIVE_LIMITATIONS))]
    executionAvailable: Literal[False]

    @model_validator(mode='after')
    def consistent(self):
        _live_limitations(self.limitations)
        chains = [chain.chainId for chain in self.chains]
        if chains != sorted(set(chains)):
            raise ValueError('chains_order')
        if (self.coverage == 'complete') != all(chain.status == 'current' for chain in self.chains):
            raise ValueError('coverage')
        # Chains are summed only when every one has its total (the owner, 2 Oct: §6.3's multi-chain rules).
        totals = [chain.totalUsd for chain in self.chains]
        if (self.totalUsd is not None) != (None not in totals) or (
                self.totalUsd is not None and fixed(self.totalUsd) != sum(fixed(total) for total in totals)):
            raise ValueError('balances_total')
        return self


class TokenListRef(WireModel):
    """The curated list's provenance: the Uniswap Labs Default token list (GPL-3.0), as pinned in the release."""
    name: Annotated[str, Field(min_length=1, max_length=64)]
    version: Annotated[str, Field(pattern=r'^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$')]
    sha256: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]


class KnownToken(WireModel):
    address: Address
    symbol: Symbol
    name: Annotated[str, Field(min_length=1, max_length=64)] | None
    decimals: Annotated[StrictInt, Field(ge=0, le=255)]
    sources: Annotated[list[Literal[TOKEN_SOURCES]], Field(min_length=1, max_length=len(TOKEN_SOURCES))]

    @model_validator(mode='after')
    def consistent(self):
        if not self.symbol.isprintable() or (self.name is not None and not self.name.isprintable()):
            raise ValueError('unsafe_text')
        if list(self.sources) != sorted(set(self.sources), key=TOKEN_SOURCES.index):
            raise ValueError('sources_order')
        return self


class ChainTokensResponse(WireModel):
    """chain-tokens: the tokens Domino knows on Base or Arbitrum One that match a query (known tokens only)."""
    schemaVersion: Literal[1]
    contractVersion: Literal[CONTRACT_VERSION]
    mode: Literal['known_chain_tokens']
    chainId: Literal[SEARCH_CHAIN_IDS]
    query: Annotated[str, Field(min_length=1, max_length=MAX_QUERY)]
    servedAt: UInt
    coverage: Literal['known_tokens_only']
    tokenList: TokenListRef
    tokens: Annotated[list[KnownToken], Field(max_length=MAX_SEARCH_TOKENS)]
    truncated: StrictBool
    limitations: Annotated[list[Literal[LIVE_LIMITATIONS]], Field(min_length=len(LIVE_LIMITATIONS),
                                                                 max_length=len(LIVE_LIMITATIONS))]
    executionAvailable: Literal[False]

    @model_validator(mode='after')
    def consistent(self):
        _live_limitations(self.limitations)
        addresses = [token.address for token in self.tokens]
        if len(addresses) != len(set(addresses)):
            raise ValueError('tokens_duplicate')
        return self


# ---------------------------------------------------------------- requests
WalletAddress = Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$', min_length=42, max_length=42)]


class PortfolioRequest(WireModel):
    wallet: WalletAddress


class ActivityPageRequest(WireModel):
    wallet: WalletAddress
    limit: Annotated[StrictInt, Field(ge=1, le=MAX_ITEMS)] = DEFAULT_ITEMS
    cursor: Cursor | None = None


class ChainPoolsRequest(WireModel):
    chainId: ChainId
    token: WalletAddress
    pairedToken: WalletAddress | None = None

    @model_validator(mode='after')
    def distinct(self):
        if self.pairedToken == self.token:
            raise ValueError('same_token')
        return self


class BalanceTokenRef(WireModel):
    chainId: ChainId
    address: WalletAddress


class ChainBalancesRequest(WireModel):
    """Without tokens: every chain's base currencies (its charge currencies)."""
    wallet: WalletAddress
    tokens: Annotated[list[BalanceTokenRef], Field(min_length=1, max_length=MAX_BALANCE_TOKENS)] | None = None

    @model_validator(mode='after')
    def distinct(self):
        if self.tokens is not None:
            keys = [(token.chainId, token.address) for token in self.tokens]
            if len(keys) != len(set(keys)):
                raise ValueError('duplicate_token')
        return self


class ChainTokensRequest(WireModel):
    chainId: Literal[SEARCH_CHAIN_IDS]
    query: Annotated[str, Field(min_length=1, max_length=MAX_QUERY)]
    limit: Annotated[StrictInt, Field(ge=1, le=MAX_SEARCH_TOKENS)] = DEFAULT_SEARCH_TOKENS

    @model_validator(mode='after')
    def readable(self):
        if not self.query.strip() or not self.query.isprintable():
            raise ValueError('query')
        return self


REQUEST_MODELS = {'portfolio': PortfolioRequest, 'activity': ActivityPageRequest, 'chain-pools': ChainPoolsRequest,
                  'chain-balances': ChainBalancesRequest, 'chain-tokens': ChainTokensRequest}
RESPONSE_MODELS = {'portfolio': PortfolioResponse, 'activity': ActivityResponse, 'chain-pools': ChainPoolsResponse,
                   'chain-balances': ChainBalancesResponse, 'chain-tokens': ChainTokensResponse}


def validate_v6_response(route, body):
    """Raise on any drift; return the exact input unchanged."""
    model = RESPONSE_MODELS.get(route)
    if model is None:
        raise ValueError('unknown_v6_route')
    model.model_validate(body)
    return body


def validate_v6_request_response(route, request, body):
    """The answer is about what was asked (the gateway's consistency check): the wallet, the chain, the token, the
    query; an answer never longer than the limit asked; balances for exactly the chains and tokens asked."""
    validate_v6_response(route, body)
    if route in ('portfolio', 'activity', 'chain-balances') and body['wallet'] != request['wallet']:
        raise ValueError('v6_wallet_mismatch')
    if route == 'activity' and len(body['items']) > request.get('limit', DEFAULT_ITEMS):
        raise ValueError('v6_page_too_long')
    if route == 'chain-pools' and (body['chainId'], body['token'], body['pairedToken']) != (
            request['chainId'], request['token'], request.get('pairedToken')):
        raise ValueError('v6_pools_mismatch')
    if route == 'chain-tokens' and ((body['chainId'], body['query']) != (request['chainId'], request['query'])
                                    or len(body['tokens']) > request.get('limit', DEFAULT_SEARCH_TOKENS)):
        raise ValueError('v6_tokens_mismatch')
    if route == 'chain-balances':
        tokens = request.get('tokens')
        chains = [chain['chainId'] for chain in body['chains']]
        if tokens is None:
            if chains != list(CHAIN_IDS):
                raise ValueError('v6_balances_mismatch')
        else:
            asked = {}
            for token in tokens:
                asked.setdefault(token['chainId'], []).append(token['address'])
            if {chain['chainId']: [b['address'] for b in chain['balances']] for chain in body['chains']} != asked:
                raise ValueError('v6_balances_mismatch')
    return body


def cursor_key(cursor):
    """(timestamp, chain id, block, log index) of a cursor, the page's exclusive bound."""
    if not isinstance(cursor, str) or not re.fullmatch(r'[0-9]{1,19}\.[1-9][0-9]{0,18}\.[0-9]{1,19}\.[0-9]{1,10}',
                                                        cursor):
        raise ValueError('invalid_cursor')
    timestamp, chain, block, index = (int(part) for part in cursor.split('.'))
    if chain not in CHAIN_IDS or max(timestamp, block) > 2**63 - 1 or index > 2**31 - 1:
        raise ValueError('invalid_cursor')
    return timestamp, chain, block, index


def make_cursor(timestamp, chain_id, block_number, log_index):
    return f'{timestamp}.{chain_id}.{block_number}.{log_index}'
