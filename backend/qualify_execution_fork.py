"""Measure the compound sandwich on a forked Robinhood pool (review D-01, D-02).

Forks Robinhood Chain (4663) at a finalized block, deploys the V4 stack from the
built artifacts, gives a synthetic owner a root position in a real pool through
DominoSetup, earns it fees with round-trip swaps, and then runs one compound per
scenario from one common snapshot:

  honest            observation at the true spot, compound, nobody interferes;
  pre-observation   the attacker moves spot by X, an honest publisher reads the
                    moved pool, the operator compounds at it, the attacker
                    restores - the residual no on-chain band can see;
  post-observation  observation at the true spot, then the attacker moves spot
                    by X before the compound - what the anchor refuses, and
                    what it lets through inside maxPriceImpactBps;
  ceiling           post-observation inside the impact limit, with the plan's
                    maxAdded set to the honest amounts - what D-02 refuses.

Every figure in the output is read from the fork; nothing is estimated. The
attacker's cost is real pool depth and real fees. Balances, impersonation and
snapshots are experiment controls on the child only. Never a production path.

The fork's upstream is either the read gateway over the configured historical
source, or a loopback JSON-RPC port (an SSH-forwarded self-hosted node), so no
provider credential ever enters this process or its output.
"""
import argparse
import json
import math
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deposit_fork import DepositFork
from discovery import CHAIN_ID, POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, ZERO, DataError
from fork_read_gateway import ForkReadGateway
from local_config import load_config
from rpc_config import DEFAULT_RPC_HOSTS, configured_history_rpc_source
import execution_models as m
import execution_v4 as v
import general_compound_receipts as g
from qualify_deposit_fork import POOLS, WETH

ROOT = Path(__file__).resolve().parents[1]
Q96 = 2**96
KEY_TYPE = '(address,address,uint24,int24,address)'
POLICY_TYPE = '(uint16,uint16,uint16,uint32,uint8,uint64,bool)'
LIMITS_TYPE = '(uint64,uint32,uint16,uint16,uint128,uint32,uint32)'
INIT_TYPE = '(uint256,bytes32,address,address,address,bool,' + POLICY_TYPE + ',' + LIMITS_TYPE + ')'
MINT_TYPE = '(bytes32,int24,int24,uint128,uint128,uint128,uint160,uint160,uint160,uint64)'
OBSERVATION_TYPE = '(bytes32,uint64,bytes32,uint64,uint64,uint160)'

# Synthetic experiment accounts, impersonated on the child only.
DEPLOYER = '0x00000000000000000000000000000000000d0d0d'
OWNER = '0x000000000000000000000000000000000000dead'
OPERATOR = '0x0000000000000000000000000000000000000b0b'
PUBLISHER = '0x000000000000000000000000000000000000f00d'
ATTACKER = '0x000000000000000000000000000000000000bad0'
RECIPIENT = '0x0000000000000000000000000000000000000fee'

# The vault's own limits: 1% price impact against the anchor, 200 bps service fee.
MAX_PRICE_IMPACT_BPS = 100
SERVICE_FEE_BPS = 200
GUARD_BAND_BPS = 2000

ERRORS = {keccak(name.encode())[:4].hex(): name for name in (
    'InvalidPrice()', 'InvalidAmount()', 'InvalidExecution()', 'InvalidObservation()',
    'InsufficientReserve()', 'InvalidRoute()', 'PermissionUnavailable()', 'UnexpectedCallback()',
    'InvalidPosition()', 'InvalidSetup()', 'Unauthorized()')}


def calldata(signature, types=(), values=()):
    return '0x' + (keccak(signature.encode())[:4] + encode(types, values)).hex()


def sqrt_at_tick(tick):
    return int(round(math.sqrt(1.0001 ** tick) * Q96))


def amounts_for_liquidity(liquidity, price, lower, upper):
    price = min(max(price, lower), upper)
    amount0 = liquidity * (upper - price) * Q96 // (price * upper) if price < upper else 0
    amount1 = liquidity * (price - lower) // Q96 if price > lower else 0
    return amount0, amount1


def liquidity_for_amounts(amount0, amount1, price, lower, upper):
    price = min(max(price, lower), upper)
    from0 = amount0 * price * upper // ((upper - price) * Q96) if price < upper else 2**128
    from1 = amount1 * Q96 // (price - lower) if price > lower else 2**128
    return min(from0, from1)


def quote_value(amount0, amount1, price):
    """Both currencies in units of currency1 at a sqrt price."""
    return amount1 + amount0 * price * price // 2**192


class Loopback:
    """A loopback JSON-RPC source (an SSH-forwarded node) in the gateway's place."""
    def __init__(self, url):
        parsed = urlsplit(url)
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.port is None:
            raise DataError('fork_gateway_required')
        self.url = url

    def request(self, method, params=()):
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': list(params)}).encode()
        request = urllib.request.Request(self.url, body, {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        if 'error' in result:
            raise DataError('fork_upstream_rpc_error')
        return result['result']

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Experiment:
    def __init__(self, fork, pool_name, band_bps):
        self.fork = fork
        self.pool_id, self.key = POOLS[pool_name]
        self.band_bps = band_bps
        self.currencies = (self.key.currency0, self.key.currency1)
        self.native = self.key.currency0 == ZERO
        # One sale size per move: every scenario starts from the same snapshot.
        self.move_amounts = {}

    # ---------------------------------------------------------------- rpc
    def call(self, target, signature, outputs, types=(), values=()):
        data = self.fork.request('eth_call', [{'to': target, 'data': calldata(signature, types, values),
            'gas': hex(5_000_000)}, 'latest'])
        return decode(outputs, bytes.fromhex(data[2:]))

    def send(self, sender, target, data='0x', value=0, gas=10_000_000):
        """Like DepositFork.send, with a receipt wait sized for swaps that cross
        many ticks of a real pool - each fresh tick is an upstream fetch."""
        tx = {'from': sender, 'data': data, 'gas': hex(gas), 'value': hex(value)}
        if target is not None:
            tx['to'] = target
        if self.fork.request('eth_chainId') != hex(CHAIN_ID):
            raise DataError('fork_chain_mismatch')
        digest = self.fork.request('eth_sendTransaction', [tx])
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            receipt = self.fork.request('eth_getTransactionReceipt', [digest])
            if receipt is not None:
                return receipt
            time.sleep(.1)
        raise DataError('fork_receipt_unavailable')

    def must(self, sender, target, data='0x', value=0, what='transaction'):
        receipt = self.send(sender, target, data, value)
        if receipt['status'] != '0x1':
            raise DataError(f'fork_step_failed:{what}:{self.revert_reason(sender, target, data, value)}')
        return receipt

    def revert_reason(self, sender, target, data, value=0):
        """Replay a failed transaction as a call to read its revert selector."""
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call', 'params': [
            {'from': sender, 'to': target, 'data': data, 'value': hex(value), 'gas': hex(10_000_000)}, 'latest']}).encode()
        request = urllib.request.Request(self.fork.url, body, {'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
        except OSError:
            return 'unknown'
        error = result.get('error') or {}
        payload = error.get('data') if isinstance(error, dict) else None
        if isinstance(payload, dict):
            payload = payload.get('data')
        if isinstance(payload, str) and payload.startswith('0x') and len(payload) >= 10:
            return ERRORS.get(payload[2:10], 'selector:' + payload[2:10])
        return 'reverted:' + str(error.get('message', ''))[:60]

    def balance(self, currency, account):
        if currency == ZERO:
            return int(self.fork.request('eth_getBalance', [account, 'latest']), 16)
        return self.call(currency, 'balanceOf(address)', ['uint256'], ['address'], [account])[0]

    def spot(self):
        return self.call(STATE_VIEW, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
            ['bytes32'], [bytes.fromhex(self.pool_id[2:])])[:2]

    def artifact(self, source, name):
        return json.loads((ROOT / 'contracts/out' / source / (name + '.json')).read_text())

    def deploy(self, sender, source, name, types=(), values=()):
        artifact = self.artifact(source, name)
        initcode = artifact['bytecode']['object'] + encode(types, values).hex()
        receipt = self.must(sender, None, initcode, what='deploy:' + name)
        return receipt['contractAddress'].lower()

    def fund_native(self, account, amount):
        self.fork.request('anvil_setBalance', [account, hex(amount)])

    def fund(self, currency, account, amount):
        """Real tokens on the child: wrap for WETH, borrow from the pool manager otherwise."""
        if currency == ZERO:
            self.fund_native(account, amount + 10**21)
        elif currency == WETH:
            self.fund_native(account, amount + 10**21)
            self.must(account, WETH, calldata('deposit()'), amount, 'wrap')
        else:
            held = self.balance(currency, POOL_MANAGER)
            if amount * 10 > held:
                raise DataError('fork_seed_balance_unavailable')
            self.fund_native(POOL_MANAGER, 10**18)
            self.fork.request('anvil_impersonateAccount', [POOL_MANAGER])
            self.must(POOL_MANAGER, currency, calldata('transfer(address,uint256)', ['address', 'uint256'],
                [account, amount]), what='seed:' + currency)
            self.fork.request('anvil_stopImpersonatingAccount', [POOL_MANAGER])

    # -------------------------------------------------------------- stack
    def deploy_stack(self):
        for account in (DEPLOYER, OWNER, OPERATOR, PUBLISHER, ATTACKER):
            self.fund_native(account, 10**22)
            self.fork.request('anvil_impersonateAccount', [account])
        self.fork.fresh_block()
        d = self.deploy
        self.factory = d(DEPLOYER, 'DominoVaultFactoryV4.sol', 'DominoVaultFactoryV4', ['address'] * 4,
            [POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, RECIPIENT])
        self.helper = d(DEPLOYER, 'DominoVaultReadHelper.sol', 'DominoVaultReadHelper', ['address'] * 2,
            [POSITION_MANAGER, STATE_VIEW])
        self.routing = d(DEPLOYER, 'DominoRoutingHelperV4.sol', 'DominoRoutingHelperV4')
        self.guard = d(DEPLOYER, 'DominoPriceGuardV4.sol', 'DominoPriceGuardV4', ['address', 'address', 'uint256'],
            [PUBLISHER, STATE_VIEW, self.band_bps])
        self.engine = d(DEPLOYER, 'DominoExecutionEngineV4.sol', 'DominoExecutionEngineV4', ['address'] * 4,
            [self.factory, self.helper, self.routing, self.guard])
        self.implementation = d(DEPLOYER, 'DominoVaultV4.sol', 'DominoVaultV4', ['address'] * 7,
            [self.factory, POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, RECIPIENT, self.helper, self.engine])
        self.setup = d(DEPLOYER, 'DominoSetup.sol', 'DominoSetup',
            ['address', 'address', 'address', 'address', 'uint16', 'uint64'],
            [POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, RECIPIENT, 65, 1])
        self.must(DEPLOYER, self.factory, calldata('finalizeImplementation(address)', ['address'],
            [self.implementation]), what='finalize')
        self.driver = d(ATTACKER, 'OfficialV4Fixture.sol', 'OfficialV4SwapDriver', ['address'], [POOL_MANAGER])

    def key_tuple(self):
        return (self.key.currency0, self.key.currency1, self.key.fee_pips, self.key.tick_spacing, self.key.hooks)

    def open_root(self, amount0, amount1, width_ticks):
        """A real root position through DominoSetup, around the current tick."""
        price, tick = self.spot()
        spacing = self.key.tick_spacing
        lower = (tick - width_ticks) // spacing * spacing
        upper = -((-(tick + width_ticks)) // spacing) * spacing
        for currency, amount in zip(self.currencies, (amount0, amount1)):
            self.fund(currency, OWNER, amount)
            if currency != ZERO:
                self.must(OWNER, currency, calldata('approve(address,uint256)', ['address', 'uint256'],
                    [self.setup, amount]), what='approve')
        operation = self.call(self.setup, 'nextOperationId(address)', ['bytes32'], ['address'], [OWNER])[0]
        self.must(OWNER, self.setup, calldata('open(bytes32,' + KEY_TYPE + ',uint128,uint128)',
            ['bytes32', KEY_TYPE, 'uint128', 'uint128'], [operation, self.key_tuple(), amount0, amount1]),
            amount0 if self.native else 0, 'open')
        lower_price, upper_price = sqrt_at_tick(lower), sqrt_at_tick(upper)
        liquidity = liquidity_for_amounts(amount0 * 98 // 100, amount1 * 98 // 100, price, lower_price, upper_price)
        token = self.call(POSITION_MANAGER, 'nextTokenId()', ['uint256'])[0]
        # DominoSetup bounds a deadline to 1200 s past the block it executes in.
        head = self.fork.request('eth_getBlockByNumber', ['latest', False])
        deadline = int(head['timestamp'], 16) + 600
        plan = (operation, lower, upper, liquidity, amount0, amount1, price * 95 // 100, price * 105 // 100, 0, deadline)
        self.must(OWNER, self.setup, calldata('mint(' + MINT_TYPE + ')', [MINT_TYPE], [plan]), what='mint')
        held = self.call(POSITION_MANAGER, 'getPositionLiquidity(uint256)', ['uint128'], ['uint256'], [token])[0]
        if held != liquidity:
            raise DataError('fork_root_liquidity_mismatch')
        self.token, self.lower, self.upper = token, lower, upper
        self.lower_price, self.upper_price = lower_price, upper_price
        return {'tokenId': token, 'tickLower': lower, 'tickUpper': upper, 'liquidity': str(liquidity),
            'tickAtOpen': tick, 'sqrtPriceAtOpen': str(price)}

    def create_vault(self):
        self.vault = self.call(self.factory, 'predictVault(address,uint256)', ['address'],
            ['address', 'uint256'], [OWNER, 0])[0]
        self.must(OWNER, POSITION_MANAGER, calldata('approve(address,uint256)', ['address', 'uint256'],
            [self.vault, self.token]), what='approve root')
        params = (self.token, bytes.fromhex(self.pool_id[2:]), *self.currencies, OPERATOR, True,
            (SERVICE_FEE_BPS, 500, 1000, 1, 4, 1, False), (1, 5000, 100, MAX_PRICE_IMPACT_BPS, 10**18, 120, 3600))
        self.must(OWNER, self.factory, calldata('createVault(' + INIT_TYPE + ',uint256)', [INIT_TYPE, 'uint256'],
            [params, 0]), what='createVault')
        self.sequence = self.call(self.vault, 'sequenceIdentityHash()', ['bytes32'])[0]
        if not self.call(self.vault, 'rootPermissionValid()', ['bool'])[0]:
            raise DataError('fork_vault_not_armed')

    # -------------------------------------------------------------- swaps
    def swap(self, zero_for_one, amount):
        """The attacker's driver swaps exact input against the real pool."""
        return self.must(ATTACKER, self.driver, calldata('swap(' + KEY_TYPE + ',bool,uint256)',
            [KEY_TYPE, 'bool', 'uint256'], [self.key_tuple(), zero_for_one, amount]), what='swap')

    def fund_driver(self, amount0, amount1):
        for currency, amount in zip(self.currencies, (amount0, amount1)):
            if amount == 0:
                continue
            if currency == ZERO:
                self.fund_native(self.driver, amount)
            else:
                self.fund(currency, ATTACKER, amount)
                self.must(ATTACKER, currency, calldata('transfer(address,uint256)', ['address', 'uint256'],
                    [self.driver, amount]), what='fund driver')

    def driver_balances(self):
        return tuple(self.balance(c, self.driver) for c in self.currencies)

    def earn_fees(self, rounds, leg):
        """Round trips of `leg` currency0 each way; the vault's share of the pool's fee."""
        for _ in range(rounds):
            self.swap(True, leg)
            received = self.balance(self.key.currency1, self.driver)
            self.swap(False, received)

    def price_after(self, zero_for_one, amount):
        checkpoint = self.fork.request('evm_snapshot')
        try:
            self.swap(zero_for_one, amount)
            return self.spot()[0]
        finally:
            self.fork.request('evm_revert', [checkpoint])

    def amount_for_move(self, move_bps):
        """Bisect the currency0 sale that lowers currency0's price by move_bps."""
        if move_bps in self.move_amounts:
            return self.move_amounts[move_bps]
        start = self.spot()[0]
        target = int(start * math.sqrt(1 - move_bps / 10000))
        low, high = 0, 10**18
        while self.price_after(True, high) > target:
            high *= 4
            if high > 10**26:
                raise DataError('fork_move_unreachable')
        for _ in range(16):
            mid = (low + high) // 2
            if self.price_after(True, mid) > target:
                low = mid
            else:
                high = mid
        self.move_amounts[move_bps] = high
        return high

    # --------------------------------------------------------- compounds
    def accrued(self):
        point = self.call(self.helper, 'readCheckpoint(bytes32,bytes32,uint256,int24,int24)', [g.CHECKPOINT_TYPE],
            ['bytes32', 'bytes32', 'uint256', 'int24', 'int24'],
            [bytes.fromhex(self.pool_id[2:]), self.sequence, self.token, self.lower, self.upper])[0]
        return self.call(self.helper, 'accrued(' + g.CHECKPOINT_TYPE + ')', ['uint128', 'uint128'],
            [g.CHECKPOINT_TYPE], [point])

    def publish(self, authority):
        price = self.spot()[0]
        point = (bytes.fromhex(self.pool_id[2:]), int(authority.observedAtBlock),
            bytes.fromhex(authority.observedBlockHash[2:]), int(authority.observedAtTimestamp),
            int(authority.deadline), price)
        receipt = self.must(PUBLISHER, self.guard, calldata('publish(' + OBSERVATION_TYPE + ')',
            [OBSERVATION_TYPE], [point]), what='publish')
        return receipt['logs'][0]['topics'][1], price

    def plan(self, liquidity_increase, max_added, swap_in=0):
        self.fork.mine()
        source = self.fork.request('eth_getBlockByNumber', ['latest', False])
        member = self.call(self.vault, 'position(uint256)', [g.POSITION_TYPE], ['uint256'], [self.token])[0]
        checkpoint = self.call(self.vault, 'checkpoint(uint256)', [g.CHECKPOINT_TYPE], ['uint256'], [self.token])[0]
        timestamp = int(source['timestamp'], 16)
        spot = self.spot()[0]
        authority = g.CompoundPlan(intentId='0x' + keccak(encode(['address', 'uint256', 'uint64'],
            [self.vault, int(source['number'], 16), int(time.time_ns() % 2**64)])).hex(),
            tokenId=str(self.token), positionIdentity='0x' + member[8].hex(), checkpointId='0x' + checkpoint[6].hex(),
            policyVersion='1', limitsVersion='1',
            stateNonce=str(self.call(self.vault, 'stateNonce()', ['uint64'])[0]),
            authorityGeneration=str(self.call(self.vault, 'authorityGeneration()', ['uint64'])[0]),
            observedAtBlock=str(int(source['number'], 16)), observedBlockHash=source['hash'],
            observedAtTimestamp=str(timestamp), deadline=str(timestamp + 100), liquidityIncrease=str(liquidity_increase),
            # The wire refuses both floors at zero, not one: a move that leaves
            # the range makes the add single-sided, and an operator can zero the
            # empty side's floor and compound anyway. That is the worst case, so
            # the floors follow where the spot sits against the range.
            maxOriginal0='0', maxOriginal1='0', maxCharged0='0', maxCharged1='0',
            minAdded0='0' if spot >= self.upper_price else '1', minAdded1='0' if spot <= self.lower_price else '1',
            minSqrtPriceX96=str(2**80), maxSqrtPriceX96=str(2**110))
        budgets = [v.FeeBudget(sourceId='0x' + member[9 + i].hex(), currency=self.currencies[i],
            maxOriginal=str(2**128 - 1), maxCharged='0', minOriginal='0', minCharged='0') for i in (0, 1)]
        if swap_in:
            # The swap's output is booked as the input source's charged balance
            # in the output currency, and the add may spend it from there.
            budgets.append(v.FeeBudget(sourceId='0x' + member[9].hex(), currency=self.currencies[1],
                maxOriginal='0', maxCharged=str(2**128 - 1), minOriginal='0', minCharged='0'))
        budgets = tuple(sorted(budgets, key=lambda b: (b.sourceId, b.currency)))
        observation, anchor = self.publish(authority)
        if swap_in:
            # The swap family: part of the currency0 fee is sold for currency1
            # at the anchor, with the minimum output the vault's own slippage
            # limit allows - the recipe of the executor's swap tests.
            minimum = self.call(self.routing, 'minimumOutput(uint128,uint160,bool,uint16)', ['uint256'],
                ['uint128', 'uint160', 'bool', 'uint16'], [swap_in, anchor, True, 100])[0]
            if minimum == 0:
                raise DataError('fork_swap_too_small_to_bound')
            swap = v.SwapPlan(sourceId='0x' + member[9].hex(), currencyIn=self.currencies[0], amountIn=str(swap_in),
                maxOriginal=str(2**128 - 1), maxCharged='0', minAmountOut=str(minimum),
                sqrtPriceLimitX96=authority.minSqrtPriceX96, priceObservationId=observation)
        else:
            swap = v.SwapPlan(sourceId=m.ZERO_HASH, currencyIn=ZERO, amountIn='0', maxOriginal='0', maxCharged='0',
                minAmountOut='0', sqrtPriceLimitX96='0', priceObservationId=observation)
        # GENERAL carries the swap; NET is the optimised path with none.
        plan = v.Plan(authority=authority, action=0, destinationTokenId=str(self.token), tickLower=0, tickUpper=0,
            maxAdded0=str(max_added[0]), maxAdded1=str(max_added[1]),
            collect=(v.PositionRef(tokenId=str(self.token), positionIdentity=authority.positionIdentity,
                checkpointId=authority.checkpointId),), budgets=budgets, swap=swap)
        return plan, anchor

    def feasible_increase(self):
        """The liquidity the accrued fees fund at the current spot, after the service fee."""
        fee0, fee1 = self.accrued()
        net0, net1 = fee0 * (10000 - SERVICE_FEE_BPS) // 10000, fee1 * (10000 - SERVICE_FEE_BPS) // 10000
        price = self.spot()[0]
        # The operator's slack: 90% of what the fees fund at the observed spot,
        # so a composition shift inside the impact band still fits.
        return liquidity_for_amounts(net0, net1, price, self.lower_price, self.upper_price) * 90 // 100, (fee0, fee1)

    def vault_state(self):
        liquidity = self.call(POSITION_MANAGER, 'getPositionLiquidity(uint256)', ['uint128'], ['uint256'], [self.token])[0]
        reserves = tuple(self.call(self.vault, 'accountedCurrency(address)', ['uint256'], ['address'], [c])[0]
            for c in self.currencies)
        return liquidity, reserves

    def vault_value(self, reference, liquidity, reserves):
        """Position at the reference price, plus reserves, plus fees still uncollected."""
        amount0, amount1 = amounts_for_liquidity(liquidity, reference, self.lower_price, self.upper_price)
        fee0, fee1 = self.accrued()
        return quote_value(amount0 + reserves[0] + fee0, amount1 + reserves[1] + fee1, reference)

    def run_scenario(self, name, move_bps, pre_observation, ceiling, reference, honest_added, swap=False):
        checkpoint = self.fork.request('evm_snapshot')
        try:
            result = {'scenario': name, 'moveBps': move_bps, 'preObservation': pre_observation, 'ceiling': ceiling,
                'swap': swap}
            attacker_before = self.driver_balances()
            liquidity_before, reserves_before = self.vault_state()
            result['sqrtPriceBefore'] = str(self.spot()[0])
            if move_bps and pre_observation:
                sold = self.amount_for_move(move_bps)
                self.swap(True, sold)
                result['attackerSold0'] = str(sold)
            increase, fees = self.feasible_increase()
            result['accruedFees'] = [str(f) for f in fees]
            swap_in = 0
            if swap:
                # Half of the net currency0 fee is sold; the add is kept small so
                # it stays feasible whatever the swap returns.
                swap_in = fees[0] * (10000 - SERVICE_FEE_BPS) // 10000 // 2
                increase = increase // 4
                result['swapIn0'] = str(swap_in)
            result['liquidityIncrease'] = str(increase)
            max_added = (2**127 - 1, 2**127 - 1)
            if ceiling:
                max_added = tuple(a + a * 50 // 10000 + 1 for a in honest_added)
                result['maxAdded'] = [str(a) for a in max_added]
            plan, anchor = self.plan(increase, max_added, swap_in)
            result['anchorSqrtPrice'] = str(anchor)
            if move_bps and not pre_observation:
                sold = self.amount_for_move(move_bps)
                self.swap(True, sold)
                result['attackerSold0'] = str(sold)
            result['sqrtPriceAtCompound'] = str(self.spot()[0])
            receipt = self.send(OPERATOR, self.vault, plan.calldata())
            result['gasUsed'] = int(receipt['gasUsed'], 16)
            if receipt['status'] == '0x1':
                result['outcome'] = 'executed'
            else:
                result['outcome'] = 'refused'
                result['reason'] = self.revert_reason(OPERATOR, self.vault, plan.calldata())
            if move_bps:
                received = self.balance(self.key.currency1, self.driver) - attacker_before[1]
                if received > 0:
                    self.swap(False, received)
                result['sqrtPriceAfterRestore'] = str(self.spot()[0])
            liquidity_after, reserves_after = self.vault_state()
            result['liquidityAdded'] = str(liquidity_after - liquidity_before)
            result['reservesAfter'] = [str(r) for r in reserves_after]
            added = amounts_for_liquidity(liquidity_after - liquidity_before, int(result['sqrtPriceAtCompound']),
                self.lower_price, self.upper_price)
            result['addedAmounts'] = [str(a) for a in added]
            value_before = self.vault_value(reference, liquidity_before, reserves_before)
            value_after = self.vault_value(reference, liquidity_after, reserves_after)
            result['vaultValueBeforeQuote'] = str(value_before)
            result['vaultValueAfterQuote'] = str(value_after)
            attacker_after = self.driver_balances()
            result['attackerPnlQuote'] = str(quote_value(*attacker_after, reference) - quote_value(*attacker_before, reference))
            result['attackerBalanceDelta'] = [str(a - b) for a, b in zip(attacker_after, attacker_before)]
            return result, added
        finally:
            self.fork.request('evm_revert', [checkpoint])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--rpc-config', type=Path, help='private providers.json; default: the local one, else the public source')
    parser.add_argument('--source-url', help='loopback JSON-RPC source, e.g. an SSH-forwarded node; replaces the gateway')
    parser.add_argument('--pool', choices=sorted(POOLS), default='weth-usdg')
    parser.add_argument('--block', help='fork block number (hex or decimal); default: the head block')
    parser.add_argument('--band', type=int, default=GUARD_BAND_BPS, help='price guard band, bps of sqrt price')
    parser.add_argument('--moves', default='50,90,110,500,2000', help='attacker price moves to measure, bps')
    parser.add_argument('--rounds', type=int, default=40, help='fee-earning round trips before the compounds')
    parser.add_argument('--root0', default='2000000000000000000', help='root deposit of currency0, raw')
    parser.add_argument('--root1', default='8000000000', help='root deposit of currency1, raw')
    parser.add_argument('--width', type=int, default=200, help='root range half-width, ticks')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    moves = [int(x) for x in args.moves.split(',') if x]
    report = {'tool': 'qualify_execution_fork', 'chainId': CHAIN_ID, 'pool': args.pool,
        'poolId': POOLS[args.pool][0], 'guardBandBps': args.band, 'maxPriceImpactBps': MAX_PRICE_IMPACT_BPS,
        'serviceFeeBps': SERVICE_FEE_BPS, 'planSlackPercent': 10, 'rootWidthTicks': args.width,
        'startedAt': int(time.time()), 'scenarios': [],
        'valuation': 'currency1 units at the pre-scenario sqrt price; position amounts from liquidity and range, plus vault reserves',
        'controls': 'synthetic accounts impersonated on the child; balances set locally; WETH wrapped; other tokens moved from the pool manager'}
    if args.source_url:
        source = Loopback(args.source_url)
        report['upstream'] = 'loopback source'
    else:
        config = load_config(args.rpc_config) if args.rpc_config else load_config()
        history = configured_history_rpc_source(config)
        hosts = config.get('rpcAllowedHosts', DEFAULT_RPC_HOSTS)
        source = ForkReadGateway(history, allowed_hosts=hosts)
        report['upstream'] = urlsplit(history[0] if isinstance(history, tuple) else history).hostname
    with source as gateway:
        if gateway.request('eth_chainId') != hex(CHAIN_ID):
            raise DataError('fork_source_chain_mismatch')
        # A pruned Nitro node keeps state for roughly its block-age window, so
        # the fork starts at the head, as the deposit qualification does, and
        # the whole session has to finish inside that window.
        tag = 'latest' if args.block is None else hex(int(args.block, 0))
        block = gateway.request('eth_getBlockByNumber', [tag, False])
        report['source'] = {k: block[k] for k in ('number', 'hash', 'timestamp')}
        with DepositFork(gateway, block=block, total_seconds=1800, max_requests=40_000) as fork:
            report['anvilVersion'] = fork.version
            x = Experiment(fork, args.pool, args.band)
            x.deploy_stack()
            report['stack'] = {k: getattr(x, k) for k in ('factory', 'helper', 'routing', 'guard', 'engine',
                'implementation', 'setup', 'driver')}
            report['root'] = x.open_root(int(args.root0), int(args.root1), args.width)
            x.create_vault()
            report['vault'] = x.vault
            print(json.dumps({'stage': 'vault', 'vault': x.vault, 'token': x.token}), flush=True)
            # The attacker's war chest, currency0 only: every unit of currency1
            # it holds afterwards came out of the pool. Funded before any swap,
            # including the sizing probes.
            x.fund_driver(10**24, 0)
            # Fee generation: legs sized to a small impact, so the price ends near where it began.
            probe = x.amount_for_move(20)
            price_start = x.spot()[0]
            x.earn_fees(args.rounds, probe)
            fees = x.accrued()
            report['fees'] = {'rounds': args.rounds, 'legCurrency0': str(probe), 'accrued': [str(f) for f in fees],
                'sqrtPriceBefore': str(price_start), 'sqrtPriceAfter': str(x.spot()[0])}
            print(json.dumps({'stage': 'fees', **report['fees']}), flush=True)
            if fees[0] == 0 and fees[1] == 0:
                raise DataError('fork_no_fees_accrued')
            reference = x.spot()[0]
            report['referenceSqrtPrice'] = str(reference)
            honest, honest_added = x.run_scenario('honest', 0, False, False, reference, (0, 0))
            report['scenarios'].append(honest)
            print(json.dumps({'stage': 'scenario', **{k: honest[k] for k in ('scenario', 'outcome', 'liquidityAdded')}}), flush=True)
            honest_value = int(honest['vaultValueAfterQuote'])
            compounded = quote_value(*honest_added, reference)
            report['honestCompoundedQuote'] = str(compounded)
            # The swap recipe's own control, before any manipulation.
            try:
                control, _ = x.run_scenario('swap-honest', 0, False, False, reference, honest_added, True)
            except Exception as error:  # noqa: BLE001
                control = {'scenario': 'swap-honest', 'moveBps': 0, 'swap': True, 'outcome': 'harness-error',
                    'reason': type(error).__name__ + ': ' + str(error)[:120]}
            report['scenarios'].append(control)
            print(json.dumps({'stage': 'scenario', **{k: control.get(k) for k in ('scenario', 'outcome', 'reason', 'liquidityAdded')}}), flush=True)
            families = (('pre-observation', True, False, False), ('post-observation', False, False, False),
                ('ceiling', False, True, False), ('swap-pre-observation', True, False, True),
                ('swap-post-observation', False, False, True))
            for move in moves:
                for name, pre, ceiling, swap in families:
                    if ceiling and move >= MAX_PRICE_IMPACT_BPS:
                        continue
                    try:
                        result, _ = x.run_scenario(name, move, pre, ceiling, reference, honest_added, swap)
                    except Exception as error:  # noqa: BLE001 - one scenario's failure is a result, not the run's
                        result = {'scenario': name, 'moveBps': move, 'swap': swap, 'outcome': 'harness-error',
                            'reason': type(error).__name__ + ': ' + str(error)[:120]}
                    else:
                        loss = honest_value - int(result['vaultValueAfterQuote'])
                        result['lossVersusHonestQuote'] = str(loss)
                        cost = -int(result['attackerPnlQuote'])
                        result['attackerCostQuote'] = str(cost)
                        if loss > 0 and compounded > 0:
                            result['lossFractionOfCompounded'] = loss / compounded
                            # What one compound would have to move for this attack to pay.
                            result['breakevenCompoundedQuote'] = str(cost * compounded // loss)
                    report['scenarios'].append(result)
                    print(json.dumps({'stage': 'scenario', **{k: result.get(k) for k in
                        ('scenario', 'moveBps', 'outcome', 'reason', 'lossVersusHonestQuote', 'attackerCostQuote',
                         'breakevenCompoundedQuote')}}), flush=True)
            report['finishedAt'] = int(time.time())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, 'x') as handle:
        json.dump(report, handle, indent=1)
    print(json.dumps({'stage': 'done', 'output': str(args.output), 'scenarios': len(report['scenarios'])}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
