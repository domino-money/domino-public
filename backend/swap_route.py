"""Setup's assisted swap, routed where it returns more to the owner.

The chosen pool is the default: DominoSetup keeps 65 bps of the gross input
and swaps the rest there, priced by Uniswap's V4 quoter. Uniswap's router is
chosen only when, after the same 65 bps taken as an integrator fee, it returns
the owner more than THRESHOLD_BPS above the pool, and the owner's whole
sequence (the exact Permit2 approval, the router allowance, the swap)
simulates on the chain's own node, at the same block as the pool quote, to at
least the quoted minimums for the owner and for Domino's fee. Anything else,
including a provider that does not answer in time, keeps the pool. A pool the
quoter cannot fill (it reverts) returns nothing, so any route that simulates
beats it. Never a signer: a chosen route is a set of unsigned transactions for
the wallet.
"""
from dataclasses import asdict
import hashlib
import json
import time

from discovery import CHAIN_ID, ZERO, DataError, ReadRpc, address, bytes32, encode, keccak, parse_block, quantity
from read_deadline import read_deadline
from uniswap_route import FEE_BPS, FEE_RECIPIENT, PERMIT2, SOURCE as UNISWAP_SOURCE, VALIDITY_SECONDS

V4_QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94'
MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
THRESHOLD_BPS = 50
ADVANTAGE_CAP_BPS = 10**12
PLAN_BUDGET_SECONDS = 10
READ_GAS = 100_000
SWAP_GAS = 3_000_000
QUOTE_SIGNATURE = 'quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))'
QUOTE_INPUT = ['((address,address,uint24,int24,address),bool,uint128,bytes)']


class RouteRpc(ReadRpc):
    """The read allowlist plus eth_simulateV1, which executes nothing on chain."""
    METHODS = ReadRpc.METHODS | frozenset({'eth_simulateV1'})


def _calldata(signature, types=(), values=()):
    return '0x' + (keccak(signature.encode())[:4] + encode(list(types), list(values))).hex()


def pool_output(rpc, key, zero_for_one, net_input, block_number):
    """What the chosen pool returns for Setup's net input, at this block."""
    value = ((key.currency0, key.currency1, key.fee_pips, key.tick_spacing, key.hooks), zero_for_one, net_input, b'')
    output, _gas = rpc.call(V4_QUOTER, QUOTE_SIGNATURE, QUOTE_INPUT, [value], ['uint256', 'uint256'], block=hex(block_number))
    return output


def advantage_bps(output, pool_out):
    """Floored basis points above the pool's output, capped; a pool that returns nothing counts as the cap."""
    if pool_out == 0:
        return ADVANTAGE_CAP_BPS
    return min((output - pool_out) * 10000 // pool_out, ADVANTAGE_CAP_BPS)


def _balance(token, holder):
    if token == ZERO:
        return {'to': MULTICALL3, 'data': _calldata('getEthBalance(address)', ['address'], [holder])}
    return {'to': token, 'data': _calldata('balanceOf(address)', ['address'], [holder])}


def simulate(rpc, block, owner, token_in, token_out, amount, route):
    """The owner's sequence on top of this block: output credited to the owner and to Domino's fee recipient."""
    reads = [dict(_balance(token_out, holder), **{'from': owner, 'gas': hex(READ_GAS)}) for holder in (owner, FEE_RECIPIENT)]
    steps = []
    if token_in != ZERO:
        steps.append({'from': owner, 'to': token_in, 'gas': hex(READ_GAS),
                      'data': _calldata('approve(address,uint256)', ['address', 'uint256'], [PERMIT2, amount])})
        if route['permitTransaction'] is not None:
            steps.append({'from': owner, 'to': PERMIT2, 'data': route['permitTransaction']['data'], 'gas': hex(READ_GAS)})
    swap = route['swapTransaction']
    # The outcome is what is checked here, not the gas: a generous limit, whatever /swap said.
    steps.append({'from': owner, 'to': swap['to'], 'data': swap['data'], 'value': hex(int(swap['valueRaw'])),
                  'gas': hex(SWAP_GAS)})
    calls = reads + steps + reads
    # Nitro's default simulated time is twelve seconds past its head; the next block is one second later.
    request = {'blockStateCalls': [{'blockOverrides': {'time': hex(block.timestamp + 1)}, 'calls': calls}], 'validation': False}
    blocks = rpc.request('eth_simulateV1', [request, block.hash])
    try:
        results = blocks[0]['calls']
        if len(results) != len(calls) or any(result.get('status') != '0x1' for result in results):
            raise DataError('uniswap_route_simulation_failed')
        owner_before, fee_before, owner_after, fee_after = (
            int(results[index]['returnData'], 16) for index in (0, 1, -2, -1))
    except DataError:
        raise
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        raise DataError('uniswap_route_simulation_failed') from None
    return owner_after - owner_before, fee_after - fee_before


def identity_of(owner, pool_id, key, token_in, amount_raw, slippage_bps):
    """Exactly the request's fields and the session's owner: what the bridge associates."""
    return {'owner': address(owner), 'chainId': CHAIN_ID, 'poolId': bytes32(pool_id), 'poolKey': asdict(key),
            'tokenIn': address(token_in), 'amountRaw': str(amount_raw), 'slippageBps': slippage_bps}


class SwapRoute:
    def __init__(self, uniswap, rpc_factory, *, clock=time.time):
        self.uniswap, self.rpc_factory, self.clock = uniswap, rpc_factory, clock

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not 0 <= value < 2**53:
            raise DataError('invalid_swap_route_clock')
        return value

    def plan(self, *, owner, pool_id, key, token_in, amount_raw, slippage_bps):
        identity = identity_of(owner, pool_id, key, token_in, amount_raw, slippage_bps)
        owner, token_in = identity['owner'], identity['tokenIn']
        currencies = (key.currency0, key.currency1)
        if token_in not in currencies or key.hooks != ZERO or not 0 < int(amount_raw) < 2**128:
            raise DataError('invalid_swap_route_request')
        token_out = currencies[1 - currencies.index(token_in)]
        gross = int(amount_raw)
        fee = gross * FEE_BPS // 10000
        net = gross - fee
        started = self._now()
        with read_deadline(PLAN_BUDGET_SECONDS):
            rpc = self.rpc_factory()
            if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
                raise DataError('swap_route_wrong_chain')
            block = parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))
            try:
                pool_out = pool_output(rpc, key, token_in == key.currency0, net, block.number)
            except DataError as error:
                # The quoter reverts when the pool cannot take the whole net
                # input (too little liquidity, not initialized): Setup's swap
                # there would not fill either.
                if str(error) != 'rpc_call_reverted':
                    raise
                pool_out = 0
            decision, uniswap, advantage = 'pool', None, None
            try:
                quote = self.uniswap.quote(owner=owner, token_in=token_in, token_out=token_out,
                                           amount_raw=str(gross), slippage_bps=slippage_bps)
            except DataError as error:
                quote, reason = None, {'uniswap_route_rejected': 'uniswap_quote_rejected',
                    'uniswap_route_unavailable': 'uniswap_quote_unavailable'}.get(str(error), 'uniswap_quote_invalid')
            if quote is not None:
                uniswap = {'source': UNISWAP_SOURCE, **{name: quote[name] for name in (
                    'quoteId', 'grossOutputRaw', 'amountOutRaw', 'minimumAmountOutRaw', 'feeRaw',
                    'minimumFeeRaw', 'priceImpactPercent')}, 'simulatedAmountOutRaw': None, 'simulatedFeeRaw': None}
                output = int(quote['amountOutRaw'])
                reason = 'pool_within_threshold'
                if output * 10000 > pool_out * (10000 + THRESHOLD_BPS):
                    try:
                        simulated, charged = simulate(rpc, block, owner, token_in, token_out, gross, quote)
                    except DataError:
                        simulated = charged = None
                        reason = 'uniswap_simulation_failed'
                    if simulated is not None:
                        uniswap.update(simulatedAmountOutRaw=str(max(simulated, 0)), simulatedFeeRaw=str(max(charged, 0)))
                        output = simulated
                        if simulated < int(quote['minimumAmountOutRaw']) or charged < int(quote['minimumFeeRaw']):
                            reason = 'uniswap_simulation_failed'
                        elif simulated * 10000 > pool_out * (10000 + THRESHOLD_BPS):
                            decision, reason = 'uniswap', 'uniswap_better_by_threshold'
                advantage = advantage_bps(output, pool_out)
                transactions = decision == 'uniswap'
                uniswap.update(
                    approval={'token': token_in, 'spender': PERMIT2, 'amountRaw': str(gross)} if transactions and token_in != ZERO else None,
                    permitTransaction=quote['permitTransaction'] if transactions else None,
                    swapTransaction=quote['swapTransaction'] if transactions else None)
        completed = self._now()
        if completed < started or completed >= int(started) + VALIDITY_SECONDS:
            raise DataError('swap_route_expired')
        return {'schemaVersion': 1, 'chainId': CHAIN_ID, 'status': 'route_selected', 'source': 'swap_route_v1',
                'requestedAt': int(started), 'retrievedAt': int(completed), 'expiresAt': int(started) + VALIDITY_SECONDS,
                'requestFingerprint': hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                'request': identity, 'tokenOut': token_out, 'decision': decision, 'reason': reason,
                'thresholdBps': THRESHOLD_BPS, 'assistedSwapFeeBps': FEE_BPS, 'feeRecipient': FEE_RECIPIENT,
                'block': {'number': str(block.number), 'hash': block.hash},
                'pool': {'source': 'v4_quoter', 'amountInRaw': str(gross), 'feeRaw': str(fee), 'netInputRaw': str(net),
                         'amountOutRaw': str(pool_out)},
                'uniswap': uniswap, 'advantageBps': advantage}
