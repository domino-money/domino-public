#!/usr/bin/env python3
"""Read-only loopback smoke for the no-transform listener candidate.

Run explicitly on the VM with Python 3.14. No repository imports, credentials,
redirects, proxy environment, wallet inputs or external RPC. Only the reader's
catalogue SELECT can reach a database. Private requests omit service identity.
Expectations: read_api.py, read_gateway.py, session_api.py, authenticated_api.py,
catalogue.py and the four contract models. No endpoint is enabled by this file.
The new private cache policy intentionally fails against the earlier a5a855c
installation until these listener changes are rolled out.
The output describes HTTP observations, not installed source identity. Record
the release's installed.json commit and a successful check_filesystem.py --commit
result beside each run; see docs/STAGING_BACKEND_HANDOFF.md.
installed.json is historical: its upgrade-state.json, when present, must not have
phase rolled_back, and exact current unit references plus verified source identity must
match the chosen installed commit; see docs/VM_DISABLED_UPGRADE.md.
"""
import hashlib
import http.client
import json
import re
import signal
import sys
import time

MAX_BODY, REQUEST_SECONDS, TOTAL_SECONDS = 16384, 4, 60
CSP = "default-src 'none'; frame-ancestors 'none'"
READ_VERSION, GENERATION = '1.1.0-rc.3', None
SERVICES = (
    ('gateway', 8878, 'read', READ_VERSION, ('token', 'pools', 'pool-market',
     'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity', 'pool-positions', 'pool-metrics')),
    ('auth', 8879, 'session', '3.0.0-rc.3', ('bootstrap', 'challenge', 'verify', 'me', 'refresh', 'logout')),
    ('onboarding', 8880, 'onboarding', '1.0.0', ('swap-preview', 'position-preview')),
    ('deposit', 8881, 'deposit', '1.1.0-rc.4', ('create', 'get', 'list', 'prepare', 'report', 'reconcile', 'cancel', 'allowances')),
)


def require(condition, label):
    if not condition:
        raise AssertionError(label)


def check_cache_policy(value, *, private):
    directives = {item.strip().lower() for item in (value or '').split(',')}
    require('no-store' in directives, 'no_store_required')
    if private:
        require('no-transform' in directives, 'no_transform_required')


def expired(*_):
    raise TimeoutError('smoke_deadline')


def strict_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, 'duplicate_json_key')
        value[key] = item
    return value


def check(name, port, method, path, status, expected, kind='Read', version=READ_VERSION,
          secured=True, body=None, extra=None):
    global GENERATION
    started = time.monotonic()
    item = {'name': name, 'port': port, 'method': method, 'path': path, 'passed': False}
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=REQUEST_SECONDS)
    try:
        remaining = DEADLINE - started
        require(remaining > 0, 'total_deadline_exceeded')
        signal.setitimer(signal.ITIMER_REAL, min(REQUEST_SECONDS, remaining))
        headers = {'Accept': 'application/json', 'Connection': 'close',
                   f'X-Domino-{kind}-Contract': version, **(extra or {})}
        payload = None if method != 'POST' else json.dumps(body or {}, separators=(',', ':')).encode()
        if payload is not None:
            headers['Content-Type'] = 'application/json'
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        pairs = [(key.lower(), value) for key, value in response.getheaders()]
        require(len({key for key, _ in pairs}) == len(pairs), 'duplicate_response_header')
        observed = dict(pairs)
        require(sum(len(k) + len(v) for k, v in pairs) <= 8192, 'response_headers_too_large')
        raw = response.read(MAX_BODY + 1)
        item.update(status=response.status, bodyBytes=len(raw), bodySha256=hashlib.sha256(raw).hexdigest())
        require(len(raw) <= MAX_BODY, 'response_body_too_large')
        require(response.status == status, 'unexpected_http_status')
        require(observed.get('content-length') == str(len(raw)), 'content_length_mismatch')
        require(observed.get('content-encoding', 'identity') == 'identity', 'identity_encoding_required')
        require(observed.get('content-type', '').split(';')[0].strip() == 'application/json', 'json_required')
        require(observed.get(f'x-domino-{kind.lower()}-contract') == version, 'contract_version_mismatch')
        require(not any(k.startswith('access-control-') or k == 'set-cookie' for k in observed), 'cors_or_cookie_exposed')
        if secured:
            check_cache_policy(observed.get('cache-control'), private=port != 8876)
            require(observed.get('x-content-type-options') == 'nosniff', 'nosniff_required')
            require(observed.get('content-security-policy') == CSP, 'csp_mismatch')
        if port == 8876:
            generation = observed.get('x-domino-reader-generation', '')
            require(re.fullmatch('[0-9a-f]{32}', generation), 'reader_generation_required')
            require(GENERATION in (None, generation), 'reader_restarted_during_smoke')
            GENERATION = generation
        else:
            require(re.fullmatch('[0-9a-f]{32}', observed.get('x-domino-request-id', '')), 'request_id_required')
        value = json.loads(raw, object_pairs_hook=strict_object, parse_constant=lambda _: expired())
        if expected == 'health':
            require(value == {'status': 'ok', 'mode': 'local_read_only', 'generation': GENERATION,
                             'readBudgetSeconds': 15, 'busy': False}, 'reader_health_mismatch')
        elif expected == 'catalogue':
            subset = {'schemaVersion': 1, 'chainId': 4663, 'mode': 'stored_catalogue_candidates',
                      'coverage': 'configured_interval_only', 'completeHistory': False, 'liveExecution': False,
                      'items': [], 'hasMore': False, 'nextAfterPoolId': None,
                      'poolManager': '0x8366a39cc670b4001a1121b8f6a443a643e40951'}
            require(all(value.get(k) == v for k, v in subset.items()), 'catalogue_empty_result_mismatch')
            require(type(value.get('revision')) is int and value['revision'] >= 0, 'catalogue_revision_invalid')
        else:
            require(value == expected, 'response_json_mismatch')
        item['passed'] = True
    except Exception as error:
        item['failure'] = str(error) if isinstance(error, AssertionError) else type(error).__name__
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        connection.close()
        item['elapsedSeconds'] = round(time.monotonic() - started, 3)
        RESULTS.append(item)


def main():
    global DEADLINE, RESULTS
    require(len(sys.argv) == 1, 'no_arguments_supported')
    started = time.monotonic()
    DEADLINE, RESULTS = started + TOTAL_SECONDS, []
    signal.signal(signal.SIGALRM, expired)
    check('reader-health', 8876, 'GET', '/health', 200, 'health')
    check('reader-origin-denied', 8876, 'GET', '/health', 403,
          {'error': 'local_client_required'}, secured=False, extra={'Origin': 'https://smoke.invalid'})
    check('reader-method-denied', 8876, 'GET', '/v1/read/catalogue', 405, {'detail': 'Method Not Allowed'})
    check('reader-route-denied', 8876, 'GET', '/v1/read/not-a-route', 404, {'detail': 'Not Found'})
    check('reader-catalogue-empty', 8876, 'POST', '/v1/read/catalogue', 200, 'catalogue',
          body={'token': '0x' + '00' * 20, 'limit': 1})
    for service, port, kind, version, routes in SERVICES:
        options = {'kind': kind.title(), 'version': version}
        prefix = f'/internal/{kind}/v1/'
        for route in routes:
            check(f'{service}-disabled-{route}', port, 'POST', prefix + route, 404, {'error': 'route_not_available'}, **options)
        for method in ('GET', 'OPTIONS'):
            status = 405 if service == 'gateway' else 404
            error = 'method_not_allowed' if status == 405 else 'route_not_available'
            check(f'{service}-{method.lower()}-denied', port, method, prefix + routes[0], status, {'error': error}, **options)
        check(f'{service}-health-not-exposed', port, 'GET', '/health', 404, {'error': 'route_not_available'}, **options)
        check(f'{service}-route-denied', port, 'POST', prefix + 'not-a-route', 404, {'error': 'route_not_available'}, **options)
    passed = len(RESULTS) == 46 and all(row['passed'] for row in RESULTS)
    print(json.dumps({'status': 'passed' if passed else 'failed', 'listenerHeaderPolicy': 'no-store_no-transform_identity',
                      'checks': RESULTS, 'complete': len(RESULTS) == 46, 'requestLimit': 46,
                      'elapsedSeconds': round(time.monotonic() - started, 3)}, indent=2))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
