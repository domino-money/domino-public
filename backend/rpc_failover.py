"""Bounded read-only failover, with chain and block proofs before reuse.

Every attempted request, including identity checks, uses the same ReadRpc count
and transport deadline. A provider is attempted at most once per read. Invalid
identity or an inconsistent snapshot poisons the whole read even if a metadata
caller catches its first exception.
"""
import logging

from discovery import RPC_URL, CHAIN_ID, DataError, ReadRpc, RpcStateUnavailable, parse_block, quantity
from read_deadline import check_read_deadline
from rpc_config import MAX_RPC_ENDPOINTS

RETRYABLE = frozenset({'network_unavailable', 'http_429', 'http_502', 'http_503', 'http_504',
                       'http_520', 'http_521', 'http_522', 'http_523', 'http_524', 'http_530'})
MAX_ANCHORS = 16
_LOG = logging.getLogger(__name__)


class FailoverReadRpc(ReadRpc):
    def __init__(self, urls, **kwargs):
        if (not isinstance(urls, (list, tuple)) or not 1 <= len(urls) <= MAX_RPC_ENDPOINTS or
                any(not isinstance(url, str) or not url for url in urls) or len(set(urls)) != len(urls)):
            raise DataError('invalid_rpc_endpoints')
        super().__init__(urls[0], **kwargs)
        self.urls, self.index = tuple(urls), 0
        self.verified, self.anchors, self.failure = False, {}, None

    def _switch(self, error):
        self.index += 1
        self.url, self.verified = self.urls[self.index], False
        # Fixed error codes and route ordinal only; never endpoint credentials.
        reason = 'historical_state_unavailable' if isinstance(error, RpcStateUnavailable) else str(error)
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
                if (code in RETRYABLE or isinstance(error, RpcStateUnavailable)) and self.index + 1 < len(self.urls):
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
                # the next provider, within the same deadline and count.
                state_only = self._state_batch_retryable(calls)
                retryable = ((code in RETRYABLE or (isinstance(error, RpcStateUnavailable) and state_only))
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

    String endpoints retain the previous single-provider behavior for explicit
    tools and old configurations. An ordered tuple opts into verified failover.
    """
    def __init__(self, urls=RPC_URL, **kwargs):
        self.legacy_single_source = isinstance(urls, str)
        self._operation_depth = 0
        self._identity_verified = set()
        if self.legacy_single_source:
            ReadRpc.__init__(self, urls, **kwargs)
        else:
            super().__init__(urls, **kwargs)

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

    def _begin_operation(self):
        # Missing old state does not send subsequent retained logs/headers to
        # Alchemy. Each independent operation starts at the local primary;
        # changing providers still checks the same highest continuity proof.
        if self._operation_depth == 0 and self.index and not self.failure:
            self.index = 0
            self.url, self.verified = self.urls[0], False
        self._operation_depth += 1

    def request(self, method, params=()):
        if self.legacy_single_source:
            return ReadRpc.request(self, method, params)
        self._begin_operation()
        try:
            return super().request(method, params)
        finally:
            self._operation_depth -= 1

    def batch(self, calls, *, item_errors=False):
        if self.legacy_single_source:
            return ReadRpc.batch(self, calls, item_errors=item_errors)
        self._begin_operation()
        try:
            return super().batch(calls, item_errors=item_errors)
        finally:
            self._operation_depth -= 1
