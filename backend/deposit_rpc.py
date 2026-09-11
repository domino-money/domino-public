"""Bounded, non-broadcast RPC for direct-deposit preparation and receipts.

This deliberately does not expand discovery.ReadRpc or choose a provider from
browser input. A fresh instance uses one explicitly configured HTTPS endpoint;
errors never contain URLs, credentials, revert data or provider messages.
"""
import json

from discovery import DataError, json_http
from read_deadline import (ReadDeadline, check_read_deadline, current_read_deadline,
                           read_timeout, use_read_deadline)
from rpc_config import DEFAULT_RPC_HOSTS, rpc_endpoint


class DepositRpc:
    METHODS = frozenset({'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode',
        'eth_getBalance', 'eth_getTransactionCount', 'eth_call', 'eth_estimateGas',
        'eth_maxPriorityFeePerGas', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
        'eth_getStorageAt'})

    def __init__(self, url, *, allowed_hosts=DEFAULT_RPC_HOSTS, transport=json_http,
                 max_requests=160):
        if type(max_requests) is not int or not 1 <= max_requests <= 160:
            raise DataError('invalid_deposit_rpc_budget')
        self._url = rpc_endpoint(url, allowed_hosts)
        self._transport = transport
        self.count, self.max_requests = 0, max_requests
        parent = current_read_deadline()
        self._deadline = ReadDeadline(20, parents=(parent,) if parent else ())

    def request(self, method, params=()):
        with use_read_deadline(self._deadline):
            return self._request(method, params)

    def _request(self, method, params):
        check_read_deadline()
        if method not in self.METHODS:
            raise DataError('method_not_read_only')
        if self.count >= self.max_requests:
            raise DataError('request_budget_exhausted')
        if not isinstance(params, (list, tuple)) or len(params) > 3:
            raise DataError('invalid_deposit_rpc_params')
        self.count += 1
        body = {'jsonrpc': '2.0', 'id': self.count, 'method': method, 'params': list(params)}
        try:
            if len(json.dumps(body, allow_nan=False).encode()) > 140_000:
                raise ValueError
        except (ValueError, TypeError, UnicodeError, RecursionError):
            raise DataError('invalid_deposit_rpc_params') from None
        try:
            result = self._transport(self._url, body, timeout=read_timeout(10))
        except Exception:
            check_read_deadline()
            raise DataError('deposit_rpc_unavailable') from None
        check_read_deadline()
        if (not isinstance(result, dict) or result.get('jsonrpc') != '2.0'
                or type(result.get('id')) is not int or result['id'] != self.count
                or set(result) not in ({'jsonrpc', 'id', 'result'}, {'jsonrpc', 'id', 'error'})):
            raise DataError('invalid_deposit_rpc_response')
        if 'error' in result:
            raise DataError('deposit_rpc_unavailable')
        return result['result']

    call = request
