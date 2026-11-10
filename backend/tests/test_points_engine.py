"""The points engine and referral links (points, season 1).

The season's configuration as committed and broken ones; the team list; the computation as a pure function
(points for use per kind and chain, the bridge's app fee, exclusions, the Auto-exit floor, referral points on one
level counting the whole season, ignored links); the text a referred wallet signs and its signature; and, over a
real PostgreSQL with migrations 052, 058 and 059: links recorded once (the first holds) and every refusal, the
excluded wallets read from the deployments, and a snapshot whose stored body hashes to its sha256.
"""
from decimal import Decimal
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import unittest.mock

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import DataError  # noqa: E402
from dev_postgres import ADMIN, PORT, SOCKET  # noqa: E402
import points_engine  # noqa: E402
from points_engine import (SEASON_1, EngineStore, canonical, compute, excluded_wallets, import_team,  # noqa: E402
                           latest_snapshot, load_season, read_team_file, sha256, stored_team, take_snapshot,
                           team_digest, wallet_points)
import points_referral  # noqa: E402
from points_referral import message, normalized, record, signer, verified  # noqa: E402
from v2_manifest import PUBLIC_TEST_ACCOUNTS  # noqa: E402

DB = 'domino_points_engine_tests'
MIGRATIONS = [Path(__file__).resolve().parents[1] / f'migrations/{name}.sql'
              for name in ('052_v2_index', '058_points_ledger', '059_points_engine')]
SEASON = load_season()
START, END = SEASON.start, SEASON.end
A, B, C, D, TEAM = ('0x' + c * 40 for c in 'abcde')
ROLES = {'deployer': '0x' + '10' * 20, 'feeRecipient': '0x' + '11' * 20, 'governance': '0x' + '12' * 20,
         'guardian': '0x' + '13' * 20, 'operator': '0x' + '14' * 20, 'publisher': '0x' + '15' * 20}
KEYS = {name: '0x' + f'{n:064x}' for n, name in enumerate(('referee', 'other', 'third'), start=7)}


def account(name):
    from eth_account import Account
    return Account.from_key(KEYS[name])


def sign(name, text):
    from eth_account import Account
    from eth_account.messages import encode_defunct
    signed = Account.sign_message(encode_defunct(text=text), private_key=KEYS[name])
    return '0x' + bytes(signed.signature).hex()


def revenue(payer, kind, net, *, chain=4663, at=START + 10, gross=None):
    return {'payer': payer, 'kind': kind, 'chain_id': chain, 'block_timestamp': at, 'net_usd': Decimal(net),
            'gross_usd': Decimal(gross if gross is not None else net)}


def link(referee, referrer, season='points-s1'):
    return {'season': season, 'referee': referee, 'referrer': referrer}


class SeasonTests(unittest.TestCase):
    def test_season_1_as_decided(self):
        self.assertEqual((SEASON.id, SEASON.start, SEASON.end), ('points-s1', 1794182400, 1802131200))
        self.assertEqual((SEASON.per_usd, SEASON.referral_share, SEASON.auto_exit_floor),
                         (Decimal(1000), Decimal('0.10'), Decimal('0.10')))
        self.assertEqual(set(SEASON.roles), set(ROLES))
        self.assertEqual(len(SEASON.safe_owners), 3)
        self.assertTrue(SEASON.public_test_accounts)
        self.assertEqual(SEASON.sha256, sha256(canonical(json.loads(SEASON_1.read_text()))))

    def test_a_broken_season_is_refused(self):
        document = json.loads(SEASON_1.read_text())
        broken = [
            {**document, 'extra': 1},
            {**document, 'startUnix': document['startUnix'] + 1},
            {**document, 'end': document['start'], 'endUnix': document['startUnix']},
            {**document, 'kind': 'other'},
            {**document, 'referralShare': '1.5'},
            {**document, 'pointsPerUsd': 'many'},
            {**document, 'excluded': {**document['excluded'], 'deploymentRoles': ['owner']}},
            {**document, 'excluded': {**document['excluded'], 'governanceSafeOwners': ['0xABC']}},
            {**document, 'excluded': {**document['excluded'], 'publicTestAccounts': 'yes'}},
            {**document, 'referral': {**document['referral'], 'levels': 2}},
            {**document, 'referral': {**document['referral'], 'freshnessSeconds': 0}},
        ]
        for i, value in enumerate(broken):
            with self.subTest(i=i):
                path = Path(tempfile.mkdtemp(prefix='points-season-')) / 'season.json'
                path.write_text(json.dumps(value))
                with self.assertRaises(DataError):
                    load_season(path)

    def test_the_team_list(self):
        path = Path(tempfile.mkdtemp(prefix='points-team-')) / 'team.json'
        path.write_text(json.dumps({'schemaVersion': 1, 'kind': 'domino-points-team', 'addresses': [TEAM.upper()
                                                                                                    .replace('0X', '0x')]}))
        self.assertEqual(read_team_file(path), frozenset({TEAM}))
        self.assertEqual(team_digest({B, A}), sha256(canonical([A, B])))
        for bad in ({'schemaVersion': 1, 'kind': 'domino-points-team', 'addresses': ['0x12']},
                    {'schemaVersion': 1, 'kind': 'other', 'addresses': []},
                    {'schemaVersion': 1, 'kind': 'domino-points-team', 'addresses': [], 'note': 'x'}):
            path.write_text(json.dumps(bad))
            with self.assertRaises(DataError):
                read_team_file(path)


class ComputeTests(unittest.TestCase):
    def test_points_for_use_per_kind_and_chain_and_the_bridge(self):
        result = compute(SEASON, [revenue(A, 1, '0.65'), revenue(A, 2, '1.5', chain=8453), revenue(A, 3, '0.2')],
                         [{'wallet': A, 'charged_at': START + 5, 'usd': Decimal('0.35'), 'destination_chain_id': 8453}],
                         [], frozenset())
        entry, = result['wallets']
        self.assertEqual((entry['points'], entry['usagePoints'], entry['referralPoints']),
                         ('2700.000000', '2700.000000', '0.000000'))
        self.assertEqual(entry['revenueUsd'], {'assisted_swap': '0.650000000000000000',
                                               'auto_exit': '0.200000000000000000',
                                               'automation': '1.500000000000000000',
                                               'bridge': '0.350000000000000000'})
        self.assertEqual(entry['chains'], {'4663': '0.850000000000000000', '8453': '1.850000000000000000'})
        self.assertEqual(result['totals']['revenueUsd'], '2.700000000000000000')

    def test_the_auto_exit_floor_and_exclusions(self):
        rows = [revenue(A, 3, '0.09', gross='0.0999'), revenue(A, 3, '0.05', gross='0.10'), revenue(TEAM, 1, '5'),
                revenue(B, 1, '1')]
        bridge = [{'wallet': TEAM, 'charged_at': START, 'usd': Decimal('1'), 'destination_chain_id': 4663}]
        result = compute(SEASON, rows, bridge, [], frozenset({TEAM}))
        by_wallet = {e['address']: e for e in result['wallets']}
        # Below US$0.10 of fee an Auto-exit counts nothing; at US$0.10 its net counts.
        self.assertEqual(by_wallet[A]['usagePoints'], '50.000000')
        self.assertNotIn(TEAM, by_wallet)
        self.assertEqual((result['totals']['excludedUsd'], result['totals']['autoExitsBelowFloor']),
                         ('6.000000000000000000', 1))

    def test_referral_points_one_level_for_the_whole_season(self):
        # A referred B, B referred C. A earns 10% of B's points for use, not of B's referral points.
        rows = [revenue(B, 1, '2', at=START), revenue(C, 2, '10', at=END - 1)]
        result = compute(SEASON, rows, [], [link(C, B), link(B, A)], frozenset())  # C's link first: one level still
        by_wallet = {e['address']: e for e in result['wallets']}
        self.assertEqual((by_wallet[A]['points'], by_wallet[A]['referralPoints'], by_wallet[A]['referees']),
                         ('200.000000', '200.000000', 1))
        self.assertEqual((by_wallet[B]['usagePoints'], by_wallet[B]['referralPoints'], by_wallet[B]['points']),
                         ('2000.000000', '1000.000000', '3000.000000'))
        self.assertEqual((by_wallet[B]['referrer'], by_wallet[C]['referrer'], by_wallet[A]['referrer']), (A, B, None))
        self.assertEqual(result['totals']['points'], '13200.000000')
        self.assertEqual(result['totals']['links'], 2)

    def test_links_that_count_for_no_one(self):
        rows = [revenue(B, 1, '1'), revenue(C, 1, '1'), revenue(D, 1, '1')]
        links = [link(B, TEAM), link(TEAM, C), link(D, D), link(C, A, season='points-s0')]
        result = compute(SEASON, rows, [], links, frozenset({TEAM}))
        self.assertTrue(all(e['referralPoints'] == '0.000000' and e['referrer'] is None for e in result['wallets']))
        self.assertEqual(result['totals']['links'], 0)

    def test_a_zero_reads_in_fixed_point(self):
        result = compute(SEASON, [revenue(A, 1, '0')], [], [], frozenset())
        self.assertEqual(result['wallets'][0]['revenueUsd'], {'assisted_swap': '0.000000000000000000'})
        self.assertEqual(result['totals']['excludedUsd'], '0.000000000000000000')

    def test_a_row_outside_the_season_is_a_bug(self):
        for row in (revenue(A, 1, '1', at=START - 1), revenue(A, 1, '1', at=END)):
            with self.assertRaises(DataError):
                compute(SEASON, [row], [], [], frozenset())
        for at in (START - 1, END):
            with self.assertRaises(DataError):
                compute(SEASON, [], [{'wallet': A, 'charged_at': at, 'usd': Decimal(1), 'destination_chain_id': 1}],
                        [], frozenset())


class SignedTextTests(unittest.TestCase):
    def test_the_text_and_its_signer(self):
        referee = account('referee').address
        text = message('points-s1', referee, A, START + 3661)
        self.assertEqual(text, f'Domino Points, Season 1\nReferred wallet: {referee.lower()}\nReferrer: {A}\n'
                               'This link lasts until the end of Season 1 and cannot change.\n'
                               'Issued at: 2026-11-09T01:01:01Z')
        signature = sign('referee', text)
        self.assertEqual(signer(text, signature), referee.lower())
        # A wallet answering v as 0 or 1 signs the same.
        low = signature[:-2] + f'{int(signature[-2:], 16) - 27:02x}'
        self.assertEqual(signer(text, low), referee.lower())
        for bad in ('0x12', signature[:-2] + '1d', 'nope', None):
            with self.assertRaises(DataError):
                normalized(bad)
        with self.assertRaises(DataError):
            message('points-s9', referee, A, START)

    def test_a_stored_link_is_verified_against_its_own_fields(self):
        referee = account('referee').address.lower()
        text = message('points-s1', referee, A, START + 5)
        link = {'season': 'points-s1', 'referee': referee, 'referrer': A, 'issued_at': START + 5, 'message': text,
                'signature': sign('referee', text)}
        self.assertTrue(verified(SEASON, link))
        for change in ({'signature': sign('other', text)},              # another wallet signed
                       {'referrer': B},                                 # the text names another referrer
                       {'issued_at': START + 6},                        # or another time
                       {'message': text + ' '},                         # the stored text is not the rebuilt one
                       {'season': 'points-s2'},                         # another season's row
                       {'signature': '0x' + '00' * 65},                 # no signature at all
                       {'issued_at': None}):
            with self.subTest(change=change):
                self.assertFalse(verified(SEASON, {**link, **change}))
        self.assertFalse(verified(SEASON, {key: value for key, value in link.items() if key != 'message'}))


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'isolated PostgreSQL required')
class StoredTests(unittest.TestCase):
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
            conn.execute(MIGRATIONS[2].read_text())  # 059 applies again safely

    @staticmethod
    def admin():
        return psycopg.connect(host=str(SOCKET), port=PORT, dbname=DB, user=ADMIN, autocommit=True)

    def setUp(self):
        with self.admin() as conn:
            conn.execute('TRUNCATE domino_v2.deployments CASCADE')
            conn.execute('TRUNCATE domino_points.referrals, domino_points.bridge_fees, domino_points.snapshots, '
                         'domino_points.team')
            for chain in (4663, 8453):
                conn.execute('''INSERT INTO domino_v2.deployments(chain_id,manifest_sha256,manifest,start_block,base_hash,
                  next_block) VALUES(%s,%s,%s,10,%s,10)''', (chain, 'a' * 64, json.dumps({'roles': ROLES}),
                                                             '0x' + '00' * 32))
        self.store = EngineStore({'host': str(SOCKET), 'port': PORT, 'dbname': DB})
        self.now = START + 100

    def link(self, referrer, *, signer_name='referee', referee=None, issued_at=None, excluded=frozenset(), now=None):
        referee = referee or account('referee').address
        issued_at = self.now if issued_at is None else issued_at
        text = message('points-s1', referee, referrer, issued_at)
        with self.store.writer() as conn:
            return record(conn, SEASON, referee=referee, referrer=referrer, issued_at=issued_at,
                          signature=sign(signer_name, text), excluded=excluded, now=self.now if now is None else now)

    def import_team(self, addresses):
        path = Path(tempfile.mkdtemp(prefix='points-team-')) / 'team.json'
        path.write_text(json.dumps({'schemaVersion': 1, 'kind': 'domino-points-team', 'addresses': addresses}))
        return import_team(self.store, path, self.now)

    def test_the_team_list_is_imported_whole(self):
        self.assertEqual(self.import_team([A, B]), {'wallets': 2, 'sha256': team_digest({A, B})})
        self.assertEqual(self.import_team([C]), {'wallets': 1, 'sha256': team_digest({C})})
        with self.store.writer() as conn:
            self.assertEqual(stored_team(conn), (frozenset({C}), team_digest({C})))
        # A broken file changes nothing.
        with self.assertRaises(DataError):
            self.import_team(['0x12'])
        with self.store.writer() as conn:
            self.assertEqual(stored_team(conn)[0], frozenset({C}))
        # The public read path's role never reads the list.
        with self.admin() as conn:
            granted = conn.execute('''SELECT privilege_type FROM information_schema.role_table_grants
              WHERE table_schema='domino_points' AND table_name='team' AND grantee='domino_catalogue_reader' ''').fetchall()
        self.assertEqual(granted, [])

    def test_the_first_link_holds(self):
        referee = account('referee').address.lower()
        self.assertEqual(self.link(A), {'status': 'recorded', 'season': 'points-s1', 'referee': referee,
                                        'referrer': A})
        self.assertEqual(self.link(B), {'status': 'existing', 'season': 'points-s1', 'referee': referee,
                                        'referrer': A})
        with self.admin() as conn:
            conn.row_factory = psycopg.rows.dict_row
            stored = conn.execute('SELECT * FROM domino_points.referrals').fetchall()
        self.assertEqual(len(stored), 1)
        # Anyone can check a stored link: its text recovers to the referred wallet.
        self.assertEqual(signer(stored[0]['message'], stored[0]['signature']), referee)

    def test_every_refusal(self):
        referee = account('referee').address
        cases = {
            'referral_self': dict(referrer=referee.lower()),
            'referral_wallet_excluded': dict(referrer=A, excluded=frozenset({A})),
            'referral_season_closed': dict(referrer=A, now=END, issued_at=END),
            'referral_message_not_fresh': dict(referrer=A, issued_at=self.now - SEASON.freshness - 1),
            'referral_signature_mismatch': dict(referrer=A, signer_name='other'),
        }
        for code, options in cases.items():
            with self.subTest(code=code):
                with self.assertRaises(DataError) as raised:
                    self.link(**options)
                self.assertEqual(str(raised.exception), code)
        excluded_referee = frozenset({referee.lower()})
        with self.assertRaises(DataError):
            self.link(A, excluded=excluded_referee)
        self.assertEqual(self.link(A, issued_at=self.now + SEASON.freshness)['status'], 'recorded')

    def test_excluded_wallets_come_from_the_deployments_and_the_season(self):
        with self.store.writer() as conn:
            excluded = excluded_wallets(conn, SEASON, frozenset({TEAM}))
        self.assertTrue(set(ROLES.values()) <= excluded)
        self.assertTrue(SEASON.safe_owners <= excluded)
        self.assertTrue(PUBLIC_TEST_ACCOUNTS <= excluded)
        self.assertIn(TEAM, excluded)
        with self.admin() as conn:
            conn.execute("UPDATE domino_v2.deployments SET manifest='{\"roles\": {}}' WHERE chain_id=8453")
        with self.store.writer() as conn, self.assertRaises(DataError):
            excluded_wallets(conn, SEASON, frozenset())

    def test_a_snapshot_reads_every_table_at_one_moment(self):
        seen = []
        real = points_engine.excluded_wallets

        def watching(conn, season, team):
            seen.append(conn.execute('SHOW transaction_isolation').fetchone()['transaction_isolation'])
            return real(conn, season, team)
        with unittest.mock.patch.object(points_engine, 'excluded_wallets', watching):
            take_snapshot(self.store, SEASON, self.now)
        self.assertEqual(seen, ['repeatable read'])

    def test_a_snapshot_counts_only_the_links_their_referred_wallet_signed(self):
        referee, other, third = (account(name).address.lower() for name in ('referee', 'other', 'third'))
        with self.admin() as conn:
            for n, payer in enumerate((referee, other, third, D)):
                conn.execute('''INSERT INTO domino_points.revenue(chain_id,block_number,log_index,block_hash,
                  block_timestamp,tx_hash,kind,token,payer,amount,ref,decimals,price_block,price_late,token_usd,
                  price_source,gross_usd,tx_gas_wei,gas_usd,net_usd,recorded_at) VALUES(4663,%s,0,%s,%s,%s,1,%s,%s,1,
                  %s,6,%s,false,1,'chain_stable',1,NULL,0,1,0)''',
                             (200 + n, '0x' + '00' * 32, START + 1 + n, '0x' + f'{200 + n:064x}', '0x' + '5a' * 20,
                              payer, '0x' + 'cd' * 32, 200 + n))
            # Rows no listener would have recorded, written past it: each names B.
            signed_by_another = message('points-s1', other, B, self.now)
            elsewhere = message('points-s1', third, C, self.now)
            for referee_of, text, signature in ((other, signed_by_another, sign('third', signed_by_another)),
                                                (third, elsewhere, sign('third', elsewhere)),
                                                (D, message('points-s1', D, B, self.now), '0x' + '00' * 65)):
                conn.execute('''INSERT INTO domino_points.referrals(season,referee,referrer,message,signature,
                  issued_at,recorded_at) VALUES('points-s1',%s,%s,%s,%s,%s,%s)''',
                             (referee_of, B, text, signature, self.now, self.now))
        self.link(A)  # the referred wallet's own, through record()
        report = take_snapshot(self.store, SEASON, self.now)
        self.assertEqual((report['totals']['links'], report['totals']['linksUnverified']), (1, 3))
        latest = latest_snapshot(self.store, SEASON)
        self.assertEqual(wallet_points(latest, B)['points'], '0.000000')
        self.assertEqual((wallet_points(latest, A)['referralPoints'], wallet_points(latest, A)['referees']),
                         ('100.000000', 1))
        for wallet in (other, third, D):
            self.assertIsNone(wallet_points(latest, wallet)['referrer'])
            self.assertEqual(wallet_points(latest, wallet)['points'], '1000.000000')

    def test_a_snapshot_is_stored_with_its_hash(self):
        referee = account('referee').address.lower()
        with self.admin() as conn:
            for n, (payer, net, at) in enumerate(((referee, '2', START + 1), (A, '1', START + 2),
                                                  (referee, '5', START - 1), (ROLES['operator'], '9', START + 3),
                                                  (TEAM, '3', START + 5))):
                conn.execute('''INSERT INTO domino_points.revenue(chain_id,block_number,log_index,block_hash,
                  block_timestamp,tx_hash,kind,token,payer,amount,ref,decimals,price_block,price_late,token_usd,
                  price_source,gross_usd,tx_gas_wei,gas_usd,net_usd,recorded_at) VALUES(4663,%s,0,%s,%s,%s,1,%s,%s,1,
                  %s,6,%s,false,1,'chain_stable',%s,NULL,0,%s,0)''',
                             (100 + n, '0x' + '00' * 32, at, '0x' + f'{n:064x}', '0x' + '5a' * 20, payer, '0x' + 'cd' * 32,
                              100 + n, net, net))
            conn.execute('''INSERT INTO domino_points.bridge_fees(provider,request_id,wallet,origin_chain_id,
              destination_chain_id,charged_at,token,amount,usd,evidence,recorded_at)
              VALUES('relay','r1',%s,1,8453,%s,%s,350000,0.35,'relay_requests_v3',0)''',
                         (A, START + 4, '0x' + '83' * 20))
            conn.execute('''INSERT INTO domino_points.ledger_cursor(chain_id,floor_block,block_number,block_hash,
              block_timestamp,caught_up,updated_at) VALUES(4663,10,120,%s,%s,true,0)''', ('0x' + 'ab' * 32, START + 9))
        self.link(A)
        self.import_team([TEAM])
        report = take_snapshot(self.store, SEASON, self.now)
        self.assertEqual(report['totals']['revenueUsd'], '3.350000000000000000')
        self.assertEqual(report['totals']['excludedUsd'], '12.000000000000000000')  # the operator's and the team's
        latest = latest_snapshot(self.store, SEASON)
        self.assertEqual(latest['sha256'], report['sha256'])
        self.assertEqual(sha256(canonical(latest['body'])), latest['sha256'])
        self.assertEqual((latest['config_sha256'], latest['team_sha256']), (SEASON.sha256, team_digest({TEAM})))
        self.assertNotIn(TEAM, json.dumps(latest['body']))  # the team's addresses never enter a snapshot
        self.assertEqual(latest['body']['ledger'], {'4663': {'through': 120, 'timestamp': START + 9, 'caughtUp': True,
                                                             'lastError': None}})
        mine = wallet_points(latest, A)
        # 1.35 of revenue and 10% of the referred wallet's 2,000 points (the row before the start counts nothing).
        self.assertEqual((mine['usagePoints'], mine['referralPoints'], mine['points'], mine['referees']),
                         ('1350.000000', '200.000000', '1550.000000', 1))
        self.assertEqual(wallet_points(latest, referee)['referrer'], A)
        self.assertEqual(wallet_points(latest, B)['points'], '0.000000')
        # The same rows give the same body, and so the same hash.
        again = take_snapshot(self.store, SEASON, self.now + 1)
        self.assertEqual({**latest['body'], 'takenAt': self.now + 1}, latest_snapshot(self.store, SEASON)['body'])
        self.assertNotEqual(again['sha256'], report['sha256'])  # takenAt is part of the body


if __name__ == '__main__':
    unittest.main()
