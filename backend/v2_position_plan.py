"""S1 plans for the V2 zap: create, increase, change range and exit, on Uniswap v3 and v4, per chain.

The app (F7) asks for a plan, checks it (api-contracts/position-plan-v1's
runtime recomputes what it can), and has the owner consent to it by one of the
zap's paths. This module builds the plan from the chain at one pinned block:

1. What the owner has: the pool (or the new pool and its initial price), the
   position, and the inputs. Positions in v4 pools with hooks are refused.
   Native ETH pays a v3 WETH pool's WETH side: the v3 zap wraps it before it
   adds, and what is left returns as WETH.
2. The swap legs. Each conversion is quoted on-chain at the block: the
   position's own pool by an exact local swap (v2_liquidity, ticks read from
   the chain; it also sees the liquidity a withdrawal removes first), every
   other pool by the chain's QuoterV2 / V4Quoter (v2_quotes), and a Universal
   Router 2.1.2 leg from the Uniswap Trading API (v2_uniswap_api) when it
   delivers ROUTER_ADVANTAGE_BPS more than the best pool route and does not
   touch the position's pool. Swap amounts are sized so the mint uses what the
   zap holds: exactly against the own pool's price after the swap, by a
   linear model and one confirming quote elsewhere (the probe's own when the
   amount is the one it priced). Every read is pinned to the block, so no
   answer in hand is asked for again.
3. The fee, exactly as the zap enforces it (v2_fee_rule, F1b): 65 bps of the
   swapped amount in the best-ranked charge currency of the route, ranks read
   from the deployed registry; (0, address(0)) with no legs.
4. The minimums (contract 1.0.0-rc.2, owner 2 Oct 2026): every leg's
   minAmountOut = floor(expected out x (1 - s)); minLiquidity and the removal
   minima at the worst price within ±s, as the Uniswap SDK's
   mintAmountsWithSlippage and burnAmountsWithSlippage
   (v2_position_plan_rules.plan_minimums, the one definition).
5. The intent and the consent artifacts: the direct call data, the Permit2
   batch-witness typed data (a free Permit2 nonce of the owner), or the
   relayed typed data (a free zap nonce). intent.deadline = permit.deadline =
   requestedAt + 300 s; the plan's quote is valid until requestedAt + 180 s
   (owner, 2 Oct 2026).
6. The owner's readiness (balances, ERC-20 allowances to the zap or Permit2,
   the NFT's approval to the zap, the account's code: an account with code,
   EIP-7702 delegated or a contract, gets the direct path only), the
   transaction's L1 data fee (v2_l1_fee: Base's GasPriceOracle inside the same
   Multicall3, Nitro's NodeInterface in one call), and a simulation of the zap
   call from the owner at the same block (eth_simulateV1 with the missing
   approvals first, or eth_call), with the L2 gas it used. When the
   simulated call's legs did not deliver what they were quoted for (a router
   leg the API priced off the block, or two legs crossing one pool), the plan
   is rebuilt from what they delivered and simulated again; a call that
   reverted on a leg's minimum is first measured with every minimum at its floor.

Nothing here signs or sends: the response is unsigned data the wallet shows.
"""
from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import secrets
import time

from eth_abi import decode, encode

from discovery import ZERO, DataError, address
from v2_abi import function
from v2_chains import DEX_V3, DEX_V4
import v2_fee_rule as fee_rule
import v2_l1_fee as l1_fee
import v2_plan_codec as codec
from v2_liquidity import (LiquidityError, U128, amounts_for_liquidity, check_range, human_price,
                          initial_sqrt_price, liquidity_for_amount0, liquidity_for_amount1, range_prices,
                          simulate_exact_in)
from v2_quotes import (ERC20_ALLOWANCE, ERC20_BALANCE_OF, ERC20_DECIMALS, GET_ETH_BALANCE, Path, PoolQuoter,
                       ReadPlan, best_two_hop, candidate_paths, pool_snapshot)
from v2_position_plan_rules import plan_minimums
from v2_events import SWAP_LEG_EXECUTED, event_from_abi
from v2_uniswap_api import SOURCE as ROUTER_SOURCE
from v2_rpc import ChainReadRpc
from v2_uniswap import PoolRef, PositionRef, UniswapReader, v3_pool_address, v4_fees_owed

SOURCE = 'position_plan_v1'
QUOTE_LIFETIME_SECONDS = 180   # expiresAt: the app signs before it (owner, 2 Oct 2026)
DEADLINE_SECONDS = 300         # intent.deadline = permit.deadline (owner, 2 Oct 2026)
DEFAULT_SLIPPAGE_BPS = 50
ROUTER_ADVANTAGE_BPS = 10
SIMULATION_GAS = 30_000_000
MAX_REQUESTS = 96
INFINITE = 1 << 200
DELEGATION_PREFIX = 'ef0100'
ZAPS = {DEX_V3: 'zap.v3', DEX_V4: 'zap.v4'}  # the manifest's components
# Stands in for the owner's signature when the signed paths' transaction is priced (L1 data fee).
PLACEHOLDER_SIGNATURE = '0x' + '11' * 65
# The zap's receipt line per executed leg (F1b), with its measured amounts: what a simulated call delivered.
SWAP_LEG_TOPIC = event_from_abi(SWAP_LEG_EXECUTED).topic0
# Rebuilds of a plan from what its simulated call delivered. One converges: only the minimums change, and they
# never bind on the outputs they were taken from.
MAX_CORRECTIONS = 2

# Errors the zap, its libraries, Permit2, the position managers and the router
# revert with, by selector: the simulation reports the name (F7 §2.12).
ERROR_SIGNATURES = (
    'InvalidPlan()', 'PlanExpired()', 'FeeMismatch()', 'SwapEffectMismatch()', 'InsufficientLiquidity()',
    'Unauthorized()', 'InvalidSignature()', 'NonceUsed(address,uint256)', 'ReentrantCall()',
    'FeeNotBacked(address)', 'FeeTransferMismatch(address)', 'TokenCallFailed(address)',
    'InsufficientLiquidity(uint128,uint128)', 'PositionPoolMismatch(uint256)', 'InvalidPool()',
    'InvalidRange(int24,int24,int24)', 'InvalidTick(int24)', 'InvalidSqrtPrice(uint160)', 'PoolNotInitialized()',
    'PartialBurn(uint256,uint128,uint128)', 'InvalidRecipient(address)', 'OpenDelta(int256,int256)',
    'TransferFailed(address)', 'SettlementMismatch(address,uint256,uint256)', 'ApprovalFailed(address)',
    'DirectCall()', 'InvalidZapConfig()', 'InvalidSigner()', 'InvalidContractSignature()',
    'InvalidSignatureLength()', 'InvalidNonce()', 'SignatureExpired(uint256)', 'InsufficientAllowance(uint256)',
    'InvalidAmount(uint256)', 'LengthMismatch()', 'NotApproved(address)', 'WrappedError(address,bytes4,bytes,bytes)',
    'MaximumAmountExceeded(uint128,uint128)', 'MinimumAmountInsufficient(uint128,uint128)',
    'V4TooLittleReceived(uint256,uint256)', 'V3TooLittleReceived()', 'TransactionDeadlinePassed()',
    'ExecutionFailed(uint256,bytes)', 'Error(string)', 'Panic(uint256)')
ERRORS = {codec.selector(signature): signature for signature in ERROR_SIGNATURES}


class PlanError(Exception):
    """A contract error code (v2_position_plan_models.ERROR_STATUS_BY_CODE)."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


class PlanRpc(ChainReadRpc):
    """The chain's read client plus the two simulation methods; neither writes."""
    METHODS = ChainReadRpc.METHODS | frozenset({'eth_simulateV1', 'eth_estimateGas'})


def _bps_floor(amount, slippage_bps):
    return int(amount) * (10_000 - slippage_bps) // 10_000


def _band(band):
    return None if band is None else {'lowerSqrtPriceX96': str(band[0]), 'upperSqrtPriceX96': str(band[1])}


def _fee_on_top_capacity(total):
    """The largest a with a + floor(a * 65 / 10000) <= total: what can be
    swapped when the fee comes on top of it in the same token."""
    low, high = 0, total
    while low < high:
        mid = (low + high + 1) // 2
        if mid + fee_rule.fee_of(mid, fee_rule.FEE_ASSISTED_SWAP_BPS) <= total:
            low = mid
        else:
            high = mid - 1
    return low


def _side_liquidity(sqrt_price, sqrt_a, sqrt_b, amount0, amount1):
    """(L funded by amount0, L funded by amount1) at a price; INFINITE where a token is not needed."""
    l0 = liquidity_for_amount0(max(sqrt_price, sqrt_a), sqrt_b, amount0) if sqrt_price < sqrt_b else INFINITE
    l1 = liquidity_for_amount1(sqrt_a, min(sqrt_price, sqrt_b), amount1) if sqrt_price > sqrt_a else INFINITE
    return l0, l1


def account_kind(code):
    """eoa, eip7702 (a delegation designator) or contract."""
    if not isinstance(code, str) or not code.startswith('0x'):
        raise DataError('invalid_code_response')
    body = code[2:].lower()
    if not body:
        return 'eoa', None
    if len(body) == 46 and body.startswith(DELEGATION_PREFIX):
        return 'eip7702', '0x' + body[6:]
    return 'contract', None


def decode_revert(data):
    """{selector, name} of revert data; name None when unknown."""
    if not isinstance(data, str) or not data.startswith('0x') or len(data) < 10:
        return {'selector': None, 'name': None}
    selector = data[:10].lower()
    return {'selector': selector, 'name': ERRORS.get(selector)}


@dataclass
class Leg:
    """One planned swap leg and what it is expected to deliver."""
    kind: int  # 1 router, 2 v3 pool, 3 v4 pool
    router: str
    token_in: str
    token_out: str
    amount_in: int
    expected_out: int
    data: str
    source: str
    pools: list
    price_impact: str | None = None
    min_out: int = 0
    router_deadline: int | None = None

    def wire(self):
        return {'kind': self.kind, 'router': self.router, 'tokenIn': self.token_in, 'tokenOut': self.token_out,
                'amountIn': str(self.amount_in), 'minAmountOut': str(self.min_out), 'data': self.data}


@dataclass
class Route:
    """A way to convert one token into another: a pool path, the own pool, or a router leg."""
    kind: str  # 'own' | 'path' | 'router'
    token_in: str
    token_out: str
    path: object = None
    rate: Fraction | None = None  # out per in at the probe amount (path, router)
    leg: dict | None = None       # router answer
    probe_in: int = 0
    probe_out: int = 0


class PositionPlanner:
    """Plans for one chain. `follower` gives the shared head; `router_legs` is
    a v2_uniswap_api.TradingApiLegs, or None when no API key is configured."""

    def __init__(self, chain, endpoints, follower, deployment, *, router_legs=None, clock=time.time,
                 nonce_word=None, simulate=True):
        if deployment.chain.chainId != chain.chainId:
            raise DataError('v2_deployment_chain_mismatch')
        self.chain, self.endpoints, self.follower, self.deployment = chain, endpoints, follower, deployment
        self.router_legs, self.clock, self.simulate = router_legs, clock, simulate
        # Permit2's nonces are one bitmap per owner, shared by every app that
        # uses SignatureTransfer: a random high word keeps clear of the low words
        # sequential nonces use (F7 §2.5.2). Tests pass a fixed word.
        self.nonce_word = nonce_word or (lambda: secrets.randbits(240) + (1 << 240))

    # ------------------------------------------------------------------ entry
    def plan(self, request, owner):
        owner = address(owner)
        # A pool or position of a Uniswap version the chain lacks is refused before any read (v2_dex_not_on_chain).
        self.chain.require_dex(request['pool']['dex'] if request['action'] == 'create' else request['position']['dex'])
        started = self.clock()
        requested = int(started)
        head = self.follower.head()
        rpc = PlanRpc(self.endpoints, anchor=head.block, batch_reads=True, max_requests=MAX_REQUESTS)
        reader = UniswapReader(self.chain, rpc)
        context = _Context(self, request, owner, requested, head, rpc, reader)
        body = context.build()
        completed = self.clock()
        if completed < started or completed >= requested + QUOTE_LIFETIME_SECONDS:
            raise PlanError('preview_expired')
        body['retrievedAt'] = int(completed)
        return body


class _Context:
    """One plan request, at one block."""

    def __init__(self, planner, request, owner, requested, head, rpc, reader):
        self.p, self.request, self.owner, self.requested = planner, request, owner, requested
        self.chain, self.head, self.rpc, self.reader = planner.chain, head, rpc, reader
        self.block = head.block
        self.action, self.consent = request['action'], request['consent']
        self.slippage = request.get('slippageBps', DEFAULT_SLIPPAGE_BPS)
        self.deadline = requested + DEADLINE_SECONDS
        self.warnings = []
        self.quoter = PoolQuoter(self.chain, rpc, self.block)
        self.router_status = None
        self._readiness_reads = {}  # the readiness Multicall3 answers at the block, by their calls

    # --------------------------------------------------------------- build
    def build(self):
        self.dex = self.request['pool']['dex'] if self.action == 'create' else self.request['position']['dex']
        self.zap = self.p.deployment.address(ZAPS[self.dex])
        self._prove_deployment()
        if self.action == 'create':
            self._load_create_target()
        else:
            self._load_position()
        # The v3 zap wraps the native ETH it holds for a WETH pool before it adds
        # (F2 "Tokens, refunds and allowances"): there, ETH is the pool's WETH.
        self.weth = self.chain.wrappedNative.address
        self.wraps = self.pool.dex == DEX_V3 and self.weth in (self.pool.currency0, self.pool.currency1)
        self.native_side = None  # the pool token the owner pays in native ETH
        self._load_ranks_and_nonce()
        sized = {'create': self._size_add, 'increase': self._size_add, 'changeRange': self._size_change_range,
                 'exit': self._size_exit}[self.action]()
        return self._assemble(sized)

    def _prove_deployment(self):
        """The code of the zap (with its v4 steps) and the registry is the
        manifest's (v2_manifest.Deployment.verify_code: once per process,
        through the chain's code cache)."""
        components = ('registry', 'zap.v3') if self.dex == DEX_V3 else ('registry', 'zap.v4', 'zap.v4.steps')
        try:
            self.p.deployment.verify_code(self.rpc, self.block, components=components)
        except DataError as error:
            if str(error).startswith('v2_deployment_'):
                raise PlanError('position_plan_unavailable') from None
            raise

    # ---------------------------------------------------------------- reads
    def _load_create_target(self):
        raw = self.request['pool']
        if raw['hooks'].lower() != ZERO:
            raise PlanError('position_plan_hooked_pool')
        try:
            pool = PoolRef(raw['dex'], raw['currency0'], raw['currency1'], raw['fee'], raw['tickSpacing'], raw['hooks'])
        except DataError:
            raise PlanError('position_plan_pool_invalid') from None
        self.pool, self.position = pool, None
        try:
            self.state = self.reader.pool(pool, self.block)
        except DataError as error:
            if str(error) in ('v3_tick_spacing_mismatch', 'v3_pool_address_mismatch'):
                raise PlanError('position_plan_pool_invalid') from None
            if str(error) not in ('v2_pool_not_found', 'v2_pool_not_initialized'):
                raise
            self.state = None
        initial = self.request.get('initialPrice')
        if self.state is None and initial is None:
            raise PlanError('position_plan_pool_not_initialized')
        if self.state is not None and initial is not None:
            raise PlanError('position_plan_pool_initialized')
        try:
            check_range(self.request['tickLower'], self.request['tickUpper'], pool.tick_spacing)
        except LiquidityError:
            raise PlanError('position_plan_range_invalid') from None
        self.tick_lower, self.tick_upper = self.request['tickLower'], self.request['tickUpper']
        self.initial, self.init_sqrt = None, 0
        if initial is not None:
            self._initial_price(pool, initial)

    def _initial_price(self, pool, initial):
        """The new pool's sqrtPriceX96 and tick from the owner's human price,
        with the decimals checked against the tokens where they answer."""
        if pool.dex == DEX_V3:
            # A v3 pool exists only in an enabled fee tier with its spacing.
            spacing, = function('IUniswapV3FactoryMinimal', 'feeAmountTickSpacing').decode(self.rpc.request('eth_call', [
                {'to': self.chain.uniswap.v3.factory, 'gas': hex(100_000),
                 'data': function('IUniswapV3FactoryMinimal', 'feeAmountTickSpacing').calldata(pool.fee)},
                self.block.tag]))
            if spacing == 0 or spacing != pool.tick_spacing:
                raise PlanError('position_plan_pool_invalid')
        elif pool.fee > 1_000_000 or not 1 <= pool.tick_spacing <= 32767:
            raise PlanError('position_plan_pool_invalid')
        declared = (initial['decimals0'], initial['decimals1'])
        reads = ReadPlan()
        slots = [None if token == ZERO else reads.add(token, ERC20_DECIMALS)
                 for token in (pool.currency0, pool.currency1)]
        answers = reads.run(self.rpc, self.chain, self.block)
        verified = True
        for index, (token, slot) in enumerate(zip((pool.currency0, pool.currency1), slots)):
            actual = 18 if token == ZERO else (answers[slot][0] if answers[slot] is not None else None)
            if actual is None:
                verified = False
            elif actual != declared[index]:
                raise PlanError('position_plan_price_decimals_mismatch')
        base0 = initial['baseToken'].lower() == pool.currency0
        if not base0 and initial['baseToken'].lower() != pool.currency1:
            raise PlanError('position_plan_price_invalid')
        try:
            sqrt_price, tick = initial_sqrt_price(Fraction(initial['price']), base0, *declared)
            price0, price1 = human_price(sqrt_price, *declared)
        except (LiquidityError, ValueError, ZeroDivisionError):
            raise PlanError('position_plan_price_invalid') from None
        self.initial = {'sqrtPriceX96': str(sqrt_price), 'tick': tick, 'price0In1': price0, 'price1In0': price1,
                        'decimals0': declared[0], 'decimals1': declared[1], 'decimalsVerified': verified,
                        'baseToken': initial['baseToken'].lower(), 'price': initial['price']}
        self.init_sqrt = sqrt_price

    def _load_position(self):
        raw = self.request['position']
        token_id = int(raw['tokenId'])
        try:
            position = self.reader.position(PositionRef(raw['dex'], self.chain.position_manager(raw['dex']), token_id),
                                            self.block)
        except DataError as error:
            if str(error) in ('v2_position_not_found', 'rpc_call_reverted', 'v2_position_has_no_owner'):
                raise PlanError('position_plan_position_not_found') from None
            raise
        if position.owner != self.owner:
            raise PlanError('position_plan_not_owner')
        if position.pool.pool.hooks != ZERO:
            raise PlanError('position_plan_hooked_pool')
        self.position, self.state, self.pool = position, position.pool, position.pool.pool
        self.initial, self.init_sqrt = None, 0
        if self.action == 'changeRange':
            try:
                check_range(self.request['tickLower'], self.request['tickUpper'], self.pool.tick_spacing)
            except LiquidityError:
                raise PlanError('position_plan_range_invalid') from None
            if (self.request['tickLower'], self.request['tickUpper']) == (position.tick_lower, position.tick_upper):
                raise PlanError('position_plan_range_invalid')
            self.tick_lower, self.tick_upper = self.request['tickLower'], self.request['tickUpper']
        else:
            self.tick_lower, self.tick_upper = position.tick_lower, position.tick_upper
        if self.action in ('changeRange', 'exit'):
            wanted = self.request['liquidityToRemove']
            remove = position.liquidity if wanted == 'all' else int(wanted)
            if remove > position.liquidity or (self.action == 'changeRange' and remove == 0):
                raise PlanError('position_plan_liquidity_invalid')
            if self.request['burn'] and remove != position.liquidity:
                raise PlanError('position_plan_burn_needs_all')
            self.remove = remove

    def _load_ranks_and_nonce(self):
        """The registry's ranks of every token a leg may touch, whether the
        router is admitted, the free nonce of the consent path and the account kind."""
        tokens = {self.pool.currency0, self.pool.currency1}
        for item in self.request.get('inputs') or ():
            tokens.add(item['token'].lower())
        receive = self.request.get('receive')
        if receive and receive.get('mode') == 'converted':
            tokens.add(receive['token'].lower())
        tokens |= {currency.address for currency in self.chain.chargeCurrencies}
        tokens.add(self.chain.wrappedNative.address)
        self.hubs = [c.address for c in self.chain.chargeCurrencies]
        registry = self.p.deployment.registry
        rank_fn = function('IDominoRegistry', 'chargeCurrencyRank')
        reads = ReadPlan()
        rank_slots = {token: reads.add(registry, rank_fn, token) for token in sorted(tokens)}
        router_slot = reads.add(registry, function('IDominoRegistry', 'routerVersion'),
                                self.chain.uniswap.universalRouter.address)
        self.nonce_word = None
        if self.consent == 'permit2':
            self.nonce_word = self.p.nonce_word()
            nonce_slot = reads.add(self.chain.permit2, function('IPermit2Signature', 'nonceBitmap'), self.owner,
                                   self.nonce_word)
        elif self.consent == 'relayed':
            self.nonce_word = self.p.nonce_word()
            nonce_slot = reads.add(self.zap, function('IDominoZap', 'nonceBitmap'), self.owner, self.nonce_word)
        answers = reads.run(self.rpc, self.chain, self.block)
        ranks = {}
        for token, slot in rank_slots.items():
            if answers[slot] is None:
                raise PlanError('position_plan_unavailable')
            ranks[token] = answers[slot][0]
        self.ranks = ranks
        self.rank = lambda token: ranks.get(token.lower(), 0) if token.lower() in ranks else self._rank_missing(token)
        self.router_admitted = answers[router_slot] is not None and answers[router_slot][0] >= 212
        self.nonce = 0
        if self.nonce_word is not None:
            if answers[nonce_slot] is None:
                raise PlanError('position_plan_unavailable')
            bits = answers[nonce_slot][0]
            free = next((bit for bit in range(256) if not bits >> bit & 1), None)
            if free is None:
                raise PlanError('position_plan_unavailable')
            self.nonce = (self.nonce_word << 8) | free
        code = self.rpc.request('eth_getCode', [self.owner, self.block.tag])
        self.account, self.delegate = account_kind(code)
        # Until a verified list of delegates with EIP-1271 exists, an account
        # with code (EIP-7702 delegated or a contract) gets the direct path only.
        if self.account != 'eoa' and self.consent != 'direct':
            raise PlanError('position_plan_consent_unsupported')

    def _rank_missing(self, token):
        """A token first seen in a router route: read its rank now (one call)."""
        value, = function('IDominoRegistry', 'chargeCurrencyRank').decode(self.rpc.request('eth_call', [
            {'to': self.p.deployment.registry, 'gas': hex(100_000),
             'data': function('IDominoRegistry', 'chargeCurrencyRank').calldata(token)}, self.block.tag]))
        self.ranks[token.lower()] = value
        return value

    # ------------------------------------------------------------- routing
    def _own_snapshot(self, removed=0):
        """The position's pool as a local swap model, minus a withdrawal when given."""
        if self.state is None:
            return None
        if not hasattr(self, '_snapshot'):
            self._snapshot = pool_snapshot(self.chain, self.rpc, self.block, self.state)
        if removed and self.position is not None:
            return self._snapshot.without_position(self.position.tick_lower, self.position.tick_upper, removed)
        return self._snapshot

    def _routes(self, token_in, token_out, probe, *, own_snapshot=None):
        """Every way to convert token_in into token_out, each probed at `probe`:
        the own pool (exact), direct pools (quoted), a two-hop path through a
        hub when no direct pool answers, and a router leg. The position's own
        pool is never used through a quoter or the router, so its price after
        the swap is always the exact local one."""
        routes = []
        own = self.pool if {token_in, token_out} == {self.pool.currency0, self.pool.currency1} else None
        if own is not None and own_snapshot is not None:
            try:
                outcome = simulate_exact_in(own_snapshot, token_in == self.pool.currency0, probe)
                routes.append(Route('own', token_in, token_out, probe_in=probe, probe_out=outcome.amount_out))
            except LiquidityError:
                pass
        paths = candidate_paths(self.chain, token_in, token_out, exclude=(self.pool,))
        quotes = self.quoter.quote(paths, probe)
        found = [q for q in quotes if q is not None]
        if not found:
            two = best_two_hop(self.quoter, token_in, token_out, self.hubs, probe, exclude=(self.pool,))
            found = [two] if two is not None else []
        for quote in found:
            routes.append(Route('path', token_in, token_out, path=quote.path, probe_in=probe,
                                probe_out=quote.amount_out, rate=Fraction(quote.amount_out, probe)))
        router = self._router_route(token_in, token_out, probe)
        if router is not None:
            routes.append(router)
        return routes

    def _router_route(self, token_in, token_out, amount):
        if self.p.router_legs is None:
            self.router_status = self.router_status or {'status': 'not_configured', 'reason': None}
            return None
        if not self.router_admitted:
            self.router_status = {'status': 'refused', 'reason': 'router_not_admitted'}
            return None
        try:
            leg = self.p.router_legs.leg(chain=self.chain, zap=self.zap, token_in=token_in, token_out=token_out,
                                         amount_in=amount, slippage_bps=self.slippage, deadline=self.deadline)
        except DataError as error:
            self.router_status = {'status': 'unavailable', 'reason': str(error)[:64]}
            return None
        own_ids = {self.pool.pool_id if self.pool.dex == DEX_V4 else
                   v3_pool_address(self.chain, self.pool.currency0, self.pool.currency1, self.pool.fee)}
        if any(hop['id'] in own_ids for path in leg['paths'] for hop in path['pools']):
            self.router_status = {'status': 'refused', 'reason': 'router_route_uses_position_pool'}
            return None
        return Route('router', token_in, token_out, leg=leg, probe_in=amount, probe_out=leg['expectedOut'],
                     rate=Fraction(leg['expectedOut'], amount))

    def _pick(self, routes, score):
        """The route with the best score; a router route must beat the best pool
        route by ROUTER_ADVANTAGE_BPS."""
        pools = [r for r in routes if r.kind != 'router']
        router = [r for r in routes if r.kind == 'router']
        best_pool = max(pools, key=score, default=None)
        if router:
            candidate = router[0]
            if best_pool is None or score(candidate) * 10_000 > score(best_pool) * (10_000 + ROUTER_ADVANTAGE_BPS):
                self.router_status = {'status': 'chosen', 'reason': None}
                return candidate
            self.router_status = {'status': 'not_better', 'reason': 'within_advantage_threshold'}
        return best_pool

    def _leg_for(self, route, amount_in, expected_out, *, own_snapshot=None):
        """The SwapLeg for a route and its exact input, and the confirmed output."""
        if route.kind == 'own':
            pool = self.pool
            outcome = simulate_exact_in(own_snapshot, route.token_in == pool.currency0, amount_in,
                                        track=self._fee_track())
            path = Path(pool.dex, route.token_in, (pool,))
            return Leg(path.leg_kind, ZERO, route.token_in, route.token_out, amount_in, outcome.amount_out,
                       path.leg_data(), 'local_simulation', path.describe(self.chain)), outcome
        if route.kind == 'path':
            return Leg(route.path.leg_kind, ZERO, route.token_in, route.token_out, amount_in, expected_out,
                       route.path.leg_data(), 'quoter_v2' if route.path.dex == DEX_V3 else 'v4_quoter',
                       route.path.describe(self.chain)), None
        leg = route.leg
        pools = [_router_pool(hop) for path in leg['paths'] for hop in path['pools']]
        return Leg(1, leg['router'], route.token_in, route.token_out, leg['amountIn'], leg['expectedOut'], leg['data'],
                   ROUTER_SOURCE, pools, leg['priceImpactPercent'],
                   router_deadline=leg['routerDeadline']), None

    def _fee_track(self):
        """The range whose fee growth the own pool's leg must report: a v4
        increase refunds the position's fees, what that leg pays it included."""
        if self.action == 'increase' and self.pool.dex == DEX_V4:
            return self.position.tick_lower, self.position.tick_upper
        return None

    def _confirm(self, route, amount_in, own_snapshot=None):
        """The leg for exactly amount_in: re-quoted (a path), simulated (own
        pool), or the probe's own quote (a path or the router) when the amount
        is the one it priced."""
        if route.kind == 'path' and amount_in == route.probe_in:
            # The same quoter call at the same block: its answer is in hand (3 Nov 2026). An exit converts what it
            # holds at the amount it probed, and an even split often lands on its probes.
            return self._leg_for(route, amount_in, route.probe_out)
        if route.kind == 'path':
            quote, = self.quoter.quote([route.path], amount_in)
            if quote is None:
                raise PlanError('position_plan_no_route')
            return self._leg_for(route, amount_in, quote.amount_out)
        if route.kind == 'router' and amount_in != route.probe_in:
            fresh = self._router_route(route.token_in, route.token_out, amount_in)
            if fresh is None:
                raise PlanError('position_plan_no_route')
            route = fresh
        return self._leg_for(route, amount_in, route.probe_out, own_snapshot=own_snapshot)

    def _confirm_choice(self, route, amount_in, alternatives, own_snapshot=None):
        """_confirm, except that a router leg the API no longer gives for the
        final amount falls back to the best pool route at the same amount."""
        try:
            return self._confirm(route, amount_in, own_snapshot)
        except PlanError:
            pools = [r for r in alternatives if r.kind != 'router']
            if route.kind != 'router' or not pools:
                raise
            self.router_status = {'status': 'unavailable', 'reason': 'router_confirmation_failed'}
            return self._confirm(max(pools, key=lambda r: r.probe_out), amount_in, own_snapshot)

    # --------------------------------------------------------------- sizing
    def _fee(self, legs, outs):
        """(bps, token, place, swapped, fee) of legs with their expected outputs."""
        if not legs:
            return 0, ZERO, 'none', 0, 0
        rows = [fee_rule.LegTokens(leg.token_in, leg.token_out, leg.amount_in) for leg in legs]
        token, source, swapped, fee = fee_rule.assisted_swap_fee(rows, outs, self.rank)
        return fee_rule.FEE_ASSISTED_SWAP_BPS, token, fee_rule.PLACES[source], swapped, fee

    def _mint_price(self):
        return self.init_sqrt if self.initial is not None else self.state.sqrt_price_x96

    def _balance_search(self, x_max, outcome):
        """The x in [0, x_max] where the side being sold stops binding: the
        smallest x whose bought side funds at least the sold side, then the
        better of it and its neighbour. `outcome(x)` gives (L_sold, L_bought, extra)."""
        low, high = 0, x_max
        while low < high:
            mid = (low + high) // 2
            sold, bought, _ = outcome(mid)
            if bought >= sold:
                high = mid
            else:
                low = mid + 1
        candidates = {low, max(0, low - 1)}
        return max(candidates, key=lambda x: (min(outcome(x)[:2]), -x))

    def _size_add(self):
        """create and increase: pull the inputs, rebalance into the range, add."""
        inputs = [(item['token'].lower(), int(item['amountRaw'])) for item in self.request['inputs']]
        pool = self.pool
        c0, c1 = pool.currency0, pool.currency1
        tokens = [token for token, _ in inputs]
        # Native ETH pays a v3 WETH pool's WETH side (never both at once).
        native = self.wraps and ZERO in tokens
        if native and self.weth in tokens:
            raise PlanError('position_plan_inputs_unsupported')
        foreign = [token for token in tokens if token not in (c0, c1) and not (native and token == ZERO)]
        if len(set(tokens)) != len(inputs) or len(foreign) > 1 or (foreign and len(inputs) > 1):
            raise PlanError('position_plan_inputs_unsupported')
        if self.consent == 'permit2' and ZERO in tokens:
            raise PlanError('position_plan_consent_unsupported')
        if self.state is None and ZERO in tokens and pool.dex == DEX_V3:
            raise PlanError('position_plan_inputs_unsupported')
        if foreign:
            return self._size_foreign(inputs[0])
        held = {c0: 0, c1: 0}
        for token, amount in inputs:
            held[self.weth if token == ZERO and native else token] += amount
        if native:
            self.native_side = self.weth
        legs, own = self._rebalance(held, held, removed=0)
        return {'inputs': inputs, 'legs': legs, 'withdrawn': None, 'own': own}

    def _rebalance(self, held, guaranteed, *, removed):
        """At most one leg between the pool's tokens, so the mint at the price
        after it uses what the zap holds. `held` is what the zap expects to hold
        (inputs, or a withdrawal), `guaranteed` the least it will hold. Returns
        the legs and the own pool's swap outcome (None when the own pool did not
        swap). With both tokens held and no route, nothing is swapped and the
        excess side is refunded."""
        pool = self.pool
        c0, c1 = pool.currency0, pool.currency1
        sqrt_a, sqrt_b = range_prices(self.tick_lower, self.tick_upper)
        price = self._mint_price()
        need0, need1 = amounts_for_liquidity(price, sqrt_a, sqrt_b, 10**18, True)
        h0, h1 = held[c0], held[c1]
        # Value of each side in currency1 at the price, to decide which side sells.
        value = lambda amount0, amount1: Fraction(amount0) * price * price / (1 << 192) + amount1
        total = value(h0, h1)
        if total == 0:
            raise PlanError('position_plan_amount_too_small')
        want0 = value(need0, 0) / value(need0, need1) if (need0 or need1) else Fraction(1, 2)
        have0 = value(h0, 0) / total
        if abs(have0 - want0) * 10_000 < 1:  # within a basis point: no swap
            return [], None
        sell0 = have0 > want0
        token_in, token_out = (c0, c1) if sell0 else (c1, c0)
        # WETH held as native ETH is sold as ETH: through v4 pools or the router,
        # never the v3 pool itself (a v3 leg spends ERC-20s only).
        spend = ZERO if token_in == self.native_side else token_in
        surplus_value = (have0 - want0) * total if sell0 else (want0 - have0) * total
        probe = int(surplus_value / (Fraction(price * price, 1 << 192))) if sell0 else int(surplus_value)
        probe = max(1, min(probe, guaranteed[token_in]))
        own_snapshot = self._own_snapshot(removed) if self.initial is None else None
        routes = self._routes(spend, token_out, probe, own_snapshot=own_snapshot)
        if not routes:
            if h0 and h1:
                return [], None
            raise PlanError('position_plan_no_route')
        fee_token, _ = fee_rule.assisted_swap_fee_token([fee_rule.LegTokens(spend, token_out, 1)], self.rank)
        fee_side = token_in if fee_token == spend else fee_token

        def outcome_for(route):
            def outcome(x):
                if x == 0:
                    out, after = 0, (own_snapshot.sqrt_price if route.kind == 'own' else price)
                elif route.kind == 'own':
                    try:
                        result = simulate_exact_in(own_snapshot, sell0, x)
                    except LiquidityError:
                        return 0, INFINITE, price  # more than the pool takes: too much
                    out, after = result.amount_out, result.sqrt_price
                else:
                    out, after = int(route.rate * x), price
                rows = [fee_rule.LegTokens(spend, token_out, x)] if x else []
                fee = fee_rule.fee_of(fee_rule.swapped_amount(rows, [out] if x else [], fee_token),
                                         fee_rule.FEE_ASSISTED_SWAP_BPS) if x else 0
                final = {c0: h0, c1: h1}
                final[token_in] -= x
                final[token_out] += out
                final[fee_side] -= fee
                if min(final.values()) < 0:
                    return 0, INFINITE, after
                l0, l1 = _side_liquidity(after, sqrt_a, sqrt_b, final[c0], final[c1])
                sold, bought = (l0, l1) if sell0 else (l1, l0)
                return sold, bought, after
            return outcome

        capacity = guaranteed[token_in]
        if fee_side == token_in:
            capacity = _fee_on_top_capacity(capacity)
        # Every route is sized to balance the mint: the own pool exactly, the
        # others by the rate of their probe (re-quoted at the chosen amount, a
        # router leg by a second API call when the amount moved).
        chosen = []
        for route in routes:
            try:
                x = self._balance_search(capacity, outcome_for(route))
            except LiquidityError:
                continue
            sold, bought, _ = outcome_for(route)(x)
            chosen.append((min(sold, bought), route, x))
        if not chosen:
            if h0 and h1:
                return [], None
            raise PlanError('position_plan_no_route')
        best_route = self._pick([route for _, route, _ in chosen],
                                score=lambda r: next(l for l, rr, _ in chosen if rr is r))
        x = next(x for _, route, x in chosen if route is best_route)
        if x == 0:
            return [], None
        leg, own = self._confirm_choice(best_route, x, [route for _, route, _ in chosen], own_snapshot)
        return [leg], own

    def _size_foreign(self, item):
        """One token outside the pool: split it between the pool's tokens (one
        leg each, neither through the position's pool), the fee on top when it
        is charged in that token."""
        token, amount = item
        pool = self.pool
        c0, c1 = pool.currency0, pool.currency1
        sqrt_a, sqrt_b = range_prices(self.tick_lower, self.tick_upper)
        price = self._mint_price()
        need0, need1 = amounts_for_liquidity(price, sqrt_a, sqrt_b, 10**18, True)
        targets = [c for c, need in ((c0, need0), (c1, need1)) if need]
        rows = [fee_rule.LegTokens(token, target, 1) for target in targets]
        fee_token, _ = fee_rule.assisted_swap_fee_token(rows, self.rank)
        spend = _fee_on_top_capacity(amount) if fee_token == token else amount
        if spend == 0:
            raise PlanError('position_plan_amount_too_small')
        # Probe each side with half (or all, for a one-sided range).
        probes = {target: spend // len(targets) for target in targets}
        routes, options = {}, {}
        for target in targets:
            found = self._routes(token, target, max(1, probes[target]))
            pick = self._pick(found, score=lambda r: r.probe_out)
            if pick is None:
                raise PlanError('position_plan_no_route')
            routes[target], options[target] = pick, found
        if len(targets) == 1:
            leg, _ = self._confirm_choice(routes[targets[0]], spend, options[targets[0]])
            return {'inputs': [item], 'legs': [leg], 'withdrawn': None, 'own': None}
        rate0, rate1 = routes[c0].rate, routes[c1].rate

        def outcome(y):
            out0, out1 = int(rate0 * y), int(rate1 * (spend - y))
            final = {c0: out0, c1: out1}
            legs_rows = [fee_rule.LegTokens(token, c0, y), fee_rule.LegTokens(token, c1, spend - y)]
            fee = fee_rule.fee_of(fee_rule.swapped_amount(legs_rows, [out0, out1], fee_token), 65)
            if fee_token in final:
                final[fee_token] -= fee
            l0, l1 = _side_liquidity(price, sqrt_a, sqrt_b, max(final[c0], 0), max(final[c1], 0))
            # Selling more into c0 raises L0: "bought" is the c0 side here.
            return l1, l0, price

        y = self._balance_search(spend, outcome)
        y = min(max(y, 1), spend - 1)
        legs = []
        for target, amount_in in ((c0, y), (c1, spend - y)):
            leg, _ = self._confirm_choice(routes[target], amount_in, options[target])
            legs.append(leg)
        return {'inputs': [item], 'legs': legs, 'withdrawn': None, 'own': None}

    def _withdrawal(self):
        """What removing self.remove pays: expected (principal + fees), the
        principal minima, and the least the zap will hold."""
        position = self.position
        sqrt_a, sqrt_b = range_prices(position.tick_lower, position.tick_upper)
        principal = amounts_for_liquidity(self.state.sqrt_price_x96, sqrt_a, sqrt_b, self.remove, False)
        fees = position.fees_owed
        removal = plan_minimums(action='exit', slippage=self.slippage,
                                currencies=(self.pool.currency0, self.pool.currency1), wrapped=self.weth,
                                wraps=self.wraps, inputs=[], legs=[], ranks=self.rank,
                                ticks=(position.tick_lower, position.tick_upper), pool_sqrt=self.state.sqrt_price_x96,
                                old_ticks=(position.tick_lower, position.tick_upper), remove=self.remove, fees=fees)
        # Within ±s of the pool's price each token pays at least these (rc.2).
        minima = (removal['amount0Removed'], removal['amount1Removed'])
        expected = tuple(p + f for p, f in zip(principal, fees))
        guaranteed = tuple(m + f for m, f in zip(minima, fees))
        return {'principal': principal, 'fees': fees, 'minima': minima, 'expected': expected,
                'guaranteed': guaranteed}

    def _size_change_range(self):
        withdrawal = self._withdrawal()
        c0, c1 = self.pool.currency0, self.pool.currency1
        held = {c0: withdrawal['expected'][0], c1: withdrawal['expected'][1]}
        guaranteed = {c0: withdrawal['guaranteed'][0], c1: withdrawal['guaranteed'][1]}
        legs, own = self._rebalance(held, guaranteed, removed=self.remove)
        return {'inputs': [], 'legs': legs, 'withdrawn': withdrawal, 'own': own}

    def _size_exit(self):
        withdrawal = self._withdrawal()
        receive = self.request['receive']
        if receive['mode'] == 'both':
            return {'inputs': [], 'legs': [], 'withdrawn': withdrawal, 'own': None}
        target = receive['token'].lower()
        c0, c1 = self.pool.currency0, self.pool.currency1
        sources = [(c, g) for c, g in zip((c0, c1), withdrawal['guaranteed']) if c != target and g > 0]
        if not sources:
            raise PlanError('position_plan_nothing_to_convert')
        rows = [fee_rule.LegTokens(c, target, 1) for c, _ in sources]
        fee_token, _ = fee_rule.assisted_swap_fee_token(rows, self.rank)
        legs, own = [], None
        snapshot = self._own_snapshot(self.remove)
        for token, guaranteed in sources:
            amount = _fee_on_top_capacity(guaranteed) if fee_token == token else guaranteed
            if amount == 0:
                continue
            routes = self._routes(token, target, amount, own_snapshot=snapshot)
            route = self._pick(routes, score=lambda r: r.probe_out)
            if route is None:
                raise PlanError('position_plan_no_route')
            leg, outcome = self._confirm_choice(route, amount, routes, snapshot)
            legs.append(leg)
            own = outcome or own
        if not legs:
            raise PlanError('position_plan_nothing_to_convert')
        return {'inputs': [], 'legs': legs, 'withdrawn': withdrawal, 'own': own}

    # ------------------------------------------------------------- assemble
    def _assemble(self, sized):
        legs = sized['legs']
        for leg in legs:
            if leg.router_deadline is not None and leg.router_deadline < self.deadline:
                raise PlanError('position_plan_no_route')
        built = self._built(sized)
        simulation = self._simulation(built)
        for _ in range(MAX_CORRECTIONS):
            # Every leg is quoted alone at the block. The call delivers something else when a router leg was priced
            # by the API off this block, or when two legs cross one pool (the second leg's quote misses the first
            # leg's trade). Then what the simulated call delivered becomes the plan: the legs' outputs, and from
            # them the fee, the minimums, the liquidity and the refunds, simulated again.
            delivered = self._delivered
            if delivered is None and simulation['status'] == 'reverted' and legs:
                # A leg quoted past what it delivers can stop the call on its own minimum. What the legs deliver
                # is then measured by the same call with every minimum at its floor; the answer keeps the real one.
                self._simulation({**built, 'zapPlan': self._floor_plan(sized, built)})
                delivered = self._delivered
            if delivered is None or delivered == [leg.expected_out for leg in legs]:
                break
            for leg, out in zip(legs, delivered):
                leg.expected_out = out
            built = self._built(sized)
            simulation = self._simulation(built)
        if simulation['status'] == 'ok' and self.action != 'exit':
            if int(simulation['result']['liquidity']) < int(built['minimums']['liquidity']):
                self.warnings.append('simulated_liquidity_below_minimum')
        if simulation['status'] == 'reverted':
            self.warnings.append('simulation_reverted')
        identity = self._identity()
        fee_bps, fee_token, place, swapped, fee_amount = built['fee']
        zap_plan, minimums = built['zapPlan'], built['minimums']
        return {
            'schemaVersion': 1, 'source': SOURCE, 'chainId': self.chain.chainId, 'action': self.action,
            'consent': self.consent, 'owner': self.owner, 'zap': self.zap,
            'block': {'number': str(self.block.number), 'hash': self.block.hash, 'timestamp': str(self.block.timestamp)},
            'requestedAt': self.requested, 'retrievedAt': self.requested,
            'expiresAt': self.requested + QUOTE_LIFETIME_SECONDS, 'deadline': str(self.deadline),
            'requestFingerprint': hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':'))
                                                 .encode()).hexdigest(),
            'request': identity,
            'pool': self._pool_view(),
            'initialPrice': self.initial,
            'position': self._position_view(),
            'zapPlan': zap_plan, 'routesHash': built['intent']['routesHash'], 'intentHash': built['intentHash'],
            'call': built['call'], 'signature': built['signature'],
            'legs': [self._leg_view(leg) for leg in legs],
            'fee': {'bps': fee_bps, 'token': fee_token, 'place': place, 'basisRaw': str(swapped),
                    'amountRaw': str(fee_amount), 'ranks': self._leg_ranks(legs)},
            'expected': built['expected'],
            'minimums': {'liquidity': str(minimums['liquidity']), 'slippageBps': self.slippage,
                         'amount0RemovedRaw': zap_plan.get('amount0MinRemoved'),
                         'amount1RemovedRaw': zap_plan.get('amount1MinRemoved'),
                         'mintBand': _band(minimums['mintBand']), 'removalBand': _band(minimums['removalBand'])},
            'routing': {'router': self.router_status or {'status': 'not_needed', 'reason': None},
                        'advantageBps': ROUTER_ADVANTAGE_BPS},
            'readiness': built['readiness'], 'simulation': simulation, 'l1DataFee': built['l1DataFee'],
            'warnings': sorted(set(self.warnings)),
        }

    def _built(self, sized):
        """The plan from its legs' expected outputs: minimums, fee, expectation, intent, consent artifacts, call,
        readiness and L1 data fee."""
        legs = sized['legs']
        for leg in legs:
            leg.min_out = max(1, _bps_floor(leg.expected_out, self.slippage))
        outs = [leg.expected_out for leg in legs]
        fee_bps, fee_token, place, swapped, fee_amount = self._fee(legs, outs)
        wire_legs = [leg.wire() for leg in legs]
        pool_json = {'dex': self.pool.dex, 'currency0': self.pool.currency0, 'currency1': self.pool.currency1,
                     'fee': self.pool.fee, 'tickSpacing': self.pool.tick_spacing, 'hooks': self.pool.hooks}
        expected = self._expected(sized, fee_token, fee_amount)
        minimums = self._minimums(sized, wire_legs, expected)
        min_liquidity = minimums['liquidity']
        if self.action != 'exit' and min_liquidity == 0:
            raise PlanError('position_plan_amount_too_small')
        intent = {'action': codec.ACTIONS[self.action], 'pool': pool_json,
                  'tokenId': str(0 if self.action == 'create' else self.position.position.token_id),
                  'tickLower': self.tick_lower, 'tickUpper': self.tick_upper, 'minLiquidity': str(min_liquidity),
                  'feeBps': fee_bps, 'feeToken': fee_token, 'routesHash': codec.routes_hash(wire_legs),
                  'recipient': self.owner, 'nonce': str(self.nonce), 'deadline': str(self.deadline)}
        zap_plan = self._zap_plan(intent, sized, wire_legs)
        intent_hash = codec.intent_hash(self.chain.chainId, self.zap, intent)
        signature = None
        if self.consent == 'permit2':
            permit = {'permitted': [{'token': i['token'], 'amount': i['amount']} for i in zap_plan['inputs']],
                      'nonce': str(self.nonce), 'deadline': str(self.deadline)}
            signature = {'kind': 'permit2', 'permit': permit,
                         'typedData': codec.permit2_typed_data(self.chain.chainId, self.zap, permit, intent),
                         'digest': codec.permit2_digest(self.chain.chainId, self.zap, permit, intent)}
        elif self.consent == 'relayed':
            relayed = codec.relayed_fields(self.action, zap_plan)
            signature = {'kind': 'relayed', 'permit': None,
                         'typedData': codec.relayed_typed_data(self.chain.chainId, self.zap, relayed),
                         'digest': codec.relayed_digest(self.chain.chainId, self.zap, relayed)}
        fn = codec.zap_function(self.action, self.consent)
        value = codec.direct_value(zap_plan) if self.consent == 'direct' else 0
        call = {'to': self.zap, 'function': fn.name, 'selector': fn.selector, 'valueRaw': str(value),
                'data': codec.call_data(self.action, 'direct', zap_plan) if self.consent == 'direct' else None}
        priced = self._transaction(zap_plan, signature)
        readiness, l1_data_fee = self._readiness(zap_plan, priced)
        return {'fee': (fee_bps, fee_token, place, swapped, fee_amount), 'expected': expected,
                'minimums': minimums, 'intent': intent, 'zapPlan': zap_plan, 'intentHash': intent_hash,
                'signature': signature, 'call': call, 'readiness': readiness, 'l1DataFee': l1_data_fee}

    def _floor_plan(self, sized, built):
        """The plan's call with every minimum the legs set at its floor: each leg's minAmountOut 1 and, when it
        adds, minLiquidity 1. Only simulated, to measure what the legs deliver."""
        wire = [{**leg.wire(), 'minAmountOut': '1'} for leg in sized['legs']]
        intent = {**built['intent'], 'routesHash': codec.routes_hash(wire)}
        if self.action != 'exit':
            intent['minLiquidity'] = '1'
        return self._zap_plan(intent, sized, wire)

    def _simulation(self, built):
        self._delivered = None
        if not self.p.simulate:
            return {'status': 'not_run', 'reason': 'simulation_disabled', 'method': None, 'error': None,
                    'gasUnits': None, 'result': None}
        return self._simulate(built['zapPlan'], built['readiness'])

    def _minimums(self, sized, wire_legs, expected):
        """plan_minimums (v2_position_plan_rules) of this plan: the same function the
        answer's checks run, from the same fields."""
        kwargs = {}
        if self.action in ('changeRange', 'exit'):
            position = self.position
            kwargs = {'pool_sqrt': self.state.sqrt_price_x96, 'old_ticks': (position.tick_lower, position.tick_upper),
                      'remove': self.remove, 'fees': position.fees_owed}
        if self.action != 'exit':
            kwargs['mint_sqrt'] = int(expected['sqrtPriceX96After'])
        inputs = [{'token': token, 'amount': str(amount)} for token, amount in sized['inputs']]
        return plan_minimums(action=self.action, slippage=self.slippage,
                             currencies=(self.pool.currency0, self.pool.currency1), wrapped=self.weth,
                             wraps=self.wraps, inputs=inputs, legs=wire_legs, ranks=self.rank,
                             ticks=(self.tick_lower, self.tick_upper), **kwargs)

    def _transaction(self, zap_plan, signature):
        """(value, call data) of the transaction that carries the plan, with a
        placeholder for a signature not yet made: what the L1 data fee prices."""
        if self.consent == 'direct':
            return codec.direct_value(zap_plan), codec.call_data(self.action, 'direct', zap_plan)
        permit = signature['permit'] if self.consent == 'permit2' else None
        return 0, codec.call_data(self.action, self.consent, zap_plan, permit=permit,
                                  signature=PLACEHOLDER_SIGNATURE)

    def _leg_ranks(self, legs):
        """The registry's rank of every token the legs touch, in order of first
        appearance: what the fee rule read (0 for a token that is no charge currency)."""
        seen = []
        for leg in legs:
            for token in (leg.token_in, leg.token_out):
                if token not in seen:
                    seen.append(token)
        return [{'token': token, 'rank': self.rank(token)} for token in seen]

    def _identity(self):
        request = json.loads(json.dumps(self.request))
        request['slippageBps'] = self.slippage
        return {'owner': self.owner, **request}

    def _zap_plan(self, intent, sized, wire_legs):
        """The IDominoPositionActions plan struct of the action, field for field."""
        if self.action in ('create', 'increase'):
            plan = {'intent': intent, 'inputs': [{'token': t, 'amount': str(a)} for t, a in sized['inputs']],
                    'legs': wire_legs, 'amount0Max': str(U128), 'amount1Max': str(U128)}
            if self.action == 'create':
                plan['initSqrtPriceX96'] = str(self.init_sqrt)
            return plan
        withdrawal = sized['withdrawn']
        plan = {'intent': intent, 'liquidityToRemove': str(self.remove),
                'amount0MinRemoved': str(withdrawal['minima'][0]), 'amount1MinRemoved': str(withdrawal['minima'][1]),
                'legs': wire_legs}
        if self.action == 'changeRange':
            plan.update(amount0Max=str(U128), amount1Max=str(U128), burnOld=bool(self.request['burn']))
        else:
            plan['burn'] = bool(self.request['burn'])
        return plan

    def _expected(self, sized, fee_token, fee_amount):
        """The tokens the zap holds when it adds, the liquidity they buy at the
        price after the legs, and what returns to the owner's wallet."""
        c0, c1 = self.pool.currency0, self.pool.currency1
        held = {}
        for token, amount in sized['inputs']:
            held[token] = held.get(token, 0) + amount
        withdrawal = sized['withdrawn']
        if withdrawal is not None:
            held[c0] = held.get(c0, 0) + withdrawal['expected'][0]
            held[c1] = held.get(c1, 0) + withdrawal['expected'][1]
        for leg in sized['legs']:
            held[leg.token_in] = held.get(leg.token_in, 0) - leg.amount_in
            held[leg.token_out] = held.get(leg.token_out, 0) + leg.expected_out
        if fee_amount:
            held[fee_token] = held.get(fee_token, 0) - fee_amount
        if any(amount < 0 for amount in held.values()):
            raise PlanError('position_plan_fee_not_backed')
        if self.wraps and self.action != 'exit' and ZERO in held:
            # Wrapped before the addition; what the mint leaves returns as WETH.
            held[self.weth] = held.get(self.weth, 0) + held.pop(ZERO)
        out = {'liquidity': '0', 'amount0Raw': '0', 'amount1Raw': '0', 'sqrtPriceX96After': None,
               'principal0Raw': None, 'principal1Raw': None, 'fees0Raw': None, 'fees1Raw': None}
        if withdrawal is not None:
            out.update(principal0Raw=str(withdrawal['principal'][0]), principal1Raw=str(withdrawal['principal'][1]),
                       fees0Raw=str(withdrawal['fees'][0]), fees1Raw=str(withdrawal['fees'][1]))
        if self.action != 'exit':
            own = sized['own']
            price = own.sqrt_price if own is not None else self._mint_price()
            sqrt_a, sqrt_b = range_prices(self.tick_lower, self.tick_upper)
            l0, l1 = _side_liquidity(price, sqrt_a, sqrt_b, held.get(c0, 0), held.get(c1, 0))
            liquidity = min(l0, l1)
            if liquidity >= INFINITE or liquidity == 0:
                raise PlanError('position_plan_amount_too_small')
            used0, used1 = amounts_for_liquidity(price, sqrt_a, sqrt_b, liquidity, True)
            held[c0] = held.get(c0, 0) - used0
            held[c1] = held.get(c1, 0) - used1
            if self.action == 'increase' and self.pool.dex == DEX_V4:
                # A v4 increase credits the position's accrued fees, those the
                # plan's own swap pays it included; the zap refunds them with the
                # rest (F7 §2.6.2). v3 keeps them owed on the NFT.
                position, fees = self.position, self.position.fees_owed
                if own is not None and own.fee_growth_in_range:
                    inside = list(position.fee_growth_inside)
                    side = 0 if own.zero_for_one else 1
                    inside[side] = (inside[side] + own.fee_growth_in_range) % (1 << 256)
                    fees = tuple(v4_fees_owed(now, last, position.liquidity)
                                 for now, last in zip(inside, position.fee_growth_inside_last))
                for token, amount in zip((c0, c1), fees):
                    held[token] = held.get(token, 0) + amount
            out.update(liquidity=str(liquidity), amount0Raw=str(used0), amount1Raw=str(used1),
                       sqrtPriceX96After=str(price))
        elif sized['own'] is not None:
            out['sqrtPriceX96After'] = str(sized['own'].sqrt_price)
        out['returned'] = [{'token': token, 'amountRaw': str(amount)} for token, amount in sorted(held.items())
                           if amount > 0]
        return out

    def _pool_view(self):
        pool = self.pool
        identity = (pool.pool_id if pool.dex == DEX_V4
                    else v3_pool_address(self.chain, pool.currency0, pool.currency1, pool.fee))
        view = {'dex': pool.dex, 'currency0': pool.currency0, 'currency1': pool.currency1, 'fee': pool.fee,
                'tickSpacing': pool.tick_spacing, 'hooks': pool.hooks, 'id': identity,
                'initialized': self.state is not None, 'sqrtPriceX96': None, 'tick': None, 'liquidity': None,
                'swapFeePips': None}
        if self.state is not None:
            view.update(sqrtPriceX96=str(self.state.sqrt_price_x96), tick=self.state.tick,
                        liquidity=str(self.state.liquidity),
                        swapFeePips={'zeroForOne': self.state.swap_fee_pips(True),
                                     'oneForZero': self.state.swap_fee_pips(False)})
        return view

    def _position_view(self):
        if self.position is None:
            return None
        p = self.position
        return {'tokenId': str(p.position.token_id), 'manager': p.position.position_manager,
                'tickLower': p.tick_lower, 'tickUpper': p.tick_upper, 'liquidity': str(p.liquidity),
                'liquidityToRemove': None if self.action == 'increase' else str(self.remove),
                'feesOwed0Raw': str(p.fees_owed[0]), 'feesOwed1Raw': str(p.fees_owed[1]), 'inRange': p.in_range,
                'approved': p.approved, 'subscriber': p.subscriber}

    def _leg_view(self, leg):
        return {'kind': {1: 'universal_router', 2: 'v3_pool', 3: 'v4_pool'}[leg.kind], 'tokenIn': leg.token_in,
                'tokenOut': leg.token_out, 'amountInRaw': str(leg.amount_in), 'expectedOutRaw': str(leg.expected_out),
                'minAmountOutRaw': str(leg.min_out), 'source': leg.source, 'pools': leg.pools,
                'priceImpactPercent': leg.price_impact}

    # ----------------------------------------------------------- readiness
    def _readiness(self, zap_plan, priced):
        """What the owner's wallet must do before the action, read at the block,
        and the transaction's L1 data fee (v2_l1_fee): on OP Stack inside the same
        Multicall3 read, on Nitro one eth_call of its own."""
        reads = ReadPlan()
        value, data = priced
        transaction = l1_fee.unsigned_transaction(self.chain.chainId, self.zap, value, data)
        l1_slots = l1_fee.op_reads(reads, transaction) if self.chain.stack == 'op-stack' else None
        rows = []
        spender = self.chain.permit2 if self.consent == 'permit2' else self.zap
        for item in zap_plan.get('inputs', ()):
            token, amount = item['token'], int(item['amount'])
            if token == ZERO:
                rows.append((token, amount, reads.add(self.chain.multicall3, GET_ETH_BALANCE, self.owner), None))
            else:
                rows.append((token, amount, reads.add(token, ERC20_BALANCE_OF, self.owner),
                             reads.add(token, ERC20_ALLOWANCE, self.owner, spender)))
        nft = None
        if self.action in ('changeRange', 'exit') or (self.action == 'increase' and self.dex == DEX_V4):
            interface = 'IV4PositionManagerMinimal' if self.dex == DEX_V4 else 'IUniswapV3PositionManagerMinimal'
            manager, token_id = self.position.position.position_manager, self.position.position.token_id
            nft = (manager, token_id, reads.add(manager, function(interface, 'getApproved'), token_id),
                   reads.add(manager, function(interface, 'isApprovedForAll'), self.owner, self.zap))
        # A rebuild from what the simulated call delivered (MAX_CORRECTIONS) asks the same balances and approvals at
        # the same block: their answer is in hand (3 Nov 2026). On OP Stack the L1 fee rides in the same read and
        # moves with the call data, so that read is asked again.
        key = tuple(reads.calls)
        answers = self._readiness_reads.get(key)
        if answers is None:
            answers = self._readiness_reads[key] = reads.run(self.rpc, self.chain, self.block)
        if l1_slots is not None:
            l1_data_fee = l1_fee.op_result(self.chain, self.block, answers, l1_slots, transaction)
        else:
            client = PlanRpc(self.p.endpoints, anchor=self.block, max_requests=2)
            l1_data_fee = l1_fee.nitro_estimate(self.chain, client, self.block, self.zap, data)
        balances, approvals, steps = [], [], []
        for token, amount, balance_slot, allowance_slot in rows:
            held = answers[balance_slot][0] if answers[balance_slot] is not None else None
            balances.append({'token': token, 'requiredRaw': str(amount), 'heldRaw': None if held is None else str(held),
                             'sufficient': None if held is None else held >= amount})
            if allowance_slot is None:
                continue
            allowance = answers[allowance_slot][0] if answers[allowance_slot] is not None else None
            sufficient = None if allowance is None else allowance >= amount
            approvals.append({'token': token, 'spender': spender,
                              'spenderKind': 'permit2' if self.consent == 'permit2' else 'zap',
                              'allowanceRaw': None if allowance is None else str(allowance),
                              'requiredRaw': str(amount), 'sufficient': sufficient})
            if not sufficient:
                steps.append({'kind': 'approve_token', 'to': token, 'valueRaw': '0',
                              'data': approve_data(spender, amount)})
        position_approval = None
        if nft is not None:
            manager, token_id, approved_slot, operator_slot = nft
            approved = answers[approved_slot][0].lower() if answers[approved_slot] is not None else None
            operator = bool(answers[operator_slot][0]) if answers[operator_slot] is not None else None
            ok = None if approved is None or operator is None else (approved == self.zap or operator)
            position_approval = {'manager': manager, 'tokenId': str(token_id), 'approved': approved,
                                 'approvedForAll': operator, 'sufficient': ok}
            if not ok:
                steps.append({'kind': 'approve_position', 'to': manager, 'valueRaw': '0',
                              'data': approve_data(self.zap, token_id)})
        if self.consent in ('permit2', 'relayed'):
            steps.append({'kind': 'sign_' + self.consent, 'to': None, 'valueRaw': '0', 'data': None})
        # The action itself is `call` (its data, or the signed variant the app encodes).
        value = codec.direct_value(zap_plan) if self.consent == 'direct' else 0
        steps.append({'kind': 'send_action', 'to': self.zap, 'valueRaw': str(value), 'data': None})
        consents = (['direct', 'permit2'] if self.action in ('create', 'increase') else ['direct', 'relayed'])
        if self.account != 'eoa' or any(item['token'] == ZERO for item in zap_plan.get('inputs', ())):
            consents = ['direct']
        return {'account': {'kind': self.account, 'delegate': self.delegate, 'consents': consents},
                'balances': balances, 'approvals': approvals, 'positionApproval': position_approval,
                'nonce': None if self.nonce_word is None else {
                    'kind': self.consent, 'word': str(self.nonce_word), 'bit': self.nonce & 0xff,
                    'nonce': str(self.nonce)},
                'steps': steps}, l1_data_fee

    # ----------------------------------------------------------- simulation
    def _simulate(self, zap_plan, readiness):
        """The direct zap call from the owner at the block. With eth_simulateV1
        each ERC-20 input is first approved to the zap and the NFT approved when
        it is not, as the direct path's own steps would; the Permit2 and
        relayed paths move the same tokens through the same steps, so the
        direct call stands for them. Without eth_simulateV1 the call runs
        alone (eth_call) when nothing is missing."""
        pre = [{'from': self.owner, 'to': item['token'], 'gas': hex(200_000),
                'data': approve_data(self.zap, int(item['amount']))}
               for item in zap_plan.get('inputs', ()) if item['token'] != ZERO]
        approval = readiness['positionApproval']
        if approval is not None and not approval['sufficient']:
            pre.append({'from': self.owner, 'to': approval['manager'], 'gas': hex(200_000),
                        'data': approve_data(self.zap, int(approval['tokenId']))})
        action = {'from': self.owner, 'to': self.zap, 'data': codec.call_data(self.action, 'direct', zap_plan),
                  'value': hex(codec.direct_value(zap_plan)), 'gas': hex(SIMULATION_GAS)}
        request = {'blockStateCalls': [{'blockOverrides': {'time': hex(self.block.timestamp + 1)},
                                        'calls': pre + [action]}], 'validation': False}
        # Its own client: a provider without eth_simulateV1 answers with an error,
        # which ends the client it reached (rpc_failover), not the plan's reads.
        simulator = PlanRpc(self.p.endpoints, anchor=self.block, max_requests=4)
        try:
            blocks = simulator.request('eth_simulateV1', [request, self.block.tag])
            results = blocks[0]['calls']
            if len(results) != len(pre) + 1:
                raise PlanError('upstream_invalid_response')
            if any(call.get('status') != '0x1' for call in results[:-1]):
                return self._simulated('reverted', 'eth_simulateV1', None, None, 'approval_reverted')
            last = results[-1]
            if last.get('status') == '0x1':
                self._delivered = self._leg_outputs(last.get('logs'), zap_plan)
                return self._simulated('ok', 'eth_simulateV1', last.get('returnData'), last.get('gasUsed'), None)
            data = last.get('returnData') or (last.get('error') or {}).get('data')
            return self._simulated('reverted', 'eth_simulateV1', data, last.get('gasUsed'), None)
        except DataError as error:
            # A node without eth_simulateV1 answers with a JSON-RPC error.
            if str(error) not in ('rpc_error', 'rpc_call_reverted', 'method_not_read_only'):
                raise
        except (KeyError, IndexError, TypeError, AttributeError):
            raise PlanError('upstream_invalid_response') from None
        missing = (any(not a['sufficient'] for a in readiness['approvals'])
                   or (approval is not None and not approval['sufficient'])
                   or (self.consent != 'direct' and pre))
        if missing:
            return {'status': 'not_run', 'reason': 'approvals_missing', 'method': None, 'error': None,
                    'gasUnits': None, 'result': None}
        call = {key: action[key] for key in ('from', 'to', 'data', 'value', 'gas')}
        try:
            raw = self.rpc.request('eth_call', [call, self.block.tag])
        except DataError as error:
            if str(error) != 'rpc_call_reverted':
                raise
            return {'status': 'reverted', 'reason': None, 'method': 'eth_call',
                    'error': {'selector': None, 'name': None}, 'gasUnits': None, 'result': None}
        return self._simulated('ok', 'eth_call', raw, None, None)

    def _leg_outputs(self, logs, zap_plan):
        """What each leg delivered in the simulated call: the zap's SwapLegExecuted lines, in the legs' order,
        each matching its leg's tokens and input. None when they do not match one for one; then the plan keeps
        its quotes."""
        legs = zap_plan['legs']
        if not isinstance(logs, list):
            return None
        found = []
        try:
            for log in logs:
                topics = log.get('topics') or []
                if address(log.get('address')) != self.zap or not topics or topics[0].lower() != SWAP_LEG_TOPIC:
                    continue
                if len(topics) != 4:
                    return None
                _, amount_in, amount_out = decode(['address', 'uint256', 'uint256'], bytes.fromhex(log['data'][2:]))
                found.append((address('0x' + topics[2][-40:]), address('0x' + topics[3][-40:]), amount_in, amount_out))
        except (DataError, KeyError, TypeError, ValueError, AttributeError):
            return None
        if len(found) != len(legs) or any(
                (token_in, token_out, str(amount_in)) != (leg['tokenIn'], leg['tokenOut'], leg['amountIn'])
                for (token_in, token_out, amount_in, _), leg in zip(found, legs)):
            return None
        return [amount_out for *_, amount_out in found]

    def _simulated(self, status, method, data, gas, reason):
        out = {'status': status, 'reason': reason, 'method': method, 'error': None,
               'gasUnits': None if gas is None else str(int(gas, 16)), 'result': None}
        if status == 'ok':
            try:
                out['result'] = codec.decode_action_result(bytes.fromhex(data[2:]))
            except Exception:
                raise PlanError('upstream_invalid_response') from None
        elif status == 'reverted' and reason is None:
            out['error'] = decode_revert(data)
        return out


def approve_data(spender, amount):
    """approve(address,uint256): an ERC-20 allowance or an NFT's approval."""
    return codec.selector('approve(address,uint256)') + encode(['address', 'uint256'], [spender, amount]).hex()


def _router_pool(hop):
    """A pool of a router route, as the API quoted it (v3 hops carry no spacing or hooks)."""
    currency0, currency1 = sorted((hop['tokenIn'], hop['tokenOut']))
    return {'dex': hop['dex'], 'currency0': currency0, 'currency1': currency1, 'fee': hop['fee'],
            'tickSpacing': hop['tickSpacing'], 'hooks': hop['hooks'], 'id': hop['id']}
