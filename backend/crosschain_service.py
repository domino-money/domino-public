"""Deposit from another chain (S2): origins, best quote with wallet steps, and tracking with fee measurement.

Bound to a SIWE session like the onboarding previews: the session's wallet is
the depositor, the recipient on the destination and the refund address; the
browser names none of them. Never a signer: the wallet signs and sends every step.

Choosing between providers: both are quoted at once with Domino's 35 bps app fee.
The candidate that delivers more of the destination token to the user's wallet,
after every provider and app fee, wins; equal outputs go to the shorter time
estimate, then to Relay. Origin gas is shown for each but does not decide: both
need the same wallet transactions (an exact approval for an ERC-20, then one
deposit) and their gas figures are unverified provider estimates. A user who
asks for destination gas can only be served by Relay's top-up.
"""
from concurrent.futures import ThreadPoolExecutor
import contextvars
import json
import math
import re
import sys
import threading
import time

from pydantic import ValidationError

from discovery import DataError
import hop_log
from crosschain_common import APP_FEE_BPS, PROVIDERS, ZERO, fingerprint
from crosschain_http import ProviderError
from crosschain_models import (CONTRACT_VERSION, MAX_ORIGIN_CHAINS, MAX_ORIGIN_TOKENS, MAX_RESPONSE,
                               PINS, POLL_SECONDS, QUOTE_LIFETIME_SECONDS, TERMINAL, CrosschainError, advance,
                               approve_data, ranked, validate_request, validate_response)
from read_deadline import check_read_deadline

LISTING_TTL_SECONDS = 600
LISTING_STALE_SECONDS = 3600
SYMBOL = re.compile(r'[A-Za-z0-9.+_-]{1,24}')
# Provider error tokens that mean "no route for this request", for both APIs.
NO_ROUTE = frozenset((
    'NO_QUOTES', 'NO_SWAP_ROUTES_FOUND', 'NO_INTERNAL_SWAP_ROUTES_FOUND', 'UNSUPPORTED_ROUTE', 'UNSUPPORTED_CHAIN',
    'UNSUPPORTED_CURRENCY', 'INVALID_INPUT_CURRENCY', 'INVALID_OUTPUT_CURRENCY', 'CHAIN_DISABLED',
    'ROUTE_TEMPORARILY_RESTRICTED', 'INSUFFICIENT_LIQUIDITY', 'SWAP_IMPACT_TOO_HIGH', 'SWAP_QUOTE_FAILED',
    'UNSUPPORTED_EXECUTION_TYPE', 'ROUTE_NOT_ENABLED', 'SWAP_QUOTE_UNAVAILABLE', 'SWAP_LIQUIDITY_INSUFFICIENT',
    'SWAP_TYPE_NOT_SUPPORTED'))


def candidate_failure(provider, error):
    """(status, reason) for a provider that did not produce an admissible quote."""
    code = str(error)
    if isinstance(error, ProviderError):
        kind = code.removeprefix(provider + '_')
        token = (error.provider_code or '').upper()
        if kind == 'rate_limited':
            return 'rate_limited', 'provider_rate_limited'
        if kind in ('request_rejected', 'not_found'):
            if token in NO_ROUTE:
                return 'no_route', 'provider_no_route'
            if token == 'AMOUNT_TOO_LOW':
                return 'amount_too_low', 'provider_amount_too_low'
            if token == 'AMOUNT_TOO_HIGH':
                return 'amount_too_high', 'provider_amount_too_high'
            return 'rejected', 'provider_request_rejected'
        if kind == 'credentials_rejected':
            return 'unavailable', 'provider_credentials_rejected'
        if kind == 'deadline_exceeded':
            return 'unavailable', 'provider_timeout'
        return 'unavailable', 'provider_unavailable'
    if code == 'read_deadline_exceeded':
        return 'unavailable', 'provider_timeout'
    # Everything else is a refusal by this service's own checks of the answer.
    if isinstance(error, DataError) and re.fullmatch(provider + r'_[a-z0-9_]{1,50}', code):
        return 'unsafe', code
    return 'unsafe', provider + '_response_invalid'


def status_failure(error):
    """A provider failure while tracking, as a contract error."""
    code = str(error)
    if isinstance(error, ProviderError):
        kind = code.split('_', 1)[1]
        if kind == 'rate_limited':
            return CrosschainError('provider_rate_limited')
        if kind in ('request_rejected', 'not_found'):
            return CrosschainError('provider_request_rejected')
        return CrosschainError('provider_unavailable')
    if code == 'read_deadline_exceeded':
        return CrosschainError('request_timeout')
    return CrosschainError('upstream_invalid_response')


# The listener's name in its request records (authenticated_api's SERVICE_NAME for crosschain_api.PREFIX).
DECISION_SERVICE = 'internal-crosschain-v1'
# The decision record's whole vocabulary, as hop_log.ALLOWED_KEYS is the request line's.
DECISION_KEYS = frozenset(('service', 'route', 'record', 'originChainId', 'destinationChainId', 'decision', 'reason',
                           'fingerprint', *PROVIDERS, *(provider + 'Reason' for provider in PROVIDERS)))


def decision_record(answer):
    """What a quote decided, beside the listener's request line (hop_log), which holds no body: the chains, the
    provider that won or `none` and why, and each provider's status and reason, all fixed codes (the owner's request
    of 5 Oct 2026: the first quotes could not be traced to a provider). No address, amount or provider text; the first
    characters of the request's fingerprint tie it to the answer the Worker received, which carries the whole one."""
    request = answer['request']
    record = {'service': DECISION_SERVICE, 'route': 'quote', 'record': 'decision',
              'originChainId': request['originChainId'], 'destinationChainId': request['destinationChainId'],
              'decision': answer['decision'] or 'none', 'reason': answer['reason'],
              'fingerprint': answer['requestFingerprint'][:8]}
    for candidate in answer['candidates']:
        record[candidate['provider']] = candidate['status']
        if candidate['reason'] is not None:
            record[candidate['provider'] + 'Reason'] = candidate['reason']
    return {key: hop_log.safe_value(value) for key, value in record.items() if key in DECISION_KEYS}


def emit_decision(answer):
    # stderr, as hop_log's lines: a CLI running the service in process keeps its stdout contract.
    print(json.dumps(decision_record(answer), separators=(',', ':'), allow_nan=False), file=sys.stderr, flush=True)


def unpriced(provider, status, reason):
    return {'provider': provider, 'status': status, 'reason': reason, 'outputRaw': None, 'minimumOutputRaw': None,
            'appFee': None, 'providerFee': None, 'originGas': None, 'destinationGas': None, 'etaSeconds': None,
            'refund': None, 'tracking': None}


def public(candidate):
    return {key: value for key, value in candidate.items() if key not in ('approval', 'deposit')}


def steps_for(candidate, origin):
    steps = []
    if candidate['approval'] is not None:
        approval = candidate['approval']
        steps.append({'kind': 'approval', 'approval': approval, 'transaction': {
            'chainId': origin, 'to': approval['token'], 'valueRaw': '0',
            'data': approve_data(approval['spender'], int(approval['amountRaw']))}})
    steps.append({'kind': 'deposit', 'approval': None, 'transaction': {'chainId': origin, **candidate['deposit']}})
    return steps


class ListingCache:
    """Provider listings change rarely: one fetch per provider and key every ten minutes, stale up to an hour on failure."""
    def __init__(self, clock=time.monotonic):
        self.clock, self._rows, self._lock = clock, {}, threading.Lock()

    def get(self, key, fetch):
        now = self.clock()
        with self._lock:
            row = self._rows.get(key)
        if row is not None and now - row[0] < LISTING_TTL_SECONDS:
            return row[1]
        try:
            value = fetch()
        except DataError:
            if row is not None and now - row[0] < LISTING_STALE_SECONDS:
                return row[1]
            raise
        with self._lock:
            self._rows[key] = (now, value)
        return value


class CrosschainService:
    def __init__(self, auth, relay, across, *, fee_recipient, clock=time.time, monotonic=time.monotonic,
                 private_values=()):
        self.auth, self.relay, self.across = auth, relay, across
        self.fee_recipient, self.clock = fee_recipient, clock
        self.private_values = tuple(value for value in private_values if value)
        self.listings = ListingCache(monotonic)

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value < 2**53:
            raise CrosschainError('upstream_unavailable')
        return value

    def execute(self, route, body, *, client, session, csrf):
        try:
            request = validate_request(route, body).model_dump()
        except CrosschainError:
            raise
        except (DataError, ValidationError, ValueError, TypeError):
            raise CrosschainError('invalid_request') from None
        started = self._now()
        check_read_deadline()
        context = self.auth.begin(client, session, csrf)
        owner = context['owner']
        check_read_deadline()
        if route == 'origins':
            body = {'contractVersion': CONTRACT_VERSION, 'origins': self.origins(request)}
        elif route == 'quote':
            body = {'contractVersion': CONTRACT_VERSION, 'quote': self.quote(request, owner, started)}
        else:
            body = {'contractVersion': CONTRACT_VERSION, 'status': self.status(request, owner)}
        result = validate_response(route, body)
        encoded = json.dumps(result, allow_nan=False, separators=(',', ':'))
        if len(encoded.encode()) > MAX_RESPONSE or any(value in encoded for value in (*self.private_values, session, csrf) if value):
            raise CrosschainError('upstream_invalid_response')
        # A logout or CSRF rotation during the provider calls invalidates delivery.
        self.auth.finish(context)
        check_read_deadline()
        if route == 'quote' and result['quote']['expiresAt'] <= self._now():
            raise CrosschainError('preview_expired')
        return result

    # origins ----------------------------------------------------------------

    def origins(self, request):
        destination, token = request['destinationChainId'], request['destinationToken'].lower()
        listings, tokens = [], {}
        fetchers = (('relay', ('relay', 'chains'), self.relay.chains),
                    ('across', ('across', destination, token), lambda: self.across.routes(destination, token)))
        for provider, key, fetch in fetchers:
            try:
                rows = self.listings.get(key, fetch)
            except DataError as error:
                limited = str(error) == f'{provider}_rate_limited'
                listings.append({'provider': provider, 'status': 'rate_limited' if limited else 'unavailable',
                                 'reason': 'provider_rate_limited' if limited else 'provider_unavailable'})
                continue
            listings.append({'provider': provider, 'status': 'listed', 'reason': None})
            for chain, entries in rows.items():
                if chain == destination or chain not in PINS['chains'] or provider not in PINS['chains'][chain]:
                    continue
                for entry in entries:
                    row = tokens.setdefault(chain, {}).setdefault(entry['address'], {
                        'address': entry['address'], 'symbol': None, 'decimals': None, 'providers': []})
                    if row['symbol'] is None and isinstance(entry['symbol'], str) and SYMBOL.fullmatch(entry['symbol']):
                        row['symbol'] = entry['symbol']
                    if row['decimals'] is None and type(entry['decimals']) is int and 0 <= entry['decimals'] <= 255:
                        row['decimals'] = entry['decimals']
                    if provider not in row['providers']:
                        row['providers'].append(provider)
        chains = []
        for chain in sorted(tokens)[:MAX_ORIGIN_CHAINS]:
            rows = sorted(tokens[chain].values(), key=lambda row: row['address'])[:MAX_ORIGIN_TOKENS]
            for row in rows:
                row['providers'] = [p for p in PROVIDERS if p in row['providers']]
            chains.append({'chainId': chain, 'name': PINS['chains'][chain]['name'], 'tokens': rows})
        return {'schemaVersion': 1, 'destinationChainId': destination, 'destinationToken': token,
                'retrievedAt': int(self._now()), 'providers': listings, 'chains': chains}

    # quote ------------------------------------------------------------------

    def quote(self, request, owner, started):
        identity = {'owner': owner, 'originChainId': request['originChainId'],
                    'originToken': request['originToken'].lower(), 'destinationChainId': request['destinationChainId'],
                    'destinationToken': request['destinationToken'].lower(), 'amountRaw': request['amountRaw'],
                    'slippageBps': request['slippageBps'], 'destinationGas': request['destinationGas']}
        if owner in (ZERO, self.fee_recipient):
            raise CrosschainError('crosschain_route_unsupported')
        call = {**identity, 'amount': int(request['amountRaw'])}
        jobs = {'relay': lambda: self.relay.quote(call), 'across': lambda: self.across.quote(call, now=int(started))}
        candidates = {}
        runnable = {}
        for provider in PROVIDERS:
            if PINS['chains'].get(call['originChainId'], {}).get(provider) is None:
                candidates[provider] = unpriced(provider, 'origin_not_supported', 'origin_chain_not_pinned')
            else:
                runnable[provider] = jobs[provider]
        if runnable:
            with ThreadPoolExecutor(max_workers=len(runnable), thread_name_prefix='crosschain-quote') as pool:
                futures = {provider: pool.submit(contextvars.copy_context().run, job) for provider, job in runnable.items()}
                for provider, future in futures.items():
                    try:
                        candidates[provider] = future.result()
                    except Exception as error:
                        candidates[provider] = unpriced(provider, *candidate_failure(provider, error))
        check_read_deadline()
        for candidate in candidates.values():
            if candidate['status'] == 'quoted' and call['destinationGas'] and candidate['destinationGas'] is None:
                candidate.update(status='destination_gas_unsupported', reason='destination_gas_unsupported')
        ordered = [candidates[provider] for provider in PROVIDERS]
        best = ranked(ordered)
        decision = best[0] if best else None
        advantage = int(best[0]['outputRaw']) - int(best[1]['outputRaw']) if len(best) == 2 else None
        completed = self._now()
        if completed < started or completed >= int(started) + QUOTE_LIFETIME_SECONDS:
            raise CrosschainError('preview_expired')
        answer = {'schemaVersion': 1, 'source': 'crosschain_quote_v1', 'requestedAt': int(started),
                'retrievedAt': int(completed), 'expiresAt': int(started) + QUOTE_LIFETIME_SECONDS,
                'requestFingerprint': fingerprint(identity), 'request': identity,
                'appFeeBps': APP_FEE_BPS, 'feeRecipient': self.fee_recipient,
                'decision': decision['provider'] if decision else None,
                'reason': 'no_quote' if not best else 'only_quote' if len(best) == 1 else 'best_output',
                'comparison': {'basis': 'expected_output_after_all_fees',
                               'advantageRaw': None if advantage is None else str(advantage),
                               'advantageBps': None if advantage is None else advantage * 10000 // int(best[1]['outputRaw'])},
                'candidates': [public(candidate) for candidate in ordered],
                'steps': steps_for(decision, call['originChainId']) if decision else []}
        emit_decision(answer)
        return answer

    # status -----------------------------------------------------------------

    def status(self, request, owner):
        provider, previous = request['provider'], request['previousState']
        origin, destination = request['originChainId'], request['destinationChainId']
        deposit_hash = request['depositTxHash'].lower()
        request_id = request['requestId'].lower() if request['requestId'] else None
        identity = {**request, 'owner': owner, 'depositTxHash': deposit_hash, 'requestId': request_id}
        fill = refund = record = None
        try:
            if provider == 'relay':
                observation = self.relay.observe(request_id)
                if observation['inTxHashes'] and deposit_hash not in observation['inTxHashes']:
                    raise CrosschainError('crosschain_deposit_not_found')
                observed, provider_status = observation['state'], observation['providerStatus']
                outgoing = observation['txHashes']
                fill = outgoing[-1] if observed == 'filled' and outgoing else None
                refund = outgoing[-1] if observed == 'refunded' and outgoing else None
            else:
                record = self.across.observe(deposit_hash)
                if record is None:
                    observed, provider_status = 'awaiting_deposit', None
                else:
                    if (record['depositor'] != owner or record['originChainId'] != origin
                            or record['destinationChainId'] != destination
                            or record['depositTxHash'] not in (None, deposit_hash)):
                        raise CrosschainError('crosschain_deposit_not_found')
                    observed, provider_status = record['state'], record['providerStatus']
                    fill, refund = record['fillTxHash'], record['refundTxHash']
        except CrosschainError:
            raise
        except Exception as error:
            raise status_failure(error) from None
        state, transition = advance(previous, observed)
        if state == 'filled' and transition != 'held':
            fee = self._fee(provider, request_id, record, owner, destination)
        else:
            fee = {'status': 'pending', 'reason': 'provider_regressed' if transition == 'held' else 'deposit_not_filled',
                   'amountRaw': None, 'chainId': None, 'token': None, 'evidence': None}
        recovery_kind = {'refund_pending': 'automatic_refund', 'failed': 'automatic_refund',
                         'refunded': 'refunded', 'refund_failed': 'manual_recovery'}.get(state)
        return {'schemaVersion': 1, 'request': identity, 'checkedAt': int(self._now()),
                'providerStatus': provider_status, 'observedState': observed, 'state': state,
                'transition': transition, 'terminal': state in TERMINAL,
                'nextCheckSeconds': POLL_SECONDS[provider].get(state),
                'fillTxHash': fill if state == 'filled' else None,
                'refundTxHash': refund if state == 'refunded' else None,
                'recovery': None if recovery_kind is None else {'kind': recovery_kind, 'chainId': origin, 'recipient': owner},
                'fee': fee}

    def _fee(self, provider, request_id, record, owner, destination):
        def unknown(status, reason):
            return {'status': status, 'reason': reason, 'amountRaw': None, 'chainId': None, 'token': None, 'evidence': None}
        try:
            if provider == 'relay':
                if not self.relay.has_key:
                    return unknown('unavailable', 'relay_api_key_missing')
                row = self.relay.record(request_id)
                if row is None:
                    return unknown('pending', 'relay_record_missing')
                if row['user'] is not None and row['user'] != owner:
                    raise CrosschainError('crosschain_deposit_not_found')
                if row['actualRaw'] is None or row['currency'] is None:
                    return unknown('pending', 'relay_fee_not_reported')
                status = 'measured' if row['actualRaw'] > 0 else 'not_collected'
                return {'status': status, 'reason': None, 'amountRaw': str(row['actualRaw']),
                        'chainId': row['currency']['chainId'], 'token': row['currency']['token'],
                        'evidence': 'relay_requests_v3'}
            status, amount, token, evidence, reason = self.across.fee(record, owner)
            if amount is None:
                return unknown(status, reason)
            return {'status': status, 'reason': reason, 'amountRaw': str(amount), 'chainId': destination,
                    'token': token, 'evidence': evidence}
        except CrosschainError:
            raise
        except ProviderError as error:
            return unknown('unavailable', 'provider_rate_limited' if str(error).endswith('_rate_limited') else 'provider_unavailable')
        except DataError:
            return unknown('unavailable', 'fee_record_invalid')
