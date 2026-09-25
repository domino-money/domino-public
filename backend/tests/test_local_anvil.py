"""local_anvil: the pinned Anvil runs as a child that leaves no state or process behind."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import local_anvil

OWNER = """import sys, time
sys.path.insert(0, sys.argv[1])
import local_anvil
process = local_anvil.start(['--host', '127.0.0.1', '--port', sys.argv[2], '--silent'])
print(process.pid, flush=True)
time.sleep(600)
"""


class HelperTests(unittest.TestCase):
    def test_the_npm_platform_package_binary_is_selected(self):
        root = Path('/checkout')
        for system, machine, package in (('Darwin', 'arm64', 'anvil-darwin-arm64'),
                ('Darwin', 'x86_64', 'anvil-darwin-amd64'), ('Linux', 'x86_64', 'anvil-linux-amd64'),
                ('Linux', 'aarch64', 'anvil-linux-arm64')):
            with self.subTest(system=system, machine=machine), \
                    patch('local_anvil.platform.system', return_value=system), \
                    patch('local_anvil.platform.machine', return_value=machine):
                self.assertEqual(local_anvil.binary(root),
                                 root/'node_modules/@foundry-rs'/package/'bin/anvil')
        with patch('local_anvil.platform.system', return_value='Windows'), self.assertRaises(OSError):
            local_anvil.binary(root)

    def test_the_binary_runs_under_the_supervisor_with_memory_only_history(self):
        with tempfile.TemporaryDirectory(prefix='domino-test-anvil-root-') as root:
            path = local_anvil.binary(root)
            path.parent.mkdir(parents=True)
            path.touch()
            with patch('local_anvil.subprocess.Popen') as spawn:
                local_anvil.start(['--port', '1'], root=root, cwd=root, env={'PATH': '/bin'})
        args, options = spawn.call_args
        self.assertEqual(args[0], [sys.executable, '-I', local_anvil.__file__, str(path),
                                   '--port', '1', '--max-persisted-states', '0'])
        self.assertEqual(options, {'stdin': subprocess.PIPE, 'start_new_session': True, 'cwd': root,
                                   'env': {'PATH': '/bin'}, 'stdout': subprocess.DEVNULL,
                                   'stderr': subprocess.DEVNULL})

    def test_a_missing_binary_fails_before_any_process_starts(self):
        with tempfile.TemporaryDirectory(prefix='domino-test-anvil-root-') as root, \
                patch('local_anvil.subprocess.Popen') as spawn:
            with self.assertRaises(FileNotFoundError):
                local_anvil.start([], root=root)
        spawn.assert_not_called()

    def test_stop_closes_the_pipe_and_waits(self):
        process = Mock()
        process.wait.return_value = 0
        with patch('local_anvil.os.killpg') as killpg:
            local_anvil.stop(process)
        process.stdin.close.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=2*local_anvil.GRACE)
        killpg.assert_not_called()

    def test_a_stuck_supervisor_is_killed_with_its_anvil_and_reaped(self):
        process = Mock(pid=4242)
        process.wait.side_effect = [subprocess.TimeoutExpired('anvil', 10), -9]
        with patch('local_anvil.os.killpg') as killpg:
            local_anvil.stop(process)
        killpg.assert_called_once_with(4242, signal.SIGKILL)
        self.assertEqual(process.wait.call_count, 2)


class SupervisorTests(unittest.TestCase):
    def test_a_child_that_ignores_sigterm_is_killed_after_the_grace_period(self):
        stubborn = 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print(flush=True); time.sleep(60)'
        supervisor = subprocess.Popen([sys.executable, '-I', local_anvil.__file__, sys.executable, '-c', stubborn],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)

        def reap():
            if supervisor.poll() is None:
                os.killpg(supervisor.pid, signal.SIGKILL)
            supervisor.wait()
            supervisor.stdout.close()
        self.addCleanup(reap)
        supervisor.stdout.readline()
        started = time.monotonic()
        supervisor.stdin.close()
        self.assertEqual(supervisor.wait(timeout=3*local_anvil.GRACE), 256 - signal.SIGKILL)
        self.assertGreaterEqual(time.monotonic() - started, local_anvil.GRACE)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires the pinned local Anvil')
class LocalAnvilEvmTests(unittest.TestCase):
    def setUp(self):
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory(prefix='domino-test-anvil-home-')))
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]

    def rpc(self, method, params=()):
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}', json.dumps({'jsonrpc': '2.0',
            'id': 1, 'method': method, 'params': list(params)}).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
        if 'error' in result:
            raise AssertionError(result['error'])
        return result['result']

    def start(self):
        process = local_anvil.start(['--host', '127.0.0.1', '--port', str(self.port), '--silent'],
                                    env={**os.environ, 'HOME': str(self.home)})
        self.addCleanup(local_anvil.stop, process)
        return process, self.anvil_of(process.pid)

    def anvil_of(self, supervisor):
        for _ in range(200):
            try:
                self.rpc('eth_chainId')
                break
            except OSError:
                time.sleep(.05)
        children = subprocess.run(['pgrep', '-P', str(supervisor)], capture_output=True, text=True).stdout.split()
        self.assertEqual(len(children), 1)
        return int(children[0])

    def assertExits(self, pid, seconds=10):
        deadline = time.monotonic() + seconds
        while True:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            if time.monotonic() >= deadline:
                self.fail(f'process {pid} still runs')
            time.sleep(.05)

    def test_states_pushed_out_of_memory_never_reach_disk_and_recent_history_stays_readable(self):
        process, anvil = self.start()
        account = self.rpc('eth_accounts')[0]
        # Past the 500-state window, where Anvil's default spills states to disk.
        self.rpc('anvil_mine', [hex(1200)])
        self.assertEqual(self.rpc('eth_getBalance', [account, hex(1200 - 64)]),
                         self.rpc('eth_getBalance', [account, 'latest']))
        local_anvil.stop(process)
        self.assertExits(anvil, seconds=0)
        self.assertEqual(process.returncode, 0)  # Anvil's own exit on SIGTERM, not a kill
        states = self.home/'.foundry/anvil/tmp'
        self.assertEqual(list(states.iterdir()) if states.exists() else [], [])

    def test_anvil_exits_when_its_owner_is_killed(self):
        owner = subprocess.Popen([sys.executable, '-c', OWNER, str(Path(local_anvil.__file__).parent),
                                  str(self.port)], stdout=subprocess.PIPE, text=True,
                                 env={**os.environ, 'HOME': str(self.home)})
        with owner:
            try:
                supervisor = int(owner.stdout.readline())
                anvil = self.anvil_of(supervisor)
            finally:
                owner.kill()
        self.assertExits(anvil)
        self.assertExits(supervisor)

    def test_a_stop_signal_to_the_supervisor_alone_stops_anvil(self):
        for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=number.name):
                process, anvil = self.start()
                os.kill(process.pid, number)
                process.wait(timeout=10)
                self.assertExits(anvil)

    def test_the_supervisor_exits_when_anvil_does(self):
        # DepositFork reads the supervisor's poll() as the node's liveness.
        process, anvil = self.start()
        os.kill(anvil, signal.SIGKILL)
        process.wait(timeout=5)
        self.assertIsNotNone(process.returncode)


if __name__ == '__main__':
    unittest.main()
