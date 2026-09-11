"""Reviewed identities, explicit controls and historical evidence, entirely offline."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

from eth_abi import encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_models import DepositError
from deposit_rpc import DepositRpc
from discovery import DataError, ZERO, POOL_MANAGER, POSITION_MANAGER
from read_deadline import read_deadline
from token_admission import (ACCOUNTS, ADMIN_SLOT, BEACON_SLOT, IMPLEMENTATION_SLOT,
    PERMIT2, POLICY, ZERO_WORD, TokenAdmission, check_profile, check_cost, digest, validate_check_budget,
    validate_manifest, validate_profile)

TOKEN = '0x' + '11' * 20
IMPLEMENTATION = '0x' + '22' * 20
ADMIN = '0x' + '33' * 20
OWNER = '0x' + '44' * 20
OTHER = '0x' + '55' * 20
BLOCK = {'number': 100, 'hash': '0x' + 'aa' * 32, 'timestamp': 1800000000}
BEFORE = {'number': 99, 'hash': '0x' + 'bb' * 32, 'timestamp': 1799999999}
DEPLOYMENTS = {'poolManager': POOL_MANAGER, 'positionManager': POSITION_MANAGER, 'permit2': PERMIT2}
CODE = '0x60006000f3'
IMPL_CODE = '0x600160005500'
ADMIN_CODE = '0x600260005500'
IDENTITY_DATA = '0x' + keccak(b'owner()')[:4].hex()
CONTEXTS = {'owner': OWNER, 'permit2': PERMIT2, 'pool_manager': POOL_MANAGER, 'position_manager': POSITION_MANAGER}


def word(value):
    return '0x' + int(value, 16).to_bytes(32, 'big').hex() if isinstance(value, str) else '0x' + value.to_bytes(32, 'big').hex()


def code_hash(code):
    return '0x' + keccak(bytes.fromhex(code[2:])).hex()


def seal(value, field='reviewId'):
    value[field] = digest(value, field)
    return value


def profile(kind='erc1967_transparent'):
    value = {'reviewId': '', 'address': TOKEN, 'codeHash': code_hash(CODE),
        'reviewReference': 'Synthetic test review; no production admission',
        'standardTransfer': True, 'nonRebasing': True, 'approvalReturn': 'bool',
        'kind': kind, 'implementation': {'address': IMPLEMENTATION, 'codeHash': code_hash(IMPL_CODE)},
        'admin': ADMIN, 'dependencies': [{'address': ADMIN, 'codeHash': code_hash(ADMIN_CODE)}],
        'identityStorage': [{'address': ADMIN, 'slot': word(0), 'value': word(OWNER)}],
        'identityCalls': [{'address': ADMIN, 'data': IDENTITY_DATA, 'result': word(OWNER)}],
        'stateStorage': [{'slot': word(4), 'mask': word(1 << 8), 'value': ZERO_WORD}],
        'accountStorage': [{'slot': word(7), 'mask': word(8), 'value': ZERO_WORD,
                            'accounts': ['owner', 'permit2', 'pool_manager', 'position_manager']}]}
    if kind in ('immutable', 'erc1967_uups'):
        value.update(admin=ZERO, dependencies=[], identityStorage=[], identityCalls=[])
    if kind == 'immutable':
        value['implementation'] = None
    return seal(value)


def manifest(profiles=None):
    return seal({'schemaVersion': 2, 'policyVersion': POLICY, 'manifestId': '',
        'reviewedAt': BLOCK['timestamp'] - 60, 'expiresAt': BLOCK['timestamp'] + 86400,
        'reviewReference': 'Synthetic manifest; no deployment qualification', 'nativeEnabled': False,
        'deployments': {key: code_hash(CODE) for key in DEPLOYMENTS},
        'tokens': deepcopy(profiles if profiles is not None else [profile()])}, 'manifestId')


def mapping_slot(account, slot):
    return '0x' + keccak(encode(['address', 'uint256'], [account, int(slot, 16)])).hex()


class ProfileRpc:
    """Rejects unpinned/unexpected RPCs; values may vary by exact block hash."""
    def __init__(self, p):
        codes = {code_hash(raw): raw for raw in (CODE, IMPL_CODE, ADMIN_CODE)}
        self.codes = {row['address']: codes[row['codeHash']]
            for row in [p, *([p['implementation']] if p['implementation'] else []), *p['dependencies']]}
        self.storage = {}
        self.responses = {}
        self.calls = []
        self.overrides = {}
        self.error = None
        if p['implementation']:
            self.storage.update({(p['address'], IMPLEMENTATION_SLOT): word(p['implementation']['address']),
                (p['address'], ADMIN_SLOT): word(p['admin']), (p['address'], BEACON_SLOT): ZERO_WORD})
        for row in p['identityStorage']:
            self.storage[row['address'], row['slot']] = row['value']
        for row in p['identityCalls']:
            self.responses[row['address'], row['data']] = row['result']
        for row in p['stateStorage']:
            self.storage[p['address'], row['slot']] = row['value']
        for row in p['accountStorage']:
            for label in row['accounts']:
                self.storage[p['address'], mapping_slot(CONTEXTS[label], row['slot'])] = row['value']

    def request(self, method, params):
        self.calls.append((method, deepcopy(params)))
        if self.error is not None:
            raise self.error
        pin = params[-1]
        assert pin in ({'blockHash': b['hash'], 'requireCanonical': True} for b in (BEFORE, BLOCK))
        if method == 'eth_getCode':
            key = (pin['blockHash'], method, params[0])
            return self.overrides.get(key, self.codes[params[0]])
        if method == 'eth_getStorageAt':
            key = (pin['blockHash'], method, params[0], params[1])
            return self.overrides.get(key, self.storage.get((params[0], params[1]), ZERO_WORD))
        if method == 'eth_call':
            assert set(params[0]) == {'to', 'data', 'gas'} and params[0]['gas'] == hex(500000)
            key = (pin['blockHash'], method, params[0]['to'], params[0]['data'])
            return self.overrides.get(key, self.responses[params[0]['to'], params[0]['data']])
        raise AssertionError('unexpected RPC method')


class ReviewedProfileTests(unittest.TestCase):
    def denied(self, function, code='deposit_admission_required'):
        with self.assertRaises(DepositError) as caught:
            function()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)

    def test_content_hashes_are_complete_detached_and_not_source_discovery(self):
        p = profile(); checked = validate_profile(p)
        self.assertEqual(checked, p); self.assertIsNot(checked, p)
        p['dependencies'][0]['codeHash'] = word(1)
        self.assertNotEqual(checked['dependencies'], p['dependencies'])
        for field, value in (('codeHash', word(2)), ('reviewReference', 'Changed review'),
                             ('approvalReturn', 'empty'), ('stateStorage', []), ('dependencies', [])):
            invalid = profile(); invalid[field] = value
            self.denied(lambda: validate_profile(invalid))
        for field in ('symbol', 'verifiedSource', 'simulationPassed', 'abi', 'providerUrl'):
            invalid = seal({**profile(), field: 'automatic evidence is not a reviewed profile'})
            self.denied(lambda: validate_profile(invalid))
        # A digest binds a trusted review record; it is not a signature or proof
        # of source semantics. A new reviewed claim requires a new review ID.
        changed = profile(); changed['reviewReference'] = 'Explicit different synthetic review'
        seal(changed); self.assertNotEqual(changed['reviewId'], profile()['reviewId'])
        self.assertEqual(validate_profile(changed), changed)

    def test_immutable_uups_and_transparent_shapes_are_explicit(self):
        for kind in ('immutable', 'erc1967_uups', 'erc1967_transparent'):
            self.assertEqual(validate_profile(profile(kind))['kind'], kind)
        mutations = [lambda p: p.update(kind='erc1967_beacon'), lambda p: p.update(standardTransfer=1),
            lambda p: p.update(nonRebasing=False), lambda p: p.update(approvalReturn='guessed'),
            lambda p: p.update(reviewReference='\nsource'), lambda p: p.update(reviewReference='x'*257),
            lambda p: p.update(admin=ZERO), lambda p: p['implementation'].update(address=TOKEN),
            lambda p: p.update(dependencies=[]), lambda p: p.update(address=ZERO),
            lambda p: p.update(codeHash='0x'+'AB'*32)]
        for mutate in mutations:
            invalid=profile(); mutate(invalid); seal(invalid)
            self.denied(lambda: validate_profile(invalid))
        for kind, field, value in (('immutable','implementation',profile()['implementation']),
                                  ('immutable','admin',ADMIN),('erc1967_uups','admin',ADMIN)):
            invalid=profile(kind);invalid[field]=value;seal(invalid)
            self.denied(lambda: validate_profile(invalid))

    def test_dependencies_and_identity_controls_cannot_escape_review_targets(self):
        mutations = [lambda p: p['dependencies'].append(deepcopy(p['dependencies'][0])),
            lambda p: p['dependencies'].append({'address': TOKEN, 'codeHash': code_hash(CODE)}),
            lambda p: p['identityStorage'][0].update(address=OTHER),
            lambda p: p['identityCalls'][0].update(address=OTHER),
            lambda p: p['identityCalls'][0].update(data='0x01'),
            lambda p: p['identityCalls'][0].update(data='0x'+'aa'*133),
            lambda p: p['identityCalls'][0].update(result='0x'),
            lambda p: p['identityCalls'][0].update(result='0x'+'aa'*257),
            lambda p: p['identityStorage'][0].update(slot='0x00')]
        for mutate in mutations:
            invalid=profile();mutate(invalid);seal(invalid)
            self.denied(lambda: validate_profile(invalid))

    def test_masked_controls_require_nonzero_masks_and_known_distinct_accounts(self):
        for field in ('stateStorage','accountStorage'):
            for key,value in (('mask',ZERO_WORD),('value',word(1)),('slot','0x1'),('mask',word(1)+'00')):
                invalid=profile();invalid[field][0][key]=value;seal(invalid)
                self.denied(lambda:validate_profile(invalid))
        for accounts in ([],['owner','owner'],['arbitrary_address'],['owner']*5,'owner'):
            invalid=profile();invalid['accountStorage'][0]['accounts']=accounts;seal(invalid)
            self.denied(lambda:validate_profile(invalid))

    def test_profile_and_manifest_collection_limits_are_finite(self):
        for field,limit in (('dependencies',8),('identityStorage',16),('identityCalls',8),('stateStorage',8),('accountStorage',8)):
            invalid=profile();invalid[field]=[deepcopy(invalid[field][0])]*(limit+1);seal(invalid)
            self.denied(lambda:validate_profile(invalid))
        invalid=manifest([profile()]*33)
        self.denied(lambda:validate_manifest(invalid,now=BLOCK['timestamp'],deployments=DEPLOYMENTS))

    def test_manifest_hash_expiry_and_deployment_set_are_strict(self):
        original=manifest(); checked=validate_manifest(original,now=BLOCK['timestamp'],deployments=DEPLOYMENTS)
        self.assertEqual(checked,original);self.assertIsNot(checked['tokens'][0],original['tokens'][0])
        for changes in ({'schemaVersion':True},{'schemaVersion':1},{'policyVersion':'direct_existing_pool_v1'},
                        {'reviewedAt':BLOCK['timestamp']+1},{'expiresAt':BLOCK['timestamp']},
                        {'expiresAt':BLOCK['timestamp']+31*86400},{'nativeEnabled':1},
                        {'tokens':[profile(),profile()]},{'reviewReference':'\u00e9'},
                        {'deployments':{}},{'manifestId':'not-a-hash'}):
            invalid=manifest();invalid.update(changes)
            if 'manifestId' not in changes:seal(invalid,'manifestId')
            self.denied(lambda:validate_manifest(invalid,now=BLOCK['timestamp'],deployments=DEPLOYMENTS))
        invalid=manifest();invalid['nativeEnabled']=True
        self.denied(lambda:validate_manifest(invalid,now=BLOCK['timestamp'],deployments=DEPLOYMENTS))
        invalid=manifest();invalid['deployments']['poolManager']='0x00';seal(invalid,'manifestId')
        self.denied(lambda:validate_manifest(invalid,now=BLOCK['timestamp'],deployments=DEPLOYMENTS))

    def test_manifest_preserves_bounded_historical_review_without_promoting_it(self):
        old=profile();current=profile();current['implementation']['address']=OTHER;seal(current)
        m=manifest([current]);m['reviewArchive']=[old];seal(m,'manifestId')
        checked=validate_manifest(m,now=BLOCK['timestamp'],deployments=DEPLOYMENTS)
        self.assertEqual(checked['tokens'],[current]);self.assertEqual(checked['reviewArchive'],[old])
        registry=TokenAdmission([*checked['tokens'],*checked['reviewArchive']]);rpc=ProfileRpc(old)
        admission={'policyVersion':POLICY,'tokenReviews':[{'address':TOKEN,'reviewId':old['reviewId']}]}
        result=registry.receipt(request=rpc.request,currency=TOKEN,admission=admission,before=BEFORE,block=BLOCK)
        self.assertEqual(result['status'],'matched')
        only_archive=manifest([]);only_archive['reviewArchive']=[old];seal(only_archive,'manifestId')
        self.assertEqual(validate_manifest(only_archive,now=BLOCK['timestamp'],deployments=DEPLOYMENTS)['tokens'],[])
        for archived in ([current],[old,old],[old]*33):
            invalid=manifest([current]);invalid['reviewArchive']=archived;seal(invalid,'manifestId')
            self.denied(lambda:validate_manifest(invalid,now=BLOCK['timestamp'],deployments=DEPLOYMENTS))
        invalid=deepcopy(m);invalid['reviewArchive'][0]['implementation']['codeHash']=word(1);seal(invalid,'manifestId')
        self.denied(lambda:validate_manifest(invalid,now=BLOCK['timestamp'],deployments=DEPLOYMENTS))
        invalid=deepcopy(m);invalid['reviewArchive']=[]
        self.denied(lambda:validate_manifest(invalid,now=BLOCK['timestamp'],deployments=DEPLOYMENTS))

    def test_every_identity_read_is_canonical_and_operational_controls_are_pinned(self):
        p=profile();rpc=ProfileRpc(p);check_profile(rpc.request,p,owner=OWNER,block=BLOCK)
        self.assertEqual(len(rpc.calls),13)
        self.assertEqual({method for method,_ in rpc.calls},{'eth_getCode','eth_getStorageAt','eth_call'})
        self.assertTrue(all(params[-1]=={'blockHash':BLOCK['hash'],'requireCanonical':True} for _,params in rpc.calls))
        observed={params[1] for method,params in rpc.calls if method=='eth_getStorageAt'}
        for account in CONTEXTS.values():self.assertIn(mapping_slot(account,word(7)),observed)

    def test_proxy_dependency_slots_and_identity_getter_changes_deny(self):
        p=profile()
        for target in (TOKEN,IMPLEMENTATION,ADMIN):
            rpc=ProfileRpc(p);rpc.codes[target]='0x6003'
            self.denied(lambda:check_profile(rpc.request,p,owner=OWNER,block=BLOCK),'deposit_token_changed')
        for target,slot in ((TOKEN,IMPLEMENTATION_SLOT),(TOKEN,ADMIN_SLOT),(TOKEN,BEACON_SLOT),(ADMIN,word(0))):
            rpc=ProfileRpc(p);rpc.storage[target,slot]=word(OTHER)
            self.denied(lambda:check_profile(rpc.request,p,owner=OWNER,block=BLOCK),'deposit_token_changed')
        rpc=ProfileRpc(p);rpc.responses[ADMIN,IDENTITY_DATA]=word(OTHER)
        self.denied(lambda:check_profile(rpc.request,p,owner=OWNER,block=BLOCK),'deposit_token_changed')

    def test_pause_mask_and_each_relevant_account_freeze_are_effective(self):
        p=profile();rpc=ProfileRpc(p);rpc.storage[TOKEN,word(4)]=word(1<<200)
        for account in CONTEXTS.values():rpc.storage[TOKEN,mapping_slot(account,word(7))]=word(1<<180)
        check_profile(rpc.request,p,owner=OWNER,block=BLOCK)
        rpc.storage[TOKEN,word(4)]=word((1<<200)|(1<<8))
        self.denied(lambda:check_profile(rpc.request,p,owner=OWNER,block=BLOCK),'deposit_token_restricted')
        for account in CONTEXTS.values():
            rpc=ProfileRpc(p);rpc.storage[TOKEN,mapping_slot(account,word(7))]=word(8)
            self.denied(lambda:check_profile(rpc.request,p,owner=OWNER,block=BLOCK),'deposit_token_restricted')

    def test_rpc_failure_and_invalid_bytes_are_finite_sanitized_and_not_retried(self):
        p=profile()
        for error in (RuntimeError('https://private.invalid/key-not-for-output'),TimeoutError('secret')):
            rpc=ProfileRpc(p);rpc.error=error
            self.denied(lambda:check_profile(rpc.request,p,owner=OWNER,block=BLOCK),'deposit_token_check_unavailable')
            self.assertEqual(len(rpc.calls),1)
        for raw in (None,False,'0x0','0xzz','0x'+'aa'*24577):
            rpc=ProfileRpc(p);rpc.codes[TOKEN]=raw
            self.denied(lambda:check_profile(rpc.request,p,owner=OWNER,block=BLOCK),'deposit_token_check_unavailable')
        rpc=ProfileRpc(p);rpc.storage[TOKEN,IMPLEMENTATION_SLOT]='0x01'
        self.denied(lambda:check_profile(rpc.request,p,owner=OWNER,block=BLOCK),'deposit_token_check_unavailable')

    def test_expired_budget_stops_before_work_and_mid_read_prevents_next_rpc(self):
        p=profile();rpc=ProfileRpc(p);now=[0.0]
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'),read_deadline(1,clock=lambda:now[0]):
            now[0]=2;check_profile(rpc.request,p,owner=OWNER,block=BLOCK)
        self.assertEqual(rpc.calls,[])
        now[0]=0
        def slow(method,params):
            value=rpc.request(method,params);now[0]=2;return value
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'),read_deadline(1,clock=lambda:now[0]):
            check_profile(slow,p,owner=OWNER,block=BLOCK)
        self.assertEqual(len(rpc.calls),1)

    def test_deposit_rpc_request_budget_stops_identity_checks_without_retry(self):
        p=profile();fake=ProfileRpc(p)
        def transport(url,body,**options):
            self.assertEqual(url,'https://rpc.mainnet.chain.robinhood.com')
            return {'jsonrpc':'2.0','id':body['id'],'result':fake.request(body['method'],body['params'])}
        rpc=DepositRpc('https://rpc.mainnet.chain.robinhood.com',transport=transport,max_requests=3)
        self.denied(lambda:check_profile(rpc.request,p,owner=OWNER,block=BLOCK),'deposit_token_check_unavailable')
        self.assertEqual((rpc.count,len(fake.calls)),(3,3))

    def test_individual_complexity_limits_match_actual_reads_and_reject_overflow(self):
        p=profile()
        p['dependencies'] += [{'address':'0x'+f'{i:040x}','codeHash':code_hash(ADMIN_CODE)} for i in range(1,7)]
        for field,limit in (('identityStorage',16),('identityCalls',8),('stateStorage',8)):
            p[field]=[deepcopy(p[field][0]) for _ in range(limit)]
        p=validate_profile(seal(p));rpc=ProfileRpc(p)
        self.assertEqual(check_cost(p),(36,48));validate_check_budget([p])
        check_profile(rpc.request,p,owner=OWNER,block=BLOCK,operational=False)
        self.assertEqual(len(rpc.calls),36);rpc.calls.clear()
        check_profile(rpc.request,p,owner=OWNER,block=BLOCK)
        self.assertEqual(len(rpc.calls),48)
        identity_over=deepcopy(p);identity_over['stateStorage']=[];identity_over['accountStorage']=[]
        identity_over['dependencies'].append({'address':'0x'+f'{7:040x}','codeHash':code_hash(ADMIN_CODE)})
        seal(identity_over);self.assertEqual(check_cost(identity_over),(37,37))
        operative_over=deepcopy(p);operative_over['accountStorage'].append({**deepcopy(p['accountStorage'][0]),'accounts':['owner']})
        seal(operative_over);self.assertEqual(check_cost(operative_over),(36,49))
        for invalid in (identity_over,operative_over):
            self.denied(lambda:validate_profile(invalid))
            self.denied(lambda:validate_check_budget([invalid]))
            archived=manifest([]);archived['reviewArchive']=[invalid];seal(archived,'manifestId')
            self.denied(lambda:validate_manifest(archived,now=BLOCK['timestamp'],deployments=DEPLOYMENTS))

    @staticmethod
    def budget_profile(token=TOKEN,*,extra_identity=0,extra_operative=0):
        p=profile();p['address']=token;p['implementation']['address']='0x'+'66'*20
        p['identityStorage']=[{**p['identityStorage'][0],'slot':word(100+i)} for i in range(11+extra_identity)]
        p['stateStorage']=[{**p['stateStorage'][0],'slot':word(200+i)} for i in range(2+extra_operative)]
        return validate_profile(seal(p))

    def test_selected_pair_exact_identity_and_operational_budgets_are_inclusive(self):
        first=self.budget_profile();second=self.budget_profile(OTHER)
        self.assertEqual(check_cost(first),(18,24));self.assertEqual(check_cost(second),(18,24))
        validate_check_budget([first,second])
        actual=0
        for p in (first,second):
            rpc=ProfileRpc(p);check_profile(rpc.request,p,owner=OWNER,block=BLOCK)
            actual+=len(rpc.calls)
        self.assertEqual(actual,48)
        self.denied(lambda:validate_check_budget([self.budget_profile(extra_operative=1),second]))
        identity_over=self.budget_profile(extra_identity=1)
        for p in (identity_over,second):p.update(stateStorage=[],accountStorage=[]);seal(p)
        self.assertEqual([check_cost(p) for p in (identity_over,second)],[(19,19),(18,18)])
        self.denied(lambda:validate_check_budget([identity_over,second]))

    def test_registry_capacity_does_not_apply_selected_pair_budget_to_unselected_reviews(self):
        profiles=[];archive=[]
        for number in range(1,65):
            p=profile();p['address']='0x'+f'{number+1000:040x}';seal(p)
            (profiles if number<=32 else archive).append(p)
        m=manifest(profiles);m['reviewArchive']=archive;seal(m,'manifestId')
        checked=validate_manifest(m,now=BLOCK['timestamp'],deployments=DEPLOYMENTS)
        self.assertEqual((len(checked['tokens']),len(checked['reviewArchive'])),(32,32))
        TokenAdmission([*checked['tokens'],*checked['reviewArchive']])
        validate_check_budget(checked['tokens'][:2])
        self.denied(lambda:validate_check_budget(checked['tokens']))

    def test_oversized_pair_is_rejected_before_rpc_factory_or_provider_for_prepare_and_revalidate(self):
        from deposit_prepare import DEPLOYMENTS as PROTOCOL_DEPLOYMENTS, DirectDepositPreparer
        from test_deposit_receipt import context
        selected,artifact=context()
        pair=[self.budget_profile(currency,extra_identity=int(index==0))
            for index,currency in enumerate((selected['poolKey']['currency0'],selected['poolKey']['currency1']))]
        for p in pair:p.update(stateStorage=[],accountStorage=[]);seal(p)
        m=manifest(pair);m['deployments']={key:code_hash(CODE) for key in PROTOCOL_DEPLOYMENTS};seal(m,'manifestId')
        position=Mock();rpc_factory=Mock(side_effect=AssertionError('RPC factory must not run for an over-budget pair'))
        preparer=DirectDepositPreparer(position,rpc_factory,admission=m,clock=lambda:BLOCK['timestamp'])
        self.denied(lambda:preparer.prepare(artifact['transaction']['from'],selected))
        rpc_factory.assert_not_called();self.assertEqual(position.mock_calls,[])
        artifact['admission']={'manifestId':m['manifestId'],'policyVersion':POLICY,
            'tokenReviews':[{'address':p['address'],'reviewId':p['reviewId']} for p in pair]}
        self.denied(lambda:preparer.revalidate(artifact['transaction']['from'],selected,artifact))
        rpc_factory.assert_not_called();self.assertEqual(position.mock_calls,[])

    def test_receipt_requires_known_review_and_checks_both_block_identities(self):
        p=profile();rpc=ProfileRpc(p);registry=TokenAdmission([p])
        admission={'policyVersion':POLICY,'tokenReviews':[{'address':TOKEN,'reviewId':p['reviewId']}]}
        result=registry.receipt(request=rpc.request,currency=TOKEN,admission=admission,before=BEFORE,block=BLOCK)
        self.assertEqual(result,{'status':'matched','reviewId':p['reviewId'],'upgradeable':True})
        self.assertEqual(len(rpc.calls),16)
        self.assertEqual([params[-1]['blockHash'] for _,params in rpc.calls],[BEFORE['hash']]*8+[BLOCK['hash']]*8)
        for snapshot in (BEFORE,BLOCK):
            rpc=ProfileRpc(p);rpc.overrides[snapshot['hash'],'eth_getCode',IMPLEMENTATION]='0x6003'
            result=registry.receipt(request=rpc.request,currency=TOKEN,admission=admission,before=BEFORE,block=BLOCK)
            self.assertEqual(result['status'],'changed')

    def test_receipt_unknown_legacy_and_mismatched_reviews_never_gain_authority(self):
        p=profile();registry=TokenAdmission([p]);ref={'address':TOKEN,'reviewId':p['reviewId']}
        for admission,expected in (({'policyVersion':'direct_existing_pool_v1'},'legacy_unqualified'),
                ({'policyVersion':POLICY,'tokenReviews':[]},'unavailable'),
                ({'policyVersion':POLICY,'tokenReviews':[ref,ref]},'unavailable'),
                ({'policyVersion':POLICY,'tokenReviews':[{**ref,'reviewId':'f'*64}]},'unavailable'),
                ({'policyVersion':POLICY,'tokenReviews':[{**ref,'address':OTHER}]},'unavailable')):
            rpc=ProfileRpc(p)
            result=registry.receipt(request=rpc.request,currency=TOKEN,admission=admission,before=BEFORE,block=BLOCK)
            self.assertEqual(result['status'],expected);self.assertEqual(rpc.calls,[])

    def test_receipt_propagates_timeout_instead_of_downgrading_it_to_missing_review(self):
        p=profile();registry=TokenAdmission([p]);rpc=ProfileRpc(p);now=[0.0];propagated=False
        admission={'policyVersion':POLICY,'tokenReviews':[{'address':TOKEN,'reviewId':p['reviewId']}]}
        def slow(method,params):
            value=rpc.request(method,params);now[0]=2;return value
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'),read_deadline(1,clock=lambda:now[0]):
            try:registry.receipt(request=slow,currency=TOKEN,admission=admission,before=BEFORE,block=BLOCK)
            except DataError:
                propagated=True
                raise
        self.assertTrue(propagated)  # not merely raised later by context exit
        self.assertEqual(len(rpc.calls),1)

    def test_review_archive_is_detached_and_receipt_operational_controls_are_separate(self):
        p=profile();review_id=p['reviewId'];registry=TokenAdmission([p]);rpc=ProfileRpc(p)
        p['codeHash']=word(3)
        rpc.storage[TOKEN,word(4)]=word(1<<8)
        admission={'policyVersion':POLICY,'tokenReviews':[{'address':TOKEN,'reviewId':review_id}]}
        result=registry.receipt(request=rpc.request,currency=TOKEN,admission=admission,before=BEFORE,block=BLOCK)
        self.assertEqual(result['status'],'matched')
        rpc=ProfileRpc(profile());rpc.error=RuntimeError('private failure')
        result=registry.receipt(request=rpc.request,currency=TOKEN,admission=admission,before=BEFORE,block=BLOCK)
        self.assertEqual(result['status'],'unavailable');self.assertEqual(len(rpc.calls),1)


if __name__ == '__main__':
    unittest.main()
