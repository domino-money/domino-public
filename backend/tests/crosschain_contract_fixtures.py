"""crosschain-v1 producer fixtures: real service answers over the recorded provider fixtures. No network.

Built in the contract's version, or (`version`) in 1.0.0-rc.1, as the switch window answers it: rc.1 requests, by exact
input only, whose answers must be main 26e264f7's rc.1 package fixtures byte for byte (fixtures/crosschain/rc1)."""
from copy import deepcopy

from crosschain_support import (CSRF, DEPOSIT_HASH, FILL_HASH, RELAY_REQUEST, SESSION, USDC_BASE, USDG, ZERO, FakeRpc,
                                across_record, default_routes, fill_receipt, fixture, make_service, output_request,
                                quote_request, quote_time, relay_record)
from crosschain_http import ProviderError
from crosschain_models import CONTRACT_VERSION, ERROR_STATUS_BY_CODE, PREVIOUS_VERSION

SPOKE_POOL_ROBINHOOD = '0xd29c85f15df544ba632c9e25829fd29d767d7978'
CLIENT = '192.0.2.1'
# The live answers by output of 6 Oct 2026 (crosschain_support): 100 USDG on Robinhood from Base's USDC, and 0.05 ETH
# on Robinhood from Base's ETH. Relay was asked the need grossed up by the 50 bps slippage, Across for its minOutput.
OUTPUT_USDG = ('relay-quote-expected-output-usdc-base-usdg.json', 'across-quote-min-output-usdc-base-usdg.json')
OUTPUT_ETH = ('relay-quote-expected-output-eth-base-robinhood.json', 'across-quote-min-output-eth-base-robinhood.json')


def output_service(answers):
    """The service answering a quote by output with one recorded pair, on the Across answer's clock."""
    relay, across = answers
    return make_service(relay_routes={('POST', '/quote/v2'): fixture(relay)},
                        across_routes={('GET', '/swap/approval'): fixture(across)}, clock=quote_time(across))[0]


def run(service, route, body, version=CONTRACT_VERSION):
    """The service's answer to `body` sent in `version`; an rc.1 quote request has no amountKind or maxInputRaw."""
    if version == PREVIOUS_VERSION and route == 'quote':
        body = {key: value for key, value in body.items() if key not in ('amountKind', 'maxInputRaw')}
    return service.execute(route, body, client=CLIENT, session=SESSION, csrf=CSRF, version=version)


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


def build_fixtures(version=CONTRACT_VERSION):
    relay_routes, across_routes = default_routes()
    service, _, _ = make_service(relay_routes=relay_routes, across_routes=across_routes)
    quote = quote_request()
    if version == PREVIOUS_VERSION:
        quote = {key: value for key, value in quote.items() if key not in ('amountKind', 'maxInputRaw')}
    requests = {'origins': {'destinationChainId': 4663, 'destinationToken': USDG},
                'quote': quote, 'status': status_request()}
    record, receipt = across_filled()
    tracker, _, _ = make_service(across_routes={('GET', '/deposit'): record}, rpc=FakeRpc(receipt))
    responses = {'origins': run(service, 'origins', requests['origins'], version),
                 'quote': run(service, 'quote', requests['quote'], version),
                 'status': run(tracker, 'status', requests['status'], version)}
    errors = {code: {'status': status, 'body': {'error': code}} for code, status in sorted(ERROR_STATUS_BY_CODE.items())}
    return requests, responses, errors


def build_variants(version=CONTRACT_VERSION):
    relay_routes, across_routes = default_routes()
    variants = {}
    # Destination gas asked for a USDG delivery: only Relay's top-up can serve it.
    gas_routes = {**relay_routes, ('POST', '/quote/v2'): fixture('relay-quote-usdc-arbitrum-usdg-topup.json')}
    service, _, _ = make_service(relay_routes=gas_routes, across_routes=across_routes)
    variants['quote.destination-gas'] = ('quote', run(service, 'quote', quote_request(gas=True), version))
    # Native ETH from Arbitrum to Robinhood through Across alone (Relay throttled).
    eth = {('GET', '/swap/approval'): fixture('across-quote-eth-arbitrum-robinhood.json')}
    service, _, _ = make_service(relay_routes={('POST', '/quote/v2'): ProviderError('relay_rate_limited')},
                                 across_routes=eth, clock=quote_time('across-quote-eth-arbitrum-robinhood.json'))
    variants['quote.native-only-across'] = ('quote', run(service, 'quote', quote_request(
        origin_token=ZERO, destination_token=ZERO, amount='50000000000000000'), version))
    # Neither provider admissible: Relay without the app fee, Across with no route.
    refused = {('POST', '/quote/v2'): fixture('relay-quote-no-app-fee.json')}
    no_route = {('GET', '/swap/approval'): ProviderError('across_request_rejected', 'ROUTE_NOT_ENABLED')}
    service, _, _ = make_service(relay_routes=refused, across_routes=no_route)
    variants['quote.none'] = ('quote', run(service, 'quote', quote_request(slippage=200), version))
    if version == CONTRACT_VERSION:
        variants.update(output_variants())
    # Relay tracking with the key: filled and the collected fee from /requests/v3.
    service, _, _ = make_service(relay_routes={('GET', '/intents/status/v3'): relay_status(),
                                               ('GET', '/requests/v3'): relay_record()})
    variants['status.relay-filled'] = ('status', run(service, 'status', status_request('relay'), version))
    service, _, _ = make_service(relay_routes={('GET', '/intents/status/v3'): fixture('relay-status-waiting.json')},
                                 relay_key=False)
    variants['status.relay-awaiting'] = ('status', run(service, 'status', status_request('relay', None), version))
    record, _ = across_filled()
    expired = deepcopy(record)
    expired['deposit'].update(status='expired', fillTx=None, fillTxnRef=None)
    service, _, _ = make_service(across_routes={('GET', '/deposit'): expired})
    variants['status.across-refund-pending'] = ('status', run(service, 'status', status_request(), version))
    # The indexer lags: a filled deposit read as not found keeps "filled".
    service, _, _ = make_service(across_routes={('GET', '/deposit'): ProviderError('across_not_found')})
    variants['status.across-held'] = ('status', run(service, 'status', status_request(previous='filled'), version))
    return variants


def output_variants():
    """Quotes by output (1.1.0-rc.1 only)."""
    variants = {}
    # By output: 100 USDG must arrive, and the wallet may send 150 USDC. Relay signed a minimum of exactly 100 USDG for
    # 100.916974 USDC; Across' minOutput takes 100.902201 USDC for 100.473291 USDG. Relay delivers more per USDC sent, so
    # it wins although it takes more, and the approval is for what its deposit takes.
    usdg = dict(origin=8453, origin_token=USDC_BASE)
    variants['quote.output'] = ('quote', run(output_service(OUTPUT_USDG), 'quote',
                                             output_request(100000000, max_input=150000000, **usdg)))
    # The same answers when the wallet may send only 100.91 USDC: Relay's deposit needs more (input_above_max, still
    # priced), and Across serves alone.
    variants['quote.output-above-max'] = ('quote', run(output_service(OUTPUT_USDG), 'quote',
                                                       output_request(100000000, max_input=100910000, **usdg)))
    # 0.05 ETH must arrive on Robinhood from Base's ETH: one native deposit whose value is Relay's input.
    variants['quote.output-native'] = ('quote', run(output_service(OUTPUT_ETH), 'quote', output_request(
        50000000000000000, max_input=60000000000000000, origin=8453, origin_token=ZERO, destination_token=ZERO)))
    return variants
