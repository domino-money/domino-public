#!/usr/bin/env python3
"""Compare the generated JS validator to producer Pydantic on bounded cases."""
import copy
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import public_data_contract as contract

fixture = lambda route: json.loads((ROOT / f'api-contracts/read-v3/fixtures/{route}.json').read_text())
cases = []


def add(label, route, response=None, request=None, mutate=None):
    case = {'label': label, 'route': route}
    if response is not None:
        case['response'] = copy.deepcopy(response)
    if request is not None:
        case['request'] = copy.deepcopy(request)
    if mutate:
        mutate(case)
    cases.append(case)


for route in ('overview','search','history','capabilities'):
    add(route+' valid',route,fixture(route))
    add(route+' extra key',route,fixture(route),mutate=lambda x:x['response'].update(extra=True))
overview,history,search = (fixture(route) for route in ('overview','history','search'))
pool_id,token = overview['pools'][0]['poolId'],search['tokens'][0]['address']
for label,request in (
    ('token',{'token':token}),('ids',{'poolIds':[pool_id]}),('empty',{}),
    ('duplicate',{'poolIds':[pool_id,pool_id]}),('too many for limit',{'poolIds':[pool_id],'limit':0}),
    ('both',{'token':token,'poolIds':[pool_id]}),('cursor no revision',{'token':token,'afterPoolId':pool_id}),
    ('cursor',{'token':token,'afterPoolId':pool_id,'revision':1}),('bool revision',{'token':token,'revision':True}),
): add(label,'overview',request=request)
add('overview echo','overview',overview,{'poolIds':[pool_id]})
add('overview different echo','overview',overview,{'poolIds':['0x'+'a'*64]})
add('overview wrong final cursor','overview',overview,{'poolIds':[pool_id]},lambda x:x['response'].update(hasMore=True,nextAfterPoolId='0x'+'b'*64))
add('token evidence','overview',overview,mutate=lambda x:x['response']['tokens'][0].update(observedAt=None))
add('APR tamper','overview',overview,mutate=lambda x:x['response']['pools'][0]['value']['estimate'].update(feeAprEstimate24hPercent='999'))
add('search duplicates','search',search,mutate=lambda x:x['response']['tokens'].append(x['response']['tokens'][0]))
add('search pending','search',search,mutate=lambda x:x['response']['tokens'][0].update(value=None,observedAt=None))
add('search echo','search',search,{'query':'TOKEN'})
add('search different echo','search',search,{'query':'OTHER'})
hq = {'poolId':history['poolId'],'currency':history['currency']}
add('history echo','history',history,hq)
add('history short window','history',history,hq,lambda x:x['response']['requestedWindow'].update(endTimestamp=86401))
add('history too many points','history',request={**hq,'windowSeconds':2592000,'resolutionSeconds':60})
for label,change in (
    ('low above open',{'low':'0.6'}),('high below close',{'high':'0.55'}),('zero price',{'low':'0'}),
    ('not aligned',{'startTimestamp':1}),('outside window',{'startTimestamp':86400}),('uncovered complete',{'complete':True}),
): add(label,'history',history,mutate=lambda x,change=change:x['response']['candles'][0].update(change))
add('duplicate candle','history',history,mutate=lambda x:x['response']['candles'].append(x['response']['candles'][0]))
add('coverage beyond window','history',history,mutate=lambda x:x['response'].update(covered=[{'startTimestamp':0,'endTimestamp':86401}]))
add('false full coverage','history',history,mutate=lambda x:x['response'].update(status='available'))
add('missing denomination','history',history,mutate=lambda x:x['response'].update(quoteCurrency=None))

expected = []
for case in cases:
    try:
        if 'request' in case and 'response' in case:
            contract.validate_request_response(case['route'],case['request'],case['response'])
        elif 'request' in case:
            contract.validate_request(case['route'],case['request'])
        else:
            contract.validate_response(case['route'],case['response'])
        expected.append(True)
    except (ValueError,TypeError,KeyError):
        expected.append(False)

program = '''import fs from 'node:fs'; import * as r from './api-contracts/read-v3/runtime.mjs';
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => 'request' in c && 'response' in c ? r.matchesRequest(c.route,c.request,c.response) : 'request' in c ? r.validateRequest(c.route,c.request) : r.validateResponse(c.route,c.response))));'''
actual = json.loads(subprocess.run(['node','--input-type=module','-e',program],input=json.dumps(cases),text=True,capture_output=True,check=True,cwd=ROOT).stdout)
failures = [case['label'] for case,a,b in zip(cases,expected,actual) if a != b]
if failures:
    raise SystemExit('Read-v3 parity failed: '+', '.join(failures))
print(f'Read-v3 Python/JS parity: {len(cases)} cases agree.')
