"""Opt-in qualification helpers; mutations are confined to a child Anvil process.

Not imported by a public API. The fork upstream is a separate read-only gateway.
No private keys, wallet RPC endpoint, mainnet write transport or admission file
is supplied to this helper. Local funding and mining are experiment controls.
"""
from collections import Counter
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from discovery import CHAIN_ID, RPC_URL, DataError
from deposit_rpc import DepositRpc
import local_anvil

READ_METHODS = DepositRpc.METHODS | {'web3_clientVersion', 'eth_getStorageAt',
    'eth_getBlockByHash', 'anvil_nodeInfo'}
LOCAL_CONTROLS = frozenset({'anvil_setBalance', 'anvil_setCode', 'anvil_impersonateAccount',
    'anvil_stopImpersonatingAccount', 'anvil_mine', 'evm_mine',
    'evm_setNextBlockTimestamp', 'evm_snapshot', 'evm_revert',
    'eth_sendTransaction'})


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise DataError('fork_redirect_rejected')


class DepositFork:
    """Own one loopback node, with no option to attach to an existing wallet RPC."""
    def __init__(self, gateway, *, block, total_seconds=1200, max_requests=5000, hardfork='cancun'):
        # Cancun matches every earlier qualification. Prague is what makes an
        # EIP-7702 designator execute on the child; Nitro already runs it.
        if (not isinstance(block, dict) or not isinstance(block.get('number'), str)
                or not isinstance(block.get('hash'), str)
                or type(total_seconds) is not int or not 1 <= total_seconds <= 1800
                or type(max_requests) is not int or not 1 <= max_requests <= 100_000
                or hardfork not in ('cancun', 'prague')):
            raise DataError('invalid_fork_configuration')
        try:
            number = int(block['number'], 16)
            if not 0 < number < 2**53 or len(block['hash']) != 66:
                raise ValueError()
            bytes.fromhex(block['hash'][2:])
        except (TypeError, ValueError):
            raise DataError('invalid_fork_configuration') from None
        self.gateway, self.source_block = gateway, dict(block)
        self.number, self.total_seconds, self.max_requests = number, total_seconds, max_requests
        self.hardfork = hardfork
        self.process = self.temp = None
        self._verified = False
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        self.counts = Counter()

    def __enter__(self):
        self.started = time.monotonic()
        try:
            # Validate before allocation, and include every startup stage in
            # cleanup. The gateway owns this URL; no alternate wallet RPC is
            # accepted. A hostname prefix alone would accept URL userinfo.
            gateway_url = self.gateway.url
            parsed = urlsplit(gateway_url)
            if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1'
                    or parsed.port is None or parsed.netloc != f'127.0.0.1:{parsed.port}'
                    or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
                raise DataError('fork_gateway_required')
            self.temp = tempfile.TemporaryDirectory(prefix='domino-deposit-fork-')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            self.url = f'http://127.0.0.1:{port}'
            # Only the task-owned read gateway reaches the upstream. Its URL,
            # not a credential-bearing provider URL, appears in child argv.
            args = ['--host', '127.0.0.1', '--port', str(port),
                '--chain-id', str(CHAIN_ID), '--accounts', '0', '--silent',
                '--fork-url', gateway_url, '--fork-block-number', str(self.number),
                '--no-storage-caching', '--retries', '0', '--timeout', '10000',
                '--hardfork', self.hardfork, '--slots-in-an-epoch', '1']
            self.process = local_anvil.start(args, cwd=self.temp.name,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')})
            for _ in range(200):
                try:
                    version = self._request('web3_clientVersion', [])
                    if not isinstance(version, str) or 'anvil' not in version.lower():
                        raise DataError('fork_node_identity_mismatch')
                    if self._request('eth_chainId', []) != hex(CHAIN_ID):
                        raise DataError('fork_chain_mismatch')
                    observed = self._request('eth_getBlockByNumber', [hex(self.number), False])
                    if not isinstance(observed, dict) or observed.get('hash') != self.source_block['hash']:
                        raise DataError('fork_source_mismatch')
                    self._verified = True
                    self.version = version
                    return self
                except (urllib.error.URLError, ConnectionError, TimeoutError):
                    if self.process.poll() is not None:
                        break
                    time.sleep(.05)
            raise DataError('fork_start_failed')
        except BaseException:
            self.close()
            raise

    def close(self):
        self._verified = False
        if self.process is not None:
            local_anvil.stop(self.process)
        if self.temp is not None:
            self.temp.cleanup()

    def __exit__(self, *args):
        self.close()

    def _request(self, method, params):
        remaining = self.total_seconds - (time.monotonic() - self.started)
        if remaining <= 0 or self.process is None or self.process.poll() is not None:
            raise DataError('fork_not_running')
        self.counts[method] += 1
        body = json.dumps({'jsonrpc': '2.0', 'id': sum(self.counts.values()),
            'method': method, 'params': params}, allow_nan=False).encode()
        if len(body) > 140_000 or sum(self.counts.values()) > self.max_requests:
            raise DataError('fork_request_budget')
        request = urllib.request.Request(self.url, body, {'Content-Type': 'application/json'})
        with self._opener.open(request, timeout=min(20, remaining)) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise DataError('fork_response_budget')
        result = json.loads(raw)
        if not isinstance(result, dict) or 'error' in result or 'result' not in result:
            # Keep only finite JSON-RPC code for experimental diagnosis.
            code = result.get('error', {}).get('code') if isinstance(result, dict) else None
            error = DataError('fork_rpc_rejected')
            error.rpc_code = code if type(code) is int else None
            raise error
        return result['result']

    def request(self, method, params=()):
        if not self._verified or method not in READ_METHODS | LOCAL_CONTROLS:
            raise DataError('fork_method_rejected')
        return self._request(method, list(params))

    def transport(self, url, body, **options):
        if url != RPC_URL or body['method'] not in DepositRpc.METHODS:
            raise DataError('fork_transport_identity')
        return {'jsonrpc': '2.0', 'id': body['id'],
            'result': self.request(body['method'], body['params'])}

    def deposit_rpc(self):
        return DepositRpc(RPC_URL, transport=self.transport, max_requests=160)

    def mine(self, count=1):
        if type(count) is not int or not 1 <= count <= 16:
            raise DataError('fork_mine_budget')
        return self.request('anvil_mine', [hex(count), '0x0'])

    def fresh_block(self):
        block = self.request('eth_getBlockByNumber', ['latest', False])
        now = int(time.time())
        if int(block['timestamp'], 16) < now:
            self.request('evm_setNextBlockTimestamp', [now])
        self.mine()

    def send(self, tx):
        """Submit on this child only. Chain identity is rechecked on every write."""
        if self.request('eth_chainId') != hex(CHAIN_ID):
            raise DataError('fork_chain_mismatch')
        digest = self.request('eth_sendTransaction', [tx])
        for _ in range(30):
            receipt = self.request('eth_getTransactionReceipt', [digest])
            if receipt is not None:
                return receipt
            time.sleep(.05)
        raise DataError('fork_receipt_unavailable')

    def send_artifact(self, artifact):
        value = artifact['transaction']
        tx = {'from': value['from'], 'to': value['to'], 'data': value['data'],
            'chainId': hex(value['chainId'])}
        for source, target in [('valueRaw', 'value'), ('nonceRaw', 'nonce'),
                ('gasLimitRaw', 'gas'), ('maxFeePerGasRaw', 'maxFeePerGas'),
                ('maxPriorityFeePerGasRaw', 'maxPriorityFeePerGas')]:
            tx[target] = hex(int(value[source]))
        return self.send(tx)
