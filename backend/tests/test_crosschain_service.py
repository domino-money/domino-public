"""The service: best route with wallet steps, origins, and tracking with transitions and fee measurement."""
from copy import deepcopy
import unittest

from crosschain_contract_fixtures import across_filled, relay_status, status_request
from crosschain_support import (CSRF, FEE, FILL_HASH, OTHER, OWNER, PRIVATE, SESSION, USDC_ARBITRUM,
                                USDG, ZERO, FakeAuth, FakeRpc, default_routes, fixture, make_service, quote_request,
                                quote_time, relay_record)
from discovery import DataError
from crosschain_http import ProviderError
from crosschain_models import CrosschainError, advance, validate_response
from crosschain_service import candidate_failure
from session_models import SessionError

DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
SPOKE_ARBITRUM = '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a'


def run(service, route, body):
    return service.execute(route, body, client='192.0.2.1', session=SESSION, csrf=CSRF)


class QuoteTests(unittest.TestCase):
    def quote(self, relay=None, across=None, body=None, **kwargs):
        relay_routes, across_routes = default_routes()
        if relay is not None:
            relay_routes[('POST', '/quote/v2')] = relay
        if across is not None:
            across_routes[('GET', '/swap/approval')] = across
        service, relay_http, across_http = make_service(relay_routes=relay_routes, across_routes=across_routes, **kwargs)
        return run(service, 'quote', body or quote_request())['quote'], relay_http, across_http

    def test_both_providers_are_quoted_with_the_fee_and_the_better_output_wins(self):
        quote, relay_http, across_http = self.quote()
        self.assertEqual(relay_http.calls[0]['body']['appFees'], [{'recipient': FEE, 'fee': '35'}])
        self.assertEqual(across_http.calls[0]['params']['appFeeRecipient'], FEE)
        self.assertEqual([c['status'] for c in quote['candidates']], ['quoted', 'quoted'])
        self.assertEqual((quote['decision'], quote['reason']), ('relay', 'best_output'))
        self.assertEqual(quote['comparison'], {'basis': 'expected_output_after_all_fees', 'advantageRaw': '8177', 'advantageBps': 0})
        self.assertEqual(quote['request']['owner'], OWNER)
        self.assertEqual((quote['appFeeBps'], quote['feeRecipient']), (35, FEE))
        approval, deposit = quote['steps']
        self.assertEqual(approval['approval'], {'token': USDC_ARBITRUM, 'spender': DEPOSITORY, 'amountRaw': '100000000'})
        self.assertEqual((deposit['transaction']['to'], deposit['transaction']['chainId'], deposit['transaction']['valueRaw']),
                         (DEPOSITORY, 42161, '0'))
        self.assertEqual(quote['expiresAt'] - quote['requestedAt'], 120)

    def test_across_wins_when_it_delivers_more(self):
        relay = fixture('relay-quote-usdc-arbitrum-usdg.json')
        for row in (relay['details']['currencyOut'], relay['protocol']['v2']['orderData']['output']['payments'][0]):
            key = 'amount' if 'amount' in row else 'expectedAmount'
            row[key] = '99000000'
        relay['details']['currencyOut']['minimumAmount'] = '98600000'
        relay['protocol']['v2']['orderData']['output']['payments'][0]['minimumAmount'] = '98600000'
        quote, _, _ = self.quote(relay=relay)
        self.assertEqual(quote['decision'], 'across')
        self.assertEqual(quote['steps'][0]['approval']['spender'], SPOKE_ARBITRUM)
        self.assertEqual(quote['steps'][1]['transaction']['to'], SPOKE_ARBITRUM)
        self.assertEqual(quote['comparison']['advantageRaw'], str(99563269 - 99000000))

    def test_equal_outputs_go_to_the_shorter_wait_then_relay(self):
        relay = fixture('relay-quote-usdc-arbitrum-usdg.json')
        across = fixture('across-quote-usdc-arbitrum-usdg-robinhood.json')
        for value in (relay['details']['currencyOut'], relay['protocol']['v2']['orderData']['output']['payments'][0]):
            value['amount' if 'amount' in value else 'expectedAmount'] = '99563269'
        relay['details']['timeEstimate'] = 5
        quote, _, _ = self.quote(relay=deepcopy(relay), across=across)
        self.assertEqual((quote['decision'], quote['comparison']['advantageRaw']), ('across', '0'))
        relay['details']['timeEstimate'] = 2
        quote, _, _ = self.quote(relay=relay, across=across)
        self.assertEqual(quote['decision'], 'relay')

    def test_destination_gas_can_only_be_served_by_relay(self):
        quote, _, _ = self.quote(relay=fixture('relay-quote-usdc-arbitrum-usdg-topup.json'), body=quote_request(gas=True))
        relay, across = quote['candidates']
        self.assertEqual((relay['status'], relay['destinationGas']), ('quoted', {'deliveredRaw': '740778127264099'}))
        self.assertEqual((across['status'], across['reason']), ('destination_gas_unsupported', 'destination_gas_unsupported'))
        self.assertEqual((quote['decision'], quote['reason']), ('relay', 'only_quote'))
        # Relay without a top-up in its answer cannot serve it either.
        quote, _, _ = self.quote(body=quote_request(gas=True))
        self.assertEqual((quote['decision'], quote['reason'], quote['steps']), (None, 'no_quote', []))

    def test_one_provider_failing_leaves_the_other(self):
        for error, status, reason in ((ProviderError('relay_rate_limited'), 'rate_limited', 'provider_rate_limited'),
                                      (ProviderError('relay_deadline_exceeded'), 'unavailable', 'provider_timeout'),
                                      (ProviderError('relay_request_rejected', 'AMOUNT_TOO_LOW'), 'amount_too_low', 'provider_amount_too_low'),
                                      (ProviderError('relay_request_rejected', 'NO_QUOTES'), 'no_route', 'provider_no_route'),
                                      (fixture('relay-quote-implicit-transfer.json'), 'unsafe', 'relay_quote_refund_recipient')):
            with self.subTest(reason=reason):
                quote, _, _ = self.quote(relay=error)
                self.assertEqual((quote['candidates'][0]['status'], quote['candidates'][0]['reason']), (status, reason))
                self.assertEqual((quote['decision'], quote['reason']), ('across', 'only_quote'))

    def test_no_admissible_quote_returns_no_steps(self):
        quote, _, _ = self.quote(relay=ProviderError('relay_unavailable'), across=ProviderError('across_credentials_rejected'))
        self.assertEqual((quote['decision'], quote['reason'], quote['steps']), (None, 'no_quote', []))
        self.assertEqual(quote['candidates'][1]['reason'], 'provider_credentials_rejected')

    def test_an_origin_without_pinned_contracts_is_not_quoted(self):
        # Cronos has a Relay Depository pinned but no Across SpokePool.
        quote, relay_http, across_http = self.quote(body=quote_request(origin=25, origin_token=ZERO))
        self.assertEqual(quote['candidates'][1]['status'], 'origin_not_supported')
        self.assertEqual(across_http.calls, [])
        self.assertEqual(len(relay_http.calls), 1)

    def test_the_session_wallet_cannot_be_the_fee_recipient(self):
        relay_routes, across_routes = default_routes()
        service, _, _ = make_service(relay_routes=relay_routes, across_routes=across_routes, auth=FakeAuth(owner=FEE))
        with self.assertRaisesRegex(CrosschainError, 'crosschain_route_unsupported'):
            run(service, 'quote', quote_request())

    def test_a_quote_that_outlives_its_window_is_refused(self):
        relay_routes, across_routes = default_routes()
        times = iter([quote_time(), quote_time() + 121, quote_time() + 121])
        service, _, _ = make_service(relay_routes=relay_routes, across_routes=across_routes)
        service.clock = lambda: next(times)
        with self.assertRaisesRegex(CrosschainError, 'preview_expired'):
            run(service, 'quote', quote_request())

    def test_invalid_requests_never_reach_a_provider(self):
        relay_routes, across_routes = default_routes()
        service, relay_http, across_http = make_service(relay_routes=relay_routes, across_routes=across_routes)
        for body in ({**quote_request(), 'owner': OTHER}, {**quote_request(), 'recipient': OTHER},
                     quote_request(destination_token=OTHER), quote_request(origin=4663), quote_request(slippage=501),
                     quote_request(amount='0'), {**quote_request(), 'originChainId': 42161.0},
                     quote_request(destination_token=ZERO, gas=True), quote_request(amount=str(2**128))):
            with self.subTest(body=body), self.assertRaisesRegex(CrosschainError, 'invalid_request'):
                run(service, 'quote', body)
        self.assertEqual((relay_http.calls, across_http.calls), ([], []))

    def test_a_session_failure_stops_before_any_provider(self):
        auth = FakeAuth()
        auth.error = SessionError('session_required')
        relay_routes, across_routes = default_routes()
        service, relay_http, _ = make_service(relay_routes=relay_routes, across_routes=across_routes, auth=auth)
        with self.assertRaises(SessionError):
            run(service, 'quote', quote_request())
        self.assertEqual(relay_http.calls, [])

    def test_private_values_never_leave(self):
        relay_routes, across_routes = default_routes()
        chains = deepcopy(relay_routes[('GET', '/chains')])
        chains['chains'][0]['solverCurrencies'][0]['symbol'] = PRIVATE[0]
        relay_routes[('GET', '/chains')] = chains
        service, _, _ = make_service(relay_routes=relay_routes, across_routes=across_routes)
        with self.assertRaisesRegex(CrosschainError, 'upstream_invalid_response'):
            run(service, 'origins', {'destinationChainId': 4663, 'destinationToken': USDG})

    def test_every_answer_satisfies_the_contract(self):
        quote, _, _ = self.quote()
        validate_response('quote', {'contractVersion': '1.0.0-rc.1', 'quote': quote})


class FailureMappingTests(unittest.TestCase):
    def test_failure_codes(self):
        cases = [(ProviderError('across_request_rejected', 'ROUTE_NOT_ENABLED'), ('no_route', 'provider_no_route')),
                 (ProviderError('across_not_found'), ('rejected', 'provider_request_rejected')),
                 (ProviderError('across_request_rejected', 'AMOUNT_TOO_HIGH'), ('amount_too_high', 'provider_amount_too_high')),
                 (ProviderError('across_invalid_response'), ('unavailable', 'provider_unavailable')),
                 (DataError('read_deadline_exceeded'), ('unavailable', 'provider_timeout')),
                 (DataError('across_quote_recipient'), ('unsafe', 'across_quote_recipient')),
                 (DataError('invalid_address'), ('unsafe', 'across_response_invalid')),
                 (KeyError('x'), ('unsafe', 'across_response_invalid'))]
        for error, expected in cases:
            with self.subTest(error=repr(error)):
                self.assertEqual(candidate_failure('across', error), expected)


class OriginsTests(unittest.TestCase):
    def test_origins_merge_both_listings_and_leave_out_the_destination(self):
        relay_routes, across_routes = default_routes()
        service, relay_http, across_http = make_service(relay_routes=relay_routes, across_routes=across_routes)
        origins = run(service, 'origins', {'destinationChainId': 4663, 'destinationToken': USDG})['origins']
        chains = {chain['chainId']: chain for chain in origins['chains']}
        self.assertNotIn(4663, chains)
        self.assertEqual(chains[42161]['name'], 'Arbitrum')
        usdc = next(t for t in chains[42161]['tokens'] if t['address'] == USDC_ARBITRUM)
        self.assertEqual((usdc['providers'], usdc['decimals'], usdc['symbol']), (['relay', 'across'], 6, 'USDC'))
        self.assertEqual([p['status'] for p in origins['providers']], ['listed', 'listed'])
        # Cached: a second request asks neither provider again.
        run(service, 'origins', {'destinationChainId': 4663, 'destinationToken': USDG})
        self.assertEqual((len(relay_http.calls), len(across_http.calls)), (1, 1))

    def test_a_throttled_provider_is_reported_and_the_other_still_lists(self):
        relay_routes, across_routes = default_routes()
        across_routes[('GET', '/available-routes')] = ProviderError('across_rate_limited')
        service, _, _ = make_service(relay_routes=relay_routes, across_routes=across_routes)
        origins = run(service, 'origins', {'destinationChainId': 8453, 'destinationToken': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'})['origins']
        self.assertEqual(origins['providers'][1], {'provider': 'across', 'status': 'rate_limited', 'reason': 'provider_rate_limited'})
        self.assertTrue(all(token['providers'] == ['relay'] for chain in origins['chains'] for token in chain['tokens']))

    def test_a_stale_listing_serves_while_the_provider_is_down(self):
        relay_routes, across_routes = default_routes()
        service, _, _ = make_service(relay_routes=relay_routes, across_routes=across_routes)
        clock = [0.0]
        service.listings.clock = lambda: clock[0]
        body = {'destinationChainId': 4663, 'destinationToken': USDG}
        first = run(service, 'origins', body)['origins']['chains']
        clock[0] = 700.0
        service.relay.http.routes[('GET', '/chains')] = ProviderError('relay_unavailable')
        self.assertEqual(run(service, 'origins', body)['origins']['chains'], first)
        clock[0] = 4000.0
        later = run(service, 'origins', body)['origins']
        self.assertEqual(later['providers'][0]['status'], 'unavailable')


class StatusTests(unittest.TestCase):
    def relay(self, status=None, record=None, key=True, previous='pending'):
        routes = {('GET', '/intents/status/v3'): status or relay_status()}
        if record is not None:
            routes[('GET', '/requests/v3')] = record
        service, http, _ = make_service(relay_routes=routes, relay_key=key)
        return run(service, 'status', status_request('relay', previous))['status'], http

    def across(self, record=None, rpc=None, previous='pending'):
        filled, receipt = across_filled()
        routes = {('GET', '/deposit'): filled if record is None else record}
        service, _, http = make_service(across_routes=routes, rpc=rpc if rpc is not None else FakeRpc(receipt))
        return run(service, 'status', status_request('across', previous))['status'], http

    def test_relay_filled_with_the_collected_fee(self):
        status, http = self.relay(record=relay_record())
        self.assertEqual((status['state'], status['transition'], status['terminal'], status['nextCheckSeconds']),
                         ('filled', 'advanced', True, None))
        self.assertEqual(status['fillTxHash'], FILL_HASH)
        self.assertEqual(status['fee'], {'status': 'measured', 'reason': None, 'amountRaw': '350000', 'chainId': 42161,
                                         'token': USDC_ARBITRUM, 'evidence': 'relay_requests_v3'})
        self.assertEqual([call['path'] for call in http.calls], ['/intents/status/v3', '/requests/v3'])

    def test_relay_fee_needs_the_key(self):
        status, http = self.relay(key=False)
        self.assertEqual(status['fee']['status'], 'unavailable')
        self.assertEqual(status['fee']['reason'], 'relay_api_key_missing')
        self.assertEqual(len(http.calls), 1)

    def test_relay_fee_not_collected_or_not_reported(self):
        self.assertEqual(self.relay(record=relay_record(actual='0'))[0]['fee']['status'], 'not_collected')
        self.assertEqual(self.relay(record=relay_record(actual=None))[0]['fee']['reason'], 'relay_fee_not_reported')

    def test_relay_answers_that_are_not_this_users_deposit(self):
        with self.assertRaisesRegex(CrosschainError, 'crosschain_deposit_not_found'):
            self.relay(status=relay_status(inTxHashes=['0x' + 'ee' * 32]))
        with self.assertRaisesRegex(CrosschainError, 'crosschain_deposit_not_found'):
            self.relay(record=relay_record(user=OTHER))

    def test_relay_failures_and_refunds_show_the_recovery(self):
        status, _ = self.relay(status=relay_status('failure', failReason='SLIPPAGE'))
        self.assertEqual((status['state'], status['recovery']), ('failed', {'kind': 'automatic_refund', 'chainId': 42161, 'recipient': OWNER}))
        self.assertEqual(status['nextCheckSeconds'], 300)
        status, _ = self.relay(status=relay_status('failure', refundFailReason='MANUAL_REFUND_REQUIRED'))
        self.assertEqual(status['recovery']['kind'], 'manual_recovery')
        status, _ = self.relay(status=relay_status('refund', txHashes=['0x' + 'bb' * 32]))
        self.assertEqual((status['state'], status['refundTxHash'], status['terminal']), ('refunded', '0x' + 'bb' * 32, True))

    def test_across_filled_with_the_fee_proven_on_the_destination(self):
        status, _ = self.across()
        self.assertEqual((status['state'], status['fee']['status'], status['fee']['evidence']), ('filled', 'measured', 'destination_receipt'))
        self.assertEqual((status['fee']['chainId'], status['fee']['token']), (4663, USDG))

    def test_across_waiting_expired_and_refunded(self):
        status, _ = self.across(record=ProviderError('across_not_found'), previous=None)
        self.assertEqual((status['state'], status['providerStatus'], status['nextCheckSeconds']), ('awaiting_deposit', None, 10))
        filled, _ = across_filled()
        expired = deepcopy(filled)
        expired['deposit'].update(status='expired', fillTx=None, fillTxnRef=None)
        status, _ = self.across(record=expired)
        self.assertEqual((status['state'], status['recovery']['kind'], status['fee']['status']), ('refund_pending', 'automatic_refund', 'pending'))
        refunded = deepcopy(expired)
        refunded['deposit'].update(status='refunded', depositRefundTxHash='0x' + 'ab' * 32, depositRefundTxnRef='0x' + 'ab' * 32)
        status, _ = self.across(record=refunded, previous='refund_pending')
        self.assertEqual((status['state'], status['refundTxHash'], status['recovery']['kind']), ('refunded', '0x' + 'ab' * 32, 'refunded'))

    def test_across_deposit_of_someone_else_is_not_found(self):
        filled, _ = across_filled()
        for field, value in (('depositor', OTHER), ('originChainId', '8453'), ('destinationChainId', '8453'),
                             ('depositTxnRef', '0x' + 'ee' * 32)):
            record = deepcopy(filled)
            record['deposit'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(CrosschainError, 'crosschain_deposit_not_found'):
                self.across(record=record)

    def test_a_lagging_provider_cannot_move_the_state_back(self):
        status, _ = self.across(record=ProviderError('across_not_found'), previous='filled')
        self.assertEqual((status['state'], status['observedState'], status['transition'], status['terminal']),
                         ('filled', 'awaiting_deposit', 'held', True))
        self.assertEqual(status['fee'], {'status': 'pending', 'reason': 'provider_regressed', 'amountRaw': None,
                                         'chainId': None, 'token': None, 'evidence': None})
        self.assertIsNone(status['fillTxHash'])

    def test_provider_failures_while_tracking(self):
        for error, code in ((ProviderError('across_rate_limited'), 'provider_rate_limited'),
                            (ProviderError('across_unavailable'), 'provider_unavailable'),
                            (ProviderError('across_request_rejected'), 'provider_request_rejected'),
                            ({'deposit': {'status': 7}}, 'upstream_invalid_response')):
            with self.subTest(code=code), self.assertRaisesRegex(CrosschainError, code):
                self.across(record=error)

    def test_a_fee_measurement_failure_does_not_fail_tracking(self):
        status, _ = self.relay(record=ProviderError('relay_rate_limited'))
        self.assertEqual((status['state'], status['fee']['status'], status['fee']['reason']),
                         ('filled', 'unavailable', 'provider_rate_limited'))


class TransitionTests(unittest.TestCase):
    def test_states_only_move_forward(self):
        self.assertEqual(advance(None, 'pending'), ('pending', 'initial'))
        self.assertEqual(advance('pending', 'pending'), ('pending', 'unchanged'))
        self.assertEqual(advance('awaiting_deposit', 'filled'), ('filled', 'advanced'))
        self.assertEqual(advance('pending', 'awaiting_deposit'), ('pending', 'held'))
        self.assertEqual(advance('refund_pending', 'filled'), ('refund_pending', 'held'))
        self.assertEqual(advance('refund_pending', 'refunded'), ('refunded', 'advanced'))
        self.assertEqual(advance('failed', 'refunded'), ('refunded', 'advanced'))
        self.assertEqual(advance('filled', 'refunded'), ('filled', 'held'))
        self.assertEqual(advance('refunded', 'pending'), ('refunded', 'held'))
        self.assertEqual(advance('refund_failed', 'refunded'), ('refunded', 'advanced'))


if __name__ == '__main__':
    unittest.main()
