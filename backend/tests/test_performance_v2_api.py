"""Offline tests of the real V2 auth boundary and financial projection."""
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path[:0] = [str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parent)]
from fastapi.testclient import TestClient
from onboarding_auth import OnboardingAuth
from performance_v2_api import PerformanceV2Gateway, create_performance_v2_app
from performance_v2_service import PerformanceV2Service
from performance_v2_contract_fixtures import build_fixtures, build_variants
import performance_v2_models as m
from test_performance_api import AuthStore, OWNER, OTHER, SESSION, CSRF, ORIGIN, HEADERS, h


class PerformanceV2ApiTests(unittest.TestCase):
    def setUp(self):
        self.requests,self.responses,_ = build_fixtures()
        self.auth_store = AuthStore(owner=self.responses['cards']['owner'])
        checker = SimpleNamespace(check=Mock(return_value={'method':'plain_eoa','blockNumber':'1','blockHash':h(1)}))
        self.auth = OnboardingAuth(self.auth_store,checker)
        self.enrollments = SimpleNamespace(visible=Mock(return_value={k:self.responses['epochs'][k] for k in ('enrollments','nextAfter')}),
            enroll=Mock(return_value=self.responses['enroll']['enrollment']))
        self.service = PerformanceV2Service(self.auth,self.enrollments,None,None,lambda *_:h(3))
        self.service._card = Mock(return_value=deepcopy(self.responses['cards']['cards'][0]))
        self.verifier = SimpleNamespace(verify=Mock())
        self.gateway = PerformanceV2Gateway(service=self.service,verifier=self.verifier,origin=ORIGIN,enabled=True)
        self.client = TestClient(create_performance_v2_app(self.gateway),client=('127.0.0.1',40000))
        self.client.__enter__(); self.addCleanup(self.client.__exit__,None,None,None)
        self.headers = {**HEADERS,'X-Domino-Performance-Contract':m.CONTRACT_VERSION}

    def post(self,route='cards',body=None,headers=None):
        return self.client.post('/internal/performance/v2/'+route,json=self.requests[route] if body is None else body,
                                headers=self.headers if headers is None else headers)

    def test_three_routes_derive_owner_from_session_and_reauthorize_delivery(self):
        for route in ('epochs','enroll','cards'):
            response = self.post(route)
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.json()['owner'],self.auth_store.owner)
            self.assertFalse(response.json()['executionAvailable'])
            self.assertIn('no-store',response.headers['cache-control'])
        self.assertEqual((self.auth_store.begin_calls,self.auth_store.finish_calls),(3,6))
        self.assertEqual(self.enrollments.enroll.call_args.args[0],self.auth_store.owner)

    def test_no_unenrolled_or_foreign_epoch_disclosure(self):
        self.enrollments.visible.return_value = {'enrollments':[],'nextAfter':None}
        result = self.post().json()
        self.assertEqual(result['cards'][0]['kind'],'not_found')
        self.assertNotIn('vault',result['cards'][0])
        self.service._card.assert_not_called()

    def test_owner_forgery_or_unadmitted_subject_never_queues(self):
        self.assertEqual(self.post('enroll',{**self.requests['enroll'],'owner':OTHER}).status_code,400)
        self.service.admission = lambda *_:None
        self.assertEqual(self.post('enroll').status_code,403)
        self.enrollments.enroll.assert_not_called()

    def test_revocation_during_projection_prevents_delivery(self):
        def revoke(*args):
            self.auth_store.revoked=True
            return self.responses['cards']['cards'][0]
        self.service._card.side_effect = revoke
        result = self.post()
        self.assertEqual((result.status_code,result.json()),(401,{'error':'session_required'}))

    def test_access_duplicate_cookie_is_not_cookie_authentication(self):
        jwt = self.headers['CF-Access-Jwt-Assertion']
        response = self.post(headers={**self.headers,'Cookie':'CF_Authorization='+jwt})
        self.assertEqual(response.status_code,200,response.text)
        self.verifier.verify.assert_called_once_with(jwt)
        for cookie in ('CF_Authorization=other','CF_Authorization='+jwt+'; __Host-domino-session='+SESSION):
            self.assertEqual(self.post(headers={**self.headers,'Cookie':cookie}).status_code,403)
        self.verifier.verify.side_effect = ValueError('private detail')
        self.assertEqual(self.post(headers={**self.headers,'Cookie':'CF_Authorization='+jwt}).status_code,503)

    def test_disabled_and_old_namespace_never_execute(self):
        self.gateway.enabled=False
        self.assertEqual(self.post().status_code,404)
        self.assertEqual(self.client.post('/internal/performance/v1/cards',json=self.requests['cards'],headers=self.headers).status_code,404)
        self.enrollments.visible.assert_not_called()

    def test_numerical_and_stale_contracts_preserve_missing_fields_and_v1_null_only(self):
        current=self.responses['cards']; stale=build_variants()['stale']
        self.assertEqual(current['cards'][0]['metrics']['newTradingFeesUsd'],'10.000000000000000000')
        self.assertEqual(stale['cards'][0]['performanceStatus'],'stale')
        self.assertIsNone(stale['cards'][0]['metrics']['netFeeAprPercent'])
        for response in (current,stale,*build_variants().values()): m.validate_response('cards',response)
        bad=deepcopy(stale); bad['cards'][0]['metrics']['netFeeAprPercent']='5'
        with self.assertRaises(m.Error): m.validate_response('cards',bad)
        bad=deepcopy(current); bad['cards'][0]['metrics']['newTradingFeesUsd']=10
        with self.assertRaises(m.Error): m.validate_response('cards',bad)
        from performance_models import validate_response, PerformanceError
        with self.assertRaises(PerformanceError): validate_response('cards',current)

    def test_real_income_or_capital_gap_withholds_apr_despite_complete_raw_day(self):
        from test_performance_history_projection import fixture,FinancialHistoryProjectionTests
        from unittest.mock import patch
        import price_history as ph
        for field in ('incomeComplete','capitalComplete'):
            bundle=fixture()
            bundle['deltas'][0]['slices'][0][field]=False
            if field=='incomeComplete': bundle['deltas'][0]['slices'][0]['issues']=['income_coverage_unavailable']
            with patch.dict(ph.PRODUCTION_QUALIFICATIONS,{},clear=True):
                valuation=FinancialHistoryProjectionTests().value(bundle)
                service=PerformanceV2Service(None,None,SimpleNamespace(read_financial_window=lambda *_:bundle),lambda _:valuation,None)
                card=service._card(bundle['epoch']['owner'],bundle['epoch']['epochId'],bundle['epoch']['cursor']['timestamp'])
            self.assertEqual(card['observedSeconds'],86400)
            self.assertEqual(card['performanceStatus'],'partial')
            self.assertFalse(card['complete24h'])
            self.assertIsNone(card['metrics']['grossFeeAprPercent'])
            self.assertIsNone(card['metrics']['netFeeAprPercent'])

    def test_authenticated_compact_cards_and_price_revocation_schedule_repair(self):
        from unittest.mock import patch
        import price_history as ph
        from performance_rollup import project
        from test_performance_history_projection import fixture,FinancialHistoryProjectionTests
        from test_performance_rollup import RollupTests
        bundle=fixture(); owner=bundle['epoch']['owner']; epoch=bundle['epoch']['epochId']
        with patch.dict(ph.PRODUCTION_QUALIFICATIONS,{},clear=True):
            valuation=FinancialHistoryProjectionTests().value(bundle)
            compact=RollupTests().compact(bundle,valuation)
            refresh=Mock()
            history=SimpleNamespace(read_projection_window=Mock(return_value=compact))
            self.auth_store.owner=owner
            self.enrollments.visible.return_value={'enrollments':[{'epochId':epoch}],'nextAfter':None}
            self.gateway.service=PerformanceV2Service(self.auth,self.enrollments,history,lambda _:valuation,None,
                clock=lambda:bundle['epoch']['cursor']['timestamp'],projection=project,projection_refresh=refresh)
            response=self.post(body={'epochIds':[epoch]})
            self.assertEqual(response.status_code,200,response.text)
            card=response.json()['cards'][0]
            self.assertEqual(card['performanceStatus'],'available')
            self.assertEqual(card['metrics']['timeWeightedCapitalUsd'],'1000.000000000000000000')
            self.assertTrue(card['complete24h'])
            refresh.assert_not_called()
            ph.PRODUCTION_QUALIFICATIONS.clear()
            response=self.post(body={'epochIds':[epoch]})
            self.assertEqual(response.status_code,200,response.text)
            card=response.json()['cards'][0]
            self.assertEqual(card['performanceStatus'],'partial')
            self.assertIsNone(card['metrics']['netFeeAprPercent'])
            self.assertFalse(card['complete24h'])
            self.assertEqual(refresh.call_args.args[:3],(owner,epoch,1))
            self.assertEqual(len(refresh.call_args.args[3]),1439)


if __name__=='__main__': unittest.main()
