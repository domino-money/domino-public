"""Opt-in, serial loopback pool-market evidence; no catalogue, wallet or backfill."""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import socket
import subprocess
from threading import Thread
import time
import urllib.error
import urllib.request

from discovery import CHAIN_ID, DataError, bytes32, json_http
from local_config import load_config, configured_rpc_urls
from market_cache import MarketCache
from market_data import GeckoMarketData
from read_api import create_app
from read_contract import CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validate_response
from read_service import ReadService, bounded_transport
from rpc_failover import FailoverReadRpc

MAX_POOLS = 2
READ_SECONDS = 15
MAX_RPC_PER_READ = 160
MAX_HTTP_RESPONSE = 1024 * 1024
CASES = (('market_only', False), ('first_chart', True), ('cached_chart', True))


@dataclass
class Counters:
    rpcs: list = field(default_factory=list)
    market_requests: int = 0

    def snapshot(self):
        return {'rpcRequests': sum(rpc.count for rpc in self.rpcs),
                'marketRequests': self.market_requests}


def build_service(config, counters):
    """Only the explicit product config is used; environment overrides are ignored."""
    urls = configured_rpc_urls(config)

    def rpc_factory():
        rpc = FailoverReadRpc(urls, transport=bounded_transport(READ_SECONDS),
                              max_requests=MAX_RPC_PER_READ)
        counters.rpcs.append(rpc)
        return rpc

    def market_transport(url, body=None, *, timeout=5):
        counters.market_requests += 1
        return json_http(url, body, timeout=timeout)

    cache = MarketCache(GeckoMarketData(transport=market_transport))
    return ReadService(rpc_factory=rpc_factory, market_cache=cache, catalogue=None)


@contextmanager
def loopback_reader(service):
    """A fresh temporary listener, with the real API boundary and admission gate."""
    import uvicorn
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen(8)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(service, read_budget_seconds=READ_SECONDS),
        access_log=False, log_config=None, log_level='critical', proxy_headers=False,
        server_header=False, lifespan='off', timeout_graceful_shutdown=20))
    thread = Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
    try:
        thread.start()
        deadline = time.monotonic() + 5
        while not server.started:
            if not thread.is_alive() or time.monotonic() >= deadline:
                raise DataError('probe_listener_unavailable')
            time.sleep(0.01)
        yield port
    finally:
        server.should_exit = True
        thread.join(timeout=25)
        listener.close()
        if thread.is_alive():
            raise DataError('probe_listener_shutdown_incomplete')


def local_request(port, body):
    request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/read/pool-market',
        data=json.dumps(body).encode(), headers={'Content-Type': 'application/json',
        'X-Domino-Read-Budget-Ms': str(READ_SECONDS * 1000)})
    try:
        response = urllib.request.urlopen(request, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, ValueError):
        return 0, {}, {'error': 'probe_local_transport_unavailable'}
    with response:
        raw = response.read(MAX_HTTP_RESPONSE + 1)
        if len(raw) > MAX_HTTP_RESPONSE:
            return 0, {}, {'error': 'probe_response_too_large'}
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeError):
            return 0, {}, {'error': 'probe_invalid_json'}
        return response.status, dict(response.headers), payload


def public_observation(observation, *, chart=False):
    """Project only public fields; never preserve a URL or arbitrary provider text."""
    data = observation['data']
    projected = None
    if data is not None:
        fields = ('source', 'chainId', 'retrievedAt', 'asOfTimestamp', 'asOfBlock',
                  'providerReported', 'currencies', 'baseToken', 'quoteToken')
        projected = {name: data[name] for name in fields}
        if chart:
            projected.update({name: data[name] for name in
                ('currency', 'selectedToken', 'intervalSeconds', 'coverage', 'candles')})
        else:
            projected.update({name: data[name] for name in
                ('reportedLiquidityUsd', 'volume24hUsd')})
    return {'status': observation['status'], 'reason': observation['reason'],
            'cache': observation['cache'], 'data': projected}


def summarize_response(pool_id, status, headers, payload, *, observed_at):
    """Validate the existing wire model; a successful API reply is not an APR proof."""
    headers = {key.lower(): value for key, value in headers.items()}
    header_ok = (headers.get('x-domino-read-contract') == CONTRACT_VERSION and
                 headers.get('cache-control') == 'no-store')
    if status != 200:
        code = payload.get('error') if isinstance(payload, dict) else None
        safe = code if type(code) is str and ERROR_STATUS_BY_CODE.get(code) == status else 'probe_request_failed'
        return {'httpStatus': status, 'contractValid': False, 'headersValid': header_ok,
                'error': safe}
    try:
        validate_response('pool-market', payload)
        pool = payload['pool']
        if (payload['poolId'] != pool_id or pool['poolId'] != pool_id or
                payload['chainId'] != CHAIN_ID or payload['snapshot'] != pool['snapshot'] or
                pool['identityStatus'] != 'verified_at_block' or
                payload['requiresLocalHistory'] is not False or
                payload['providerMetricsReconciled'] is not False or
                payload['feeApr24h'] is not None or pool['feeApr24h'] is not None or
                payload['executionAvailable'] is not False or payload['suggested'] is not False):
            raise ValueError()
        age = observed_at - payload['snapshot']['timestamp']
        if age < 0:
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        return {'httpStatus': status, 'contractValid': False, 'headersValid': header_ok,
                'error': 'probe_response_contract_mismatch'}
    return {'httpStatus': status, 'contractValid': True, 'headersValid': header_ok,
        'snapshot': payload['snapshot'], 'snapshotAgeSecondsAtReceipt': age,
        'poolKey': pool['poolKey'], 'currencies': pool['currencies'],
        'identityStatus': pool['identityStatus'], 'integrationClass': pool['integrationClass'],
        'market': public_observation(payload['market']),
        'priceHistory': public_observation(payload['priceHistory'], chart=True),
        'feeApr24h': None, 'aprReason': payload['aprReason'], 'suggested': False,
        'executionAvailable': False, 'requiresLocalHistory': False,
        'providerMetricsReconciled': False}


def run_probe(port, pool_ids, counters, *, price_token='base', request=local_request,
              clock=time.monotonic, wall_clock=time.time, sleep=time.sleep):
    if (not 1 <= len(pool_ids) <= MAX_POOLS or len(set(pool_ids)) != len(pool_ids) or
            any(bytes32(pool_id) != pool_id for pool_id in pool_ids) or price_token not in ('base', 'quote')):
        raise ValueError('invalid_probe_selection')
    results = []
    for pool_id in pool_ids:
        for case, history in CASES:
            if results:
                sleep(1.05)  # Honor the unmodified reader's one-start-per-second gate.
            before = counters.snapshot()
            started = clock()
            body = {'poolId': pool_id, 'includePriceHistory': history, 'priceToken': price_token}
            status, headers, payload = request(port, body)
            elapsed = clock() - started
            after = counters.snapshot()
            results.append({'poolId': pool_id, 'case': case, 'request': body,
                'elapsedSeconds': round(elapsed, 6),
                'requests': {key: after[key] - before[key] for key in before},
                'observation': summarize_response(pool_id, status, headers, payload,
                                                  observed_at=int(wall_clock()))})
    return results


def write_report(path, report):
    # Exclusive creation preserves every failed/partial attempt as evidence.
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rpc-config', type=Path, required=True,
                        help='Private product providers.json; never a provider URL')
    parser.add_argument('--pool-id', action='append', required=True)
    parser.add_argument('--price-token', choices=('base', 'quote'), default='base')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if (not 1 <= len(args.pool_id) <= MAX_POOLS or len(set(args.pool_id)) != len(args.pool_id) or
                any(bytes32(value) != value for value in args.pool_id) or args.output.exists()):
            raise ValueError()
        config = load_config(args.rpc_config)
        if not config:
            raise ValueError()
        counters = Counters()
        service = build_service(config, counters)
        root = Path(__file__).resolve().parents[1]
        commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, check=True,
            capture_output=True, text=True).stdout.strip()
        report = {'schemaVersion': 1, 'mode': 'serial_live_loopback_pool_market_probe',
            'startedAt': datetime.now(timezone.utc).isoformat(), 'sourceCommit': commit,
            'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'readManifestSha256': hashlib.sha256((root / 'api-contracts/read-v1/manifest.json').read_bytes()).hexdigest(),
            'contractVersion': CONTRACT_VERSION, 'chainId': CHAIN_ID,
            'rpcEndpointCount': len(configured_rpc_urls(config)),
            'limits': {'pools': MAX_POOLS, 'casesPerPool': len(CASES),
                'readerDeadlineSeconds': READ_SECONDS, 'rpcRequestsPerRead': MAX_RPC_PER_READ,
                'marketRequestsPerMinute': service.market_cache.requests_per_minute},
            'catalogueConfigured': False, 'historicalBackfillStarted': False,
            'productionPricingQualified': False, 'financialTransactions': 0,
            'publicDeploymentChanged': False, 'concurrentClientsTested': False}
        with loopback_reader(service) as port:
            report['reads'] = run_probe(port, args.pool_id, counters, price_token=args.price_token)
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        report['requests'] = counters.snapshot()
        report['allResponsesValid'] = all(row['observation']['contractValid'] and
            row['observation']['headersValid'] for row in report['reads'])
        write_report(args.output, report)
        print(json.dumps({'status': 'report_saved', 'reads': len(report['reads']),
                          'allResponsesValid': report['allResponsesValid'],
                          'requests': report['requests']}))
        return 0 if report['allResponsesValid'] else 1
    except Exception:
        # Configs, provider URLs and arbitrary exception text never leave this CLI.
        print(json.dumps({'status': 'probe_failed', 'reason': 'probe_setup_or_output_failed'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
