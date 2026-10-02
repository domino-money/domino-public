"""crosschain-v1 producer fixtures: real service answers over the recorded provider fixtures. No network."""
from copy import deepcopy

from crosschain_support import (CSRF, DEPOSIT_HASH, FILL_HASH, RELAY_REQUEST, SESSION, USDG, ZERO, FakeRpc,
                                across_record, default_routes, fill_receipt, fixture, make_service, quote_request,
                                quote_time, relay_record)
from crosschain_http import ProviderError
from crosschain_models import ERROR_STATUS_BY_CODE

SPOKE_POOL_ROBINHOOD = '0xd29c85f15df544ba632c9e25829fd29d767d7978'
CLIENT = '192.0.2.1'


def run(service, route, body):
    return service.execute(route, body, client=CLIENT, session=SESSION, csrf=CSRF)


def status_request(provider='across', previous='pending'):
    return {'provider': provider, 'originChainId': 42161, 'destinationChainId': 4663, 'depositTxHash': DEPOSIT_HASH,
            'requestId': RELAY_REQUEST if provider == 'relay' else None, 'previousState': previous}


def relay_status(status='success', **changes):
    body = {'status': status, 'inTxHashes': [DEPOSIT_HASH], 'txHashes': [FILL_HASH] if status == 'success' else [],
            'updatedAt': 1790905000000, 'originChainId': 42161, 'destinationChainId': 4663,
            'failReason': 'N/A', 'refundFailReason': 'N/A'}
    body.update(changes)
    return body


def across_filled():
    record = across_record('across-quote-usdc-arbitrum-usdg-robinhood.json', origin=42161)
    fee = int(record['deposit']['outputAmount']) * 35 // 10000
    return record, fill_receipt(record, spoke_pool=SPOKE_POOL_ROBINHOOD, fee=fee)


def build_fixtures():
    relay_routes, across_routes = default_routes()
    service, _, _ = make_service(relay_routes=relay_routes, across_routes=across_routes)
    requests = {'origins': {'destinationChainId': 4663, 'destinationToken': USDG},
                'quote': quote_request(), 'status': status_request()}
    record, receipt = across_filled()
    tracker, _, _ = make_service(across_routes={('GET', '/deposit'): record}, rpc=FakeRpc(receipt))
    responses = {'origins': run(service, 'origins', requests['origins']),
                 'quote': run(service, 'quote', requests['quote']),
                 'status': run(tracker, 'status', requests['status'])}
    errors = {code: {'status': status, 'body': {'error': code}} for code, status in sorted(ERROR_STATUS_BY_CODE.items())}
    return requests, responses, errors


def build_variants():
    relay_routes, across_routes = default_routes()
    variants = {}
    # Destination gas asked for a USDG delivery: only Relay's top-up can serve it.
    gas_routes = {**relay_routes, ('POST', '/quote/v2'): fixture('relay-quote-usdc-arbitrum-usdg-topup.json')}
    service, _, _ = make_service(relay_routes=gas_routes, across_routes=across_routes)
    variants['quote.destination-gas'] = ('quote', run(service, 'quote', quote_request(gas=True)))
    # Native ETH from Arbitrum to Robinhood through Across alone (Relay throttled).
    eth = {('GET', '/swap/approval'): fixture('across-quote-eth-arbitrum-robinhood.json')}
    service, _, _ = make_service(relay_routes={('POST', '/quote/v2'): ProviderError('relay_rate_limited')},
                                 across_routes=eth, clock=quote_time('across-quote-eth-arbitrum-robinhood.json'))
    variants['quote.native-only-across'] = ('quote', run(service, 'quote', quote_request(
        origin_token=ZERO, destination_token=ZERO, amount='50000000000000000')))
    # Neither provider admissible: Relay without the app fee, Across with no route.
    refused = {('POST', '/quote/v2'): fixture('relay-quote-no-app-fee.json')}
    no_route = {('GET', '/swap/approval'): ProviderError('across_request_rejected', 'ROUTE_NOT_ENABLED')}
    service, _, _ = make_service(relay_routes=refused, across_routes=no_route)
    variants['quote.none'] = ('quote', run(service, 'quote', quote_request(slippage=200)))
    # Relay tracking with the key: filled and the collected fee from /requests/v3.
    service, _, _ = make_service(relay_routes={('GET', '/intents/status/v3'): relay_status(),
                                               ('GET', '/requests/v3'): relay_record()})
    variants['status.relay-filled'] = ('status', run(service, 'status', status_request('relay')))
    service, _, _ = make_service(relay_routes={('GET', '/intents/status/v3'): fixture('relay-status-waiting.json')},
                                 relay_key=False)
    variants['status.relay-awaiting'] = ('status', run(service, 'status', status_request('relay', None)))
    record, _ = across_filled()
    expired = deepcopy(record)
    expired['deposit'].update(status='expired', fillTx=None, fillTxnRef=None)
    service, _, _ = make_service(across_routes={('GET', '/deposit'): expired})
    variants['status.across-refund-pending'] = ('status', run(service, 'status', status_request()))
    # The indexer lags: a filled deposit read as not found keeps "filled".
    service, _, _ = make_service(across_routes={('GET', '/deposit'): ProviderError('across_not_found')})
    variants['status.across-held'] = ('status', run(service, 'status', status_request(previous='filled')))
    return variants
