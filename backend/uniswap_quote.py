"""Non-executable, exact-input quote observations for owner-funded onboarding.

No approval/swap endpoints, arbitrary headers, permits, calldata or persisted
authorizations. CLASSIC hookless v4 is the only admitted preview route. A route
hash proves field association, not on-chain state or token transfer safety.
"""
from dataclasses import asdict
from decimal import Decimal, InvalidOperation
from fractions import Fraction
import hashlib
import json
import math
import re
import time

from discovery import (CHAIN_ID, ZERO, DataError, PoolKey, address, bytes32,
                       json_http, TRADING_QUOTE_ENDPOINT, TRADING_QUOTE_HEADERS)
from read_deadline import read_deadline
from uniswap_liquidity import checked_api_key, SCHEMA_COMMIT

ENDPOINT = TRADING_QUOTE_ENDPOINT
SOURCE = 'uniswap_trading_quote_v1'
TIMEOUT_SECONDS = 12
VALIDITY_SECONDS = 30
MAX_PATHS, MAX_HOPS = 8, 4
UINT256_MAX = (1 << 256) - 1
FAILURE_CODES = frozenset(('SIMULATION_ERROR', 'UNSUPPORTED_SIMULATION',
    'SIMULATION_UNAVAILABLE', 'SLIPPAGE_TOO_LOW', 'TRANSFER_FROM_FAILED'))


def _integer(value, low, high, *, string=False):
    if string and isinstance(value, str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,77})', value):
        value = int(value)
    if type(value) is not int or not low <= value <= high:
        raise DataError('invalid_uniswap_quote_number')
    return value


def _raw(value, *, positive=False, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise DataError('invalid_uniswap_quote_amount')
    return str(_integer(value, int(positive), UINT256_MAX, string=True))


def _decimal(value, *, maximum=100, signed=False):
    # json_http parses decimal JSON numbers as Decimal, never binary floats.
    if type(value) not in (str, int, Decimal) or len(str(value)) > 128:
        raise DataError('invalid_uniswap_quote_decimal')
    try:
        number = Decimal(value)
        if (not number.is_finite() or not (-maximum if signed else 0) <= number <= maximum
                or not -36 <= number.as_tuple().exponent <= 30):
            raise ValueError()
        return number
    except (ValueError, InvalidOperation):
        raise DataError('invalid_uniswap_quote_decimal') from None


def _clock_value(clock):
    value = clock()
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value < 2**53:
        raise DataError('invalid_uniswap_quote_clock')
    return value


def _token(raw, seen):
    if not isinstance(raw, dict) or type(raw.get('chainId')) is not int or raw['chainId'] != CHAIN_ID:
        raise DataError('uniswap_quote_chain_mismatch')
    token = address(raw.get('address'))
    decimals = raw.get('decimals')
    decimals = None if decimals is None else _integer(decimals, 0, 255, string=True)
    if token in seen and decimals is not None and seen[token] is not None and seen[token] != decimals:
        raise DataError('uniswap_quote_decimals_mismatch')
    if token not in seen or decimals is not None:
        seen[token] = decimals
    # An explicit transfer-tax observation does not fit the initial route scope.
    for name in ('buyFeeBps', 'sellFeeBps'):
        if raw.get(name) is not None and _decimal(raw[name], maximum=10000) != 0:
            raise DataError('uniswap_quote_transfer_tax_unsupported')
    return {'address': token, 'decimals': decimals}


def _routes(raw, token_in, token_out, amount_in, amount_out):
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_PATHS:
        raise DataError('invalid_uniswap_quote_routes')
    result, metadata, pools = [], {}, set()
    total_in = total_out = 0
    for path in raw:
        if not isinstance(path, list) or not 1 <= len(path) <= MAX_HOPS:
            raise DataError('invalid_uniswap_quote_routes')
        normalized, previous, visited = [], token_in, {token_in}
        for index, hop in enumerate(path):
            if not isinstance(hop, dict) or hop.get('type') != 'v4-pool':
                raise DataError('uniswap_quote_route_unsupported')
            a, b = _token(hop.get('tokenIn'), metadata), _token(hop.get('tokenOut'), metadata)
            if index == 0 and token_in == ZERO and a['address'] != ZERO:
                raise DataError('uniswap_quote_native_route_unsupported')
            if a['address'] != previous or b['address'] in visited:
                raise DataError('uniswap_quote_route_disconnected')
            previous = b['address']; visited.add(previous)
            hooks = address(hop.get('hooks'))
            fee = _integer(hop.get('fee'), 0, 1_000_000, string=True)
            spacing = _integer(hop.get('tickSpacing'), 1, 32767, string=True)
            if hooks != ZERO:
                raise DataError('uniswap_quote_hooks_unsupported')
            pool_id = bytes32(hop.get('address'))
            key = PoolKey.checked((*sorted((a['address'], b['address'])), fee, spacing, hooks), pool_id)
            if pool_id in pools:
                raise DataError('uniswap_quote_pool_reused')
            pools.add(pool_id)
            # Upstream emits only first input / last output for multihop paths.
            incoming = _raw(hop.get('amountIn'), positive=True, optional=index != 0)
            outgoing = _raw(hop.get('amountOut'), positive=True, optional=index != len(path)-1)
            if normalized and incoming is not None and normalized[-1]['amountOutRaw'] is not None:
                if incoming != normalized[-1]['amountOutRaw']:
                    raise DataError('uniswap_quote_route_amount_mismatch')
            normalized.append({'poolId': pool_id, 'poolKey': asdict(key),
                'tokenIn': a, 'tokenOut': b, 'amountInRaw': incoming, 'amountOutRaw': outgoing})
        if previous != token_out:
            if token_out == ZERO:
                raise DataError('uniswap_quote_native_route_unsupported')
            raise DataError('uniswap_quote_route_disconnected')
        total_in += int(normalized[0]['amountInRaw'])
        total_out += int(normalized[-1]['amountOutRaw'])
        result.append(normalized)
    if total_in != int(amount_in) or total_out != int(amount_out):
        raise DataError('uniswap_quote_route_amount_mismatch')
    return result


def _provider_fees(quote, owner, currency, output, minimum):
    bps, amount, recipient = quote.get('portionBips'), quote.get('portionAmount'), quote.get('portionRecipient')
    bps = None if bps is None else _decimal(bps, maximum=10000)
    if bps is not None and (Fraction(bps) * 100).denominator != 1:
        raise DataError('invalid_uniswap_quote_fee')
    amount = _raw(amount, optional=True)
    recipient = None if recipient is None else address(recipient)
    if amount is not None and int(amount) > int(output):
        raise DataError('invalid_uniswap_quote_fee')
    if bps == 0 and amount is not None and int(amount) != 0:
        raise DataError('invalid_uniswap_quote_fee')
    outputs = quote.get('aggregatedOutputs')
    normalized = None
    has_fee_output = False
    if outputs is not None:
        if not isinstance(outputs, list) or not 1 <= len(outputs) <= 4:
            raise DataError('invalid_uniswap_quote_outputs')
        normalized, total, recipients = [], 0, set()
        for entry in outputs:
            if not isinstance(entry, dict) or address(entry.get('token')) != currency:
                raise DataError('uniswap_quote_currency_mismatch')
            target = address(entry.get('recipient'))
            if target in recipients or target == ZERO:
                raise DataError('invalid_uniswap_quote_outputs')
            recipients.add(target)
            value = _raw(entry.get('amount'))
            floor = _raw(entry.get('minAmount'))
            if int(floor) > int(value):
                raise DataError('invalid_uniswap_quote_outputs')
            weight = entry.get('bps')
            if weight is not None:
                weight = _decimal(weight, maximum=10000)
                if (Fraction(weight) * 100).denominator != 1:
                    raise DataError('invalid_uniswap_quote_outputs')
            kind = entry.get('fee')
            if kind not in (None, 'INTEGRATOR'):
                raise DataError('invalid_uniswap_quote_outputs')
            if target != owner or kind is not None:
                has_fee_output = True
            if target == owner and kind is not None:
                raise DataError('invalid_uniswap_quote_outputs')
            total += int(value)
            normalized.append({'recipient': target, 'amountRaw': value, 'minimumAmountRaw': floor,
                               'bps': None if weight is None else format(weight, 'f'), 'kind': kind})
        if total != int(output) or owner not in recipients:
            raise DataError('uniswap_quote_output_amount_mismatch')
        fee_outputs = [row for row in normalized if row['recipient'] != owner]
        fee_total = sum(int(row['amountRaw']) for row in fee_outputs)
        if amount is not None and fee_total != int(amount):
            raise DataError('uniswap_quote_output_amount_mismatch')
        if recipient is not None and any(row['recipient'] != recipient for row in fee_outputs):
            raise DataError('uniswap_quote_recipient_mismatch')
        weights = [row['bps'] for row in normalized]
        if all(weight is not None for weight in weights):
            if sum(Fraction(weight) for weight in weights) != 10000:
                raise DataError('invalid_uniswap_quote_outputs')
            if bps is not None and sum(Fraction(row['bps']) for row in fee_outputs) != Fraction(bps):
                raise DataError('invalid_uniswap_quote_fee')
    # A complete, explicitly 100% owner output is independent evidence even
    # when the optional legacy portion fields are absent. Keep those fields
    # null; do not invent a legacy zero or interpret an absent output list.
    aggregate_zero = (normalized is not None and len(normalized) == 1
        and normalized[0]['recipient'] == owner and normalized[0]['kind'] is None
        and normalized[0]['bps'] is not None and Fraction(normalized[0]['bps']) == 10000
        and normalized[0]['minimumAmountRaw'] == minimum)
    zero = not has_fee_output and ((bps == 0 and amount == '0') or aggregate_zero)
    nonzero = (bps is not None and bps > 0) or (amount is not None and int(amount) > 0) or has_fee_output
    if zero and normalized is not None and (len(normalized) != 1 or normalized[0]['minimumAmountRaw'] != minimum):
        raise DataError('uniswap_quote_output_amount_mismatch')
    return {'status': 'reported_zero' if zero else 'unsupported_nonzero' if nonzero else 'unknown',
        'basis': 'output_currency', 'currency': currency,
        'bps': None if bps is None else format(bps, 'f'), 'amountRaw': amount,
        'recipient': recipient, 'aggregatedOutputs': normalized,
        'zeroEvidence': 'aggregated_outputs' if zero and aggregate_zero else
                        'explicit_legacy_portion' if zero else None}


class UniswapQuote:
    """One fixed request. No retries, background refresh, quote cache or signer."""
    def __init__(self, api_key, *, transport=json_http, clock=time.time):
        self._api_key = checked_api_key(api_key)
        self._transport, self._clock = transport, clock

    def preview(self, *, owner, token_in, token_out, amount_raw, slippage_bps,
                max_price_impact_bps, chain_id=CHAIN_ID):
        if type(chain_id) is not int or chain_id != CHAIN_ID:
            raise DataError('uniswap_quote_chain_mismatch')
        owner, token_in, token_out = address(owner), address(token_in), address(token_out)
        if owner == ZERO or token_in == token_out:
            raise DataError('invalid_uniswap_quote_identity')
        amount_raw = _raw(amount_raw, positive=True)
        slippage_bps = _integer(slippage_bps, 0, 9999)
        max_price_impact_bps = _integer(max_price_impact_bps, 0, 10000)
        body = {'type': 'EXACT_INPUT', 'amount': amount_raw,
            'tokenInChainId': CHAIN_ID, 'tokenOutChainId': CHAIN_ID,
            'tokenIn': token_in, 'tokenOut': token_out, 'swapper': owner, 'recipient': owner,
            'slippageTolerance': slippage_bps / 100, 'routingPreference': 'BEST_PRICE',
            'protocols': ['V4'], 'hooksOptions': 'V4_NO_HOOKS',
            'generatePermitAsTransaction': False, 'permitAmount': 'EXACT'}
        started = _clock_value(self._clock)
        with read_deadline(TIMEOUT_SECONDS):
            try:
                payload = self._transport(ENDPOINT, body, timeout=TIMEOUT_SECONDS,
                    headers={'x-api-key': self._api_key, **TRADING_QUOTE_HEADERS})
            except Exception as error:
                code = str(error)
                safe = {'http_400': 'uniswap_quote_request_rejected',
                    'http_401': 'uniswap_quote_credentials_rejected',
                    'http_403': 'uniswap_quote_access_denied', 'http_404': 'uniswap_quote_no_route',
                    'http_429': 'uniswap_quote_rate_limited', 'response_too_large': 'uniswap_quote_response_too_large',
                    'read_deadline_exceeded': 'uniswap_quote_deadline_exceeded'}
                raise DataError(safe.get(code, 'uniswap_quote_unavailable') if isinstance(error, DataError)
                                else 'uniswap_quote_unavailable') from None
            result = self._normalize(payload, owner, token_in, token_out, amount_raw,
                                     slippage_bps, max_price_impact_bps)
            completed = _clock_value(self._clock)
            if completed < started or completed >= int(started) + VALIDITY_SECONDS:
                raise DataError('uniswap_quote_expired')
            result.update(requestedAt=int(started), retrievedAt=int(completed),
                          expiresAt=int(started) + VALIDITY_SECONDS)
            identity = {'owner': owner, 'chainId': CHAIN_ID, 'tokenIn': token_in, 'tokenOut': token_out,
                'amountRaw': amount_raw, 'slippageBps': slippage_bps,
                'maxPriceImpactBps': max_price_impact_bps}
            result['request'] = identity
            result['requestFingerprint'] = hashlib.sha256(json.dumps(identity, sort_keys=True,
                separators=(',', ':')).encode()).hexdigest()
            return result

    @staticmethod
    def _normalize(payload, owner, token_in, token_out, amount, slippage, impact_limit):
        if not isinstance(payload, dict) or 'error' in payload or 'code' in payload:
            raise DataError('invalid_uniswap_quote_response')
        if payload.get('routing') != 'CLASSIC':
            raise DataError('uniswap_quote_route_unsupported')
        quote = payload.get('quote')
        if not isinstance(quote, dict):
            raise DataError('invalid_uniswap_quote_response')
        if type(quote.get('chainId')) is not int or quote['chainId'] != CHAIN_ID:
            raise DataError('uniswap_quote_chain_mismatch')
        if address(quote.get('swapper')) != owner or quote.get('tradeType') != 'EXACT_INPUT':
            raise DataError('uniswap_quote_request_mismatch')
        if _decimal(quote.get('slippage')) != Decimal(slippage) / 100:
            raise DataError('uniswap_quote_slippage_mismatch')
        incoming, outgoing = quote.get('input'), quote.get('output')
        if not isinstance(incoming, dict) or not isinstance(outgoing, dict):
            raise DataError('invalid_uniswap_quote_response')
        if address(incoming.get('token')) != token_in or address(outgoing.get('token')) != token_out:
            raise DataError('uniswap_quote_currency_mismatch')
        if _raw(incoming.get('amount'), positive=True) != amount:
            raise DataError('uniswap_quote_input_mismatch')
        if incoming.get('maximumAmount') is not None and _raw(incoming['maximumAmount']) != amount:
            raise DataError('uniswap_quote_input_mismatch')
        if address(outgoing.get('recipient')) != owner:
            raise DataError('uniswap_quote_recipient_mismatch')
        output, minimum = _raw(outgoing.get('amount'), positive=True), _raw(outgoing.get('minimumAmount'), positive=True)
        floor = int(output) * (10000-slippage) // 10000
        if not floor <= int(minimum) <= int(output):
            raise DataError('uniswap_quote_minimum_output_mismatch')
        routes = _routes(quote.get('route'), token_in, token_out, amount, output)
        fees = _provider_fees(quote, owner, token_out, output, minimum)
        impact = quote.get('priceImpact')
        impact = None if impact is None else _decimal(impact, signed=True)
        checks = []
        if impact is None:
            checks.append('price_impact_unknown')
        elif Fraction(impact) * 100 > impact_limit:
            checks.append('price_impact_exceeded')
        if fees['status'] != 'reported_zero':
            checks.append('provider_output_fee_' + fees['status'])
        failures = quote.get('txFailureReasons')
        if failures is not None and (not isinstance(failures, list) or len(failures) > 16
                or any(not isinstance(item, str) or item not in FAILURE_CODES for item in failures)):
            raise DataError('invalid_uniswap_quote_simulation')
        if failures is None:
            checks.append('simulation_unknown')
        elif failures:
            checks.append('provider_simulation_failed')
        gas = {target: _raw(quote.get(source), optional=True) for source, target in (
            ('gasFee', 'feeWei'), ('gasUseEstimate', 'units'))}
        gas_usd = quote.get('gasFeeUSD')
        gas['usd'] = None if gas_usd is None else format(_decimal(gas_usd, maximum=10**30), 'f')
        gas.update(source='provider_estimate', includesApprovals=False, fullNetworkCostVerified=False)
        if gas['feeWei'] is None or gas['units'] is None:
            checks.append('gas_estimate_incomplete')
        approval = payload.get('isTokenApprovalApplicable')
        if approval is not None and type(approval) is not bool:
            raise DataError('invalid_uniswap_quote_approval_flag')
        block = quote.get('blockNumber')
        block = None if block is None else str(_integer(block, 0, 2**63-1, string=True))
        return {'schemaVersion': 1, 'source': SOURCE, 'chainId': CHAIN_ID,
            'status': 'preview_only', 'executionAvailable': False,
            'quote': {'dexInputAmountRaw': amount, 'grossOutputAmountRaw': output,
                'grossMinimumOutputAmountRaw': minimum, 'policyMinimumOutputRaw': str(floor),
                'outputAfterProviderFeeRaw': output if fees['status'] == 'reported_zero' else None,
                'minimumAfterProviderFeeRaw': minimum if fees['status'] == 'reported_zero' else None,
                'priceImpactPercent': None if impact is None else format(impact, 'f'), 'routes': routes},
            'previewChecks': {'status': 'within_observed_limits' if not checks else 'blocked', 'reasons': checks},
            'providerOutputFee': fees,
            'dominoFee': {'status': 'tariff_not_selected', 'bps': None, 'amountRaw': None,
                'basis': 'consumed_owner_selected_gross_input', 'ceilingBps': 65,
                'includedInDexInput': False, 'automationFeeApplies': False},
            'gas': gas, 'simulation': {'status': 'unknown' if failures is None else
                'provider_reported_failure' if failures else 'no_provider_failure_reported',
                'failureCodes': failures, 'independentSuccessProven': False},
            'approvalApplicable': approval,
            'provenance': {'endpoint': ENDPOINT, 'schemaCommit': SCHEMA_COMMIT,
                'routerVersion': '2.1.1', 'providerBlockNumber': block, 'providerBlockHash': None,
                'onchainSnapshotVerified': False, 'routeIdentity': 'provider_pool_key_hash_checked',
                'tokenTransferSafetyVerified': False, 'ownerControlVerified': False}}
