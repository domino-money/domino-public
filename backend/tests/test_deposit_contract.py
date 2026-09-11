"""Closed deposit contract and exact artifact semantics across producer variants."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path[:0]=[str(Path(__file__).resolve().parents[1])]
from pydantic import ValidationError
from deposit_models import CONTRACT_VERSION, validate_request, validate_response, PreparedArtifact
from deposit_receipt import validate_issued_artifact
from deposit_contract_fixtures import build_fixtures, build_variants, artifact, selection, OWNER


def read_views(body):
    """Exercise the same receipt through full history and compact lastStep."""
    item = deepcopy(body['operation'])
    history = item.pop('history')
    item.update(historyCount=len(history), lastStep=history[-1] if history else None)
    return (('get', body), ('list', {
        'contractVersion': body['contractVersion'], 'operations': [item],
        'hasMore': False, 'nextBefore': None,
        'serverBroadcastAvailable': False, 'automationAvailable': False}))


class DepositContractTests(unittest.TestCase):
    def test_all_producer_requests_and_observed_receipt_variants(self):
        self.assertEqual(CONTRACT_VERSION, '1.1.0-rc.4')
        requests,responses,_=build_fixtures()
        for route in requests:
            validate_request(route,requests[route]);validate_response(route,responses[route])
        for route,body in build_variants().values():
            validate_response(route,body)
            if body.get('walletStep'):
                validate_issued_artifact(body['operation']['owner'],body['operation']['selection'],body['walletStep'])

    def test_identity_budget_and_authority_cannot_be_browser_fields(self):
        body=build_fixtures()[0]['create']
        for key in ('owner','recipient','signature','providerUrl','calldata','tenant'):
            with self.subTest(key=key),self.assertRaises(ValidationError):
                validate_request('create',{**body,key:'untrusted'})
        for path,value in (('budget0Raw',1000),('maxGasLimitRaw','3000001'),('maxPriorityFeePerGasRaw','11'),
                           ('chainId',4663.0),('tickLower',-121),('budget0Raw',str(2**128))):
            invalid=deepcopy(body);invalid['selection'][path]=value
            with self.subTest(path=path),self.assertRaises(ValidationError): validate_request('create',invalid)

    def test_transaction_nonce_expiry_and_gas_bounds(self):
        for field,value in (('nonceRaw',str(2**64)),('gasLimitRaw','3000001'),('maxPriorityFeePerGasRaw','11')):
            invalid=artifact();invalid['transaction'][field]=value
            with self.subTest(field=field),self.assertRaises(ValidationError): PreparedArtifact.model_validate(invalid)
        for field,value in (('expiresAt',1800000100),('preparedDeadline',1800000400)):
            invalid=artifact();invalid[field]=value
            with self.subTest(field=field),self.assertRaises(ValidationError): PreparedArtifact.model_validate(invalid)

    def test_only_prepare_can_deliver_wallet_data(self):
        prepared=build_fixtures()[1]['prepare']
        for route in ('get','report','reconcile','cancel','create'):
            with self.subTest(route=route),self.assertRaises(ValueError): validate_response(route,prepared)
        invalid=deepcopy(prepared);invalid['operation']['owner']='0x'+'bb'*20
        with self.assertRaises(ValidationError): validate_response('prepare',invalid)

    def test_receipt_costs_and_owner_observation_are_not_invented(self):
        _,body=build_variants()['confirmed']
        receipt=body['operation']['history'][0]['receipt']
        self.assertIn('ownershipObservedBlock',receipt['position'])
        for change in ({'grossGasFeeRaw':'1'},{'totalFeeRaw':'0'},
                       {'executionFeeRaw':receipt['grossGasFeeRaw']},
                       {'l1GasUsedRaw':str(int(receipt['gasUsedRaw'])+1)}):
            invalid=deepcopy(body);invalid['operation']['history'][0]['receipt'].update(change)
            with self.assertRaises(ValidationError): validate_response('get',invalid)

    def test_list_pagination_and_compact_history_consistency(self):
        body=build_fixtures()[1]['list']
        for field,value in (('hasMore',True),('nextBefore',body['operations'][0]['id'])):
            invalid=deepcopy(body);invalid[field]=value
            with self.assertRaises(ValidationError):validate_response('list',invalid)
        invalid=deepcopy(body);invalid['operations'][0]['historyCount']=1
        with self.assertRaises(ValidationError):validate_response('list',invalid)

    def test_observed_limit_flags_are_exact_for_each_subset_and_equality(self):
        source = build_variants()['fee_cap_breach'][1]
        fields = (('gasLimit', 'gasLimitRaw', 'maxGasLimitRaw'),
                  ('maxFeePerGas', 'maxFeePerGasRaw', 'maxFeePerGasRaw'),
                  ('maxPriorityFeePerGas', 'maxPriorityFeePerGasRaw', 'maxPriorityFeePerGasRaw'))
        for mask in range(8):
            body = deepcopy(source)
            observed = body['operation']['history'][0]['receipt']['transaction']
            observed['selectedLimitsExceeded'] = []
            for bit, (flag, actual, cap) in enumerate(fields):
                exceeds = bool(mask & (1 << bit))
                observed[actual] = str(int(body['operation']['selection'][cap]) + int(exceeds))
                if exceeds:
                    observed['selectedLimitsExceeded'].append(flag)
            for route, value in read_views(body):
                with self.subTest(mask=mask, route=route): validate_response(route, value)
        # Observed chain gas may exceed the preparation ceiling without being
        # relabelled as a new wallet instruction or losing the actual receipt.
        body = deepcopy(source)
        body['operation']['history'][0]['receipt']['transaction']['gasLimitRaw'] = '3000001'
        for route, value in read_views(body): validate_response(route, value)

    def test_observed_limit_flags_cannot_be_missing_reordered_duplicated_or_invented(self):
        source = build_variants()['fee_cap_breach'][1]
        for flags in ([], ['gasLimit'], ['gasLimit', 'gasLimit', 'maxFeePerGas'],
                      ['maxPriorityFeePerGas', 'maxFeePerGas', 'gasLimit'],
                      ['gasLimit', 'maxFeePerGas', 'unknown'],
                      ['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasLimit'], None):
            body = deepcopy(source)
            body['operation']['history'][0]['receipt']['transaction']['selectedLimitsExceeded'] = flags
            for route, value in read_views(body):
                with self.subTest(flags=flags, route=route), self.assertRaises(ValidationError):
                    validate_response(route, value)
        body = deepcopy(build_variants()['confirmed'][1])
        body['operation']['history'][0]['receipt']['transaction']['selectedLimitsExceeded'] = ['gasLimit']
        for route, value in read_views(body):
            with self.subTest(route=route), self.assertRaises(ValidationError): validate_response(route, value)

    def test_observed_envelope_nonce_and_costs_remain_bound(self):
        source = build_variants()['fee_cap_breach'][1]
        changes = [('transaction', 'nonceRaw', value) for value in ('6', str(2**64), '05', 5)]
        changes += [('transaction', 'gasLimitRaw', '20999'),
                    ('transaction', 'maxPriorityFeePerGasRaw', '202'),
                    ('receipt', 'gasUsedRaw', '300002'),
                    ('receipt', 'effectiveGasPriceRaw', '202'),
                    ('receipt', 'grossGasFeeRaw', '1'), ('receipt', 'totalFeeRaw', '1')]
        for section, field, changed in changes:
            body = deepcopy(source)
            receipt = body['operation']['history'][0]['receipt']
            (receipt['transaction'] if section == 'transaction' else receipt)[field] = changed
            if field in ('gasUsedRaw', 'effectiveGasPriceRaw'):
                receipt['grossGasFeeRaw'] = str(int(receipt['gasUsedRaw']) * int(receipt['effectiveGasPriceRaw']))
                receipt['l1FeeRaw'] = (None if receipt['l1GasUsedRaw'] is None else
                    str(int(receipt['l1GasUsedRaw']) * int(receipt['effectiveGasPriceRaw'])))
            for route, value in read_views(body):
                with self.subTest(field=field, changed=changed, route=route), self.assertRaises(ValidationError):
                    validate_response(route, value)

    def test_legacy_receipt_requires_explicit_null_observation(self):
        body = build_variants()['legacy_receipt'][1]
        self.assertIsNone(body['operation']['history'][0]['receipt']['transaction'])
        for route, value in read_views(body): validate_response(route, value)
        del body['operation']['history'][0]['receipt']['transaction']
        for route, value in read_views(body):
            with self.subTest(route=route), self.assertRaises(ValidationError): validate_response(route, value)

    def test_reported_conflicts_require_distinct_hashes_and_other_valid_nonces(self):
        source = build_variants()['reported_nonce_conflict'][1]
        step = source['operation']['history'][0]
        conflict = step['reportedEffectConflicts'][0]
        bad_conflicts = [[{**conflict, 'nonceRaw': value}] for value in (step['nonceRaw'], str(2**64), '06', 6)]
        bad_conflicts += [[conflict, {**conflict, 'nonceRaw': '7'}],
                          [{**conflict, 'transactionHash': '0x1234'}],
                          [{'transactionHash': '0x' + f'{index:064x}', 'nonceRaw': '6'} for index in range(9)]]
        for conflicts in bad_conflicts:
            body = deepcopy(source)
            body['operation']['history'][0]['reportedEffectConflicts'] = conflicts
            for route, value in read_views(body):
                with self.subTest(conflicts=conflicts, route=route), self.assertRaises(ValidationError):
                    validate_response(route, value)

    def test_reported_conflicts_never_become_terminal_or_draft_in_full_or_compact_reads(self):
        source = build_variants()['reported_nonce_conflict'][1]
        for state in ('attention', 'cancel_requested'):
            body = deepcopy(source);body['operation']['state'] = state
            for route, value in read_views(body): validate_response(route, value)
        for state in ('draft', 'awaiting_wallet', 'pending', 'confirmed', 'reverted', 'cancelled', 'superseded'):
            body = deepcopy(source)
            body['operation'].update(state=state, outstanding=False)
            if state == 'superseded':
                body['operation']['history'][0]['receipt']['position'] = None
            # Removing only the conflict makes this same envelope valid; the
            # rejection must not depend on an unrelated outstanding/state rule.
            cleared = deepcopy(body)
            cleared['operation']['history'][0]['reportedEffectConflicts'] = []
            for route, value in read_views(cleared): validate_response(route, value)
            for route, value in read_views(body):
                with self.subTest(state=state, route=route), self.assertRaises(ValidationError):
                    validate_response(route, value)

    def test_observed_fee_bumps_do_not_relax_new_preparation_caps(self):
        source = build_variants()['mint'][1]
        fields = (('gasLimitRaw', 'maxGasLimitRaw'), ('maxFeePerGasRaw', 'maxFeePerGasRaw'),
                  ('maxPriorityFeePerGasRaw', 'maxPriorityFeePerGasRaw'))
        exact = deepcopy(source)
        for actual, cap in fields:
            exact['walletStep']['transaction'][actual] = exact['operation']['selection'][cap]
        validate_response('prepare', exact)
        for actual, cap in fields:
            body = deepcopy(exact)
            body['walletStep']['transaction'][actual] = str(int(body['operation']['selection'][cap]) + 1)
            with self.subTest(actual=actual), self.assertRaises(ValidationError): validate_response('prepare', body)
