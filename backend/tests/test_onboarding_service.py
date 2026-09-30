"""Session binding with actual preview adapters and offline provider payloads."""
from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path[:0] = [str(Path(__file__).resolve().parents[1])]
from discovery import DataError
from onboarding_models import OnboardingError
from onboarding_service import OnboardingService
from read_deadline import read_deadline
from session_models import SessionError
from uniswap_quote import UniswapQuote
from uniswap_position import UniswapPosition
from test_uniswap_quote import Transport as QuoteTransport, OWNER, OTHER, A, B
from test_uniswap_position import response as position_payload, Transport as PositionTransport

SESSION, CSRF, KEY = 's'*43, 'c'*43, 'synthetic-provider-api-key'


def make_service(*, route='swap-preview', clock=lambda:1000.5):
    if route == 'swap-preview':
        body = {'chainId':4663, 'tokenIn':A, 'tokenOut':B, 'amountRaw':'1000',
                'slippageBps':50, 'maxPriceImpactBps':100}
        owner, transport = OWNER, QuoteTransport()
        adapter = UniswapQuote(KEY, transport=transport, clock=clock)
    else:
        data, context = position_payload()
        owner = context['owner']
        key = context['pool_key']
        body = {'chainId':4663,'poolId':context['pool_id'],
            'poolKey':dict(currency0=key.currency0,currency1=key.currency1,
                           fee_pips=key.fee_pips,tick_spacing=key.tick_spacing,hooks=key.hooks),
            'independentToken':key.currency0, 'amountRaw':'100','tickLower':-120,'tickUpper':180,
            'slippageBps':50,'budget0Raw':'110','budget1Raw':'220',
            'nativeBalanceRaw':'1000','nativeGasReserveRaw':'300'}
        transport = PositionTransport(data)
        adapter = UniswapPosition(KEY, transport=transport, clock=clock)
    auth = SimpleNamespace(begin=Mock(return_value={'owner':owner,'session':SESSION,'csrf':CSRF,'validation':{}}),
                           finish=Mock())
    service = OnboardingService(auth, adapter if route=='swap-preview' else None,
                                adapter if route=='position-preview' else None,
                                clock=clock, private_values=(KEY,))
    return service, auth, transport, body


class OnboardingServiceTests(unittest.TestCase):
    def run_preview(self, service, body, route='swap-preview'):
        return service.execute(route,body,client='192.0.2.1',session=SESSION,csrf=CSRF)

    def test_actual_quote_and_position_adapters_receive_authenticated_owner(self):
        for route in ('swap-preview','position-preview'):
            with self.subTest(route=route):
                service, auth, transport, body = make_service(route=route)
                result = self.run_preview(service,body,route)
                self.assertEqual(result['contractVersion'],'1.1.0')
                self.assertFalse(result['preview']['executionAvailable'])
                self.assertEqual(result['preview']['request']['owner'],auth.begin.return_value['owner'])
                auth.begin.assert_called_once_with('192.0.2.1',SESSION,CSRF)
                auth.finish.assert_called_once_with(auth.begin.return_value)
                self.assertEqual(len(transport.calls),1)
                sent = transport.calls[0][1]
                self.assertEqual(sent.get('swapper',sent.get('walletAddress')),auth.begin.return_value['owner'])
                for secret in (SESSION,CSRF,KEY,'dd46508f'):
                    self.assertNotIn(secret,json.dumps(result))

    def test_browser_identity_fields_never_reach_auth_or_provider(self):
        for route in ('swap-preview','position-preview'):
            for field in ('owner','wallet','recipient','tenant','session','csrf','calldata','apiKey','url'):
                service, auth, transport, body = make_service(route=route)
                body[field] = OTHER
                with self.subTest(route=route,field=field),self.assertRaisesRegex(OnboardingError,'^invalid_request$'):
                    self.run_preview(service,body,route)
                auth.begin.assert_not_called()
                self.assertEqual(transport.calls,[])

    def test_invalid_or_revoked_session_never_calls_provider(self):
        for code in ('session_required','csrf_invalid','account_unsupported','session_store_unavailable',
                     'session_rate_limited','session_capacity_busy','account_check_unavailable'):
            service, auth, transport, body = make_service()
            auth.begin.side_effect = SessionError(code)
            with self.subTest(code=code),self.assertRaisesRegex(SessionError,'^'+code+'$'):
                self.run_preview(service,body)
            self.assertEqual(transport.calls,[])
            auth.finish.assert_not_called()

    def test_provider_failure_does_not_repeat_reserved_auth_or_retry(self):
        for raw, expected in ((DataError('http_429'),'provider_rate_limited'),
            (DataError('http_400'),'provider_request_rejected'),
            (DataError('http_401'),'provider_unavailable'),
            (RuntimeError(KEY),'provider_unavailable')):
            service, auth, transport, body = make_service()
            transport.error = raw
            with self.subTest(expected=expected),self.assertRaisesRegex(OnboardingError,'^'+expected+'$'):
                self.run_preview(service,body)
            self.assertEqual(len(transport.calls),1)
            self.assertEqual(auth.begin.call_count,1)

    def test_logout_expiry_or_csrf_rotation_during_provider_prevents_delivery(self):
        for code in ('session_required','csrf_invalid'):
            service, auth, transport, body = make_service()
            auth.finish.side_effect=SessionError(code)
            with self.subTest(code=code),self.assertRaisesRegex(SessionError,'^'+code+'$'):
                self.run_preview(service,body)
            self.assertEqual(len(transport.calls),1)

    def test_expiry_is_checked_after_final_database_work(self):
        now=[1000.5]
        service, auth, transport, body = make_service(clock=lambda:now[0])
        auth.finish.side_effect=lambda _:now.__setitem__(0,1030)
        with self.assertRaisesRegex(OnboardingError,'^preview_expired$'):
            self.run_preview(service,body)

    def test_injected_adapter_cannot_change_owner_or_request(self):
        service, auth, transport, body = make_service()
        valid=self.run_preview(service,body)['preview']
        for field,value in (('owner',OTHER),('amountRaw','999'),('slippageBps',60),('maxPriceImpactBps',500)):
            item=deepcopy(valid);item['request'][field]=value
            service.quote=SimpleNamespace(preview=lambda **_:deepcopy(item))
            with self.subTest(field=field),self.assertRaises(OnboardingError):
                self.run_preview(service,body)

    def test_injected_adapter_cannot_return_expired_or_old_cached_preview(self):
        service, auth, transport, body = make_service()
        valid=self.run_preview(service,body)['preview']
        for updates in ({'requestedAt':969,'retrievedAt':970,'expiresAt':999},
                        {'requestedAt':995,'retrievedAt':996,'expiresAt':1025},
                        {'requestedAt':1007,'retrievedAt':1007,'expiresAt':1037},
                        {'expiresAt':1100}):
            item={**deepcopy(valid),**updates}
            service.quote=SimpleNamespace(preview=lambda **_:deepcopy(item))
            with self.subTest(updates=updates),self.assertRaises(OnboardingError):
                self.run_preview(service,body)

    def test_injected_adapter_cannot_export_calldata_or_bearers(self):
        service, auth, transport, body = make_service()
        valid=self.run_preview(service,body)['preview']
        for extra in ({'calldata':'0x1234'},{'session':SESSION},{'credentials':{'csrf':CSRF}},
                      {'executionAvailable':True}):
            item={**deepcopy(valid),**extra}
            service.quote=SimpleNamespace(preview=lambda **_:deepcopy(item))
            with self.subTest(extra=extra),self.assertRaises(OnboardingError):
                self.run_preview(service,body)

    def test_valid_shaped_secret_in_output_still_fails_redaction(self):
        service, auth, transport, body = make_service()
        valid=self.run_preview(service,body)['preview']
        service.private_values=(valid['requestFingerprint'],)
        service.quote=SimpleNamespace(preview=lambda **_:deepcopy(valid))
        with self.assertRaisesRegex(OnboardingError,'^upstream_invalid_response$'):
            self.run_preview(service,body)

    def test_over_budget_position_is_a_blocked_preview_without_spending(self):
        service, auth, transport, body = make_service(route='position-preview')
        body['budget1Raw']='1'
        result=self.run_preview(service,body,'position-preview')
        self.assertEqual(result['preview']['previewChecks']['status'],'blocked')
        self.assertEqual(result['preview']['position']['tokens'][1]['maximumDebitRaw'],'202')
        self.assertFalse(result['preview']['executionAvailable'])
        self.assertEqual(result['preview']['dominoFee']['bps'],0)

    def test_missing_budget_is_null_and_is_not_wallet_balance(self):
        service, auth, transport, body = make_service(route='position-preview')
        for field in ('budget0Raw','budget1Raw','nativeBalanceRaw','nativeGasReserveRaw'):
            body.pop(field)
        result=self.run_preview(service,body,'position-preview')
        self.assertIsNone(result['preview']['request']['budget0Raw'])
        self.assertEqual(result['preview']['previewChecks']['status'],'incomplete')
        self.assertIsNone(result['preview']['nativeFunding']['reportedBalanceRaw'])

    def test_expired_parent_budget_stops_before_auth(self):
        service, auth, transport, body = make_service()
        now=[0]
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
            with read_deadline(1,clock=lambda:now[0]):
                now[0]=2
                self.run_preview(service,body)
        auth.begin.assert_not_called()
        self.assertEqual(transport.calls,[])

    def test_invalid_service_clock_fails_without_auth(self):
        for value in (True,float('nan'),float('inf'),-1,'1000'):
            service, auth, transport, body = make_service(clock=lambda:value)
            with self.subTest(value=value),self.assertRaises(OnboardingError):
                self.run_preview(service,body)
            auth.begin.assert_not_called()


if __name__=='__main__':
    unittest.main()
