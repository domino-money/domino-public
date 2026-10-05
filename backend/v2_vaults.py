"""What the V2 automation reads about vaults, pools and prices, at a pinned block.

Every read goes through a chain-verified client (v2_rpc) at a block the
chain's head follower pinned (v2_head), with the frozen ABI exports (v2_abi)
and the deployment manifest's addresses (v2_manifest):

- discovery: the factories' VaultCreated logs, from each factory's deployment
  block; an event only proposes a vault, which is then proven at the head:
  the factory's isVault, the EIP-1167 clone of the manifest's implementation
  for its DEX, and the implementation's wiring equal to the manifest's;
- a vault's state for the planner (v2_planner.VaultState): owner, pool, root,
  members, lots, policy, limits, pause, the root's live arming, the state
  nonce, the last execution, the registry's halt, and each member's position
  as its manager reports it (v2_uniswap). A root its owner burned no longer
  exists; it reads as a closed root (no liquidity, nothing owed), so a closed
  vault's reserves can still go back to the owner (returnReserves);
- a closed vault's reserves (reserves(token) of both pool tokens);
- the anchor the vault will use: on v4 the spot a publisher signs at this
  block (v2_observation), on v3 the pool's TWAP through the price anchor
  itself (twapSqrtPrice, the same arithmetic the vault's anchor() runs);
- the owner gate's evidence: fee growth inside a member's range at the head
  and at an earlier block, the pool's time-weighted fee rate;
- native prices of the pool tokens, USD-free: reference pools between a
  token and the chain's wrapped native token, read at the head.
"""
from dataclasses import dataclass
from fractions import Fraction
import re

from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import ZERO, Block, DataError, address, parse_block, prefetched
from v2_abi import event, function
from v2_chains import DEX_V3, DEX_V4
from v2_planner import Limits, MemberState, Policy, PoolState as PlannerPool, VaultState
from v2_rpc import batched_reads
from v2_scan_state import valid_address
from v2_uniswap import PoolRef, PositionRef, v3_fee_growth_inside, v3_pool_address

VAULT = 'IDominoVault'
LEDGER = 'IDominoVaultLedger'
FACTORY = 'IDominoVaultFactory'
REGISTRY = 'IDominoRegistry'
ANCHOR = 'IDominoPriceAnchor'
V3_POOL = 'IUniswapV3PoolMinimal'
V4_STATE = 'IV4StateViewMinimal'
# DominoV2VaultBase.wiring(): the implementation's Deployment, not a frozen surface.
WIRING_SELECTOR = '0x' + keccak(b'wiring()')[:4].hex()
WIRING_TYPES = ['(address,address,address,address,address,address)']
MAX_MEMBERS = 64
# How a position that no longer exists answers: no position info on v4
# (v2_uniswap), a reverted positions() on v3 (the manager's "Invalid token ID").
GONE = frozenset({'v2_position_not_found', 'rpc_call_reverted'})


def clone_code(implementation):
    """The 45-byte EIP-1167 runtime DominoV2VaultFactory deploys for an implementation."""
    return ('0x363d3d373d3d3d363d73' + address(implementation)[2:] + '5af43d82803e903d91602b57fd5bf3')


def calls(rpc, block, items):
    """Decoded results of view calls at `block`, batched as the client admits."""
    gas = hex(rpc.call_gas_limit)
    specs = [('eth_call', [{'to': target, 'data': fn.calldata(*args), 'gas': gas}, block.tag])
             for target, fn, args in items]
    return [fn.decode(prefetched(raw)) for (_, fn, _), raw in zip(items, batched_reads(rpc, specs))]


def pool_ref(raw):
    dex, currency0, currency1, fee, spacing, hooks = raw
    return PoolRef(dex, currency0, currency1, fee, spacing, hooks)


@dataclass(frozen=True)
class VaultRecord:
    """A vault a factory created, as its event proposed it."""
    vault: str
    owner: str
    root_token_id: int
    dex: int
    block_number: int


class VaultDiscovery:
    """VaultCreated logs of both factories, read once from each factory's deployment block and then incrementally.

    Each window read moves the scan on at once, so a pass that stops on its request budget keeps what it read.
    With a `state` (v2_scan_state.ScanState) the position and the vaults found outlive the process."""

    def __init__(self, deployment, *, max_blocks_per_read=50_000, state=None):
        self.deployment, self.max_blocks, self.state = deployment, max_blocks_per_read, state
        self.next_block = {dex: deployment.start_block(f'vaultFactory.v{dex}') for dex in (DEX_V3, DEX_V4)}
        self.records = {}
        for dex in (DEX_V3, DEX_V4):
            saved = state.get(f'vaultFactory.v{dex}') if state is not None else None
            if saved is None:
                continue
            self.next_block[dex] = max(self.next_block[dex], saved['next'])
            for vault, row in saved['items'].items():
                if (valid_address(vault) and isinstance(row, list) and len(row) == 3 and valid_address(row[0])
                        and all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in row[1:])):
                    self.records.setdefault(vault, VaultRecord(vault, row[0], row[1], dex, row[2]))

    def scan(self, rpc, head, *, lag_blocks=0):
        """Every vault proposed up to the head (less lag_blocks), through an index client (v2_rpc.ChainIndexRpc)."""
        created = event(FACTORY, 'VaultCreated')
        end = head.number - lag_blocks
        try:
            for dex in (DEX_V3, DEX_V4):
                factory = self.deployment.factory(dex)
                while self.next_block[dex] <= end:
                    start = self.next_block[dex]
                    stop = min(end, start + self.max_blocks - 1)
                    logs = rpc.request('eth_getLogs', [{'address': factory, 'topics': [created.topic],
                                                             'fromBlock': hex(start), 'toBlock': hex(stop)}])
                    found = {}
                    for log in logs:
                        if address(log['address']) != factory:
                            raise DataError('v2_log_address_mismatch')
                        values = created.decode(log)
                        vault = address(values['vault'])
                        if values['dex'] == dex and vault not in self.records:
                            found[vault] = VaultRecord(vault, address(values['owner']), values['rootTokenId'], dex,
                                                       int(log['blockNumber'], 16))
                    # The window counts only once all its logs were accepted.
                    for vault, record in found.items():
                        self.records.setdefault(vault, record)
                    self.next_block[dex] = stop + 1
        finally:
            self._keep(end)
        return [self.records[vault] for vault in sorted(self.records, key=lambda v: (self.records[v].block_number, v))]

    def _keep(self, end):
        if self.state is None:
            return
        for dex in (DEX_V3, DEX_V4):
            items = {r.vault: [r.owner, r.root_token_id, r.block_number] for r in self.records.values() if r.dex == dex}
            self.state.put(f'vaultFactory.v{dex}', self.next_block[dex], end, items)
        self.state.save()


class VaultReader:
    """One vault's state at a pinned block, for the planner."""

    def __init__(self, chain, deployment, rpc, uniswap, *, proven=None):
        self.chain, self.deployment, self.rpc, self.uniswap = chain, deployment, rpc, uniswap
        self._proven = set() if proven is None else proven

    def prove(self, vault, dex, block):
        """The vault is a clone of the manifest's implementation, its factory's,
        wired exactly as the manifest says. Proven once per process."""
        vault = address(vault)
        if (vault, dex) in self._proven:
            return
        implementation = self.deployment.address(f'vault.v{dex}')
        code = self.rpc.request('eth_getCode', [vault, block.tag])
        if type(code) is not str or code.lower() != clone_code(implementation):
            raise DataError('v2_vault_not_a_clone')
        (is_vault,), = calls(self.rpc, block, [(self.deployment.factory(dex), function(FACTORY, 'isVault'), (vault,))])
        raw = self.rpc.request('eth_call', [{'to': vault, 'data': WIRING_SELECTOR, 'gas': hex(self.rpc.call_gas_limit)},
                                            block.tag])
        try:
            wiring = tuple(address(a) for a in decode(WIRING_TYPES, bytes.fromhex(raw[2:]))[0])
        except Exception:
            raise DataError('v2_vault_wiring_mismatch') from None
        expected = (self.deployment.factory(dex), self.deployment.registry, self.deployment.price_anchor,
                    {DEX_V3: self.chain.uniswap.v3.positionManager, DEX_V4: self.chain.uniswap.v4.positionManager}[dex],
                    self.deployment.address('vaultSwap'), self.deployment.auto_exit)
        if not is_vault or wiring != expected:
            raise DataError('v2_vault_wiring_mismatch')
        self._proven.add((vault, dex))

    def read(self, record, block):
        """The planner's VaultState of a discovered vault at `block`."""
        self.prove(record.vault, record.dex, block)
        v = record.vault
        names = ('owner', 'pool', 'root', 'positions', 'policy', 'limits', 'paused', 'rootArmed', 'stateNonce')
        items = [(v, function(VAULT, name), ()) for name in names]
        items += [(v, function(LEDGER, 'lastExecutionAt'), ()), (v, function(LEDGER, 'quoteCurrency'), ()),
                  (self.deployment.registry, function(REGISTRY, 'automationHalted'), ())]
        (owner,), (pool,), (root,), (members,), (policy,), (limits,), (paused,), (armed,), (nonce,), (last,), \
            (quote,), (halted,) = calls(self.rpc, block, items)
        pool = pool_ref(pool)
        if address(quote) not in (pool.currency0, pool.currency1):
            raise DataError('v2_vault_state_invalid')
        if root[0] != record.dex or pool.dex != record.dex or len(members) > MAX_MEMBERS:
            raise DataError('v2_vault_state_invalid')
        ledger = []
        for token_id in members:
            ledger += [(v, function(LEDGER, 'member'), (token_id,)),
                       (v, function(LEDGER, 'lot'), (token_id, pool.currency0)),
                       (v, function(LEDGER, 'lot'), (token_id, pool.currency1))]
        rows = calls(self.rpc, block, ledger) if ledger else []
        manager = {DEX_V3: self.chain.uniswap.v3.positionManager, DEX_V4: self.chain.uniswap.v4.positionManager}[
            record.dex]
        states, pool_state = [], None
        for index, token_id in enumerate(members):
            (member,), (lot0,), (lot1,) = rows[3 * index: 3 * index + 3]
            active, parent, successor, lower, upper = member
            if not active:
                continue
            lots = ((lot0[0], lot0[1]), (lot1[0], lot1[1]))
            try:
                position = self.uniswap.position(PositionRef(record.dex, manager, token_id), block)
            except DataError as error:
                # Only the root can be gone while the vault lists it: the owner
                # burned it. It is closed; the contract confirms it before any
                # return (IDominoVaultLedger.returnReserves). Anything else refuses.
                if token_id != root[2] or str(error) not in GONE:
                    raise
                states.append(MemberState(token_id, lower, upper, 0, (0, 0), lots, parent, successor))
                continue
            if position.pool.pool != pool or (position.tick_lower, position.tick_upper) != (lower, upper):
                raise DataError('v2_vault_member_mismatch')
            pool_state = position.pool
            states.append(MemberState(token_id, lower, upper, position.liquidity, tuple(position.fees_owed), lots,
                                      parent, successor))
        if pool_state is None:
            pool_state = self.uniswap.pool(pool, block)
        planner_pool = PlannerPool(pool, pool_state.sqrt_price_x96, pool_state.liquidity,
                                   (pool_state.swap_fee_pips(True), pool_state.swap_fee_pips(False)))
        return VaultState(
            chain_id=self.chain.chainId, vault=v, owner=address(owner), root_token_id=root[2], members=tuple(states),
            policy=Policy(*policy), limits=Limits(*limits), pool=planner_pool, state_nonce=nonce,
            last_execution_at=last, paused=paused, root_armed=armed, halted=halted, swap_available=True,
            block_number=block.number, block_timestamp=block.timestamp, inverse=address(quote) == pool.currency0)

    def reserves(self, vault, block):
        """reserves(token) of both pool tokens (IDominoVault): idle plus every
        member's lots, everything returnReserves would pay the owner."""
        pool = vault.pool.pool
        (amount0,), (amount1,) = calls(self.rpc, block, [(vault.vault, function(VAULT, 'reserves'), (pool.currency0,)),
                                                         (vault.vault, function(VAULT, 'reserves'), (pool.currency1,))])
        return amount0, amount1


# ------------------------------------------------------------------ anchor
def twap_window(limits, anchor_min_twap, preferred):
    """The v3 TWAP window a vault's anchor() accepts: in [minTwapSeconds,
    maxObservationAgeSeconds], as long as the preferred window allows."""
    window = min(preferred, limits.max_observation_age_seconds)
    if window < anchor_min_twap:
        raise DataError('v2_twap_window_unavailable')
    return window


def twap_price(rpc, deployment, pool, window, block):
    """The anchor's own TWAP reading for `pool` (twapSqrtPrice), at `block`."""
    (price,), = calls(rpc, block, [(deployment.price_anchor, function(ANCHOR, 'twapSqrtPrice'),
                                    ((pool.dex, pool.currency0, pool.currency1, pool.fee, pool.tick_spacing,
                                      pool.hooks), window))])
    return price


def anchor_min_twap(rpc, deployment, block):
    raw = rpc.request('eth_call', [{'to': deployment.price_anchor, 'data': '0x' + keccak(b'minTwapSeconds()')[:4].hex(),
                                    'gas': hex(rpc.call_gas_limit)}, block.tag])
    return decode(['uint32'], bytes.fromhex(raw[2:]))[0]


# ---------------------------------------------------------------- earnings
def fee_growth_inside(chain, rpc, pool, tick_lower, tick_upper, block):
    """Fee growth inside a range per unit of liquidity (Q128), per token, at `block`."""
    if pool.dex == DEX_V4:
        (growth0, growth1), = calls(rpc, block, [(chain.uniswap.v4.stateView, function(V4_STATE, 'getFeeGrowthInside'),
                                                  (bytes.fromhex(pool.pool_id[2:]), tick_lower, tick_upper))])
        return growth0, growth1
    target = v3_pool_address(chain, pool.currency0, pool.currency1, pool.fee)
    slot0, (global0,), (global1,), lower, upper = calls(rpc, block, [
        (target, function(V3_POOL, 'slot0'), ()), (target, function(V3_POOL, 'feeGrowthGlobal0X128'), ()),
        (target, function(V3_POOL, 'feeGrowthGlobal1X128'), ()), (target, function(V3_POOL, 'ticks'), (tick_lower,)),
        (target, function(V3_POOL, 'ticks'), (tick_upper,))])
    tick = slot0[1]
    return (v3_fee_growth_inside(tick, tick_lower, tick_upper, global0, lower[2], upper[2]),
            v3_fee_growth_inside(tick, tick_lower, tick_upper, global1, lower[3], upper[3]))


def earlier_block(history_rpc, head, seconds, block_time):
    """The block about `seconds` before the head, pinned by its header."""
    count = max(1, int(Fraction(seconds) / block_time))
    if count > head.number:
        raise DataError('v2_earnings_history_unavailable')
    block = parse_block(history_rpc.request('eth_getBlockByNumber', [hex(head.number - count), False]))
    if block.number != head.number - count or block.timestamp >= head.timestamp:
        raise DataError('block_unavailable')
    return block


# ------------------------------------------------------------------ prices
@dataclass(frozen=True)
class PriceReference:
    """A pool between `token` and the chain's native or wrapped native token."""
    token: str
    pool: PoolRef


def reference_prices(chain, uniswap, references, block):
    """Native wei per raw unit of each referenced token, from its pool's spot."""
    wrapped = chain.wrappedNative.address
    prices = {ZERO: Fraction(1), wrapped: Fraction(1)}
    for reference in references:
        pool = reference.pool
        token = address(reference.token)
        other = pool.currency1 if pool.currency0 == token else pool.currency0
        if token not in (pool.currency0, pool.currency1) or other not in (ZERO, wrapped):
            raise DataError('v2_price_reference_invalid')
        price = uniswap.pool(pool, block).sqrt_price_x96
        ratio = Fraction(price * price, 1 << 192)  # token1 per token0
        prices[token] = ratio if token == pool.currency0 else 1 / ratio
    return prices


def checked_references(chain, entries):
    """Price references from configuration: [{"token": ..., "pool": {PoolRef fields}}]."""
    result = []
    for entry in entries:
        if type(entry) is not dict or set(entry) != {'token', 'pool'} or type(entry['pool']) is not dict:
            raise DataError('v2_price_reference_invalid')
        p = entry['pool']
        if set(p) != {'dex', 'currency0', 'currency1', 'fee', 'tickSpacing', 'hooks'}:
            raise DataError('v2_price_reference_invalid')
        if not isinstance(entry['token'], str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', entry['token']):
            raise DataError('v2_price_reference_invalid')
        result.append(PriceReference(address(entry['token']),
                                     PoolRef(p['dex'], p['currency0'], p['currency1'], p['fee'], p['tickSpacing'],
                                             p['hooks'])))
    return tuple(result)


# --------------------------------------------------------------- L1 data fee
OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f'
# GasPriceOracle.getL1FeeUpperBound(uint256 unsignedTxSize) (OP Stack, Fjord and later).
L1_UPPER_BOUND = '0x' + keccak(b'getL1FeeUpperBound(uint256)')[:4].hex()
# An EIP-1559 envelope's fields around the calldata, signed: a generous bound.
TX_OVERHEAD_BYTES = 200


def l1_fee(chain, rpc, calldata_bytes, block):
    """The L1 data fee an OP Stack chain charges apart from gas, as an upper
    bound for the transaction's size; Nitro chains fold it into gas units,
    which eth_estimateGas already reports (0 here)."""
    if chain.stack != 'op-stack':
        return 0
    raw = rpc.request('eth_call', [{'to': OP_GAS_PRICE_ORACLE,
                                    'data': L1_UPPER_BOUND + encode(['uint256'], [calldata_bytes + TX_OVERHEAD_BYTES]).hex(),
                                    'gas': hex(rpc.call_gas_limit)}, block.tag])
    return decode(['uint256'], bytes.fromhex(raw[2:]))[0]


def head_block(head):
    if not isinstance(head.block, Block):
        raise DataError('block_unavailable')
    return head.block
