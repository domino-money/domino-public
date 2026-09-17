"""Bounded read-only failover, with chain and block proofs before reuse.

Every attempted request, including identity checks, uses the same ReadRpc count
and transport deadline. A provider is attempted at most once per read. Invalid
identity or an inconsistent snapshot poisons the whole read even if a metadata
caller catches its first exception.
"""
from discovery import CHAIN_ID, DataError, ReadRpc, parse_block, quantity
from read_deadline import check_read_deadline
from rpc_config import MAX_RPC_ENDPOINTS

RETRYABLE = frozenset({'network_unavailable', 'http_429', 'http_502', 'http_503', 'http_504'})
MAX_ANCHORS = 16


class FailoverReadRpc(ReadRpc):
    def __init__(self, urls, **kwargs):
        if (not isinstance(urls, (list, tuple)) or not 1 <= len(urls) <= MAX_RPC_ENDPOINTS or
                any(not isinstance(url, str) or not url for url in urls) or len(set(urls)) != len(urls)):
            raise DataError('invalid_rpc_endpoints')
        super().__init__(urls[0], **kwargs)
        self.urls, self.index = tuple(urls), 0
        self.verified, self.anchors, self.failure = False, {}, None

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
                    if not params or not isinstance(params[-1], str) or params[-1] not in self.anchors:
                        raise DataError('block_unavailable')
                result = super().request(method, params)
                if method == 'eth_chainId' and quantity(result) != CHAIN_ID:
                    raise DataError('wrong_chain')
                if method == 'eth_getBlockByNumber':
                    block = parse_block(result)
                    if block.tag in self.anchors and block != self.anchors[block.tag]:
                        raise DataError('snapshot_reorganized')
                    if block.tag not in self.anchors and len(self.anchors) >= MAX_ANCHORS:
                        raise DataError('request_budget_exhausted')
                    self.anchors[block.tag] = block
                return result
            except DataError as error:
                code = str(error)
                if code in RETRYABLE and self.index + 1 < len(self.urls):
                    self.index += 1
                    self.url, self.verified = self.urls[self.index], False
                    continue
                # Transport exhaustion and proof/budget failures cannot be hidden
                # as optional metadata. Application RPC reverts remain token-local.
                if (verifying or method not in ('eth_call', 'eth_getCode', 'eth_getBalance')
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
                    if method in ('eth_call','eth_getCode','eth_getBalance') and params[-1] not in self.anchors:
                        raise DataError('block_unavailable')
                batch_attempted = True
                results = super().batch(calls, item_errors=item_errors)
                # Commit anchors only after the entire envelope and every chain
                # or block assertion validates. Never merge partial providers.
                anchors = dict(self.anchors)
                for (method,params),result in zip(calls,results):
                    if isinstance(result, DataError):
                        continue  # a delivered per-item refusal proves nothing about anchors
                    if method == 'eth_chainId' and quantity(result)!=CHAIN_ID:
                        raise DataError('wrong_chain')
                    if method == 'eth_getBlockByNumber':
                        block = parse_block(result)
                        if params[0]!='latest' and block.tag!=params[0]:
                            raise DataError('snapshot_reorganized')
                        if block.tag in anchors and block!=anchors[block.tag]:
                            raise DataError('snapshot_reorganized')
                        if block.tag not in anchors and len(anchors)>=MAX_ANCHORS:
                            raise DataError('request_budget_exhausted')
                        anchors[block.tag] = block
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
                retryable = code in RETRYABLE and (code != 'network_unavailable' or not batch_attempted)
                if retryable and self.index+1<len(self.urls):
                    self.index += 1
                    self.url,self.verified = self.urls[self.index],False
                    continue
                self.failure = code
                raise
