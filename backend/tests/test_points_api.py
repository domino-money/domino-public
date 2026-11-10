"""points-v1 (season 1's points for the app): the contract, the service over a real PostgreSQL as the session
role, and the listener through the authenticated boundary.

The service reads and records only through migration 059's functions: the tests run it as domino_session_auth
and check that this role reaches nothing else of the points schema. A link is checked before it is recorded (the
referred wallet's signature over the rebuilt text, both wallets against every exclusion, the season, the text's
freshness), and the first link holds.
"""
import io
import json
import os
from contextlib import redirect_stderr
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from dev_postgres import ADMIN, PORT, SOCKET  # noqa: E402
from points_engine import EngineStore, import_team, load_season, take_snapshot  # noqa: E402
from points_models import CONTRACT_VERSION, PointsError, validate_request, validate_response  # noqa: E402
from points_referral import message  # noqa: E402
from points_service import PointsService  # noqa: E402
from v2_manifest import PUBLIC_TEST_ACCOUNTS  # noqa: E402

DB = 'domino_points_api_tests'
MIGRATIONS = [Path(__file__).resolve().parents[1] / f'migrations/{name}.sql'
              for name in ('052_v2_index', '058_points_ledger', '059_points_engine')]
SEASON = load_season()
NOW = SEASON.start + 3600
KEYS = {'me': '0x' + '07' * 32, 'other': '0x' + '08' * 32}
REFERRER, TEAM = '0x' + 'aa' * 20, '0x' + 'ee' * 20
OPERATOR = '0x' + '14' * 20
SESSION, CSRF = 's' * 43, 'c' * 43


def wallet(name):
    from eth_account import Account
    return Account.from_key(KEYS[name]).address.lower()


def sign(name, text):
    from eth_account import Account
    from eth_account.messages import encode_defunct
    return '0x' + bytes(Account.sign_message(encode_defunct(text=text), private_key=KEYS[name]).signature).hex()


def link_body(referrer=REFERRER, signer='me', referee=None, issued_at=NOW):
    text = message(SEASON.id, referee or wallet('me'), referrer, issued_at)
    return {'referrer': referrer, 'issuedAt': issued_at, 'signature': sign(signer, text)}


class FakeAuth:
    def __init__(self, owner):
        self.owner, self.begun, self.finished = owner, 0, 0

    def begin(self, client, session, csrf):
        self.begun += 1
        return {'owner': self.owner, 'session': session, 'csrf': csrf}

    def finish(self, context):
        self.finished += 1


class ContractTests(unittest.TestCase):
    def test_requests_are_closed(self):
        self.assertEqual(validate_request('points', {}).model_dump(), {})
        for route, body in (('points', {'wallet': REFERRER}), ('link', {'referrer': REFERRER, 'issuedAt': 1}),
                            ('link', {**link_body(), 'referee': REFERRER}), ('link', {**link_body(), 'issuedAt': '1'}),
                            ('link', {**link_body(), 'signature': '0x12'}), ('link', {**link_body(), 'referrer': '0x1'}),
                            ('quote', {})):
            with self.subTest(route=route, body=body):
                with self.assertRaisesRegex(PointsError, 'invalid_request'):
                    validate_request(route, body)

    def test_a_response_must_add_up(self):
        base = {'contractVersion': CONTRACT_VERSION,
                'season': {'id': 'points-s1', 'title': 'Season 1', 'start': '2026-11-09T00:00:00Z',
                           'end': '2027-02-09T00:00:00Z', 'configSha256': 'a' * 64},
                'snapshot': None,
                'wallet': {'address': REFERRER, 'points': '3.000000', 'usagePoints': '1.000000',
                           'referralPoints': '2.000000',
                           'revenueUsd': {k: '0.000000000000000000' for k in ('assistedSwap', 'automation',
                                                                               'autoExit', 'bridge')},
                           'referrer': None, 'referees': 0}}
        self.assertEqual(validate_response('points', base)['wallet']['points'], '3.000000')
        for change in ({'points': '4.000000'}, {'referrer': REFERRER}, {'points': '3.0'}, {'referees': -1}):
            with self.subTest(change=change):
                with self.assertRaisesRegex(PointsError, 'upstream_contract_mismatch'):
                    validate_response('points', {**base, 'wallet': {**base['wallet'], **change}})
        with self.assertRaisesRegex(PointsError, 'upstream_contract_mismatch'):
            validate_response('link', {'contractVersion': CONTRACT_VERSION, 'status': 'recorded', 'referee': REFERRER,
                                       'referrer': REFERRER})


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'isolated PostgreSQL required')
class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with psycopg.connect(host=str(SOCKET), port=PORT, dbname='postgres', user=ADMIN, autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (DB,)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DB)))
        with cls.admin() as conn:
            conn.execute('DROP SCHEMA IF EXISTS domino_points CASCADE')
            conn.execute('DROP SCHEMA IF EXISTS domino_v2 CASCADE')
            for migration in MIGRATIONS:
                conn.execute(migration.read_text())

    @staticmethod
    def admin():
        return psycopg.connect(host=str(SOCKET), port=PORT, dbname=DB, user=ADMIN, autocommit=True)

    def setUp(self):
        roles = {'deployer': '0x' + '10' * 20, 'feeRecipient': '0x' + '11' * 20, 'governance': '0x' + '12' * 20,
                 'guardian': '0x' + '13' * 20, 'operator': OPERATOR, 'publisher': '0x' + '15' * 20}
        with self.admin() as conn:
            conn.execute('TRUNCATE domino_v2.deployments CASCADE')
            conn.execute('TRUNCATE domino_points.referrals, domino_points.snapshots, domino_points.team')
            conn.execute('''INSERT INTO domino_v2.deployments(chain_id,manifest_sha256,manifest,start_block,base_hash,
              next_block) VALUES(4663,%s,%s,10,%s,10)''', ('a' * 64, json.dumps({'roles': roles}), '0x' + '00' * 32))
        self.database = {'host': str(SOCKET), 'port': PORT, 'dbname': DB}
        self.store = EngineStore(self.database)
        team = Path(tempfile.mkdtemp(prefix='points-api-team-')) / 'team.json'
        team.write_text(json.dumps({'schemaVersion': 1, 'kind': 'domino-points-team', 'addresses': [TEAM]}))
        import_team(self.store, team, NOW)
        self.auth = FakeAuth(wallet('me'))
        self.service = PointsService(self.auth, self.database, SEASON, clock=lambda: NOW)

    def execute(self, route, body):
        return self.service.execute(route, body, client='192.0.2.1', session=SESSION, csrf=CSRF)

    def test_a_season_without_a_snapshot_answers_zero_and_null(self):
        answer = self.execute('points', {})
        self.assertEqual(answer['snapshot'], None)
        self.assertEqual((answer['wallet']['address'], answer['wallet']['points'], answer['wallet']['referrer']),
                         (wallet('me'), '0.000000', None))
        self.assertEqual(answer['season'], {'id': 'points-s1', 'title': 'Season 1', 'start': '2026-11-09T00:00:00Z',
                                            'end': '2027-02-09T00:00:00Z', 'configSha256': SEASON.sha256})
        self.assertEqual((self.auth.begun, self.auth.finished), (1, 1))

    def test_a_link_then_the_points_of_the_latest_snapshot(self):
        self.assertEqual(self.execute('link', link_body()), {'contractVersion': CONTRACT_VERSION, 'status': 'recorded',
                                                             'referee': wallet('me'), 'referrer': REFERRER})
        # The first link holds: another referrer, well signed, gets the first one back.
        other = '0x' + 'ab' * 20
        self.assertEqual(self.execute('link', link_body(referrer=other))['status'], 'existing')
        self.assertEqual(self.execute('link', link_body(referrer=other))['referrer'], REFERRER)
        with self.admin() as conn:
            conn.execute('''INSERT INTO domino_points.revenue(chain_id,block_number,log_index,block_hash,block_timestamp,
              tx_hash,kind,token,payer,amount,ref,decimals,price_block,price_late,token_usd,price_source,gross_usd,
              tx_gas_wei,gas_usd,net_usd,recorded_at) VALUES(4663,100,0,%s,%s,%s,1,%s,%s,1,%s,6,100,false,1,
              'chain_stable',0.65,NULL,0,0.65,0)''', ('0x' + '00' * 32, NOW - 10, '0x' + '01' * 32, '0x' + '5a' * 20,
                                                      wallet('me'), '0x' + 'cd' * 32))
        take_snapshot(self.store, SEASON, NOW)
        mine = self.execute('points', {})
        self.assertEqual((mine['wallet']['points'], mine['wallet']['referrer'], mine['wallet']['revenueUsd']['assistedSwap']),
                         ('650.000000', REFERRER, '0.650000000000000000'))
        self.assertEqual(mine['wallet']['revenueUsd']['bridge'], '0.000000000000000000')
        self.assertEqual(mine['snapshot']['takenAt'], NOW)
        self.auth.owner = REFERRER
        theirs = self.execute('points', {})
        self.assertEqual((theirs['wallet']['referralPoints'], theirs['wallet']['referees']), ('65.000000', 1))

    def test_every_refusal_of_a_link(self):
        cases = {
            'referral_signature_mismatch': link_body(signer='other'),
            'referral_self': link_body(referrer=wallet('me')),
            'referral_wallet_excluded': link_body(referrer=TEAM),
            'referral_message_not_fresh': link_body(issued_at=NOW - SEASON.freshness - 1),
        }
        for excluded in (OPERATOR, sorted(SEASON.safe_owners)[0], sorted(PUBLIC_TEST_ACCOUNTS)[0]):
            cases[f'referral_wallet_excluded {excluded}'] = link_body(referrer=excluded)
        for code, body in cases.items():
            with self.subTest(code=code):
                with self.assertRaises(PointsError) as raised:
                    self.execute('link', body)
                self.assertEqual(raised.exception.code, code.split()[0])
        self.auth.owner = TEAM  # the referred wallet itself excluded
        with self.assertRaisesRegex(PointsError, 'referral_wallet_excluded'):
            self.execute('link', link_body(referee=TEAM))
        self.auth.owner = wallet('me')
        late = PointsService(self.auth, self.database, SEASON, clock=lambda: SEASON.end)
        with self.assertRaisesRegex(PointsError, 'referral_season_closed'):
            late.execute('link', link_body(issued_at=SEASON.end), client='192.0.2.1', session=SESSION, csrf=CSRF)
        with self.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_points.referrals').fetchone()[0], 0)

    def test_the_session_role_reaches_only_the_functions(self):
        with psycopg.connect(**self.database, user='domino_session_auth', autocommit=True) as conn:
            for table in ('referrals', 'snapshots', 'team', 'revenue', 'bridge_fees'):
                with self.subTest(table=table):
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                        conn.execute(f'SELECT 1 FROM domino_points.{table} LIMIT 1')
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('''INSERT INTO domino_points.referrals(season,referee,referrer,message,signature,issued_at,
                  recorded_at) VALUES('points-s1',%s,%s,'x',%s,1,1)''', (wallet('me'), REFERRER, '0x' + '1' * 130))
            # Membership one wallet at a time, never the list.
            self.assertTrue(conn.execute('SELECT domino_points.is_excluded(%s,%s)', (TEAM, [])).fetchone()[0])
            self.assertTrue(conn.execute('SELECT domino_points.is_excluded(%s,%s)', (OPERATOR, ['operator'])).fetchone()[0])
            self.assertFalse(conn.execute('SELECT domino_points.is_excluded(%s,%s)', (OPERATOR, ['guardian'])).fetchone()[0])

    def test_a_database_failure_is_points_unavailable(self):
        broken = PointsService(self.auth, {**self.database, 'dbname': 'domino_points_missing'}, SEASON, clock=lambda: NOW)
        with self.assertRaisesRegex(PointsError, 'points_unavailable'):
            broken.execute('points', {}, client='192.0.2.1', session=SESSION, csrf=CSRF)


ORIGIN = 'https://domino.money'
HEADERS = {'CF-Access-Jwt-Assertion': 'synthetic-service-assertion', 'X-Domino-Client-Id': '192.0.2.1',
           'X-Domino-Browser-Origin': ORIGIN, 'X-Domino-Points-Contract': CONTRACT_VERSION,
           'X-Domino-Session': SESSION, 'X-Domino-CSRF': CSRF}


class ApiTests(unittest.TestCase):
    def client(self, service):
        from fastapi.testclient import TestClient
        from points_api import PointsGateway, create_points_app
        self.verifier = SimpleNamespace(verify=Mock())
        gateway = PointsGateway(service=service, verifier=self.verifier, origin=ORIGIN, enabled=True, clock=lambda: 0.0)
        client = TestClient(create_points_app(gateway), client=('127.0.0.1', 43100), base_url='http://127.0.0.1:8912')
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def post(self, client, body, route='points', headers=None):
        return client.post('/internal/points/v1/' + route, content=json.dumps(body),
                           headers={'content-type': 'application/json',
                                    **{k.lower(): v for k, v in (headers or HEADERS).items()}})

    def test_points_are_served_with_the_contract_header_and_one_safe_record(self):
        answer = {'contractVersion': CONTRACT_VERSION,
                  'season': {'id': 'points-s1', 'title': 'Season 1', 'start': '2026-11-09T00:00:00Z',
                             'end': '2027-02-09T00:00:00Z', 'configSha256': SEASON.sha256},
                  'snapshot': None,
                  'wallet': {'address': REFERRER, 'points': '0.000000', 'usagePoints': '0.000000',
                             'referralPoints': '0.000000',
                             'revenueUsd': {k: '0.000000000000000000' for k in ('assistedSwap', 'automation',
                                                                                 'autoExit', 'bridge')},
                             'referrer': None, 'referees': 0}}
        service = Mock()
        service.execute.return_value = answer
        client = self.client(service)
        with redirect_stderr(io.StringIO()) as printed:
            response = self.post(client, {})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers['X-Domino-Points-Contract'], CONTRACT_VERSION)
        self.assertIn('no-store', response.headers['cache-control'])
        self.assertEqual(response.json(), answer)
        records = [json.loads(line) for line in printed.getvalue().splitlines() if line]
        self.assertEqual([(r['service'], r['route'], r['status']) for r in records], [('internal-points-v1', 'points', 200)])
        self.assertIsNone(re.search(r'0x[0-9a-fA-F]{40}', printed.getvalue()))
        for value in (SESSION, CSRF):
            self.assertNotIn(value, printed.getvalue())

    def test_the_admission_boundary(self):
        service = Mock()
        service.execute.side_effect = PointsError('referral_signature_mismatch')
        client = self.client(service)
        self.assertEqual((self.post(client, link_body(), route='link').status_code,
                          self.post(client, link_body(), route='link').json()),
                         (422, {'error': 'referral_signature_mismatch'}))
        self.assertEqual(self.post(client, {}, headers={**HEADERS, 'X-Domino-Points-Contract': '0.9.0'}).json(),
                         {'error': 'upstream_contract_mismatch'})
        self.assertEqual(self.post(client, {}, route='quote').status_code, 404)
        self.assertEqual(self.post(client, {}, headers={**HEADERS, 'X-Domino-Browser-Origin': 'https://evil.example'}).json(),
                         {'error': 'origin_not_allowed'})
        self.assertEqual(client.get('/internal/points/v1/points').status_code, 405)

    def test_a_disabled_listener_serves_nothing(self):
        from fastapi.testclient import TestClient
        from points_api import create_points_app
        with TestClient(create_points_app(), client=('127.0.0.1', 43000)) as client:
            response = client.post('/internal/points/v1/points', content='{}', headers={'content-type': 'application/json'})
        self.assertEqual((response.status_code, response.json()), (404, {'error': 'route_not_available'}))


if __name__ == '__main__':
    unittest.main()
