"""Private collection cards: offline ingress/auth/projection tests, no RPC."""
from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from discovery import POOL_MANAGER, POSITION_MANAGER, STATE_VIEW
from onboarding_auth import OnboardingAuth
from performance_api import PerformanceGateway, create_performance_app
from performance_collection import Baseline, epoch_id
from performance_models import (CONTRACT_VERSION, MAX_BODY, PERFORMANCE_REASONS, PerformanceError,
    validate_request, validate_response)
from performance_service import PerformanceService
from performance_store import PerformanceStoreError
from session_models import ERROR_STATUS, SessionError, token
from authenticated_api import MAX_WORKERS

OWNER = '0x'+'aa'*20
OTHER = '0x'+'cc'*20
VAULT = '0x'+'bb'*20
SESSION = 'a'*43
CSRF = 'b'*43
ORIGIN = 'https://domino.money'
HEADERS = {'Content-Type': 'application/json', 'X-Domino-Performance-Contract': CONTRACT_VERSION,
    'X-Domino-Browser-Origin': ORIGIN, 'CF-Access-Jwt-Assertion': 'synthetic-access-assertion',
    'X-Domino-Client-Id': '192.0.2.1', 'X-Domino-Session': SESSION, 'X-Domino-CSRF': CSRF}


def h(number):
    return '0x'+f'{number:064x}'


def stored_epoch(owner=OWNER, *, vault=VAULT):
    factory, implementation = '0x'+'dd'*20, '0x'+'ee'*20
    checkpoint = ['1000', '0', '0', '1', '1', '100', h(42)]
    baseline = {'chainId': 4663, 'owner': owner, 'vault': vault,
        'epochId': epoch_id(owner, vault, h(100)), 'positionManager': POSITION_MANAGER,
        'rootTokenId': '1', 'tokenIds': ['1'],
        'baseline': {'blockNumber': 100, 'blockHash': h(100), 'parentHash': h(99), 'timestamp': 1000},
        'vaultCodeHash': h(90), 'opening': {'sequenceIdentity': h(70),
            'poolManager': POOL_MANAGER, 'stateView': STATE_VIEW, 'factory': factory,
            'implementation': implementation, 'implementationVersion': 1, 'poolId': h(71),
            'currencies': ['0x'+'11'*20, '0x'+'22'*20],
            'members': [{'tokenId': '1', 'holder': owner, 'isRoot': True, 'parentTokenId': '0',
                'generation': 1, 'tickLower': -60, 'tickUpper': 60, 'identity': h(72),
                'registrationBaselineId': h(42), 'source0': h(73), 'source1': h(74),
                'liquidityRaw': '1000', 'principalRaw': ['100', '200'],
                'unsettledFeesRaw': ['10', '20'], 'registrationCheckpoint': checkpoint,
                'checkpoint': checkpoint}],
            'codePins': [{'address': address, 'codeHash': h(90 if address == vault else index+10)}
                for index, address in enumerate((vault, POSITION_MANAGER, POOL_MANAGER, STATE_VIEW,
                                                 factory, implementation))],
            'heldRaw': ['3', '4'], 'accountedRaw': ['1', '2'], 'nativeHeldRaw': '5'}}
    baseline = Baseline.model_validate(baseline).model_dump(mode='json')
    return {'owner': owner, 'epochId': baseline['epochId'], 'baseline': baseline,
        'cursor': {'blockNumber': 110, 'blockHash': h(110), 'parentHash': h(109), 'timestamp': 1060},
        'revision': 2, 'replayGeneration': 1, 'status': 'active', 'lastError': None,
        'pageCount': 1, 'receiptCount': 2, 'eventCount': 3, 'createdAt': 1000, 'updatedAt': 1061}


class AuthStore:
    """Exercise the actual OnboardingAuth orchestration without a database."""
    def __init__(self, owner=OWNER):
        self.owner = owner
        self.revoked = False
        self.begin_calls = 0
        self.finish_calls = 0

    def _check(self, session, csrf):
        token(session, required='session_required')
        token(csrf, required='csrf_invalid')
        if self.revoked or session != SESSION:
            raise SessionError('session_required')
        if csrf != CSRF:
            raise SessionError('csrf_invalid')

    def begin_preview(self, client, session, csrf, *, budget):
        self.begin_calls += 1
        self.budget = budget
        self._check(session, csrf)
        return {'address': self.owner, 'chainId': 4663}

    def finish_preview(self, session, csrf, owner, validation):
        self.finish_calls += 1
        self._check(session, csrf)
        if owner != self.owner:
            raise SessionError('session_required')

    def revoke(self, session):
        self.revoked = True


class PerformanceApiTests(unittest.TestCase):
    def setUp(self):
        self.record = stored_epoch()
        self.epoch = self.record['epochId']
        self.now = 1070
        self.auth_store = AuthStore()
        self.checker = SimpleNamespace(check=Mock(return_value={'method': 'plain_eoa',
            'blockNumber': '100', 'blockHash': h(100)}))
        self.auth = OnboardingAuth(self.auth_store, self.checker)
        self.reader = SimpleNamespace(list_epochs=Mock(side_effect=self.read))
        self.service = PerformanceService(self.auth, self.reader, clock=lambda: self.now)
        self.verifier = SimpleNamespace(verify=Mock())
        self.gateway = PerformanceGateway(service=self.service, verifier=self.verifier,
                                           origin=ORIGIN, enabled=True)
        self.client = self.client_for(self.gateway)

    def read(self, owner, ids):
        return [deepcopy(self.record)] if owner == self.record['owner'] and self.epoch in ids else []

    def client_for(self, gateway, host='127.0.0.1'):
        client = TestClient(create_performance_app(gateway), client=(host, 40000))
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def post(self, *, body=None, headers=None, raw=None, path='cards', client=None):
        return (client or self.client).post('/internal/performance/v1/'+path,
            content=raw if raw is not None else json.dumps(body if body is not None else {'epochIds': [self.epoch]}),
            headers=HEADERS if headers is None else headers)

    def test_authenticated_projection_is_raw_observation_span_not_financial_return(self):
        response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        result, card = response.json(), response.json()['cards'][0]
        self.assertEqual(result['owner'], OWNER)
        self.assertEqual((card['collectionStatus'], card['observedSeconds'], card['snapshotAgeSeconds']),
                         ('measuring', 60, 10))
        self.assertEqual(card['observations'], {'pages': 1, 'receipts': 2, 'events': 3})
        self.assertEqual(card['performanceReasons'], PERFORMANCE_REASONS)
        self.assertTrue(all(amount is None for amount in card['metrics'].values()))
        self.assertFalse(card['complete24h'])
        self.assertFalse(result['executionAvailable'])
        for name in ('opening', 'principalRaw', 'unsettledFeesRaw', 'heldRaw', 'rawReceipt', 'session', 'csrf'):
            self.assertNotIn('"'+name+'"', response.text)
        self.reader.list_epochs.assert_called_once_with(OWNER, [self.epoch])
        self.assertEqual((self.auth_store.begin_calls, self.auth_store.finish_calls), (1, 2))
        # Its own preview budget, apart from plans and quotes (3 Nov 2026).
        self.assertEqual(self.auth_store.budget, 'execution-performance')
        self.assertEqual(response.headers['X-Domino-Performance-Contract'], CONTRACT_VERSION)
        self.assertEqual(set(response.headers['cache-control'].split(', ')), {'no-store', 'no-transform'})
        for name in ('set-cookie', 'access-control-allow-origin', 'content-encoding'):
            self.assertNotIn(name, response.headers)

    def test_missing_and_foreign_epoch_are_indistinguishable(self):
        self.auth_store.owner = OTHER
        foreign = self.post().json()
        self.record['owner'] = OWNER  # Durable owner is never substituted from input.
        self.reader.list_epochs.side_effect = lambda owner, ids: []
        missing = self.post().json()
        self.assertEqual(foreign, missing)
        self.assertEqual(foreign['cards'][0]['kind'], 'not_found')
        self.assertEqual(foreign['owner'], OTHER)
        self.assertNotIn(OWNER, json.dumps(foreign))

    def test_order_and_uniform_missing_items_follow_bounded_request(self):
        missing = h(400)
        response = self.post(body={'epochIds': [missing, self.epoch]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([c['epochId'] for c in response.json()['cards']], [missing, self.epoch])
        self.assertEqual([c['kind'] for c in response.json()['cards']], ['not_found', 'tracked'])

    def test_eight_cards_use_one_owner_bound_store_read(self):
        ids = [self.epoch, *(h(400+i) for i in range(7))]
        response = self.post(body={'epochIds': ids})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([card['epochId'] for card in response.json()['cards']], ids)
        self.reader.list_epochs.assert_called_once_with(OWNER, ids)
        self.checker.check.assert_called_once_with(OWNER)

    def test_every_request_rechecks_auth_and_durable_revision(self):
        self.assertEqual(self.post().json()['cards'][0]['revision'], 2)
        self.record['revision'] = 3
        self.record['status'] = 'read_failed'
        self.record['lastError'] = 'private-provider-detail'
        response = self.post()
        self.assertEqual(response.json()['cards'][0]['revision'], 3)
        self.assertNotIn('private-provider-detail', response.text)
        self.assertEqual((self.reader.list_epochs.call_count, self.auth_store.begin_calls,
                          self.auth_store.finish_calls), (2, 2, 4))

    def test_revocation_during_store_read_prevents_response(self):
        def revoke(owner, ids):
            self.auth_store.revoked = True
            return [deepcopy(self.record)]
        self.reader.list_epochs.side_effect = revoke
        response = self.post()
        self.assertEqual((response.status_code, response.json()), (401, {'error': 'session_required'}))
        self.assertNotIn(self.epoch, response.text)

    def test_staleness_keeps_original_baseline_and_last_successful_snapshot(self):
        fresh = self.post().json()['cards'][0]
        self.record['status'] = 'read_failed'
        failed = self.post().json()['cards'][0]
        self.assertEqual(failed['collectionReason'], 'latest_read_failed')
        self.assertEqual(failed['collectionStatus'], 'stale')
        self.assertEqual((failed['baseline'], failed['snapshot'], failed['observedSeconds']),
                         (fresh['baseline'], fresh['snapshot'], fresh['observedSeconds']))
        self.record['status'] = 'active'
        self.now = 1180
        self.assertEqual(self.post().json()['cards'][0]['collectionStatus'], 'measuring')
        self.now = 1181
        aged = self.post().json()
        self.assertEqual(aged['cards'][0]['collectionReason'], 'snapshot_stale')
        self.assertEqual(aged['refreshAfterSeconds'], 60)
        self.assertEqual(aged['cards'][0]['snapshot'], fresh['snapshot'])

    def test_reorg_and_replay_never_expose_apr_or_reset_old_baseline(self):
        baseline = self.record['baseline']['baseline']
        for status, expected in (('replaying', 'partial'), ('baseline_reorged', 'unavailable')):
            self.record['status'] = status
            result = self.post().json()['cards'][0]
            self.assertEqual(result['collectionStatus'], expected)
            self.assertEqual(result['baseline']['blockHash'], baseline['blockHash'])
            self.assertEqual(result['performanceStatus'], 'unavailable')
            self.assertIsNone(result['metrics']['netFeeAprPercent'])

    def test_a_day_of_raw_observations_does_not_unlock_financial_metrics(self):
        self.record['cursor']['timestamp'] = 87400
        self.record['updatedAt'] = 87400
        self.now = 87410
        card = self.post().json()['cards'][0]
        self.assertEqual(card['observedSeconds'], 86400)
        self.assertFalse(card['complete24h'])
        self.assertEqual(card['performanceStatus'], 'unavailable')
        self.assertTrue(all(value is None for value in card['metrics'].values()))

    def test_disabled_exact_route_and_methods_have_no_runtime_effect(self):
        self.assertEqual(self.post(client=self.client_for(PerformanceGateway())).status_code, 404)
        for path in ('cards/', '%63ards', 'cards?owner=x', 'create', 'collect', 'sign', 'broadcast'):
            self.assertEqual(self.post(path=path).status_code, 404, path)
        self.assertEqual(self.client.get('/internal/performance/v1/cards').status_code, 405)
        self.assertEqual(self.client.get('/docs').status_code, 404)
        self.reader.list_epochs.assert_not_called()
        self.checker.check.assert_not_called()

    def test_loopback_origin_and_access_boundaries_precede_auth(self):
        self.assertEqual(self.post(client=self.client_for(self.gateway, '192.0.2.8')).status_code, 403)
        for field in ('Origin', 'Cookie', 'Authorization'):
            self.assertEqual(self.post(headers={**HEADERS, field: 'forged'}).status_code, 403)
        self.assertEqual(self.post(headers={**HEADERS, 'X-Domino-Browser-Origin': 'https://evil.invalid'}).status_code, 403)
        self.assertEqual(self.auth_store.begin_calls, 0)
        self.verifier.verify.side_effect = RuntimeError('private-service-token')
        response = self.post()
        self.assertEqual((response.status_code, response.json()), (503, {'error': 'upstream_unavailable'}))
        self.assertNotIn('private-service-token', response.text)
        self.assertEqual(self.auth_store.begin_calls, 0)

    def test_missing_bearer_and_csrf_use_existing_session_statuses(self):
        for name, expected in (('X-Domino-Session', (401, 'session_required')),
                               ('X-Domino-CSRF', (403, 'csrf_invalid'))):
            response = self.post(headers={k: v for k, v in HEADERS.items() if k != name})
            self.assertEqual((response.status_code, response.json()['error']), expected)
        response = self.post(headers={**HEADERS, 'X-Domino-CSRF': 'z'*43})
        self.assertEqual(response.status_code, 403)
        self.reader.list_epochs.assert_not_called()

    def test_full_session_error_mapping_is_preserved(self):
        from performance_models import ERROR_STATUS_BY_CODE
        for code, status in ERROR_STATUS.items():
            self.assertEqual(ERROR_STATUS_BY_CODE[code], status, code)
        for code in ('account_unsupported', 'session_capacity_busy', 'session_store_unavailable'):
            self.service.auth = SimpleNamespace(begin=Mock(side_effect=SessionError(code)))
            response = self.post()
            self.assertEqual((response.status_code, response.json()), (ERROR_STATUS[code], {'error': code}))

    def test_input_bounds_duplicates_and_private_fields_rejected_before_auth(self):
        invalid = [[], None, {}, {'epochIds': []}, {'epochIds': [self.epoch]*2},
            {'epochIds': [h(i) for i in range(1, 10)]}, {'epochIds': [h(0)]},
            {'epochIds': [self.epoch.upper()]}, {'epochIds': [self.epoch+'\n']},
            {'epochIds': [1]}, {'epochIds': '1'},
            *({'epochIds': [self.epoch], key: 'untrusted'} for key in ('owner', 'provider', 'evidence', 'receipt'))]
        for value in invalid:
            self.assertEqual(self.post(raw=json.dumps(value)).status_code, 400, value)
        for raw in ('{"epochIds":[],"epochIds":[]}', '{"epochIds":[NaN]}'):
            self.assertEqual(self.post(raw=raw).status_code, 400)
        self.assertEqual(self.post(raw=' '*(MAX_BODY+1)).status_code, 413)
        self.assertEqual(self.auth_store.begin_calls, 0)

    def test_forged_owner_header_has_no_effect_and_contract_header_is_strict(self):
        response = self.post(headers={**HEADERS, 'X-Domino-Owner': OTHER})
        self.assertEqual(response.json()['owner'], OWNER)
        self.assertEqual(self.post(headers={**HEADERS, 'X-Domino-Performance-Contract': '1.0.0'}).status_code, 502)
        self.assertEqual(self.post(headers=[*HEADERS.items(), ('x-domino-session', SESSION)]).status_code, 400)

    def test_capacity_and_store_errors_are_bounded_sanitized(self):
        for _ in range(MAX_WORKERS): self.gateway.slot.acquire()
        try:
            response = self.post()
            self.assertEqual((response.status_code, response.json()), (429, {'error': 'performance_capacity_busy'}))
            self.assertIn(response.headers['Retry-After'], {'2', '3', '4', '5'})
        finally:
            for _ in range(MAX_WORKERS): self.gateway.slot.release()
        self.reader.list_epochs.side_effect = PerformanceStoreError('performance_store_unavailable')
        response = self.post()
        self.assertEqual((response.status_code, response.json()), (503, {'error': 'performance_store_unavailable'}))

    def test_bad_owner_identity_cursor_counts_or_extra_store_data_never_leak(self):
        bad_rows = []
        for key, value in (('owner', OTHER), ('revision', 0), ('replayGeneration', 0),
                           ('pageCount', 0), ('receiptCount', 0), ('rawReceipt', {'secret': SESSION})):
            bad_rows.append({**deepcopy(self.record), key: value})
        wrong = deepcopy(self.record); wrong['cursor']['timestamp'] = self.now+1; bad_rows.append(wrong)
        wrong = deepcopy(self.record); wrong['cursor']['blockNumber'] = 100; bad_rows.append(wrong)
        for row in bad_rows:
            self.reader.list_epochs.side_effect = lambda *args, value=row: [value]
            response = self.post()
            self.assertEqual(response.status_code, 502, response.text)
            self.assertNotIn(SESSION, response.text)
        self.reader.list_epochs.side_effect = lambda *args: [self.record, self.record]
        self.assertEqual(self.post().status_code, 502)

    def test_injected_success_cannot_add_private_fields_or_financial_numbers(self):
        good = self.post().json()
        variants = []
        for field in ('rawReceipt', 'opening', 'principalRaw', 'session'):
            bad = deepcopy(good); bad['cards'][0][field] = SESSION; variants.append(bad)
        bad = deepcopy(good); bad['cards'][0]['metrics']['newTradingFeesUsd'] = '0'; variants.append(bad)
        bad = deepcopy(good); bad['cards'][0]['performanceStatus'] = 'available'; variants.append(bad)
        bad = deepcopy(good); bad['executionAvailable'] = True; variants.append(bad)
        for bad in variants:
            self.gateway.service = SimpleNamespace(execute=Mock(return_value=bad))
            response = self.post()
            self.assertEqual(response.status_code, 502)
            self.assertNotIn(SESSION, response.text)

    def test_response_validation_covers_relationships_and_numeric_coercion(self):
        good = self.post().json()
        variants = []
        for field, value in (('observedSeconds', 61), ('replayGeneration', 0),
                             ('snapshotAgeSeconds', 121), ('rootTokenId', str(2**256))):
            bad = deepcopy(good); bad['cards'][0][field] = value; variants.append(bad)
        for value in (30.0, '30', True):
            bad = deepcopy(good); bad['refreshAfterSeconds'] = value; variants.append(bad)
        bad = deepcopy(good); bad['cards'][0]['observations']['receipts'] = 0; variants.append(bad)
        bad = deepcopy(good); bad['cards'][0]['performanceReasons'].reverse(); variants.append(bad)
        for bad in variants:
            with self.assertRaises(PerformanceError):
                validate_response('cards', bad)
        self.assertEqual(validate_request('cards', {'epochIds': [self.epoch]}), {'epochIds': [self.epoch]})


if __name__ == '__main__':
    unittest.main()
