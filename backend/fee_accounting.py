"""Versioned, conservative reconstruction of core trading fees from v4 events.

The event omits original exact-in/out mode and price limit. Try equivalent
consumed-amount replays, require matching legs, price, tick and liquidity, and
reject differing fee results. A separate persistence gate reconciles globals.
"""
import copy
from bisect import bisect_left, bisect_right

from discovery import DataError, ZERO
from pool_activity import active_liquidity, protocol_directions, replay
from v4_math import MAX_SQRT, MIN_SQRT, PIPS, Q128, U256, sqrt_at_tick, swap_step, tick_at_sqrt

VERSION = 1
MAX_STEPS = 8192
MAX_CHUNK_STEPS = 100000


def supported(key):
    return key.hooks == ZERO and key.fee_pips != 0x800000


def tick_boundaries(model):
    ticks = {}
    for bounds, value in model['ranges'].items():
        lower, upper = map(int, bounds.split(':'))
        liquidity = int(value)
        # Net-zero shared boundaries still have initialized bitmap bits.
        ticks[lower] = ticks.get(lower, 0) + liquidity
        ticks[upper] = ticks.get(upper, 0) - liquidity
    return ticks


def next_boundary(tick, spacing, zero, ticks, ordered=None):
    ordered = sorted(ticks) if ordered is None else ordered
    compressed = tick // spacing
    if zero:
        edge = (compressed // 256) * 256 * spacing
        at = bisect_right(ordered, compressed * spacing)-1
        result = ordered[at] if at >= 0 and ordered[at] >= edge else edge
    else:
        compressed += 1
        edge = ((compressed // 256) * 256 + 255) * spacing
        at = bisect_left(ordered, compressed * spacing)
        result = ordered[at] if at < len(ordered) and ordered[at] <= edge else edge
    result = max(-887272, min(887272, result))
    return result, result in ticks


def simulate(model, key, *, zero, remaining, limit, fee, budget=None, with_trace=False):
    price, tick = int(model['sqrtPriceX96']), model['tick']
    liquidity = active_liquidity(model)
    if not MIN_SQRT < limit < MAX_SQRT or not (limit < price if zero else limit > price):
        raise DataError('invalid_replay_price_limit')
    ticks = tick_boundaries(model)
    ordered = sorted(ticks)
    protocol = protocol_directions(model['protocolFeeRaw'])[0 if zero else 1]
    exact_in = remaining < 0
    gross = output = lp = protocol_total = growth = count = crossings = 0
    trace = []
    while remaining and price != limit:
        if count >= MAX_STEPS:
            raise DataError('fee_step_budget_exhausted')
        if budget is not None:
            budget[0] -= 1
            if budget[0] < 0:
                raise DataError('fee_step_budget_exhausted')
        nxt, initialized = next_boundary(tick, key.tick_spacing, zero, ticks, ordered)
        boundary_price = sqrt_at_tick(nxt)
        target = max(limit, boundary_price) if zero else min(limit, boundary_price)
        end, amount_in, amount_out, charge = swap_step(price, target, liquidity, remaining, fee)
        step_gross = amount_in + charge
        remaining += step_gross if exact_in else -amount_out
        protocol_charge = charge if fee == protocol else step_gross * protocol // PIPS
        if not 0 <= protocol_charge <= charge:
            raise DataError('fee_protocol_split_mismatch')
        earned = charge - protocol_charge
        lp += earned; protocol_total += protocol_charge
        gross += step_gross; output += amount_out
        if liquidity:
            growth = (growth + earned * Q128 // liquidity) & U256
        if with_trace and end == boundary_price and initialized:
            trace.append((nxt, growth))
        if end == boundary_price:
            if initialized:
                liquidity += -ticks[nxt] if zero else ticks[nxt]
                crossings += 1
            tick = nxt - 1 if zero else nxt
        elif end != price:
            tick = tick_at_sqrt(end)
        if not 0 <= liquidity < 1 << 128:
            raise DataError('fee_crossing_liquidity_mismatch')
        price = end
        count += 1
    result = {'grossInput': gross, 'output': output, 'sqrtPriceX96': price,
            'tick': tick, 'liquidity': liquidity, 'lp': lp, 'protocol': protocol_total,
            'growth': growth, 'steps': count, 'crossings': crossings}
    if with_trace:
        result['crossingGrowth'] = tuple(trace)
    return result


def reconstruct_swap(model, key, payload, *, budget=None, with_trace=False):
    if not supported(key):
        raise DataError('fee_accounting_adapter_required')
    a0, a1 = int(payload['amount0']), int(payload['amount1'])
    before, after = int(model['sqrtPriceX96']), int(payload['sqrtPriceX96'])
    if a0 == a1 == 0 and before == after and model['tick'] == payload['tick']:
        if active_liquidity(model) != int(payload['liquidity']):
            raise DataError('fee_swap_replay_mismatch')
        return {'lpFeesRaw': ['0','0'], 'protocolFeesRaw': ['0','0'],
                'growthX128': ['0','0'], **({'crossingGrowth':[], 'inputCurrencyIndex':None} if with_trace else {})}
    zero = a0 < 0 or a1 > 0 or (a0 == a1 == 0 and after < before)
    direction = 0 if zero else 1
    gross, output = (-a0, a1) if zero else (-a1, a0)
    protocol = protocol_directions(model['protocolFeeRaw'])[direction]
    expected_fee = protocol + key.fee_pips - protocol * key.fee_pips // PIPS
    fee = payload['swapFeePips']
    if gross < 0 or output < 0 or fee != expected_fee:
        raise DataError('fee_swap_schedule_mismatch')
    limits = [MIN_SQRT+1 if zero else MAX_SQRT-1]
    if after != before:
        limits.append(after)
    amounts = [-gross] if gross else []
    if output and fee < PIPS:
        amounts.append(output)
    if gross == output == 0:
        # Nonzero specified amount may traverse only empty liquidity to a limit.
        amounts = [-1]
    matches = set()
    for limit in limits:
        candidates = list(amounts)
        if limit == after:
            # A limit beyond the last active range can leave unused specified
            # amount. Preserve nonzero remaining while crossing the empty tail.
            candidates.append(-gross-1)
            if fee < PIPS:
                candidates.append(output+1)
        for remaining in set(candidates):
            try:
                result = simulate(model, key, zero=zero, remaining=remaining, limit=limit, fee=fee,
                                  budget=budget,with_trace=with_trace)
            except DataError as error:
                if str(error) == 'fee_step_budget_exhausted':
                    raise
                continue
            expected = (gross, output, after, payload['tick'], int(payload['liquidity']))
            actual = tuple(result[k] for k in ('grossInput','output','sqrtPriceX96','tick','liquidity'))
            if actual == expected:
                matches.add((result['lp'], result['protocol'], result['growth'],
                             result['crossingGrowth'] if with_trace else ()))
    if len(matches) != 1:
        raise DataError('fee_swap_replay_ambiguous' if matches else 'fee_swap_replay_mismatch')
    lp, protocol_total, growth, trace = matches.pop()
    result = {'lpFeesRaw': ['0','0'], 'protocolFeesRaw': ['0','0'], 'growthX128': ['0','0']}
    for name, value in [('lpFeesRaw',lp),('protocolFeesRaw',protocol_total),('growthX128',growth)]:
        result[name][direction] = str(value)
    if with_trace:
        result.update(crossingGrowth=[{'tick':tick,'growthSinceSwapStartX128':str(g)} for tick,g in trace],
                      inputCurrencyIndex=direction)
    return result


def replay_fees(activity_model, ledger_model, events, pool_id, key):
    """Return independent activity/fee models and one fee row per swap event."""
    if not supported(key):
        raise DataError('fee_accounting_adapter_required')
    ledger = copy.deepcopy(ledger_model)
    state = copy.deepcopy(activity_model)
    if (ledger is None) != (state is None):
        raise DataError('fee_replay_anchor_required')
    if ledger is not None and ledger.get('version') != VERSION:
        raise DataError('fee_methodology_mismatch')
    rows = []
    budget = [MAX_CHUNK_STEPS]
    for event in events:
        kind, payload = event['kind'], event['payload']
        if kind == 'initialize':
            if ledger is not None or tick_at_sqrt(int(payload['sqrtPriceX96'])) != payload['tick']:
                raise DataError('invalid_fee_initialize_anchor')
            ledger = {'version':VERSION, 'growthX128':['0','0'], 'lpFeesRaw':['0','0'],
                      'protocolFeesRaw':['0','0'], 'donationsRaw':['0','0'], 'swapCount':0}
        if ledger is None:
            raise DataError('fee_replay_anchor_required')
        if kind == 'swap':
            result = reconstruct_swap(state, key, payload,budget=budget)
            rows.append({**event, 'fees':result})
            ledger['swapCount'] += 1
            for name in ('lpFeesRaw','protocolFeesRaw','growthX128'):
                for i in (0,1):
                    value = int(ledger[name][i]) + int(result[name][i])
                    ledger[name][i] = str(value & U256 if name == 'growthX128' else value)
        elif kind == 'donate':
            liquidity = active_liquidity(state)
            if not liquidity:
                raise DataError('donation_without_active_liquidity')
            for i in (0,1):
                amount = int(payload[f'amount{i}'])
                ledger['donationsRaw'][i] = str(int(ledger['donationsRaw'][i]) + amount)
                ledger['growthX128'][i] = str((int(ledger['growthX128'][i]) + amount * Q128 // liquidity) & U256)
        state = replay(state, [event], pool_id, key.__dict__)
    return state, ledger, rows
