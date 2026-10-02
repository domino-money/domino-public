"""The rules a position-plan-v1 answer must satisfy, recomputed from its own fields.

The service checks every answer with these before sending it (the closed
model calls check_document), and api-contracts/position-plan-v1/runtime.mjs
applies the same rules in the app, so a plan the app shows is one whose fee,
routes hash, intent hash, minimums and consent fields agree with each other
and with the request. What neither can check here is the chain itself: the
app takes the zap's address from its pinned manifest and compares it with
`zap`, reads the registry's ranks (or the profile's) and compares them with
`fee.ranks`, and simulates before sending (F7 §2.4).
"""
import v2_fee_rule as fee_rule
from v2_liquidity import BAND_STEPS, LiquidityError, amounts_for_liquidity, band_sqrt_price, liquidity_for_amounts, \
    range_prices
import v2_plan_codec as codec

ZERO = '0x' + '00' * 20
QUOTE_LIFETIME_SECONDS = 180
DEADLINE_SECONDS = 300
ACTION_CODES = {'create': 1, 'increase': 2, 'changeRange': 3, 'exit': 4}
PLAN_KEYS = {
    'create': ['intent', 'inputs', 'legs', 'amount0Max', 'amount1Max', 'initSqrtPriceX96'],
    'increase': ['intent', 'inputs', 'legs', 'amount0Max', 'amount1Max'],
    'changeRange': ['intent', 'liquidityToRemove', 'amount0MinRemoved', 'amount1MinRemoved', 'legs', 'amount0Max',
                    'amount1Max', 'burnOld'],
    'exit': ['intent', 'liquidityToRemove', 'amount0MinRemoved', 'amount1MinRemoved', 'legs', 'burn'],
}
FUNCTIONS = {('create', 'direct'): ('create', '0x0e97b041'), ('create', 'permit2'): ('createWithPermit', '0xec627dfe'),
             ('increase', 'direct'): ('increase', '0x2e563c43'),
             ('increase', 'permit2'): ('increaseWithPermit', '0xc6b4277b'),
             ('changeRange', 'direct'): ('changeRange', '0x2abb5a53'),
             ('changeRange', 'relayed'): ('changeRangeWithSignature', '0xf6b7af55'),
             ('exit', 'direct'): ('exit', '0xda5951bb'), ('exit', 'relayed'): ('exitWithSignature', '0x2573777b')}
LEG_KINDS = {'universal_router': 1, 'v3_pool': 2, 'v4_pool': 3}


class RuleError(ValueError):
    """position_plan_rule_<what>: the answer contradicts itself or its request."""


def plan_minimums(*, action, slippage, currencies, wrapped, wraps, inputs, legs, ranks, ticks, mint_sqrt=None,
                  pool_sqrt=None, old_ticks=None, remove=0, fees=(0, 0)):
    """The minimums of a plan (contract 1.0.0-rc.2): each at the worst price within
    ±s of the plan's, as the Uniswap SDK's mintAmountsWithSlippage and
    burnAmountsWithSlippage take theirs (owner, 2 Oct 2026).

    - Removal (changeRange, exit): amount0MinRemoved is what removing `remove`
      pays in currency0 at the band's upper price, amount1MinRemoved what it pays
      in currency1 at the lower one: within the band each pays at least that.
    - minLiquidity (create, increase, changeRange): the least liquidity the zap
      mints at any point of the band (BAND_STEPS) around the price the mint
      meets (`mint_sqrt`), from the holdings it is sure of: the inputs, every
      leg at its minAmountOut and the fee at those outputs, and for a change of
      range the withdrawal at the same shift of the pool's price. Native ETH a
      v3 WETH pool takes counts as WETH (the zap wraps it before adding).
    An exit's minLiquidity is the liquidity it removes. `ranks` maps a token to
    its registry rank; legs and inputs are the plan struct's own."""
    c0, c1 = currencies
    out = {'liquidity': None, 'amount0Removed': None, 'amount1Removed': None, 'mintBand': None, 'removalBand': None}
    if action in ('changeRange', 'exit'):
        old_a, old_b = range_prices(*old_ticks)
        lower, upper = band_sqrt_price(pool_sqrt, slippage, -2), band_sqrt_price(pool_sqrt, slippage, 2)
        out['amount0Removed'] = amounts_for_liquidity(upper, old_a, old_b, remove, False)[0]
        out['amount1Removed'] = amounts_for_liquidity(lower, old_a, old_b, remove, False)[1]
        out['removalBand'] = (lower, upper)
    if action == 'exit':
        out['liquidity'] = remove
        return out
    fold = (lambda token: wrapped if token == ZERO else token) if wraps else (lambda token: token)
    held = {c0: 0, c1: 0}
    for item in inputs:
        held[fold(item['token'])] = held.get(fold(item['token']), 0) + int(item['amount'])
    for leg in legs:
        held[fold(leg['tokenIn'])] = held.get(fold(leg['tokenIn']), 0) - int(leg['amountIn'])
        held[fold(leg['tokenOut'])] = held.get(fold(leg['tokenOut']), 0) + int(leg['minAmountOut'])
    if legs:
        rows = [fee_rule.LegTokens(leg['tokenIn'], leg['tokenOut'], int(leg['amountIn'])) for leg in legs]
        token, _, _, fee = fee_rule.assisted_swap_fee(rows, [int(leg['minAmountOut']) for leg in legs], ranks)
        held[fold(token)] = held.get(fold(token), 0) - fee
    sqrt_a, sqrt_b = range_prices(*ticks)
    least = None
    for step in BAND_STEPS:
        amount0, amount1 = held[c0], held[c1]
        if action == 'changeRange':
            withdrawn = amounts_for_liquidity(band_sqrt_price(pool_sqrt, slippage, step), old_a, old_b, remove, False)
            amount0, amount1 = amount0 + withdrawn[0] + fees[0], amount1 + withdrawn[1] + fees[1]
        if amount0 < 0 or amount1 < 0:
            liquidity = 0
        else:
            try:
                liquidity = liquidity_for_amounts(band_sqrt_price(mint_sqrt, slippage, step), sqrt_a, sqrt_b,
                                                  amount0, amount1)
            except LiquidityError:
                liquidity = 0
        least = liquidity if least is None else min(least, liquidity)
    out['liquidity'] = least
    out['mintBand'] = (band_sqrt_price(mint_sqrt, slippage, -2), band_sqrt_price(mint_sqrt, slippage, 2))
    return out


def _require(condition, what):
    if not condition:
        raise RuleError('position_plan_rule_' + what)


def _floor(amount, slippage):
    return int(amount) * (10_000 - slippage) // 10_000


def check_document(doc):
    request, plan, intent = doc['request'], doc['zapPlan'], doc['zapPlan']['intent']
    action, consent, owner, chain_id = doc['action'], doc['consent'], doc['owner'], doc['chainId']
    slippage = request['slippageBps']
    _require((request['chainId'], request['action'], request['consent'], request['owner'])
             == (chain_id, action, consent, owner), 'request')
    _require(doc['requestedAt'] <= doc['retrievedAt'] < doc['expiresAt'] == doc['requestedAt'] + QUOTE_LIFETIME_SECONDS
             and int(doc['deadline']) == doc['requestedAt'] + DEADLINE_SECONDS, 'times')
    _require(sorted(plan) == sorted(PLAN_KEYS[action]), 'plan_shape')
    _require(intent['action'] == ACTION_CODES[action] and intent['recipient'] == owner
             and intent['deadline'] == doc['deadline'], 'intent')
    pool = doc['pool']
    _require(intent['pool'] == {key: pool[key] for key in ('dex', 'currency0', 'currency1', 'fee', 'tickSpacing', 'hooks')}
             and pool['hooks'] == ZERO, 'pool')
    _check_target(doc, request, plan, intent)
    _check_nonce(doc, consent, intent)
    legs = _check_legs(doc, plan, intent, slippage)
    _check_fee(doc, plan, intent, legs)
    _check_minimums(doc, action, plan, intent, slippage)
    _check_inputs(doc, request, plan, consent)
    _check_call(doc, action, consent, plan)
    _check_signature(doc, chain_id, consent, action, plan, intent)
    _require(doc['intentHash'] == codec.intent_hash(chain_id, doc['zap'], intent), 'intent_hash')
    _check_readiness(doc, consent)
    _check_simulation(doc['simulation'])
    _check_l1_data_fee(doc)


def _check_target(doc, request, plan, intent):
    action, position = doc['action'], doc['position']
    if action == 'create':
        requested = request['pool']
        _require(position is None and intent['tokenId'] == '0', 'create_target')
        _require({k: (v.lower() if isinstance(v, str) else v) for k, v in requested.items()} == intent['pool'], 'pool')
        _require((intent['tickLower'], intent['tickUpper']) == (request['tickLower'], request['tickUpper']), 'ticks')
        initial = doc['initialPrice']
        _require((initial is None) == (request['initialPrice'] is None) and doc['pool']['initialized'] == (initial is None),
                 'initial_price')
        _require(plan['initSqrtPriceX96'] == (initial['sqrtPriceX96'] if initial else '0'), 'initial_price')
        return
    _require(position is not None and doc['initialPrice'] is None and intent['tokenId'] == position['tokenId']
             == request['position']['tokenId'], 'position')
    if action == 'changeRange':
        _require((intent['tickLower'], intent['tickUpper']) == (request['tickLower'], request['tickUpper']), 'ticks')
    else:
        _require((intent['tickLower'], intent['tickUpper']) == (position['tickLower'], position['tickUpper']), 'ticks')
    if action in ('changeRange', 'exit'):
        remove = plan['liquidityToRemove']
        wanted = request['liquidityToRemove']
        _require(remove == position['liquidityToRemove'] and remove == (
            position['liquidity'] if wanted == 'all' else wanted), 'liquidity_to_remove')
        burn = plan['burnOld'] if action == 'changeRange' else plan['burn']
        _require(burn == request['burn'] and (not burn or remove == position['liquidity']), 'burn')


def _check_nonce(doc, consent, intent):
    nonce = doc['readiness']['nonce']
    if consent == 'direct':
        _require(intent['nonce'] == '0' and nonce is None, 'nonce')
        return
    _require(nonce is not None and nonce['kind'] == consent and nonce['nonce'] == intent['nonce']
             and (int(nonce['word']) << 8 | nonce['bit']) == int(intent['nonce']), 'nonce')


def _check_legs(doc, plan, intent, slippage):
    legs, views = plan['legs'], doc['legs']
    routes = codec.routes_hash(legs)
    _require(routes == intent['routesHash'] == doc['routesHash'], 'routes_hash')
    _require(len(legs) == len(views), 'legs')
    for leg, view in zip(legs, views):
        _require(leg['kind'] == LEG_KINDS[view['kind']] and (leg['tokenIn'], leg['tokenOut'], leg['amountIn'],
                 leg['minAmountOut']) == (view['tokenIn'], view['tokenOut'], view['amountInRaw'],
                                          view['minAmountOutRaw']), 'legs')
        _require(leg['tokenIn'] != leg['tokenOut'], 'legs')
        _require((leg['router'] == ZERO) == (leg['kind'] != 1), 'leg_router')
        _require(int(leg['minAmountOut']) == max(1, _floor(view['expectedOutRaw'], slippage)), 'leg_minimum')
    return legs


def _check_fee(doc, plan, intent, legs):
    fee = doc['fee']
    seen = []
    for leg in legs:
        for token in (leg['tokenIn'], leg['tokenOut']):
            if token not in seen:
                seen.append(token)
    _require([row['token'] for row in fee['ranks']] == seen, 'fee_ranks')
    if not legs:
        _require((fee['bps'], fee['token'], fee['place'], fee['basisRaw'], fee['amountRaw']) == (0, ZERO, 'none', '0', '0')
                 and (intent['feeBps'], intent['feeToken']) == (0, ZERO), 'fee')
        return
    ranks = fee_rule.ranks_from_mapping({row['token']: row['rank'] for row in fee['ranks']})
    outs = [int(view['expectedOutRaw']) for view in doc['legs']]
    token, source, swapped, amount = fee_rule.assisted_swap_fee(legs, outs, ranks)
    _require((fee['bps'], fee['token'], fee['place']) == (65, token, fee_rule.PLACES[source])
             and (intent['feeBps'], intent['feeToken']) == (65, token), 'fee')
    _require((fee['basisRaw'], fee['amountRaw']) == (str(swapped), str(amount)), 'fee_amount')


def document_minimums(doc):
    """plan_minimums from an answer's own fields."""
    from v2_chains import default_registry
    action, plan, pool, position = doc['action'], doc['zapPlan'], doc['pool'], doc['position']
    intent = plan['intent']
    wrapped = default_registry().chain(doc['chainId']).wrappedNative.address
    kwargs = {}
    if action in ('changeRange', 'exit'):
        kwargs = {'pool_sqrt': int(pool['sqrtPriceX96']), 'old_ticks': (position['tickLower'], position['tickUpper']),
                  'remove': int(plan['liquidityToRemove']),
                  'fees': (int(position['feesOwed0Raw']), int(position['feesOwed1Raw']))}
    if action != 'exit':
        kwargs['mint_sqrt'] = int(doc['expected']['sqrtPriceX96After'])
    ranks = fee_rule.ranks_from_mapping({row['token']: row['rank'] for row in doc['fee']['ranks']})
    return plan_minimums(action=action, slippage=doc['request']['slippageBps'],
                         currencies=(pool['currency0'], pool['currency1']), wrapped=wrapped,
                         wraps=pool['dex'] == 3 and wrapped in (pool['currency0'], pool['currency1']),
                         inputs=plan.get('inputs', []), legs=plan['legs'], ranks=ranks,
                         ticks=(intent['tickLower'], intent['tickUpper']), **kwargs)


def _band(band):
    return None if band is None else {'lowerSqrtPriceX96': str(band[0]), 'upperSqrtPriceX96': str(band[1])}


def _check_minimums(doc, action, plan, intent, slippage):
    minimums = doc['minimums']
    _require(minimums['slippageBps'] == slippage and minimums['liquidity'] == intent['minLiquidity'], 'minimums')
    try:
        expected = document_minimums(doc)
    except (LiquidityError, KeyError, TypeError, ValueError):
        raise RuleError('position_plan_rule_minimums') from None
    _require(int(intent['minLiquidity']) == expected['liquidity']
             and (action == 'exit' or expected['liquidity'] > 0), 'minimums')
    _require(minimums['mintBand'] == _band(expected['mintBand'])
             and minimums['removalBand'] == _band(expected['removalBand']), 'minimum_bands')
    if action in ('changeRange', 'exit'):
        for side in ('0', '1'):
            _require(plan['amount' + side + 'MinRemoved'] == minimums['amount' + side + 'RemovedRaw']
                     == str(expected['amount' + side + 'Removed']), 'removal_minimums')
    else:
        _require(minimums['amount0RemovedRaw'] is None and minimums['amount1RemovedRaw'] is None
                 and doc['expected']['principal0Raw'] is None, 'removal_minimums')


def _check_inputs(doc, request, plan, consent):
    if doc['action'] not in ('create', 'increase'):
        return
    wanted = [{'token': item['token'].lower(), 'amount': item['amountRaw']} for item in request['inputs']]
    _require(plan['inputs'] == wanted, 'inputs')
    if consent == 'permit2':
        _require(all(item['token'] != ZERO for item in plan['inputs']), 'permit2_native')


def _check_call(doc, action, consent, plan):
    call = doc['call']
    name, selector = FUNCTIONS[(action, consent)]
    _require((call['function'], call['selector'], call['to']) == (name, selector, doc['zap']), 'call')
    if consent == 'direct':
        _require(call['data'] == codec.call_data(action, 'direct', plan)
                 and call['valueRaw'] == str(codec.direct_value(plan)), 'call')
    else:
        _require(call['data'] is None and call['valueRaw'] == '0', 'call')


def _check_signature(doc, chain_id, consent, action, plan, intent):
    signature, zap = doc['signature'], doc['zap']
    if consent == 'direct':
        _require(signature is None, 'signature')
        return
    _require(signature is not None and signature['kind'] == consent, 'signature')
    if consent == 'permit2':
        permit = signature['permit']
        _require(permit == {'permitted': plan['inputs'], 'nonce': intent['nonce'], 'deadline': intent['deadline']},
                 'permit')
        _require(signature['typedData'] == codec.permit2_typed_data(chain_id, zap, permit, intent)
                 and signature['digest'] == codec.permit2_digest(chain_id, zap, permit, intent), 'typed_data')
    else:
        relayed = codec.relayed_fields(action, plan)
        _require(signature['permit'] is None and signature['typedData'] == codec.relayed_typed_data(chain_id, zap, relayed)
                 and signature['digest'] == codec.relayed_digest(chain_id, zap, relayed), 'typed_data')


def _check_readiness(doc, consent):
    readiness = doc['readiness']
    account = readiness['account']
    _require(consent in account['consents'], 'consent')
    if account['kind'] != 'eoa':
        _require(account['consents'] == ['direct'], 'consent')
    steps = readiness['steps']
    _require(steps[-1]['kind'] == 'send_action' and steps[-1]['to'] == doc['zap']
             and steps[-1]['valueRaw'] == doc['call']['valueRaw'] and steps[-1]['data'] is None, 'steps')
    for step in steps[:-1]:
        if step['kind'].startswith('sign_'):
            _require(step['kind'] == 'sign_' + consent and step['to'] is None and step['data'] is None, 'steps')
        else:
            _require(step['valueRaw'] == '0' and step['data'] is not None and step['data'][:10] == '0x095ea7b3', 'steps')


def _check_l1_data_fee(doc):
    from v2_chains import default_registry
    from v2_l1_fee import SOURCES
    fee = doc['l1DataFee']
    _require(fee['block'] == doc['block']['number']
             and fee['source'] == SOURCES[default_registry().chain(doc['chainId']).stack], 'l1_data_fee')


def _check_simulation(simulation):
    status = simulation['status']
    if status == 'ok':
        _require(simulation['result'] is not None and simulation['error'] is None and simulation['method'] is not None
                 and simulation['reason'] is None, 'simulation')
    elif status == 'reverted':
        _require(simulation['result'] is None and simulation['method'] is not None
                 and (simulation['error'] is not None) == (simulation['reason'] is None), 'simulation')
    else:
        _require(simulation['result'] is None and simulation['error'] is None and simulation['reason'] is not None
                 and simulation['method'] is None and simulation['gasUnits'] is None, 'simulation')
