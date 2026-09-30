"""Synthetic adapter outputs; no key, network, wallet or database needed."""
from onboarding_models import CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validate_request, validate_response
from test_uniswap_quote import QuoteTests, payload as quote_payload
from test_uniswap_position import PositionPreviewTests
from test_swap_route import fixture_plan


def build_fixtures():
    previews = {'swap-preview': QuoteTests().preview(),
                'position-preview': PositionPreviewTests().preview(),
                'swap-route': fixture_plan('uniswap')}
    requests = {route: {key: value for key, value in preview['request'].items() if key != 'owner'}
                for route, preview in previews.items()}
    responses = {route: {'contractVersion': CONTRACT_VERSION, 'preview': preview}
                 for route, preview in previews.items()}
    for route, value in requests.items():
        validate_request(route, value)
    for route, value in responses.items():
        validate_response(route, value)
    return requests, responses, {code: {'status': status, 'body': {'error': code}}
                                 for code, status in ERROR_STATUS_BY_CODE.items()}


def build_variants():
    data = quote_payload()
    for field in ('priceImpact', 'txFailureReasons', 'portionBips', 'portionAmount', 'gasFee', 'gasUseEstimate', 'gasFeeUSD'):
        data['quote'].pop(field)
    variants = {
        'swap-preview.unknown': ('swap-preview', QuoteTests().preview(data)),
        'position-preview.incomplete': ('position-preview', PositionPreviewTests().preview(
            budget0_raw=None, budget1_raw=None, native_balance_raw=None, native_gas_reserve_raw=None)),
        'position-preview.blocked': ('position-preview', PositionPreviewTests().preview(budget1_raw='1')),
        'position-preview.native': ('position-preview', PositionPreviewTests().preview(native=True)),
        'swap-route.native': ('swap-route', fixture_plan('native')),
        'swap-route.unfilled': ('swap-route', fixture_plan('unfilled')),
        'swap-route.pool': ('swap-route', fixture_plan('pool')),
        'swap-route.unavailable': ('swap-route', fixture_plan('unavailable')),
    }
    return {name: (route, validate_response(route, {'contractVersion': CONTRACT_VERSION, 'preview': preview}))
            for name, (route, preview) in variants.items()}
