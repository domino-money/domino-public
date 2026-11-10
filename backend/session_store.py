"""Durable auth transitions, using only the private auth role and DB time.

Short transactions serialize through a database advisory lock across processes.
Signature/RPC verification never holds that lock. Fixed table capacities and
indexed cleanup batches bound alpha storage and transaction work; saturation is
an explicit retryable denial, never an eviction of a live security decision.
Refresh's buckets and the guesses' share of rate_limits (GUESS_ROWS) alone fail
open: past capacity a new key goes unrecorded, and its request is answered as
before.
"""
from datetime import timedelta
from dataclasses import dataclass
import base64
import hashlib
import hmac
import ipaddress
import math
import secrets

import psycopg
from psycopg.rows import dict_row

from discovery import DataError
from read_deadline import check_read_deadline, read_timeout
from session_models import CHAIN_ID, POLICY_VERSION, SessionError, token, utc, validate_account

AUTH_ROLE = 'domino_session_auth'
# L-04's siblings (7 Nov 2026): no table every visitor shares may fill with what its global windows admit, since a
# full table refuses every new client's sign-in. The bounds count both scopes (production's and '@preview') at once,
# and a row that sign-in writes after verify-global admits it (a proven wallet's hour, a session) follows by at most
# the listener's 20 s. rate_limits holds every row the global windows can open within its lifetime (issuance's and
# verify's IP minutes and, since 8 Nov, their IPv6 /48 minutes; 62 windows of proven wallets' hours; every preview
# budget's IP and account minutes: 180,014) plus GUESS_ROWS. sessions counts only the sessions within their first
# SESSION_IDLE (_session_room), of which verify-global admits 2 x 1,000 x 32 windows. test_session_store pins both sums.
CAPACITIES = {'contexts': 10000, 'challenges': 20000, 'sessions': 64000,
              'rate_limits': 200000, 'private_limits': 20000}
SESSION_LIFETIME = timedelta(hours=12)
SESSION_IDLE = timedelta(minutes=30)
CLEANUP_BATCH = 100
LOCK_ID = 0x444F4D53455353
# Public launch, 2 Nov 2026: a crowd behind one shared IPv4 may sign in and plan at once, and every signed-in family
# (plans, bridge quotes and status, execution status) shares the preview rows; the listeners' slots bound the load.
# No limit may pass RATE_COUNT_MAX, rate_limits.count's CHECK (migration 008): the call that would count past it
# fails as session_store_unavailable instead of being refused as session_rate_limited.
RATE_COUNT_MAX = 1000
ISSUANCE_IP_PER_MINUTE = 30
ISSUANCE_GLOBAL_PER_MINUTE = 1000
VERIFY_IP_PER_MINUTE = 30
VERIFY_GLOBAL_PER_MINUTE = 1000
PROVEN_WALLET_PER_HOUR = 20
PROVEN_WALLET_SECONDS = 3600
PREVIEW_IP_LIMIT = 120
PREVIEW_ACCOUNT_LIMIT = 30
PREVIEW_GLOBAL_LIMIT = 1000
PREVIEW_WINDOW_SECONDS = 60
# Refresh's token buckets (private_limits, migration 008), one per client and one per account: PRIVATE_CREDIT
# microseconds of credit, five refreshes of PRIVATE_COST each, regained a microsecond a microsecond (30/minute).
PRIVATE_CREDIT = 10000000
PRIVATE_COST = 2000000
# 7 Nov 2026: a refused preview credential (missing, malformed or unknown) is charged to its IP's window alone.
# 8 Nov 2026 (L-04's class, on windows): a site-wide sign-in window is spent only by an attempt the store carries out,
# so a refused challenge or verify is charged to its IP's window alone too. No global window bounds how many clients
# refuse. Such a guess writes a new row only while rate_limits holds fewer than GUESS_ROWS rows; past that it is
# refused all the same but not counted (it fails open), so guesses from any number of addresses never take the rows
# CAPACITIES keeps for what the global windows admit.
GUESS_ROWS = 10000
# 8 Nov 2026: sign-in's per-client windows key an IPv6 client by its /64, and one /48 holds 65,536 of them, so whoever
# holds a /48 could sign in as that many clients. Each sign-in step's own window therefore rides with one for the /48
# holding it (client_block), worth BLOCK_CLIENTS clients: a /48 is one site (a home, an office, a free tunnel-broker
# allocation) or a slice of a mobile carrier's pool, and four visitors' worth is what PR #470 gives a /48 at the read
# gateway. IPv4 gets no wider group: carrier-grade NAT already puts many people behind one address or /24, and grouping
# them further would refuse them because of each other.
BLOCK_CLIENTS = 4
ISSUANCE_BLOCK_PER_MINUTE = BLOCK_CLIENTS * ISSUANCE_IP_PER_MINUTE
VERIFY_BLOCK_PER_MINUTE = BLOCK_CLIENTS * VERIFY_IP_PER_MINUTE


def digest(value):
    return hashlib.sha256(value.encode('ascii')).digest() if value else None


def bearer():
    return secrets.token_urlsafe(32)


def session_csrf(session):
    """Recoverable CSRF, domain-separated from the random HttpOnly bearer.

    Knowing the CSRF or its stored digest does not disclose the 256-bit bearer.
    Recovery needs that bearer, not a reversible database token or abuse key.
    The value is stable for one session and replaced when a new session mints.
    """
    value = hmac.digest(session.encode('ascii'), b'domino/session-csrf/v2', 'sha256')
    return base64.urlsafe_b64encode(value).decode('ascii').rstrip('=')


def same_hash(stored, value):
    return value is not None and hmac.compare_digest(bytes(stored), digest(value))


def limited(seconds):
    """session_rate_limited, carrying the seconds until the limit admits again: the listeners' Retry-After."""
    error = SessionError('session_rate_limited')
    error.retry_after = seconds
    return error


# Launch round P3 (4 Nov 2026), item 7, review M1 and L3. `origin` below is the browser origin a listener admitted, as
# migration 057 stores it: None for the listener's canonical origin, the exact origin string for a listed preview. A
# session is used only through the origin it signed in on, in both directions; and a preview's traffic spends budgets
# of its own (every rate key kind, global, IP and account), so neither a preview nor anything deployed to its Pages
# environment can spend production's site-wide limits or a production visitor's IP budget.
def scoped(kind, origin):
    """The rate key kind of `origin`'s traffic: production's own, or the preview's."""
    return kind if origin is None else kind + '@preview'


def same_origin(row, origin):
    return row is not None and row['origin'] == origin


def client_block(client):
    """The IPv6 /48 holding a client key (SessionService keys an IPv6 client by its /64), or None for IPv4.

    An IPv4-mapped address is an IPv4 client (SessionService turns it into one), so it has no block either.
    """
    network = ipaddress.ip_network(client, strict=False)
    if network.version != 6 or network.network_address.ipv4_mapped is not None:
        return None
    return str(network.supernet(new_prefix=48))


class _DeadlineConnection:
    """Clamp every SQL operation to the same worker budget, including cleanup."""
    def __init__(self, conn):
        self.conn=conn

    def execute(self, statement, params=None):
        check_read_deadline()
        millis=max(1,min(1000,int(read_timeout(1)*1000)))
        self.conn.execute(f'SET LOCAL statement_timeout={millis}')
        check_read_deadline()
        result=self.conn.execute(statement,params)
        check_read_deadline()
        return result


@dataclass
class _CommitResult:
    value: dict
    expires: object
    error: str


class SessionStore:
    def __init__(self, settings, *, abuse_secret, connect=psycopg.connect):
        if not isinstance(abuse_secret, bytes) or len(abuse_secret) < 32:
            raise ValueError('invalid_session_abuse_secret')
        if not isinstance(settings, dict) or set(settings) != {'host', 'port', 'dbname'}:
            raise ValueError('invalid_session_database_settings')
        # Never let configuration choose an owner, role, search path, or SQL option.
        self.settings, self.abuse_secret, self.connect = dict(settings), abuse_secret, connect

    def _key(self, kind, value):
        return hmac.digest(self.abuse_secret, (kind+'\0'+value).encode('utf-8'), 'sha256')

    def _transaction(self, operation, *, readonly=False):
        try:
            check_read_deadline()
            millis = max(1, min(1000, int(read_timeout(1)*1000)))
            with self.connect(**self.settings, user=AUTH_ROLE,
                              connect_timeout=max(1, math.ceil(read_timeout(2))),
                              options=f'-c statement_timeout={millis} -c lock_timeout={min(millis,250)} '
                                      '-c idle_in_transaction_session_timeout=1000 -c search_path=domino_sessions -c TimeZone=UTC',
                              row_factory=dict_row) as conn:
                conn=_DeadlineConnection(conn)
                if readonly:
                    conn.execute('SET TRANSACTION READ ONLY')
                conn.execute('SELECT pg_advisory_xact_lock(%s)', (LOCK_ID,))
                now = conn.execute('SELECT clock_timestamp() AS now').fetchone()['now']
                if not readonly:
                    self._cleanup(conn, now)
                    now = conn.execute('SELECT clock_timestamp() AS now').fetchone()['now']
                outcome = operation(conn, now)
                if isinstance(outcome,_CommitResult):
                    # The last security check uses fresh database time, after
                    # every mutation. Expiry here rolls back consume/create/touch
                    # together; a previously reserved attempt stays committed.
                    if not conn.execute('SELECT clock_timestamp()<%s AS valid',(outcome.expires,)).fetchone()['valid']:
                        raise SessionError(outcome.error)
                    outcome=outcome.value
                check_read_deadline()
            # Expected denials are returned from the transaction so attempt and
            # rate reservations commit. Never roll them back with the failure.
            if isinstance(outcome, SessionError):
                raise outcome
            check_read_deadline()
            return outcome
        except psycopg.errors.LockNotAvailable:
            raise SessionError('session_capacity_busy') from None
        except psycopg.Error:
            raise SessionError('session_store_unavailable') from None
        except DataError:
            raise SessionError('request_timeout') from None

    def _cleanup(self, conn, now):
        for table, column in (('contexts','expires_at'), ('challenges','expires_at'),
                              ('sessions','expires_at'), ('rate_limits','reset_at'),
                              ('private_limits','expires_at')):
            # Identifiers are constants from this tuple, never request input.
            conn.execute(f'DELETE FROM {table} WHERE ctid IN (SELECT ctid FROM {table} '
                         f'WHERE {column}<=%s ORDER BY {column} LIMIT %s)', (now,CLEANUP_BATCH))
        conn.execute('DELETE FROM sessions WHERE ctid IN (SELECT ctid FROM sessions '
                     'WHERE revoked_at IS NOT NULL ORDER BY revoked_at LIMIT %s)', (CLEANUP_BATCH,))
        conn.execute('DELETE FROM sessions WHERE ctid IN (SELECT ctid FROM sessions '
                     "WHERE last_used_at<=%s-interval '30 minutes' ORDER BY last_used_at LIMIT %s)",
                     (now,CLEANUP_BATCH))

    def _room(self, conn, table):
        return conn.execute(f'SELECT count(*) AS n FROM {table}').fetchone()['n'] < CAPACITIES[table]

    @staticmethod
    def _session_room(conn, now):
        """Room for one more session among those within their first SESSION_IDLE (7 Nov 2026).

        Only verify-global's admissions bound those, so only they count against CAPACITIES['sessions']: an older
        session is alive only because its owner keeps using it, each use reading the chain and spending that owner's
        own budgets. expires_at is created_at + SESSION_LIFETIME (008's CHECK) and indexed; created_at is not.
        """
        young = conn.execute('SELECT count(*) AS n FROM sessions WHERE expires_at>%s',
                             (now+SESSION_LIFETIME-SESSION_IDLE,)).fetchone()['n']
        return young < CAPACITIES['sessions']

    def _rate(self, conn, now, *limits, charge=True):
        """Charge one attempt to every (kind, value, maximum, seconds) limit, or to none of them.

        3 Nov 2026 (launch): every limit is read before any is charged, the site-wide one first, so a
        refusal commits no increment to the others and a refused attempt never spends its caller's own
        budget. The advisory lock holds from the reads to the charge. A refusal names the seconds until
        its fullest window resets; charge=False only reads the windows (7 Nov 2026: room in the table is
        the charge's question, so a read never refuses a guess for want of a row it will not write).
        """
        windows, wait = [], None
        for kind, value, maximum, seconds in limits:
            key = self._key(kind,value)
            row = conn.execute('SELECT * FROM rate_limits WHERE key_hash=%s', (key,)).fetchone()
            live = bool(row and row['reset_at']>now)
            if live and row['count']>=maximum:
                wait = max(wait or 0, (row['reset_at']-now).total_seconds())
            windows.append((key, row is None, live, seconds))
        if wait is not None:
            return limited(wait)
        if not charge:
            return None
        new = sum(missing for _, missing, _, _ in windows)
        if new and conn.execute('SELECT count(*) AS n FROM rate_limits').fetchone()['n']+new>CAPACITIES['rate_limits']:
            return SessionError('session_capacity_busy')
        for key, _, live, seconds in windows:
            if live:
                conn.execute('UPDATE rate_limits SET count=count+1 WHERE key_hash=%s', (key,))
            else:
                conn.execute('INSERT INTO rate_limits(key_hash,reset_at,count) VALUES (%s,%s,1) '
                             'ON CONFLICT(key_hash) DO UPDATE SET reset_at=EXCLUDED.reset_at,count=1',
                             (key,now+timedelta(seconds=seconds)))

    def _guess(self, conn, now, limit):
        """Charge a refused attempt to its IP's `limit`, without taking a row the windows need.

        Nothing global bounds how many clients are refused, so a guess writes a new row only while the table holds
        fewer than GUESS_ROWS rows (counted no further than that). Past that it is not counted: the caller's refusal
        stands, and the guess spends nothing every visitor shares. A client's existing row is always charged.
        """
        kind, value, _, _ = limit
        if (conn.execute('SELECT 1 FROM rate_limits WHERE key_hash=%s', (self._key(kind,value),)).fetchone() is None
                and conn.execute('SELECT count(*) AS n FROM (SELECT 1 FROM rate_limits LIMIT %s) AS r',
                                 (GUESS_ROWS,)).fetchone()['n']>=GUESS_ROWS):
            return None
        return self._rate(conn, now, limit)

    @staticmethod
    def _block(kind, client, maximum, origin):
        """A sign-in step's window for the IPv6 /48 holding `client`, as _rate limits: one, or none for IPv4.

        It is charged with the step's other windows, all read before any is charged, so a full /48 refuses before
        anything is spent. A refused attempt never reaches it: _guess charges the client's own window alone.
        """
        block = client_block(client)
        return () if block is None else ((scoped(kind, origin), block, maximum, 60),)

    def _private_rate(self, conn, now, client, address, origin=None):
        """Charge one refresh to the client's and the account's token buckets, or to neither.

        8 Nov 2026: both buckets are read before either is charged, so a refusal by one charges neither (one session
        presented from new /64s left a row behind for every /64 its account's bucket refused). An admitted refresh
        keeps its charges whatever fails after it, so repeated failing account checks are never free. A row lives
        until its bucket is full again, at most PRIVATE_CREDIT's 10 s, and from then reads exactly as no row. The
        table never refuses a refresh for room: past its capacity a key with no row goes unrecorded, its bucket full,
        and a key with a row is charged as ever. A charge keeps a row PRIVATE_COST's 2 s and a refresh makes two, so
        filling the table takes a quarter of its capacity in admitted refreshes a second, each an account check;
        whoever has those holds more accounts and /64s than these buckets constrain.
        """
        buckets, wait = [], None
        for kind, value in (('private-ip', client), ('private-account', address)):
            key = self._key(scoped(kind, origin), value)
            row = conn.execute('SELECT credit, updated_at FROM private_limits WHERE key_hash=%s', (key,)).fetchone()
            credit = PRIVATE_CREDIT
            if row:
                delta = now-row['updated_at']
                elapsed = max(0, (delta.days*86400+delta.seconds)*1000000+delta.microseconds)
                credit = min(PRIVATE_CREDIT, row['credit']+elapsed)
            if credit < PRIVATE_COST:
                wait = max(wait or 0, (PRIVATE_COST-credit)/1000000)
            buckets.append((key, row is not None, credit-PRIVATE_COST))
        if wait is not None:
            return limited(wait)
        for key, stored, credit in buckets:
            if stored or self._room(conn, 'private_limits'):
                conn.execute('INSERT INTO private_limits VALUES (%s,%s,%s,%s) ON CONFLICT(key_hash) DO UPDATE SET '
                             'credit=EXCLUDED.credit,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at',
                             (key, credit, now, now+timedelta(microseconds=PRIVATE_CREDIT-credit)))

    @staticmethod
    def _live(row, now):
        return bool(row and row['revoked_at'] is None and row['expires_at']>now and
                    row['last_used_at']>now-SESSION_IDLE and row['policy']==POLICY_VERSION)

    @staticmethod
    def _active(row, now):
        """Live and on this chain. 008 constrains the column; re-read it anyway.

        Only logout uses _live on its own: a browser may discard its own
        session whatever else has already denied it.
        """
        return SessionStore._live(row,now) and row['chain_id']==CHAIN_ID

    @staticmethod
    def _context(conn, now, preauth, csrf, *, allow_consumed=False):
        row=conn.execute('SELECT * FROM contexts WHERE bearer_hash=%s',(digest(preauth),)).fetchone()
        if not row or row['expires_at']<=now or row['revoked_at'] is not None or (
                row['consumed_at'] is not None and not allow_consumed):
            return SessionError('preauth_required')
        if not same_hash(row['csrf_hash'],csrf):
            return SessionError('csrf_invalid')
        return row

    @staticmethod
    def _session(conn, session):
        return conn.execute('SELECT * FROM sessions WHERE bearer_hash=%s',(digest(session),)).fetchone()

    def bootstrap(self, client, preauth=None, session=None, origin=None):
        new,csrf=bearer(),bearer()
        wide=self._block('issuance-block',client,ISSUANCE_BLOCK_PER_MINUTE,origin)
        def operation(conn,now):
            denied=self._rate(conn,now,(scoped('issuance-global',origin),'all',ISSUANCE_GLOBAL_PER_MINUTE,60),
                              (scoped('issuance-ip',origin),client,ISSUANCE_IP_PER_MINUTE,60),*wide)
            if denied:return denied
            if self._active(self._session(conn,session),now):
                return SessionError('session_exists')
            # A concurrently consumed browser context cannot be reset into a
            # second login flow while its newly created session is active.
            created=conn.execute('SELECT * FROM sessions WHERE source_context_hash=%s',
                                 (digest(preauth),)).fetchone()
            if self._active(created,now):return SessionError('session_exists')
            if not self._room(conn,'contexts'):return SessionError('session_capacity_busy')
            conn.execute('UPDATE contexts SET revoked_at=%s WHERE bearer_hash=%s',(now,digest(preauth)))
            conn.execute('UPDATE challenges SET consumed_at=%s WHERE context_hash=%s AND consumed_at IS NULL',
                         (now,digest(preauth)))
            expires=now+timedelta(minutes=10)
            conn.execute('INSERT INTO contexts(bearer_hash,csrf_hash,created_at,expires_at) VALUES (%s,%s,%s,%s)',
                         (digest(new),digest(csrf),now,expires))
            return {'result':{'status':'challenge_required','csrfToken':csrf,'expiresAt':utc(expires)},
                    'credentials':{'preauth':new}}
        return self._transaction(operation)

    def challenge(self, client, preauth, csrf, address, issue, origin=None):
        """Store a challenge for the presenter's own live context, ending the context's earlier one.

        8 Nov 2026 (L-04's class, on windows): issuance-global is spent only by a challenge this call goes on to store.
        A request refused for what it carries (no live context for its preauth, another CSRF, under a second of context
        left) is charged to its IP's window alone, in the guesses' share (_guess), so well-formed tokens the store never
        issued spend nothing every visitor shares, from any number of clients. A full table refuses before any charge.
        A stored challenge also spends the window of the IPv6 /48 holding its client (_block).
        """
        identifier,nonce=secrets.token_hex(16),secrets.token_hex(16)
        ip=(scoped('issuance-ip',origin),client,ISSUANCE_IP_PER_MINUTE,60)
        wide=self._block('issuance-block',client,ISSUANCE_BLOCK_PER_MINUTE,origin)
        def operation(conn,now):
            context=self._context(conn,now,preauth,csrf)
            if isinstance(context,SessionError):return self._guess(conn,now,ip) or context
            issued=now.replace(microsecond=0)
            expires=min(issued+timedelta(minutes=5),context['expires_at'].replace(microsecond=0))
            if expires<=now:return self._guess(conn,now,ip) or SessionError('preauth_required')
            if not self._room(conn,'challenges'):return SessionError('session_capacity_busy')
            denied=self._rate(conn,now,(scoped('issuance-global',origin),'all',ISSUANCE_GLOBAL_PER_MINUTE,60),ip,*wide)
            if denied:return denied
            message=issue(address,nonce,issued,expires)
            conn.execute('UPDATE challenges SET consumed_at=%s WHERE context_hash=%s AND consumed_at IS NULL',
                         (now,digest(preauth)))
            conn.execute('INSERT INTO challenges(id,context_hash,address,nonce,issued_at,expires_at,message) '
                         'VALUES (%s,%s,%s,%s,%s,%s,%s)',
                         (identifier,digest(preauth),address,nonce,issued,expires,message))
            return _CommitResult({'result':{'challengeId':identifier,'message':message,'expiresAt':utc(expires)},'credentials':{}},
                                 min(expires,context['expires_at']),'challenge_invalid')
        return self._transaction(operation)

    def reserve_verify(self, client, preauth, csrf, identifier, message, old_session=None, origin=None):
        """Reserve one of a challenge's five attempts for the signature check that follows.

        8 Nov 2026 (L-04's class, on windows): verify-global is spent only by an attempt that goes on to that check:
        no active session presented, the presenter's own live context and CSRF, a live challenge of that context with
        an attempt left, and that challenge's exact message. A request refused before that is charged to its IP's
        window alone, in the guesses' share (_guess), so well-formed tokens the store never issued spend nothing every
        visitor shares, from any number of clients. Another message still uses one of the challenge's attempts. An
        attempt that goes on also spends the window of the IPv6 /48 holding its client (_block).
        """
        ip=(scoped('verify-ip',origin),client,VERIFY_IP_PER_MINUTE,60)
        wide=self._block('verify-block',client,VERIFY_BLOCK_PER_MINUTE,origin)
        def operation(conn,now):
            if self._active(self._session(conn,old_session),now):
                return self._guess(conn,now,ip) or SessionError('session_exists')
            context=self._context(conn,now,preauth,csrf)
            if isinstance(context,SessionError):return self._guess(conn,now,ip) or context
            challenge=conn.execute('SELECT * FROM challenges WHERE id=%s AND context_hash=%s',
                                   (identifier,digest(preauth))).fetchone()
            if (not challenge or challenge['expires_at']<=now or challenge['consumed_at'] is not None or
                    challenge['attempts']>=5):return self._guess(conn,now,ip) or SessionError('challenge_invalid')
            if challenge['message']!=message:
                denied=self._guess(conn,now,ip)
                if denied:return denied
                conn.execute('UPDATE challenges SET attempts=attempts+1 WHERE id=%s',(identifier,))
                return SessionError('challenge_invalid')
            denied=self._rate(conn,now,(scoped('verify-global',origin),'all',VERIFY_GLOBAL_PER_MINUTE,60),ip,*wide)
            if denied:return denied
            conn.execute('UPDATE challenges SET attempts=attempts+1 WHERE id=%s',(identifier,))
            return challenge
        return self._transaction(operation)

    def reserve_verified_address(self, preauth, csrf, challenge, origin=None):
        """Called only after SIWE ownership proof, before any EOA provider read."""
        def operation(conn,now):
            context=self._context(conn,now,preauth,csrf)
            if isinstance(context,SessionError):return SessionError('challenge_invalid')
            current=conn.execute('SELECT * FROM challenges WHERE id=%s AND context_hash=%s',
                (challenge['id'],digest(preauth))).fetchone()
            if (not current or current['expires_at']<=now or current['consumed_at'] is not None
                    or current['attempts']<1 or any(current[key]!=challenge[key] for key in
                        ('address','nonce','message'))):
                return SessionError('challenge_invalid')
            # Unsigned requests never spend another wallet's shared budget.
            denied=self._rate(conn,now,(scoped('verified-address',origin),current['address'],PROVEN_WALLET_PER_HOUR,
                                        PROVEN_WALLET_SECONDS))
            if denied:return denied
            return _CommitResult(None,min(context['expires_at'],current['expires_at']),'challenge_invalid')
        return self._transaction(operation)

    def finish_verify(self, preauth, csrf, challenge, validation, old_session=None, origin=None):
        new=bearer()
        new_csrf=session_csrf(new)
        def operation(conn,now):
            # Active-session replacement is intentionally unsupported. A second
            # preauth from another tab must not create a successor that an
            # already submitted logout cannot revoke. Log out explicitly first.
            if self._active(self._session(conn,old_session),now):
                return SessionError('session_exists')
            context=self._context(conn,now,preauth,csrf)
            if isinstance(context,SessionError):return SessionError('challenge_invalid')
            current=conn.execute('SELECT * FROM challenges WHERE id=%s AND context_hash=%s',
                                 (challenge['id'],digest(preauth))).fetchone()
            if (not current or current['expires_at']<=now or current['consumed_at'] is not None or
                    any(current[key]!=challenge[key] for key in ('address','nonce','message')) or current['attempts']<1):
                return SessionError('challenge_invalid')
            if not self._session_room(conn,now):return SessionError('session_capacity_busy')
            conn.execute('UPDATE challenges SET consumed_at=%s WHERE id=%s',(now,current['id']))
            conn.execute('UPDATE contexts SET consumed_at=%s WHERE bearer_hash=%s',(now,digest(preauth)))
            conn.execute('UPDATE sessions SET revoked_at=%s WHERE bearer_hash=%s',(now,digest(old_session)))
            expires=now+SESSION_LIFETIME
            # The session is the origin's it signed in on (migration 057): None, the canonical one, or a preview's.
            conn.execute('INSERT INTO sessions(bearer_hash,csrf_hash,source_context_hash,address,chain_id,policy,'
                         'created_at,last_used_at,expires_at,block_number,block_hash,delegate,origin) VALUES '
                         '(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                         (digest(new),digest(new_csrf),digest(preauth),current['address'],CHAIN_ID,POLICY_VERSION,
                          now,now,expires,validation['blockNumber'],validation['blockHash'],validation.get('delegate'),
                          origin))
            return _CommitResult({'result':self._result(current['address'],expires,new_csrf,validation),
                    'credentials':{'preauth':None,'session':new}},
                    min(context['expires_at'],current['expires_at']),'challenge_invalid')
        return self._transaction(operation)

    @staticmethod
    def _result(address, expires, csrf, validation):
        return {'authenticated':True,'owner':{'address':address,'chainId':CHAIN_ID},
                'expiresAt':utc(expires),'csrfToken':csrf,'validation':validation}

    def me(self, session, origin=None):
        """Reload/bootstrap read: no RPC, renewal, cleanup, quota or revocation.

        The returned validation is the last stored observation, not a fresh EOA
        decision. Protected consumers must perform their own fresh check.
        """
        csrf=session_csrf(session)
        def operation(conn,now):
            row=self._session(conn,session)
            if not self._active(row,now) or not same_origin(row,origin):return SessionError('session_required')
            # Pre-v2 candidates used unrecoverable random CSRF. Never replace
            # their hash on GET; rollout revokes old sessions before enabling.
            if not same_hash(row['csrf_hash'],csrf):return SessionError('session_required')
            validation={'method':'plain_eoa','blockNumber':row['block_number'],'blockHash':row['block_hash']}
            if row['delegate'] is not None:
                validation={**validation,'method':'eip7702_delegated','delegate':row['delegate']}
            return _CommitResult({'result':self._result(row['address'],row['expires_at'],csrf,validation),'credentials':{}},
                                 min(row['expires_at'],row['last_used_at']+timedelta(minutes=30)),'session_required')
        return self._transaction(operation,readonly=True)

    def begin_private(self, client, session, csrf, origin=None):
        def operation(conn,now):
            row=self._session(conn,session)
            if not self._active(row,now) or not same_origin(row,origin):return SessionError('session_required')
            # Missing/foreign CSRF must not consume another tab's refresh quota
            # or reach a code check that could revoke the session.
            if not same_hash(row['csrf_hash'],csrf):return SessionError('csrf_invalid')
            return self._private_rate(conn,now,client,row['address'],origin) or row
        return self._transaction(operation)

    @staticmethod
    def _account_changed(conn, now, row, session, validation):
        """Revoke a session whose account now runs other code than at sign-in.

        The key is unchanged, but a new delegate (or one added or cleared) is
        code this session never admitted. Committed, so the error that follows
        cannot leave the session usable; the browser signs in again.
        """
        if row['delegate']==validation.get('delegate'):
            return None
        conn.execute('UPDATE sessions SET revoked_at=%s WHERE bearer_hash=%s',(now,digest(session)))
        return SessionError('session_required')

    def finish_private(self, session, csrf, validation, origin=None):
        def operation(conn,now):
            row=self._session(conn,session)
            if not self._active(row,now) or not same_origin(row,origin):return SessionError('session_required')
            if not same_hash(row['csrf_hash'],csrf):return SessionError('csrf_invalid')
            changed=self._account_changed(conn,now,row,session,validation)
            if changed:return changed
            conn.execute('UPDATE sessions SET last_used_at=%s,block_number=%s,block_hash=%s '
                         'WHERE bearer_hash=%s', (now,validation['blockNumber'],validation['blockHash'],digest(session)))
            return _CommitResult({'result':self._result(row['address'],row['expires_at'],csrf,validation),'credentials':{}},
                                 min(row['expires_at'],row['last_used_at']+timedelta(minutes=30)),'session_required')
        return self._transaction(operation)

    def begin_preview(self, client, session, csrf, *, budget='onboarding', origin=None):
        """Reserve costly preview reads before any external account/API check.

        This namespace is separate from login and private-read quotas; each
        `budget` (onboarding_auth.BUDGETS) has its own IP, account and
        site-wide keys. The site-wide and IP limits are read before the
        credentials, and a refusal by any limit charges none of them (3 Nov
        2026). Missing, malformed or unknown credentials still spend the IP's
        attempt: guessing is never free. Since 7 Nov 2026 that attempt takes a
        new row only in the guesses' own share of the table (_guess), and is
        never refused for room. An admitted attempt keeps its charges
        whatever fails later. Only the verified public owner leaves this
        transaction; stored credential hashes never do.
        """
        def operation(conn, now):
            everyone = (scoped(budget + '-global', origin), 'all', PREVIEW_GLOBAL_LIMIT, PREVIEW_WINDOW_SECONDS)
            ip = (scoped(budget + '-ip', origin), client, PREVIEW_IP_LIMIT, PREVIEW_WINDOW_SECONDS)
            denied = self._rate(conn, now, everyone, ip, charge=False)
            if denied:
                return denied
            try:
                token(session, required='session_required')
                token(csrf, required='csrf_invalid')
                row = self._session(conn, session)
                if not self._active(row, now) or row['chain_id'] != CHAIN_ID or not same_origin(row, origin):
                    raise SessionError('session_required')
                if not same_hash(row['csrf_hash'], csrf):
                    raise SessionError('csrf_invalid')
            except SessionError as error:
                return self._guess(conn, now, ip) or error
            denied = self._rate(conn, now, everyone, ip, (scoped(budget + '-account', origin), row['address'],
                                                          PREVIEW_ACCOUNT_LIMIT, PREVIEW_WINDOW_SECONDS))
            if denied:
                return denied
            # Keep reservations when expiry is crossed during the DB work.
            # The separate finish guard rechecks immediately before provider use.
            fresh = conn.execute('SELECT clock_timestamp() AS now').fetchone()['now']
            if not self._active(row, fresh):
                return SessionError('session_required')
            # The delegate the session was admitted with (None: a plain EOA). A
            # cached account check may answer only a session admitted with its own
            # delegate (onboarding_auth, 4 Nov 2026); this is no credential.
            return {'address': row['address'], 'chainId': CHAIN_ID, 'delegate': row['delegate']}
        return self._transaction(operation)

    def finish_preview(self, session, csrf, owner, validation, origin=None):
        """Reauthorize before/after provider work without rotating browser CSRF."""
        token(session, required='session_required')
        token(csrf, required='csrf_invalid')
        validation = validate_account(validation)
        def operation(conn, now):
            row = self._session(conn, session)
            if (not self._active(row, now) or row['chain_id'] != CHAIN_ID
                    or row['address'] != owner or not same_origin(row, origin)):
                return SessionError('session_required')
            if not same_hash(row['csrf_hash'], csrf):
                return SessionError('csrf_invalid')
            changed = self._account_changed(conn, now, row, session, validation)
            if changed:
                return changed
            conn.execute('UPDATE sessions SET last_used_at=%s,block_number=%s,block_hash=%s '
                         'WHERE bearer_hash=%s',
                         (now, validation['blockNumber'], validation['blockHash'], digest(session)))
            return _CommitResult(None,
                                 min(row['expires_at'], row['last_used_at'] + timedelta(minutes=30)),
                                 'session_required')
        return self._transaction(operation)

    def revoke(self, session):
        return self._transaction(lambda conn,now: conn.execute(
            'UPDATE sessions SET revoked_at=%s WHERE bearer_hash=%s',(now,digest(session))) and None)

    def logout(self, client, preauth, session, csrf, origin=None):
        def operation(conn,now):
            # Matching live credentials let a browser explicitly discard its
            # own session, whatever else has already denied it; another origin's
            # session is none of this origin's (launch round P3, review M1).
            row=self._session(conn,session)
            active=self._live(row,now) and same_origin(row,origin)
            context=None
            if active and same_hash(row['csrf_hash'],csrf):
                # Authenticated credentials take precedence over any unrelated
                # preauth context; never use one credential to revoke the other.
                target=bytes(row['source_context_hash'])
            else:
                context=self._context(conn,now,preauth,csrf,allow_consumed=True)
                if isinstance(context,SessionError):
                    return SessionError('csrf_invalid' if active else context.code if preauth else 'session_required')
                target=bytes(context['bearer_hash'])
                if active and target!=bytes(row['source_context_hash']):
                    return SessionError('csrf_invalid')
            # Same-context abort is allowed after consume but only until the
            # original ten-minute context expires. It grants no read authority.
            conn.execute('UPDATE contexts SET revoked_at=%s WHERE bearer_hash=%s',(now,target))
            conn.execute('UPDATE challenges SET consumed_at=%s WHERE context_hash=%s AND consumed_at IS NULL',(now,target))
            conn.execute('UPDATE sessions SET revoked_at=%s WHERE source_context_hash=%s',(now,target))
            return {'result':{'authenticated':False},'credentials':{'preauth':None,'session':None}}
        return self._transaction(operation)
