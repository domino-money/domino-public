"""Fresh canonical plain-EOA classification, independent of Uniswap or SIWE.

An empty-code observation never authenticates by itself. The session service
must separately verify SIWE and atomically authorize against its private store.
Each check creates a new bounded reader; no positive code/session cache exists.
"""
import math
import re
import time

from discovery import (CHAIN_ID, SNAPSHOT_LOOPBACK_RPC, DataError, address as normalized_address,
                       json_http, parse_block, quantity, snapshot_loopback_http)
from read_deadline import read_deadline
from rpc_config import DEFAULT_RPC_HOSTS, MAX_RPC_ENDPOINTS, rpc_endpoint, rpc_hosts
from rpc_failover import FailoverReadRpc
from session_models import SessionError


CHECK_BUDGET_SECONDS = 10
MAX_CHECK_REQUESTS = 16
MAX_BLOCK_AGE_SECONDS = 120
MAX_FUTURE_SECONDS = 15


class PlainEoaChecker:
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
                result = {'method': 'plain_eoa', 'blockNumber': str(block.number), 'blockHash': block.hash}
            # Only a canonical, fresh observation can trigger unsupported/revocation.
            if code != '0x':
                raise SessionError('account_unsupported')
            return result
        except SessionError:
            raise
        except Exception:
            raise SessionError('account_check_unavailable') from None
