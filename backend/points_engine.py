"""Points, season 1, part 2: the engine (docs/points/POINTS.md).

From the revenue ledger (migration 058), the bridge's app fees and the referral
links (059), the engine computes the season's points per wallet under the
season's configuration (points_season_1.json, whose sha256 every snapshot
records) and stores a snapshot: each wallet's points, their parts and the
season's totals, as canonical JSON with its sha256. A snapshot is a pure
function of those rows, the configuration and the team list: computing it again
from the same rows gives the same bytes.

The owner's rules (6-7 Nov 2026):
- 1,000 points per US$1 of net revenue Domino received from the wallet within
  the season (00:00 UTC 9 Nov 2026 to 00:00 UTC 9 Feb 2027): the ledger's net
  value of its fees, and the bridge's app fee; nothing before the start counts;
- the referrer earns 10% more: 10% of each linked wallet's points for use in
  the season, whenever the link was made; one level (never of the linked
  wallet's own referral points); the first link holds for the season;
- no conversion cap and no minimum claim: a snapshot holds points, not tokens.
With them, from the study and the blueprint: an Auto-exit fee counts from
US$0.10 (a position of US$50); excluded wallets (the team's private list,
Domino's deployment roles, the governance Safe's owners, the public test
accounts) earn nothing, and their links count for no one.

The team's list is private: `team --team-file <path>` imports it into
domino_points.team (the catalogue writer's only), and a snapshot records the
sha256 of the sorted list, never its addresses.

CLI: `team` (imports the list), `snapshot` (the unit domino-points-snapshot,
hourly), `status`, `wallet`, `message` (the text a referred wallet signs) and
`link` (records a signed link by hand; the app's route is part 3's).
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal, InvalidOperation, localcontext
import hashlib
import json
from pathlib import Path
import re
import sys
import time

import psycopg

from discovery import DataError, address

SEASON_1 = Path(__file__).resolve().parent / 'points_season_1.json'
KINDS = {1: 'assisted_swap', 2: 'automation', 3: 'auto_exit'}
BRIDGE = 'bridge'
ROLES = frozenset({'deployer', 'feeRecipient', 'governance', 'guardian', 'operator', 'publisher'})
SEASON_KEYS = frozenset({'schemaVersion', 'kind', 'id', 'version', 'decided', 'start', 'startUnix', 'end', 'endUnix',
                         'pointsPerUsd', 'referralShare', 'autoExitFloorUsd', 'excluded', 'referral'})
TEAM_KEYS = frozenset({'schemaVersion', 'kind', 'addresses'})
POINT_PLACES = Decimal('0.000001')
USD_PLACES = Decimal('0.000000000000000001')
PRECISION = 90
ADDRESS = re.compile(r'0x[0-9a-f]{40}')
ZERO = Decimal(0)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


@dataclass(frozen=True)
class Season:
    id: str
    start: int
    end: int
    per_usd: Decimal
    referral_share: Decimal
    auto_exit_floor: Decimal
    roles: tuple
    safe_owners: frozenset
    public_test_accounts: bool
    freshness: int
    sha256: str


def _unix(text):
    try:
        moment = datetime.strptime(text, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        raise DataError('points_season_invalid') from None
    return int(moment.timestamp())


def _decimal(text, low, high):
    try:
        value = Decimal(text) if isinstance(text, str) else None
    except InvalidOperation:
        value = None
    if value is None or not value.is_finite() or not low <= value <= high:
        raise DataError('points_season_invalid')
    return value


def load_season(path=SEASON_1):
    """The season's configuration, checked whole, and the sha256 of its canonical JSON."""
    try:
        document = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        raise DataError('points_season_invalid') from None
    if type(document) is not dict or set(document) != SEASON_KEYS or document['schemaVersion'] != 1 \
            or document['kind'] != 'domino-points-season' or not isinstance(document['id'], str) \
            or not re.fullmatch(r'[a-z0-9-]{1,40}', document['id']) or type(document['version']) is not int:
        raise DataError('points_season_invalid')
    start, end = _unix(document['start']), _unix(document['end'])
    if (start, end) != (document['startUnix'], document['endUnix']) or not start < end:
        raise DataError('points_season_invalid')
    excluded, referral = document['excluded'], document['referral']
    if type(excluded) is not dict or set(excluded) != {'deploymentRoles', 'governanceSafeOwners', 'publicTestAccounts',
                                                        'teamList'}:
        raise DataError('points_season_invalid')
    roles = excluded['deploymentRoles']
    owners = excluded['governanceSafeOwners']
    if type(roles) is not list or not set(roles) <= ROLES or len(set(roles)) != len(roles) \
            or type(owners) is not list or not all(isinstance(o, str) and ADDRESS.fullmatch(o) for o in owners) \
            or type(excluded['publicTestAccounts']) is not bool:
        raise DataError('points_season_invalid')
    if type(referral) is not dict or set(referral) != {'levels', 'countsFrom', 'freshnessSeconds'} \
            or referral['levels'] != 1 or type(referral['freshnessSeconds']) is not int \
            or not 0 < referral['freshnessSeconds'] <= 3600:
        raise DataError('points_season_invalid')
    return Season(document['id'], start, end, _decimal(document['pointsPerUsd'], Decimal(1), Decimal(10 ** 9)),
                  _decimal(document['referralShare'], ZERO, Decimal('0.99')),
                  _decimal(document['autoExitFloorUsd'], ZERO, Decimal(1000)), tuple(roles), frozenset(owners),
                  excluded['publicTestAccounts'], referral['freshnessSeconds'], sha256(canonical(document)))


def read_team_file(path):
    """The team's wallets from the owner's file, checked whole."""
    try:
        document = json.loads(Path(path).read_bytes())
    except (OSError, ValueError):
        raise DataError('points_team_list_invalid') from None
    if type(document) is not dict or set(document) != TEAM_KEYS or document['schemaVersion'] != 1 \
            or document['kind'] != 'domino-points-team' or type(document['addresses']) is not list:
        raise DataError('points_team_list_invalid')
    try:
        return frozenset(address(value) for value in document['addresses'])
    except DataError:
        raise DataError('points_team_list_invalid') from None


def team_digest(team):
    """The sha256 a snapshot records for the team's list: of its sorted addresses' canonical JSON."""
    return sha256(canonical(sorted(team)))


def stored_team(conn):
    """The team's list as imported, and its digest."""
    team = frozenset(row['address'] for row in conn.execute('SELECT address FROM domino_points.team').fetchall())
    return team, team_digest(team)


def import_team(store, path, now):
    """Replace the stored list with the file's, in one transaction; its size and digest."""
    team = read_team_file(path)
    with store.writer() as conn:
        with conn.transaction():
            conn.execute('DELETE FROM domino_points.team')
            for wallet in sorted(team):
                conn.execute('INSERT INTO domino_points.team(address,imported_at) VALUES(%s,%s)', (wallet, int(now)))
    return {'wallets': len(team), 'sha256': team_digest(team)}


def excluded_wallets(conn, season, team):
    """The team, every deployment's roles the season names, the governance Safe's owners and, if the season says
    so, the public test accounts."""
    out = set(team) | set(season.safe_owners)
    for row in conn.execute('SELECT manifest FROM domino_v2.deployments').fetchall():
        roles = row['manifest'].get('roles') if isinstance(row['manifest'], dict) else None
        if not isinstance(roles, dict):
            raise DataError('points_deployment_roles_missing')
        for role in season.roles:
            value = roles.get(role)
            if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', value):
                raise DataError('points_deployment_roles_missing')
            out.add(value.lower())
    if season.public_test_accounts:
        from v2_manifest import PUBLIC_TEST_ACCOUNTS
        out |= PUBLIC_TEST_ACCOUNTS
    return frozenset(out)


def _points(value):
    return value.quantize(POINT_PLACES, rounding=ROUND_DOWN)


def _usd(value):
    # Fixed point always: a zero at 18 places prints as '0E-18' through str().
    return format(value.quantize(USD_PLACES, rounding=ROUND_DOWN), 'f')


def compute(season, revenue, bridge, links, excluded):
    """{'wallets': [...], 'totals': {...}} for the season's rows (each already within the season), pure."""
    with localcontext() as ctx:
        ctx.prec = PRECISION
        usd, kinds, chains = {}, {}, {}
        excluded_usd, below_floor = ZERO, 0

        def add(wallet, kind, chain, value):
            usd[wallet] = usd.get(wallet, ZERO) + value
            kinds.setdefault(wallet, {})[kind] = kinds.get(wallet, {}).get(kind, ZERO) + value
            chains.setdefault(wallet, {})[chain] = chains.get(wallet, {}).get(chain, ZERO) + value
        for row in revenue:
            if not season.start <= int(row['block_timestamp']) < season.end:
                raise DataError('points_row_outside_season')
            net = Decimal(row['net_usd'])
            if row['payer'] in excluded:
                excluded_usd += net
                continue
            kind = KINDS[int(row['kind'])]
            if kind == 'auto_exit' and Decimal(row['gross_usd']) < season.auto_exit_floor:
                below_floor += 1
                continue
            add(row['payer'], kind, int(row['chain_id']), net)
        for row in bridge:
            if not season.start <= int(row['charged_at']) < season.end:
                raise DataError('points_row_outside_season')
            value = Decimal(row['usd'])
            if row['wallet'] in excluded:
                excluded_usd += value
                continue
            add(row['wallet'], BRIDGE, int(row['destination_chain_id']), value)
        usage = {wallet: _points(value * season.per_usd) for wallet, value in usd.items()}
        referral, referees, referrer_of, counted = {}, {}, {}, 0
        for link in links:
            referee, referrer = link['referee'], link['referrer']
            if link['season'] != season.id or referee == referrer or referee in excluded or referrer in excluded:
                continue
            counted += 1
            referrer_of[referee] = referrer
            referees[referrer] = referees.get(referrer, 0) + 1
            referral[referrer] = referral.get(referrer, ZERO) + usage.get(referee, ZERO) * season.referral_share
        referral = {wallet: _points(value) for wallet, value in referral.items()}
        wallets = []
        for wallet in sorted(set(usage) | set(referral) | set(referrer_of) | set(referees)):
            own, extra = usage.get(wallet, ZERO), referral.get(wallet, ZERO)
            wallets.append({'address': wallet, 'points': str(_points(own + extra)), 'usagePoints': str(_points(own)),
                            'referralPoints': str(_points(extra)),
                            'revenueUsd': {kind: _usd(v) for kind, v in sorted(kinds.get(wallet, {}).items())},
                            'chains': {str(chain): _usd(v) for chain, v in sorted(chains.get(wallet, {}).items())},
                            'referrer': referrer_of.get(wallet), 'referees': referees.get(wallet, 0)})
        totals = {'wallets': len(wallets), 'links': counted, 'revenueUsd': _usd(sum(usd.values(), ZERO)),
                  'excludedUsd': _usd(excluded_usd), 'autoExitsBelowFloor': below_floor,
                  'usagePoints': str(_points(sum(usage.values(), ZERO))),
                  'referralPoints': str(_points(sum(referral.values(), ZERO)))}
        totals['points'] = str(_points(Decimal(totals['usagePoints']) + Decimal(totals['referralPoints'])))
    return {'wallets': wallets, 'totals': totals}


# ------------------------------------------------------------------ storage
class EngineStore:
    """Migrations 058 and 059 through the catalogue writer."""

    def __init__(self, settings):
        from v2_index_store import V2Store
        self.index = V2Store(settings)

    @contextmanager
    def writer(self):
        try:
            conn = self.index._connect('domino_catalogue_writer', autocommit=True)
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None
        try:
            yield conn
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None
        finally:
            conn.close()


def take_snapshot(store, season, now):
    """Compute the season's points from one consistent read of the rows and store them; the snapshot's summary."""
    from psycopg.types.json import Jsonb
    from points_referral import verified
    taken_at = int(now)
    with store.writer() as conn:
        with conn.transaction():
            conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            revenue = conn.execute('''SELECT chain_id,kind,payer,block_timestamp,gross_usd,net_usd
              FROM domino_points.revenue WHERE block_timestamp>=%s AND block_timestamp<%s''',
                                   (season.start, season.end)).fetchall()
            bridge = conn.execute('''SELECT wallet,destination_chain_id,charged_at,usd FROM domino_points.bridge_fees
              WHERE charged_at>=%s AND charged_at<%s''', (season.start, season.end)).fetchall()
            stored = conn.execute('''SELECT season,referee,referrer,message,signature,issued_at
              FROM domino_points.referrals WHERE season=%s''', (season.id,)).fetchall()
            # Only a link its referred wallet signed counts (points_referral.verified): the listener checks the
            # signature before it records, and this holds even for a row that did not come through it.
            links = [link for link in stored if verified(season, link)]
            ledger = conn.execute('''SELECT chain_id,block_number,block_timestamp,caught_up,last_error
              FROM domino_points.ledger_cursor ORDER BY chain_id''').fetchall()
            team, team_sha256 = stored_team(conn)
            result = compute(season, revenue, bridge, links, excluded_wallets(conn, season, team))
            result['totals']['linksUnverified'] = len(stored) - len(links)
            body = {'season': season.id, 'configSha256': season.sha256, 'teamSha256': team_sha256,
                    'takenAt': taken_at, 'totals': result['totals'], 'wallets': result['wallets'],
                    'ledger': {str(row['chain_id']): {'through': int(row['block_number']),
                                                      'timestamp': int(row['block_timestamp']),
                                                      'caughtUp': row['caught_up'], 'lastError': row['last_error']}
                               for row in ledger}}
            digest = sha256(canonical(body))
            conn.execute('''INSERT INTO domino_points.snapshots(season,taken_at,sha256,config_sha256,team_sha256,
              wallets,body) VALUES(%s,%s,%s,%s,%s,%s,%s)''',
                         (season.id, taken_at, digest, season.sha256, team_sha256, len(result['wallets']),
                          Jsonb(body)))
    return {'season': season.id, 'takenAt': taken_at, 'sha256': digest, 'totals': result['totals']}


def latest_snapshot(store, season):
    with store.writer() as conn:
        return conn.execute('''SELECT taken_at,sha256,config_sha256,team_sha256,wallets,body FROM domino_points.snapshots
          WHERE season=%s ORDER BY taken_at DESC LIMIT 1''', (season.id,)).fetchone()


def wallet_points(snapshot, wallet):
    """A wallet's entry in a snapshot's body, or its zero entry."""
    wallet = address(wallet)
    for entry in snapshot['body']['wallets']:
        if entry['address'] == wallet:
            return entry
    return {'address': wallet, 'points': '0.000000', 'usagePoints': '0.000000', 'referralPoints': '0.000000',
            'revenueUsd': {}, 'chains': {}, 'referrer': None, 'referees': 0}


def main(argv=None):
    from catalogue import database_settings
    import points_referral
    parser = argparse.ArgumentParser(description='Compute and keep the season\'s points (points, season 1).')
    parser.add_argument('command', choices=('team', 'snapshot', 'status', 'wallet', 'message', 'link'))
    parser.add_argument('--season-file', default=str(SEASON_1))
    parser.add_argument('--team-file', help='team: the owner\'s private list of the team\'s wallets')
    parser.add_argument('--address', help='wallet: the wallet to show')
    parser.add_argument('--referee', help='message, link: the referred wallet (the signer)')
    parser.add_argument('--referrer', help='message, link: its referrer')
    parser.add_argument('--issued-at', type=int, help='message, link: the time the text states, unix seconds')
    parser.add_argument('--signature', help='link: the referred wallet\'s personal_sign of the text')
    args = parser.parse_args(argv)
    try:
        season = load_season(args.season_file)
        if args.command == 'message':
            print(points_referral.message(season.id, args.referee, args.referrer, args.issued_at))
            return 0
        settings = database_settings()
        if settings is None:
            raise DataError('catalogue_not_configured')
        store = EngineStore(settings)
        if args.command == 'team':
            if not args.team_file:
                raise DataError('points_team_list_required')
            report = import_team(store, args.team_file, time.time())
        elif args.command == 'snapshot':
            report = take_snapshot(store, season, time.time())
        elif args.command == 'link':
            with store.writer() as conn:
                team, _ = stored_team(conn)
                report = points_referral.record(conn, season, referee=args.referee, referrer=args.referrer,
                                                issued_at=args.issued_at, signature=args.signature,
                                                excluded=excluded_wallets(conn, season, team), now=time.time())
        else:
            latest = latest_snapshot(store, season)
            if latest is None:
                report = {'season': season.id, 'status': 'no_snapshot'}
            elif args.command == 'status':
                report = {'season': season.id, 'takenAt': latest['taken_at'], 'sha256': latest['sha256'],
                          'configSha256': latest['config_sha256'], 'wallets': latest['wallets'],
                          'totals': latest['body']['totals'], 'ledger': latest['body']['ledger']}
            else:
                report = {'season': season.id, 'takenAt': latest['taken_at'],
                          **wallet_points(latest, args.address)}
    except DataError as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
