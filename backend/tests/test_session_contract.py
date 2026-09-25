"""Python/JavaScript session contract parity, using reserved fixture identities."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'backend'))
from pydantic import ValidationError
from session_models import REQUEST_MODELS, RESPONSE_MODELS, SessionError, validate_body
from session_contract_fixtures import build_fixtures


class SessionContractTests(unittest.TestCase):
    def test_python_and_javascript_reject_same_boundary_mutations(self):
        requests, responses, _ = build_fixtures()
        cases = []
        for route, value in requests.items():
            cases.append({'kind': 'request', 'route': route, 'value': value, 'valid': True})
            cases.append({'kind': 'request', 'route': route, 'value': {**value, 'tenant': 'other-owner'}, 'valid': False})
        for route, value in responses.items():
            cases.append({'kind': 'response', 'route': route, 'value': value, 'valid': True})
            cases.append({'kind': 'response', 'route': route, 'value': {**value, 'sessionToken': 'x'*43}, 'valid': False})
        for value in [True, '4663', 1, None]:
            cases.append({'kind':'request','route':'challenge', 'value':{**requests['challenge'],'chainId':value}, 'valid':False})
        for value in ['é'*1025, '\ud800', '']:
            cases.append({'kind':'request','route':'verify', 'value':{**requests['verify'],'message':value},'valid':False})
        for field,value in [('expiresAt','2026-02-30T12:00:00Z'), ('expiresAt','2026-09-10T12:00:00+00:00'),
                             ('authenticated',1), ('csrfToken','x'*43+'\n')]:
            cases.append({'kind':'response','route':'me','value':{**responses['me'],field:value},'valid':False})
        # An EIP-7702 account names its delegate; a plain EOA names none.
        plain=responses['me']['validation']
        delegated={**plain,'method':'eip7702_delegated','delegate':'0x'+'d7'*20}
        for route in ('verify','me','refresh'):
            cases.append({'kind':'response','route':route,'value':{**responses[route],'validation':delegated},'valid':True})
        for validation in ({**plain,'delegate':'0x'+'d7'*20}, {k:v for k,v in delegated.items() if k!='delegate'},
                           {**delegated,'delegate':'0x'+'0'*40}, {**delegated,'delegate':'0x'+'D7'*20},
                           {**delegated,'delegate':'0x'+'d7'*19}, {**delegated,'delegate':None},
                           {**delegated,'method':'contract'}, {**delegated,'method':'eip7702'},
                           {**plain,'method':'contract'}, {**plain,'method':'PLAIN_EOA'}, None, []):
            cases.append({'kind':'response','route':'me','value':{**responses['me'],'validation':validation},'valid':False})
        for case in cases:
            with self.subTest(kind=case['kind'],route=case['route'],value=repr(case['value'])[:80]):
                try:
                    if case['kind']=='request': validate_body(case['route'],case['value'])
                    models=REQUEST_MODELS if case['kind']=='request' else RESPONSE_MODELS
                    models[case['route']].model_validate(case['value'])
                    valid=True
                except (ValidationError,SessionError,ValueError): valid=False
                self.assertEqual(valid,case['valid'])
        script="""
import {readFileSync} from 'node:fs';
import {validateRequest, validateResponse} from './api-contracts/session-v1/runtime.mjs';
const cases=JSON.parse(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(cases.map(c=>(c.kind==='request'?validateRequest:validateResponse)(c.route,c.value))));
"""
        result=subprocess.run(['node','--input-type=module','-e',script],cwd=ROOT,
                              input=json.dumps(cases),text=True,capture_output=True,timeout=15,check=True)
        self.assertEqual(json.loads(result.stdout),[case['valid'] for case in cases])

    def test_export_is_current_and_needs_no_provider_or_database(self):
        result=subprocess.run([sys.executable,'scripts/export-session-contract.py','--check'],cwd=ROOT,
                              capture_output=True,text=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)


if __name__=='__main__': unittest.main()
