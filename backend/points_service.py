"""points-v1's service: season 1's points and referral links for the SIWE session's wallet.

Both routes read and write through migration 059's functions only, as the
session role the listener already logs in as (domino_session_auth): the
wallet's entry in the season's latest snapshot, whether a wallet is excluded by
the team's list or a deployment's role, and recording a link, where the first
holds. The listener cannot read a table of the points schema. A link is checked
here before it is recorded (points_referral.record): its text rebuilt from the
fields, its signature recovered to the session's wallet, both wallets checked
against every exclusion (the governance Safe's owners and the public test
accounts from the season's configuration; the team and the roles from the
database), the season open and the text fresh.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import time

import psycopg
from psycopg.rows import dict_row

from discovery import DataError
from points_models import CONTRACT_VERSION, PointsError, validate_request, validate_response
from read_deadline import check_read_deadline

SESSION_ROLE = 'domino_session_auth'
ZERO_POINTS, ZERO_USD = '0.000000', '0.000000000000000000'
REVENUE_KEYS = (('assisted_swap', 'assistedSwap'), ('automation', 'automation'), ('auto_exit', 'autoExit'),
                ('bridge', 'bridge'))
# What points_referral.record refuses, as the contract says it; anything else about the request is invalid.
LINK_CODES = frozenset({'referral_self', 'referral_wallet_excluded', 'referral_season_closed',
                        'referral_message_not_fresh', 'referral_signature_invalid', 'referral_signature_mismatch'})


def instant(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class PointsService:
    def __init__(self, auth, database, season, *, clock=time.time, connect=psycopg.connect):
        from points_referral import SEASON_TITLES
        if season.id not in SEASON_TITLES:
            raise ValueError('points_season_unknown')
        self.auth, self.database, self.season, self.clock, self.connect = auth, database, season, clock, connect
        static = set(season.safe_owners)
        if season.public_test_accounts:
            from v2_manifest import PUBLIC_TEST_ACCOUNTS
            static |= PUBLIC_TEST_ACCOUNTS
        self.static_excluded = frozenset(static)
        self.season_view = {'id': season.id, 'title': SEASON_TITLES[season.id], 'start': instant(season.start),
                            'end': instant(season.end), 'configSha256': season.sha256}

    @contextmanager
    def session_connection(self):
        try:
            conn = self.connect(**self.database, user=SESSION_ROLE, connect_timeout=3, autocommit=True,
                                row_factory=dict_row)
        except psycopg.Error:
            raise PointsError('points_unavailable') from None
        try:
            yield conn
        except psycopg.Error:
            raise PointsError('points_unavailable') from None
        finally:
            conn.close()

    def execute(self, route, body, *, client, session, csrf):
        request = validate_request(route, body).model_dump()
        check_read_deadline()
        context = self.auth.begin(client, session, csrf)
        wallet = context['owner'].lower()
        with self.session_connection() as conn:
            result = self.points(conn, wallet) if route == 'points' else self.link(conn, wallet, request)
        result = validate_response(route, result)
        # A logout or a CSRF rotation while the database answered invalidates delivery.
        self.auth.finish(context)
        check_read_deadline()
        return result

    def points(self, conn, wallet):
        row = conn.execute('SELECT taken_at,snapshot_sha256,entry FROM domino_points.wallet_entry(%s,%s)',
                           (self.season.id, wallet)).fetchone()
        entry = None if row is None else row['entry']
        revenue = (entry or {}).get('revenueUsd', {})
        return {'contractVersion': CONTRACT_VERSION, 'season': self.season_view,
                'snapshot': None if row is None else {'takenAt': int(row['taken_at']), 'sha256': row['snapshot_sha256']},
                'wallet': {'address': wallet,
                           'points': entry['points'] if entry else ZERO_POINTS,
                           'usagePoints': entry['usagePoints'] if entry else ZERO_POINTS,
                           'referralPoints': entry['referralPoints'] if entry else ZERO_POINTS,
                           'revenueUsd': {name: revenue.get(kind, ZERO_USD) for kind, name in REVENUE_KEYS},
                           'referrer': entry['referrer'] if entry else None,
                           'referees': entry['referees'] if entry else 0}}

    def excluded(self, conn, wallets):
        out = set()
        for wallet in wallets:
            if wallet in self.static_excluded or conn.execute('SELECT domino_points.is_excluded(%s,%s) AS excluded',
                                                              (wallet, list(self.season.roles))).fetchone()['excluded']:
                out.add(wallet)
        return frozenset(out)

    def link(self, conn, wallet, request):
        from points_referral import record
        referrer = request['referrer'].lower()
        try:
            outcome = record(conn, self.season, referee=wallet, referrer=referrer, issued_at=request['issuedAt'],
                             signature=request['signature'], excluded=self.excluded(conn, (wallet, referrer)),
                             now=int(self.clock()))
        except DataError as error:
            raise PointsError(str(error) if str(error) in LINK_CODES else 'invalid_request') from None
        return {'contractVersion': CONTRACT_VERSION, 'status': outcome['status'], 'referee': outcome['referee'],
                'referrer': outcome['referrer']}
