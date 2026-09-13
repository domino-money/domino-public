"""Deterministic synthetic evidence only; never production price qualification."""
from types import SimpleNamespace
from unittest.mock import patch

import performance_v2_models as m
from performance_v2_service import PerformanceV2Service
import price_history as ph
from test_performance_history_projection import fixture, FinancialHistoryProjectionTests


def tracked(*, stale=False, qualified=True):
    bundle = fixture()
    owner,epoch = bundle['epoch']['owner'],bundle['epoch']['epochId']
    now = bundle['epoch']['cursor']['timestamp']+(121 if stale else 0)
    with patch.dict(ph.PRODUCTION_QUALIFICATIONS,{},clear=True):
        prices = FinancialHistoryProjectionTests().value(bundle,qualified=qualified)
        service = PerformanceV2Service(None,None,SimpleNamespace(read_financial_window=lambda *_:bundle),
            lambda _:prices,None,clock=lambda:now)
        return service._card(owner,epoch,now)


def build_fixtures():
    card = tracked()
    owner = fixture()['epoch']['owner']
    base = {'contractVersion':m.CONTRACT_VERSION,'chainId':4663,'owner':owner,
            'refreshAfterSeconds':60,'executionAvailable':False}
    enrollment = {'enrollmentId':'0x'+'12'*32,'vault':card['vault'],'tokenIds':[card['rootTokenId']],
        'epochId':card['epochId'],'status':'tracking','reason':'forward_collection','updatedAt':card['snapshot']['timestamp']}
    requests = {'epochs':{},'enroll':{'vault':card['vault'],'tokenIds':[card['rootTokenId']]},'cards':{'epochIds':[card['epochId']]}}
    responses = {'epochs':{**base,'enrollments':[enrollment],'nextAfter':None},
        'enroll':{**base,'enrollment':enrollment},'cards':{**base,'cards':[card]}}
    for route in requests:
        m.validate_request(route,requests[route]); m.validate_response(route,responses[route])
    return requests,responses,[{'status':status,'body':{'error':code}} for code,status in sorted(m.ERROR_STATUS_BY_CODE.items())]


def build_variants():
    _,responses,_ = build_fixtures()
    base = responses['cards']
    return {'stale':{**base,'cards':[tracked(stale=True)]},
            'unqualified-prices':{**base,'cards':[tracked(qualified=False)]}}
