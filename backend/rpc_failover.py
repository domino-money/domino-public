"""Bounded read-only failover, with chain and block proofs before reuse.

Every attempted request, including identity checks, uses the same ReadRpc count
and transport deadline. A provider is attempted at most once per read. Invalid
identity or an inconsistent snapshot poisons the whole read even if a metadata
caller catches its first exception.

A call a route did not answer within its own ceiling (discovery.RpcCallTimeout:
8 s on the reader's transport, 12 s by default) moves the read to the next
route, as a transport failure does; a slow call that answers stays where it is.
The process's next reads start past that route for a short hold (ProcessRoutes):
the configured order is kept, a held route is passed over, never moved.
"""
import logging
import threading
import time

from discovery import CHAIN_ID, DataError, ReadRpc, RpcCallTimeout, RpcStateUnavailable, parse_block, quantity
from read_deadline import check_read_deadline
from rpc_config import LOCAL_STATE_BLOCKS, MAX_RPC_ENDPOINTS, own_node

RETRYABLE = frozenset({'network_unavailable', 'http_429', 'http_502', 'http_503', 'http_504',
                       'http_520', 'http_521', 'http_522', 'http_523', 'http_524', 'http_530'})
MAX_ANCHORS = 16
# How long this process's new reads pass over a route a call just ran out of time
# on: one Robinhood automation pass. Between 21 Oct and 3 Nov 2026 calls through
# the node's proxy hung past their ceiling at six moments while HAProxy's health
# check passed, and each read then waited out the same ceiling on the same route.
CALL_TIMEOUT_HOLD_SECONDS = 15
# A call this slow, or one that ran out of time, leaves one log line: its route
# (an ordinal or an endpoint name, never a URL), methods, items, ms and outcome.
SLOW_CALL_SECONDS = 2
_LOG = logging.getLogger(__name__)


def slow_call(body, seconds, error=None):
    """The fields of a call's slow-call line, or None for a call neither slow nor out of time. Its methods are the
    client's own allowlisted ones and its outcome a fixed code; never a parameter, a URL or a provider's text."""
    timed_out = isinstance(error, RpcCallTimeout)
    if seconds < SLOW_CALL_SECONDS and not timed_out:
        return None
    items = body if isinstance(body, list) else [body]
    methods = '+'.join(sorted({str(item.get('method')) for item in items if isinstance(item, dict)})) or '-'
    outcome = 'call_timeout' if timed_out else 'answered' if error is None else str(error)
    return 'method=%s items=%d ms=%d outcome=%s' % (methods, len(items), int(seconds * 1000), outcome)


class ProcessRoutes:
    """This process's V1 routes: the holds a call timeout leaves on them, and the slow-call log.

    A V1 reader builds a client per read, so without a hold each new read would
    wait out the same ceiling on the same route before moving on. A hold only
    passes a route over; a read whose every route is held starts at the first.
    """
    def __init__(self, clock=time.monotonic):
        self.clock, self._until, self._lock = clock, {}, threading.Lock()

    def hold(self, urls):
        until = self.clock() + CALL_TIMEOUT_HOLD_SECONDS
        with self._lock:
            for url in urls:
                self._until[url] = max(self._until.get(url, until), until)

    def first_open(self, urls, start=0):
        """The first of `urls` from `start` that is not held, else `start` itself."""
        now = self.clock()
        with self._lock:
            return next((index for index in range(start, len(urls)) if self._until.get(urls[index], now) <= now),
                        start)

    def note(self, index, body, seconds, error=None):
        """The slow-call line of one call to route `index`, when it took SLOW_CALL_SECONDS or ran out of time."""
        line = slow_call(body, seconds, error)
        if line is not None:
            _LOG.warning('rpc_slow_call provider_index=%d %s', index, line)


PROCESS_ROUTES = ProcessRoutes()


class FailoverReadRpc(ReadRpc):
    # This process's routes, held after a call timeout and timed for the slow-call log. V2 clients
    # (v2_rpc) keep both per endpoint, in the chain's ChainEndpoints, instead.
    routes = PROCESS_ROUTES

    def __init__(self, urls, **kwargs):
        if (not isinstance(urls, (list, tuple)) or not 1 <= len(urls) <= MAX_RPC_ENDPOINTS or
                any(not isinstance(url, str) or not url for url in urls) or len(set(urls)) != len(urls)):
            raise DataError('invalid_rpc_endpoints')
        super().__init__(urls[0], **kwargs)
        self.urls = tuple(urls)
        # A new read starts past the routes a call of this process just ran out of time on.
        self.index = 0 if self.routes is None else self.routes.first_open(self.urls)
        self.url = self.urls[self.index]
        self.verified, self.anchors, self.failure = False, {}, None

    def _send(self, body):
        routes = self.routes
        if routes is None:
            return super()._send(body)
        index, started = getattr(self, 'index', 0), routes.clock()  # a single-source client has no index
        try:
            payload = super()._send(body)
        except DataError as error:
            routes.note(index, body, routes.clock() - started, error)
            raise
        routes.note(index, body, routes.clock() - started)
        return payload

    def _timed_out(self, error, method, verifying):
        """A call the route did not answer in time. A slow log range on the own node is its range, which the
        walk narrows (indexer_io.AdaptiveSpan), not a stalled node: that one stays where it is."""
        return (isinstance(error, RpcCallTimeout)
                and (verifying or method != 'eth_getLogs' or not own_node(self.url)))

    def _switch(self, error):
        refused_state = isinstance(error, RpcStateUnavailable)
        timed_out = isinstance(error, RpcCallTimeout)
        # State the own node refused over one path, it refuses over the other; a call it did not answer in
        # time over one path, it would not answer over the other: the same node is behind both.
        skip = (refused_state or timed_out) and own_node(self.url)
        passed = [self.url]
        self.index += 1
        while skip and self.index + 1 < len(self.urls) and own_node(self.urls[self.index]):
            passed.append(self.urls[self.index])
            self.index += 1
        if timed_out and self.routes is not None:
            self.routes.hold(passed)
        self.url, self.verified = self.urls[self.index], False
        # Fixed error codes and route ordinal only; never endpoint credentials.
        reason = 'historical_state_unavailable' if refused_state else 'call_timeout' if timed_out else str(error)
        _LOG.warning('rpc_failover provider_index=%d reason=%s', self.index, reason)

    def _validate_header_tag(self, tag, block):
        if tag not in ('latest', 'finalized') and block.tag != tag:
            raise DataError('snapshot_reorganized')

    def _record_block(self, anchors, block):
        if block.tag in anchors and block != anchors[block.tag]:
            raise DataError('snapshot_reorganized')
        if block.tag not in anchors and len(anchors) >= MAX_ANCHORS:
            raise DataError('request_budget_exhausted')
        anchors[block.tag] = block

    def _prepare_state(self, params):
        if not params or not isinstance(params[-1], str) or params[-1] not in self.anchors:
            raise DataError('block_unavailable')

    def _state_batch_retryable(self, calls):
        return all(method in ('eth_call', 'eth_getCode', 'eth_getBalance') for method, _ in calls)

    def _verify(self):
        if quantity(super().request('eth_chainId')) != CHAIN_ID:
            raise DataError('wrong_chain')
        for tag, expected in self.anchors.items():
            observed = parse_block(super().request('eth_getBlockByNumber', [tag, False]))
            if observed != expected:
                raise DataError('snapshot_reorganized')
        self.verified = True

    def request(self, method, params=()):
        if method not in self.METHODS:
            raise DataError('method_not_read_only')
        if self.failure:
            raise DataError(self.failure)
        params = list(params)
        while True:
            check_read_deadline()
            verifying = not self.verified
            try:
                if not self.verified:
                    self._verify()
                verifying = False
                if method in ('eth_call', 'eth_getCode', 'eth_getBalance'):
                    # Only an already observed numeric block may be used for state.
                    self._prepare_state(params)
                result = super().request(method, params)
                if method == 'eth_chainId' and quantity(result) != CHAIN_ID:
                    raise DataError('wrong_chain')
                if method == 'eth_getBlockByNumber':
                    block = parse_block(result)
                    self._validate_header_tag(params[0], block)
                    self._record_block(self.anchors, block)
                return result
            except DataError as error:
                code = str(error)
                if ((code in RETRYABLE or isinstance(error, RpcStateUnavailable)
                     or self._timed_out(error, method, verifying)) and self.index + 1 < len(self.urls)):
                    self._switch(error)
                    continue
                # Transport exhaustion and proof/budget failures cannot be hidden
                # as optional metadata. Application RPC reverts remain token-local.
                if (verifying or isinstance(error, RpcStateUnavailable)
                        or method not in ('eth_call', 'eth_getCode', 'eth_getBalance')
                        or code not in ('rpc_error', 'rpc_call_reverted', 'rpc_call_gas_limit')):
                    self.failure = code
                raise

    def batch(self, calls, *, item_errors=False):
        calls = self._batch_specs(calls)
        if self.failure:
            raise DataError(self.failure)
        while True:
            batch_attempted = False
            try:
                check_read_deadline()
                if not self.verified:
                    self._verify()
                for method,params in calls:
                    if method in ('eth_call','eth_getCode','eth_getBalance'):
                        self._prepare_state(params)
                batch_attempted = True
                # Inspect every delivered identity proof before any state
                # refusal can trigger recovery. A mixed batch must not hide a
                # wrong chain/header behind another item's missing-state error.
                results = super().batch(calls, item_errors=True)
                # Commit anchors only after the entire envelope and every chain
                # or block assertion validates. Never merge partial providers.
                anchors = dict(self.anchors)
                delivered_blocks = {}
                for (method,params),result in zip(calls,results):
                    if isinstance(result, DataError):
                        if method in ('eth_chainId', 'eth_getBlockByNumber'):
                            raise result
                        continue  # a delivered per-item refusal proves nothing about anchors
                    if method == 'eth_chainId' and quantity(result)!=CHAIN_ID:
                        raise DataError('wrong_chain')
                    if method == 'eth_getBlockByNumber':
                        block = parse_block(result)
                        self._validate_header_tag(params[0], block)
                        if block.tag in delivered_blocks and block != delivered_blocks[block.tag]:
                            raise DataError('snapshot_reorganized')
                        delivered_blocks[block.tag] = block
                        self._record_block(anchors, block)
                # A history client may retry a mixed batch after an explicit
                # state refusal. Keep all validated continuity proofs first.
                if self._state_batch_retryable(calls):
                    self.anchors = anchors
                for result in results:
                    if isinstance(result, RpcStateUnavailable) or (isinstance(result, DataError) and not item_errors):
                        raise result
                self.anchors = anchors
                return results
            except DataError as error:
                try:
                    check_read_deadline()
                except DataError as expired:
                    self.failure = str(expired)
                    raise
                code = str(error)
                # Failed pre-dispatch identity/anchor reads retain scalar
                # failover. Once a batch is attempted, a network failure may
                # mean unknown completion and must not replay it. Explicit HTTP
                # failures still allow fresh chain/all-anchor verification on
                # the next provider, within the same deadline and count; so
                # does a batch the route did not answer in time: every batched
                # method is a read, so asking the next route changes nothing.
                state_only = self._state_batch_retryable(calls)
                retryable = ((code in RETRYABLE or isinstance(error, RpcCallTimeout)
                              or (isinstance(error, RpcStateUnavailable) and state_only))
                             and (code != 'network_unavailable' or not batch_attempted))
                if retryable and self.index+1<len(self.urls):
                    self._switch(error)
                    continue
                self.failure = code
                raise


class HistoricalReadRpc(FailoverReadRpc):
    """Local-first historical reads with bounded cross-provider continuity.

    A verified highest header commits its ancestors through parent hashes; keep
    that continuity proof and the most recently needed headers. Indexers retain
    their own range/log/canonicality checks. Unlike a browser read, a historical
    walk may observe thousands of headers and must not accumulate all of them.
    An evicted numeric state block is read and pinned again before state access.
    State older than the own pruned node keeps starts at the first route past it.

    String endpoints retain the previous single-provider behavior for explicit
    tools and old configurations. An ordered tuple opts into verified failover.
    """
    def __init__(self, urls, **kwargs):
        self.legacy_single_source = isinstance(urls, str)
        self._operation_depth = 0
        self._identity_verified = set()
        if self.legacy_single_source:
            ReadRpc.__init__(self, urls, **kwargs)
        else:
            super().__init__(urls, **kwargs)
        # The own node may lead over two paths, its VM-local proxy and its public
        # route; old state starts at the first route past both.
        self._archive = (None if self.legacy_single_source else
                         next((index for index, url in enumerate(self.urls) if not own_node(url)), None))
        self._pruned_primary = self._archive not in (None, 0)

    def _record_block(self, anchors, block):
        if block.tag in anchors and block != anchors[block.tag]:
            raise DataError('snapshot_reorganized')
        # Dict insertion order is a bounded recency queue. Never evict the
        # highest observed block: matching it on recovery links prior data.
        anchors.pop(block.tag, None)
        anchors[block.tag] = block
        highest = max(anchors, key=lambda tag: anchors[tag].number)
        while len(anchors) > MAX_ANCHORS:
            oldest = next(tag for tag in anchors if tag != highest)
            del anchors[oldest]

    def _prepare_state(self, params):
        if not params or not isinstance(params[-1], str):
            raise DataError('block_unavailable')
        tag = params[-1]
        # Historical clients never turn an unpinned latest/pending request into
        # state at a different provider's head.
        quantity(tag)
        if tag not in self.anchors:
            self.request('eth_getBlockByNumber', [tag, False])

    def _state_batch_retryable(self, calls):
        return True  # Every delivered identity/header is validated before retry.

    def _verify(self):
        if self.index not in self._identity_verified:
            if quantity(ReadRpc.request(self, 'eth_chainId')) != CHAIN_ID:
                raise DataError('wrong_chain')
            self._identity_verified.add(self.index)
        if self.anchors:
            expected = max(self.anchors.values(), key=lambda block: block.number)
            observed = parse_block(ReadRpc.request(self, 'eth_getBlockByNumber', [expected.tag, False]))
            if observed != expected:
                raise DataError('snapshot_reorganized')
        self.verified = True

    def _beyond_local_state(self, calls):
        # The highest verified header is the head this read has proven; the own
        # node refuses state further below it, so asking there is a wasted trip.
        # Only state reads end in a numeric block; headers end in False, logs
        # in a filter and EIP-1898 pins in an object.
        if not self._pruned_primary or not self.anchors:
            return False
        head = max(block.number for block in self.anchors.values())
        for _, params in calls:
            try:
                if head - quantity(params[-1] if params else None) > LOCAL_STATE_BLOCKS:
                    return True
            except DataError:
                pass  # Not a numeric state block; the read path decides.
        return False

    def _begin_operation(self, calls):
        # Missing old state does not send subsequent retained logs/headers to
        # Alchemy. Each independent operation starts at the local primary,
        # except state older than it keeps, which starts past the own node,
        # and past any route a call just ran out of time on (ProcessRoutes).
        # Changing providers still checks the same highest continuity proof.
        if self._operation_depth == 0 and not self.failure:
            start = self._archive if self._beyond_local_state(calls) else 0
            if self.routes is not None:
                start = self.routes.first_open(self.urls, start)
            if self.index != start:
                self.index = start
                self.url, self.verified = self.urls[start], False
        self._operation_depth += 1

    def request(self, method, params=()):
        if self.legacy_single_source:
            return ReadRpc.request(self, method, params)
        self._begin_operation(((method, params),))
        try:
            return super().request(method, params)
        finally:
            self._operation_depth -= 1

    def batch(self, calls, *, item_errors=False):
        if self.legacy_single_source:
            return ReadRpc.batch(self, calls, item_errors=item_errors)
        self._begin_operation(self._batch_specs(calls))
        try:
            return super().batch(calls, item_errors=item_errors)
        finally:
            self._operation_depth -= 1
