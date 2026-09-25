"""Qualification is a child-only experiment, never a production admission path."""
from contextlib import redirect_stdout, redirect_stderr
from copy import deepcopy
from io import StringIO
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from urllib.request import Request, ProxyHandler, build_opener

from deposit_fork import DepositFork, LOCAL_CONTROLS
from discovery import CHAIN_ID, DataError
from fork_read_gateway import ForkReadGateway, METHODS
import qualify_deposit_fork as runner


CANARY = 'OFFLINE_PRIVATE_FORK_CANARY'
ENDPOINT = 'https://robinhood-mainnet.g.alchemy.com/v2/'+CANARY
BLOCK = {'number': '0x123', 'hash': '0x'+'12'*32, 'timestamp': '0x1234567'}


class Gateway:
    def __init__(self, *args, chain=hex(CHAIN_ID), reorg=False, **kwargs):
        self.url = 'http://127.0.0.1:31234/'
        self.chain, self.calls, self.reorg = chain, [], reorg
        self._stats = {'requests': 1, 'methods': {}, 'failures': {}, 'closed': False}

    @property
    def stats(self):
        return deepcopy(self._stats)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self._stats['closed'] = True

    def request(self, method, params=()):
        self.calls.append((method, list(params)))
        if method == 'eth_chainId':
            return self.chain
        if method == 'eth_getBlockByNumber':
            return {**BLOCK, 'hash': '0x'+'34'*32} if self.reorg and params[0] != 'latest' else deepcopy(BLOCK)
        raise AssertionError(method)


class LocalNode:
    def __init__(self, *args, **kwargs):
        self.version = 'anvil/v1.0.0'
        self.counts = {}
        self.calls, self.closed = [], False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def request(self, method, params=()):
        self.calls.append((method, list(params)))
        if method == 'evm_snapshot':
            return '0x1'
        if method == 'evm_revert':
            return True
        raise AssertionError(method)


class DepositForkTests(unittest.TestCase):
    def process(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.return_value = 0
        return process

    def answers(self, *, version='anvil/v1.0.0', chain=hex(CHAIN_ID), source=BLOCK):
        def result(method, params):
            if method == 'web3_clientVersion':
                return version
            if method == 'eth_chainId':
                return chain
            if method == 'eth_getBlockByNumber':
                return deepcopy(source)
            raise AssertionError(method)
        return result

    def test_child_argv_env_and_temporary_directory_contain_no_provider_secret(self):
        process = self.process()
        gateway = Gateway()
        gateway.endpoint = ENDPOINT
        fork = DepositFork(gateway, block=BLOCK)
        with patch('deposit_fork.subprocess.Popen', return_value=process) as spawn, \
                patch.object(fork, '_request', side_effect=self.answers()), \
                patch.dict(os.environ, {'ALCHEMY_API_KEY': CANARY, 'PRIVATE_KEY': CANARY}):
            with fork:
                self.assertTrue(fork._verified)
                path = Path(fork.temp.name)
                self.assertTrue(path.is_dir())
                args, options = spawn.call_args
                self.assertNotIn(CANARY, repr((args, options)))
                self.assertIn('--no-storage-caching', args[0])
                self.assertEqual(args[0][args[0].index('--accounts')+1], '0')
                self.assertEqual(args[0][args[0].index('--fork-url')+1], gateway.url)
                self.assertEqual(args[0][args[0].index('--fork-block-number')+1], str(int(BLOCK['number'], 16)))
                self.assertEqual(args[0][args[0].index('--hardfork')+1], 'cancun')
                self.assertEqual(set(options['env']), {'PATH'})
                self.assertEqual(options['stdout'], subprocess.DEVNULL)
                self.assertEqual(options['stderr'], subprocess.DEVNULL)
            process.terminate.assert_called_once()
            self.assertFalse(path.exists())
            self.assertFalse(fork._verified)

    def test_prague_is_the_only_other_child_hardfork(self):
        # Prague makes an EIP-7702 designator execute on the child.
        process = self.process()
        fork = DepositFork(Gateway(), block=BLOCK, hardfork='prague')
        with patch('deposit_fork.subprocess.Popen', return_value=process) as spawn, \
                patch.object(fork, '_request', side_effect=self.answers()):
            with fork:
                args = spawn.call_args[0][0]
                self.assertEqual(args[args.index('--hardfork')+1], 'prague')
        for value in ('osaka', 'Prague', '', None, 1):
            with self.subTest(hardfork=value), self.assertRaisesRegex(DataError, '^invalid_fork_configuration$'):
                DepositFork(Gateway(), block=BLOCK, hardfork=value)

    def test_child_identity_chain_and_source_pin_required_before_local_writes(self):
        cases = [self.answers(version='other-node'), self.answers(chain='0x1'),
                 self.answers(source={**BLOCK, 'hash': '0x'+'34'*32})]
        for answers in cases:
            process = self.process()
            fork = DepositFork(Gateway(), block=BLOCK)
            with patch('deposit_fork.subprocess.Popen', return_value=process), \
                    patch.object(fork, '_request', side_effect=answers):
                with self.assertRaises(DataError):
                    fork.__enter__()
                self.assertFalse(fork._verified)
                self.assertFalse(Path(fork.temp.name).exists())
                process.terminate.assert_called_once()
                with self.assertRaisesRegex(DataError, '^fork_method_rejected$'):
                    fork.request('eth_sendTransaction', [{}])

    def test_invalid_gateway_is_rejected_before_spawn_and_temp_is_cleaned(self):
        for url in ('https://upstream.invalid/'+CANARY,
                    'http://127.0.0.1:31234@upstream.invalid/',
                    'http://127.0.0.1:31234/?key='+CANARY,
                    'http://127.0.0.1:31234/#'+CANARY):
            with self.subTest(url=url):
                gateway = Gateway()
                gateway.url = url
                fork = DepositFork(gateway, block=BLOCK)
                with patch('deposit_fork.subprocess.Popen') as spawn:
                    with self.assertRaises(DataError) as caught:
                        fork.__enter__()
                    self.assertNotIn(CANARY, str(caught.exception))
                    spawn.assert_not_called()
                    self.assertTrue(fork.temp is None or not Path(fork.temp.name).exists())

    def test_spawn_failure_cleans_temp_without_marking_node_verified(self):
        fork = DepositFork(Gateway(), block=BLOCK)
        with patch('deposit_fork.subprocess.Popen', side_effect=FileNotFoundError('anvil absent')):
            with self.assertRaises((DataError, OSError)):
                fork.__enter__()
        self.assertFalse(fork._verified)
        self.assertFalse(Path(fork.temp.name).exists())

    def test_stubborn_child_is_killed_and_waited_before_temp_cleanup(self):
        fork = DepositFork(Gateway(), block=BLOCK)
        process = self.process()
        process.wait.side_effect = [subprocess.TimeoutExpired('anvil', 5), 0]
        fork.process = process
        fork.temp = tempfile.TemporaryDirectory(prefix='domino-test-fork-close-')
        path = Path(fork.temp.name)
        fork.close()
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)
        self.assertFalse(path.exists())

    def test_read_adapter_cannot_forward_local_write_controls(self):
        fork = DepositFork(Gateway(), block=BLOCK)
        fork._verified = True
        with patch.object(fork, '_request') as send:
            for method in LOCAL_CONTROLS | {'eth_sendRawTransaction', 'personal_sign'}:
                with self.subTest(method=method), self.assertRaises(DataError):
                    fork.transport('https://rpc.mainnet.chain.robinhood.com',
                        {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': []})
            send.assert_not_called()
            for method in ('eth_sendRawTransaction', 'personal_sign'):
                with self.assertRaisesRegex(DataError, '^fork_method_rejected$'):
                    fork.request(method, [])
            send.assert_not_called()


    def test_code_emulation_is_only_a_verified_child_control(self):
        fork = DepositFork(Gateway(), block=BLOCK)
        with patch.object(fork, '_request', return_value=True) as send:
            with self.assertRaises(DataError):
                fork.request('anvil_setCode', ['0x' + '00'*19 + '64', '0x6000'])
            send.assert_not_called()
            fork._verified = True
            self.assertTrue(fork.request('anvil_setCode', ['0x' + '00'*19 + '64', '0x6000']))
            send.assert_called_once()


class DepositForkCliTests(unittest.TestCase):
    def test_v4_qualification_passes_local_first_routes_without_exporting_credentials(self):
        local = 'https://rpc.domino.money/SYNTHETIC_LOCAL_TOKEN_0123456789/'
        config = {'version': 4, 'rpcUrl': local, 'rpcFallbackUrls': [ENDPOINT]}
        with tempfile.TemporaryDirectory(prefix='domino-test-fork-routing-') as directory:
            output = Path(directory)/'report.json'
            with patch.object(runner, 'load_config', return_value=config), \
                    patch.object(runner.uniswap_config, 'load_config', return_value={'apiKey': CANARY}), \
                    patch.object(runner, 'ForkReadGateway', side_effect=DataError('offline_stop')) as gateway, \
                    redirect_stdout(StringIO()):
                self.assertEqual(runner.main(['--rpc-config', 'unused', '--uniswap-config', 'unused',
                                              '--output', str(output)]), 2)
            self.assertEqual(gateway.call_args.args[0], (local, ENDPOINT))
            self.assertNotIn(CANARY, output.read_text())
            self.assertNotIn('SYNTHETIC_LOCAL_TOKEN', output.read_text())

    def execute(self, *, gateway=None, node=None, failure=None, case_failure=None):
        gateway, node = gateway or Gateway(), node or LocalNode()
        output, errors = StringIO(), StringIO()
        with tempfile.TemporaryDirectory(prefix='domino-test-qualification-report-') as path:
            target = Path(path)/'report.json'
            config = {'rpcUrl': ENDPOINT}
            with patch.object(runner, 'load_config', side_effect=failure, return_value=config), \
                    patch.object(runner.uniswap_config, 'load_config', return_value={'apiKey': CANARY}), \
                    patch.object(runner, 'ForkReadGateway', return_value=gateway), \
                    patch.object(runner, 'DepositFork', return_value=node) as child, \
                    patch.object(runner, '_bootstrap', return_value={'syntheticNativeBalanceRaw': '100'}), \
                    patch.object(runner, 'run_case', side_effect=case_failure, return_value={
                        'name': 'weth-input', 'status': 'protocol_path_passed',
                        'executionEligible': False, 'testAdmissionOverride': True}), \
                    redirect_stdout(output), redirect_stderr(errors):
                status = runner.main(['--rpc-config', str(Path(path)/'missing-provider.json'),
                    '--uniswap-config', str(Path(path)/'missing-uniswap.json'),
                    '--case', 'weth-input', '--output', str(target)])
            files = [file.name for file in Path(path).rglob('*') if file.is_file()]
            report = json.loads(target.read_text())
            return status, report, output.getvalue()+errors.getvalue(), files, child.call_count

    def test_success_is_explicitly_synthetic_and_exports_only_report(self):
        node, gateway = LocalNode(), Gateway()
        status, report, output, files, child_calls = self.execute(node=node, gateway=gateway)
        self.assertEqual(status, 0)
        self.assertEqual(child_calls, 1)
        self.assertEqual(files, ['report.json'])
        self.assertFalse(report['executionEligible'])
        self.assertFalse(report['productionAdmissionChanged'])
        self.assertEqual(report['mainnetTransactionsSent'], 0)
        self.assertIn('synthetic', report['testAdmissionOverride'].lower())
        self.assertIn('not Nitro', report['gasModel'])
        self.assertIn('not mainnet', report['finalityModel'])
        self.assertNotIn(CANARY, json.dumps(report)+output)
        self.assertNotIn('manifestId', json.dumps(report))
        self.assertTrue(node.closed)
        self.assertTrue(gateway.stats['closed'])
        self.assertTrue(report['upstream']['closed'])
        self.assertEqual(node.calls, [('evm_snapshot', []), ('evm_revert', ['0x1'])])

    def test_source_network_checked_independently_of_forced_child_chain_id(self):
        gateway = Gateway(chain='0x1')
        status, report, output, _, child_calls = self.execute(gateway=gateway)
        self.assertEqual(status, 2)
        self.assertEqual(child_calls, 0)
        self.assertEqual(report['status'], 'failed')
        self.assertIn(('eth_chainId', []), gateway.calls)
        self.assertTrue(gateway.stats['closed'])
        self.assertFalse(report['productionAdmissionChanged'])

    def test_source_reorganization_does_not_become_successful_qualification(self):
        gateway, node = Gateway(reorg=True), LocalNode()
        status, report, _, _, _ = self.execute(gateway=gateway, node=node)
        self.assertEqual(status, 2)
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['reason'], 'fork_source_changed')
        self.assertNotIn('sourceCanonicalAtEnd', report)
        self.assertTrue(gateway.stats['closed'])
        self.assertTrue(node.closed)

    def test_unconstrained_data_errors_and_provider_messages_are_redacted(self):
        for error in (DataError('provider '+ENDPOINT), RuntimeError('provider '+ENDPOINT)):
            with self.subTest(error=type(error).__name__):
                status, report, output, _, child_calls = self.execute(failure=error)
                self.assertEqual(status, 2)
                self.assertEqual(child_calls, 0)
                self.assertNotIn(CANARY, json.dumps(report)+output)
                self.assertNotIn(ENDPOINT, json.dumps(report)+output)
        status, report, output, _, _ = self.execute(case_failure=DataError('provider '+ENDPOINT))
        self.assertEqual(status, 2)
        self.assertNotIn(CANARY, json.dumps(report)+output)

    def test_invalid_cli_argument_does_not_echo_its_secret_value(self):
        output, errors = StringIO(), StringIO()
        with redirect_stdout(output), redirect_stderr(errors), patch.object(runner, 'load_config') as config:
            status = runner.main(['--unexpected-key', CANARY])
        self.assertEqual(status, 2)
        config.assert_not_called()
        self.assertNotIn(CANARY, output.getvalue()+errors.getvalue())

    def test_case_exception_still_restores_checkpoint_and_closes_local_resources(self):
        node, gateway = LocalNode(), Gateway()
        status, report, _, _, _ = self.execute(node=node, gateway=gateway,
            case_failure=DataError('fork_step_not_confirmed'))
        self.assertEqual(status, 2)
        self.assertTrue(node.closed)
        self.assertTrue(gateway.stats['closed'])
        self.assertIn(('evm_revert', ['0x1']), node.calls)
        self.assertFalse(report['executionEligible'])


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'opt-in isolated local Anvil parent/child oracle')
class DepositForkEvmTests(unittest.TestCase):
    def test_actual_child_transfer_never_mutates_parent_or_forwards_a_write(self):
        binary = Path(__file__).resolve().parents[2]/'node_modules/.bin/anvil'
        self.assertTrue(binary.exists(), 'Install pinned local EVM test dependencies first.')
        process, gateway = None, None
        with tempfile.TemporaryDirectory(prefix='domino-test-parent-anvil-') as path:
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            url = f'http://127.0.0.1:{port}/'
            opener = build_opener(ProxyHandler({}))
            count = [0]

            def parent(method, params=()):
                count[0] += 1
                request = Request(url, json.dumps({'jsonrpc': '2.0', 'id': count[0],
                    'method': method, 'params': list(params)}).encode(), {'Content-Type': 'application/json'})
                with opener.open(request, timeout=2) as response:
                    result = json.loads(response.read(2_000_001))
                self.assertNotIn('error', result)
                return result['result']

            try:
                process = subprocess.Popen([str(binary), '--host', '127.0.0.1', '--port', str(port),
                    '--chain-id', str(CHAIN_ID), '--accounts', '0', '--silent'],
                    cwd=path, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')})
                for _ in range(100):
                    try:
                        if parent('eth_chainId') == hex(CHAIN_ID):
                            break
                    except OSError:
                        time.sleep(.02)
                else:
                    self.fail('Local parent Anvil did not start.')
                owner = '0x'+'11'*20
                recipient = '0x'+'22'*20
                parent('anvil_setBalance', [owner, hex(10**18)])
                parent('anvil_mine', ['0x1'])
                source = parent('eth_getBlockByNumber', ['latest', False])
                original_balance = parent('eth_getBalance', [owner, 'latest'])
                reads = []

                def upstream(endpoint, request, **options):
                    self.assertEqual(endpoint, ENDPOINT)
                    self.assertIn(request['method'], METHODS)
                    reads.append(request['method'])
                    return {'jsonrpc': '2.0', 'id': request['id'],
                        'result': parent(request['method'], request['params'])}

                with ForkReadGateway(ENDPOINT, transport=upstream, total_seconds=30) as gateway:
                    with DepositFork(gateway, block=source, total_seconds=30) as fork:
                        fork.request('anvil_setBalance', [owner, hex(2*10**18)])
                        fork.request('anvil_impersonateAccount', [owner])
                        receipt = fork.send({'from': owner, 'to': recipient, 'value': '0x7',
                            'gas': '0x5208', 'gasPrice': hex(10**10), 'chainId': hex(CHAIN_ID)})
                        self.assertEqual(receipt['status'], '0x1')
                        self.assertEqual(fork.request('eth_getBalance', [recipient, 'latest']), '0x7')
                        self.assertEqual(parent('eth_getBalance', [owner, 'latest']), original_balance)
                        self.assertEqual(parent('eth_getBalance', [recipient, 'latest']), '0x0')
                        self.assertEqual(parent('eth_getTransactionCount', [owner, 'latest']), '0x0')
                        self.assertIsNone(parent('eth_getTransactionReceipt', [receipt['transactionHash']]))
                        child_path = Path(fork.temp.name)
                    self.assertIsNotNone(fork.process.poll())
                    self.assertFalse(child_path.exists())
                self.assertTrue(reads)
                self.assertTrue(set(reads) <= METHODS)
                self.assertFalse(set(reads) & LOCAL_CONTROLS)
                self.assertTrue(gateway.stats['closed'])
                self.assertNotIn(CANARY, json.dumps(gateway.stats))
            finally:
                if process is not None and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)


if __name__ == '__main__':
    unittest.main()
