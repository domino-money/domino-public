"""Fresh canonical EOA classification, independent of Uniswap or SIWE.

An EOA is admitted with empty code or with exactly one EIP-7702 designator:
either way the account's own key signs, which is what SIWE proves. Any other
code is a contract account and stays unsupported. An observation never
authenticates by itself. The session service must separately verify SIWE and
atomically authorize against its private store, which also refuses a session
whose account changed kind or delegate since it was admitted.
Each check creates a new bounded reader. AccountCache keeps a positive answer
about a minute for the read-only routes of the signed-in listeners only; sign-in
and refresh (session_service.py) and every other route read the chain.
"""
import math
import re
from threading import Lock
import time

from discovery import (CHAIN_ID, SNAPSHOT_LOOPBACK_RPC, DataError, address as normalized_address,
                       json_http, parse_block, quantity, snapshot_loopback_http)
from read_deadline import read_deadline
from rpc_config import DEFAULT_RPC_HOSTS, MAX_RPC_ENDPOINTS, rpc_endpoint, rpc_hosts
from rpc_failover import FailoverReadRpc
from session_models import SessionError, account_code, validate_account


CHECK_BUDGET_SECONDS = 10
MAX_CHECK_REQUESTS = 16
MAX_BLOCK_AGE_SECONDS = 120
MAX_FUTURE_SECONDS = 15
# 4 Nov 2026 (launch round P3): every signed-in call paid the account check, six
# sequential chain reads, a status poll included. A positive answer is kept this
# long for read-only routes (onboarding_auth.READ_ONLY_ROUTES), and the listener
# holds at most this many accounts, the oldest leaving first.
ACCOUNT_CACHE_SECONDS = 60
MAX_CACHED_ACCOUNTS = 4096


class EoaChecker:
    def __init__(self, rpc_urls, *, allowed_hosts=DEFAULT_RPC_HOSTS, transport=json_http,
                 clock=time.time, execution_status_loopback=False):
        # Only explicitly supplied operator configuration can select destinations.
        if not isinstance(rpc_urls, (tuple, list)) or not 1 <= len(rpc_urls) <= MAX_RPC_ENDPOINTS:
            raise ValueError('invalid_session_rpc_config')
        try:
            hosts = rpc_hosts(allowed_hosts)
            if type(execution_status_loopback) is not bool:
                raise ValueError('invalid_loopback_opt_in')
            if execution_status_loopback:
                # One private status-only route, with the existing no-proxy,
                # no-redirect transport. No external fallback or injected
                # transport can silently replace its destination.
                if tuple(rpc_urls) != (SNAPSHOT_LOOPBACK_RPC,) or transport is not json_http:
                    raise ValueError('invalid_status_loopback')
                urls, transport = (SNAPSHOT_LOOPBACK_RPC,), snapshot_loopback_http
            else:
                urls = tuple(rpc_endpoint(url, hosts) for url in rpc_urls)
            if len(set(urls)) != len(urls):
                raise ValueError('duplicate_endpoint')
        except (DataError, ValueError, TypeError):
            raise ValueError('invalid_session_rpc_config') from None
        self.urls, self.transport, self.clock = urls, transport, clock

    def _fresh(self, block):
        now = self.clock()
        if (type(now) not in (int, float) or not math.isfinite(now)
                or not -MAX_FUTURE_SECONDS <= now - block.timestamp <= MAX_BLOCK_AGE_SECONDS):
            raise DataError('stale_or_future_block')

    def check(self, address):
        try:
            with read_deadline(CHECK_BUDGET_SECONDS):
                owner = normalized_address(address)
                rpc = FailoverReadRpc(self.urls, transport=self.transport, max_requests=MAX_CHECK_REQUESTS)
                if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
                    raise DataError('wrong_chain')
                block = parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))
                if len(str(block.number)) > 20:
                    raise DataError('block_unavailable')
                self._fresh(block)
                code = rpc.request('eth_getCode', [owner, block.tag])
                if (not isinstance(code, str) or len(code) > 2_000_000
                        or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', code)):
                    raise DataError('token_code_unavailable')
                if parse_block(rpc.request('eth_getBlockByNumber', [block.tag, False])) != block:
                    raise DataError('snapshot_reorganized')
                if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
                    raise DataError('wrong_chain')
                self._fresh(block)
                kind = account_code(code)
                result = {'blockNumber': str(block.number), 'blockHash': block.hash}
            # Only a canonical, fresh observation can trigger unsupported/revocation.
            if kind is None:
                raise SessionError('account_unsupported')
            return {**kind, **result}
        except SessionError:
            raise
        except Exception:
            raise SessionError('account_check_unavailable') from None


class AccountCache:
    """A positive account check kept ACCOUNT_CACHE_SECONDS, served only to a session admitted with its delegate.

    P2 (3 Nov 2026) found why a plain positive cache is unsafe: a wallet
    upgraded to EIP-7702 mid-session loops sign-in. The fresh check that sees the
    new delegate revokes the session, the wallet signs in again with it, and the
    cached answer from before the upgrade (no delegate) revokes the new session
    on its next call, and the next, until the entry expires. So a cached answer
    is served only when its delegate is the one the session was admitted with
    (None for a plain EOA): it can only confirm a session as admitted, never
    revoke one. Any other answer comes from the chain, and only that one revokes.
    Every fresh positive answer replaces the account's entry, whichever route
    asked, so the entry is the newest observation this listener holds. Failures
    and unsupported accounts are never kept.
    """

    def __init__(self, checker, *, seconds=ACCOUNT_CACHE_SECONDS, capacity=MAX_CACHED_ACCOUNTS,
                 clock=time.monotonic):
        self.checker, self.seconds, self.capacity, self.clock = checker, seconds, capacity, clock
        self.entries = {}
        self.lock = Lock()

    def fresh(self, owner):
        """A check read from the chain; a positive one becomes the account's entry."""
        observed = self.clock()
        validation = dict(validate_account(self.checker.check(owner)))
        with self.lock:
            # Insertion order is age order: a renewed account moves to the end.
            self.entries.pop(owner, None)
            while len(self.entries) >= self.capacity:
                del self.entries[next(iter(self.entries))]
            self.entries[owner] = (observed + self.seconds, validation)
        return dict(validation)

    def read_only(self, owner, delegate):
        """For a read-only route of a session admitted with `delegate`: the entry when it is younger than
        ACCOUNT_CACHE_SECONDS and names that delegate, else a fresh check."""
        entry = self.entries.get(owner)
        if entry is not None and self.clock() < entry[0] and entry[1].get('delegate') == delegate:
            return dict(entry[1])
        return self.fresh(owner)
