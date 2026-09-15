"""Defensive development ceilings, not evidence of provider-account headroom.

One instance belongs to the sole development reader process. Every actual
transport attempt spends it, including batch items, inventory and failover.
Restarting the process imposes a full rolling-window cooldown before admission.
"""
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import math
import re
from threading import Lock
import time

from discovery import DataError, ReadRpc, address, json_http
from inventory import PAGE_SIZE, page_key
from read_api import ReadGate
from read_deadline import check_read_deadline, read_deadline, read_timeout


_OPERATION = ContextVar('domino_dev_read_operation', default=None)
RPC_PER_OPERATION = 64
CEILINGS = {'rpc': 120, 'gecko': 6, 'dex': 6}
WINDOW_SECONDS = 60
GECKO_ROUTE = re.compile(
    r'https://api\.geckoterminal\.com/api/v2/networks/robinhood/pools/0x[0-9a-f]{64}'
    r'(?:/ohlcv/hour\?aggregate=1&limit=24&currency=usd&token=0x[0-9a-f]{40})?\Z')
DEX_ROUTE = re.compile(r'https://api\.dexscreener\.com/token-pairs/v1/robinhood/0x[0-9a-f]{40}\Z')


@dataclass
class Operation:
    owner: object
    rpc_items: int = 0
    failure: str | None = None


class DevelopmentBudgets:
    def __init__(self, *, qualified, expires_at, clock=time.monotonic, wall_clock=time.time):
        if type(qualified) is not bool or type(expires_at) is not int:
            raise ValueError('invalid_development_qualification')
        self.qualified, self.expires_at = qualified, expires_at
        self.clock, self.wall_clock = clock, wall_clock
        self.ready_at = clock() + WINDOW_SECONDS
        self.events = {kind: deque() for kind in CEILINGS}
        self.lock = Lock()

    def check(self):
        now = self.clock()
        wall = self.wall_clock()
        if (not self.qualified or not math.isfinite(now) or not math.isfinite(wall)
                or wall >= self.expires_at or now < self.ready_at):
            raise DataError('upstream_unavailable')

    def admission(self):
        now, wall = self.clock(), self.wall_clock()
        if not self.qualified or not math.isfinite(now) or not math.isfinite(wall):
            state, retry = 'qualification_disabled', 0
        elif wall >= self.expires_at:
            state, retry = 'qualification_expired', 0
        else:
            retry = min(60, max(0, math.ceil(self.ready_at - now)))
            state = 'cooldown' if retry else 'ready'
        return {'state': state, 'retryAfterSeconds': retry,
                'startsPerMinute': 6, 'minimumStartIntervalSeconds': 2}

    @contextmanager
    def operation(self):
        current = _OPERATION.get()
        if current is not None:
            if current.owner is not self:
                raise DataError('upstream_unavailable')
            yield current
            return
        self.check()
        operation = Operation(self)
        token = _OPERATION.set(operation)
        try:
            with read_deadline(15):
                yield operation
                self.check()
                if operation.failure:
                    raise DataError(operation.failure)
        finally:
            _OPERATION.reset(token)

    def spend(self, kind, count):
        operation = _OPERATION.get()
        if operation is None or operation.owner is not self:
            raise DataError('upstream_unavailable')
        try:
            self.check()
            check_read_deadline()
            if operation.failure:
                raise DataError(operation.failure)
            if (kind not in CEILINGS or type(count) is not int or count < 1
                    or (kind == 'rpc' and operation.rpc_items + count > RPC_PER_OPERATION)):
                raise DataError('request_budget_exhausted')
            with self.lock:
                now = self.clock()
                events = self.events[kind]
                while events and events[0] <= now - WINDOW_SECONDS:
                    events.popleft()
                if len(events) + count > CEILINGS[kind]:
                    raise DataError('request_budget_exhausted')
                # Charge before dispatch; failures never refund an attempt.
                events.extend([now] * count)
                if kind == 'rpc':
                    operation.rpc_items += count
        except DataError as error:
            operation.failure = str(error)
            raise


class DevelopmentGate(ReadGate):
    """No queue, one actual worker per kind, six starts/window, >=2 s between starts.

    The dev lane's binding constraint is the per-provider budget, so both
    kinds share one starts window and the same 2s start interval; the stored
    slot only adds a second concurrent worker, not extra provider capacity.
    """
    def __init__(self, budgets):
        super().__init__(interval=2, clock=budgets.clock)
        self.budgets, self.starts = budgets, deque()

    def enter(self, kind=ReadGate.PROVIDER):
        slot = self.stored_slot if kind == self.STORED else self.slot
        if not slot.acquire(blocking=False):
            return False
        admitted = False
        try:
            with self.lock:
                self.budgets.check()
                now = self.clock()
                while self.starts and self.starts[0] <= now - WINDOW_SECONDS:
                    self.starts.popleft()
                if len(self.starts) < 6 and now - self.last >= self.interval:
                    self.starts.append(now)
                    self.last, admitted = now, True
        except DataError:
            pass
        finally:
            if not admitted:
                slot.release()
        return admitted

    def admission(self):
        result = self.budgets.admission()
        if result['state'] != 'ready':
            return result
        with self.lock:
            now = self.clock()
            while self.starts and self.starts[0] <= now - WINDOW_SECONDS:
                self.starts.popleft()
            retry = max(0, self.last + self.interval - now)
            if len(self.starts) >= 6:
                retry = max(retry, self.starts[0] + WINDOW_SECONDS - now)
        if retry:
            result.update(state='cooldown', retryAfterSeconds=min(60, math.ceil(retry)))
        return result


class DevelopmentTransport:
    def __init__(self, budgets, *, rpc_urls, inventory_url=None, transport=json_http):
        self.budgets = budgets
        self.rpc_urls, self.inventory_url = frozenset(rpc_urls), inventory_url
        self.transport = transport

    def _rpc_items(self, url, body):
        items = body if type(body) is list else [body]
        if not 1 <= len(items) <= ReadRpc.MAX_BATCH_ITEMS:
            raise DataError('upstream_unavailable')
        ids = set()
        for item in items:
            if (type(item) is not dict or set(item) != {'jsonrpc', 'id', 'method', 'params'}
                    or item['jsonrpc'] != '2.0' or type(item['id']) is not int
                    or not 1 <= item['id'] <= 2**53 - 1 or item['id'] in ids
                    or type(item['method']) is not str or type(item['params']) is not list):
                raise DataError('upstream_unavailable')
            ids.add(item['id'])
            method, params = item['method'], item['params']
            if method == 'alchemy_getTokenBalances':
                if (url != self.inventory_url or len(items) != 1 or len(params) != 3
                        or address(params[0]) != params[0] or params[1] != 'erc20'
                        or type(params[2]) is not dict
                        or set(params[2]) not in ({'maxCount'}, {'maxCount', 'pageKey'})
                        or type(params[2]['maxCount']) is not int or params[2]['maxCount'] != PAGE_SIZE):
                    raise DataError('upstream_unavailable')
                if 'pageKey' in params[2]:
                    page_key(params[2]['pageKey'])
            elif url in self.rpc_urls or (url == self.inventory_url and method == 'eth_chainId'):
                # Shares the producer's read-only parameter/gas validation;
                # rejects state overrides and every signing/broadcast method.
                ReadRpc(url)._batch_specs([(method, params)])
            else:
                raise DataError('upstream_unavailable')
        return len(items)

    def __call__(self, url, body=None, *, timeout=8):
        check_read_deadline()
        if type(url) is not str or type(timeout) not in (int, float) or not 0 < timeout <= 8:
            raise DataError('upstream_unavailable')
        if url in self.rpc_urls or (self.inventory_url is not None and url == self.inventory_url):
            count, kind = self._rpc_items(url, body), 'rpc'
        elif body is None and GECKO_ROUTE.fullmatch(url):
            count, kind = 1, 'gecko'
        elif body is None and DEX_ROUTE.fullmatch(url):
            count, kind = 1, 'dex'
        else:
            # No Blockscout, trading, arbitrary URLs or browser-selected relay.
            raise DataError('upstream_unavailable')
        self.budgets.spend(kind, count)
        # json_http refuses redirects and enforces a total socket/read deadline.
        # Do not accept caller headers or a caller-selected opener.
        result = self.transport(url, body, timeout=read_timeout(min(timeout, 5)))
        check_read_deadline()
        self.budgets.check()
        return result
