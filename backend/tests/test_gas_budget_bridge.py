"""Local IPC boundary: a request cannot bypass the peer or claim an ack."""
import json
import os
from pathlib import Path
import socket
import stat
import struct
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gas_budget_bridge import GasBudgetClient, _dispatch, serve_one
from gas_usd_budget import GasBudgetError, GasBudgetService, GasUsdBudget, EthUsdReader


PUBLISHER = '0x' + '11' * 20
OPERATOR = '0x' + '22' * 20
PUBLICATION = '0x' + '33' * 32
INTENT = '0x' + '44' * 32
RESERVED = {'day': '2026-09-22', 'reservedUsdMicros': 1000000, 'state': 'reserved'}
ATTESTED = {'answerRaw': 4000 * 10**8, 'roundId': (1 << 64) + 17,
            'answerUpdatedAt': 100, 'blockNumber': 200,
            'blockHash': '0x' + '55' * 32, 'blockTimestamp': 200}


class FakeService:
    def __init__(self):
        self.calls = []

    def reserve_pair(self, *args):
        self.calls.append(('reserve_pair', args))
        return {'publisher': RESERVED, 'operator': RESERVED}

    def health(self):
        self.calls.append(('health', ()))
        return True

    def require_reservation(self, *args):
        self.calls.append(('require_reservation', args))

    def attest_settlement_quote(self, *args):
        self.calls.append(('attest_settlement_quote', args))
        return ATTESTED


class BridgeTests(unittest.TestCase):
    def test_health_requires_a_responding_peer_and_validates_its_boolean_ack(self):
        service = FakeService()
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'budget.sock')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(path)
                os.chmod(path, 0o660)
                client = GasBudgetClient(path, server_uid=os.getuid())
                with self.assertRaisesRegex(GasBudgetError, 'gas_budget_unavailable'):
                    client.health()  # The inode exists, but nothing listens.
                listener.listen(1)
                def handle():
                    conn, _ = listener.accept()
                    with conn:
                        serve_one(conn, service, {os.getuid(): {'health'}})
                thread = threading.Thread(target=handle)
                thread.start()
                with patch('gas_budget_bridge._peer_credentials',
                           return_value=(os.getpid(), os.getuid(), os.getgid())):
                    self.assertTrue(client.health())
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(service.calls, [('health', ())])
        self.assertFalse(_dispatch(type('Spent', (), {'health': lambda self: False})(),
                                   {'operation': 'health', 'args': []}, {'health'}))
        with self.assertRaisesRegex(GasBudgetError, 'gas_budget_unavailable'):
            _dispatch(service, {'operation': 'health', 'args': []}, {'attest_settlement_quote'})
        with patch('gas_budget_bridge._peer_credentials',
                   return_value=(os.getpid(), os.getuid(), os.getgid())):
            with patch('gas_budget_bridge.os.stat') as stat_call, patch('gas_budget_bridge.socket.socket') as socket_call:
                stat_call.return_value.st_mode = stat.S_IFSOCK | 0o660
                stat_call.return_value.st_uid = os.getuid()
                socket_call.return_value.__enter__.return_value.recv.return_value = b'{"ok":1}\n'
                with self.assertRaisesRegex(GasBudgetError, 'gas_budget_protocol'):
                    client.health()

    def test_health_checks_budget_and_quote_without_reserving(self):
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *_): return False
        service = GasBudgetService({'host': '/tmp/test', 'port': 5432, 'dbname': 'domino_catalogue'},
                                   object(), connect=lambda **kwargs: Connection())
        with patch.object(GasUsdBudget, 'status', return_value={'remainingUsdMicros': 10}) as status, \
             patch.object(EthUsdReader, 'quote', return_value=object()) as quote:
            self.assertTrue(service.health())
            self.assertEqual(status.call_count, 1)
            self.assertEqual(quote.call_count, 2)
        with patch.object(GasUsdBudget, 'status', return_value={'remainingUsdMicros': 10}), \
             patch.object(EthUsdReader, 'quote', side_effect=[object(), GasBudgetError('gas_quote_block_stale')]):
            with self.assertRaisesRegex(GasBudgetError, 'gas_quote_block_stale'):
                service.health()
        with patch.object(GasUsdBudget, 'status', return_value={'remainingUsdMicros': 0}), \
             patch.object(EthUsdReader, 'quote') as quote:
            self.assertFalse(service.health())
            quote.assert_not_called()

    def test_client_reaches_only_the_allowed_local_peer_and_validates_ack(self):
        service = FakeService()
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'budget.sock')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(path)
                os.chmod(path, 0o660)
                listener.listen(1)

                def handle():
                    conn, _ = listener.accept()
                    with conn:
                        serve_one(conn, service, {os.getuid(): {'reserve_pair'}})

                thread = threading.Thread(target=handle)
                thread.start()
                with patch('gas_budget_bridge._peer_credentials',
                           return_value=(os.getpid(), os.getuid(), os.getgid())):
                    client = GasBudgetClient(path, server_uid=os.getuid())
                    result = client.reserve_pair(PUBLICATION, PUBLISHER, 1,
                                                 INTENT, OPERATOR, 2)
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(result, {'publisher': RESERVED, 'operator': RESERVED})
                self.assertEqual(service.calls[0][0], 'reserve_pair')

                # A socket with unexpected file permissions is refused before
                # signing, even when its peer UID would otherwise match.
                os.chmod(path, 0o666)
                with self.assertRaisesRegex(GasBudgetError, 'gas_budget_unavailable'):
                    client.require_reservation(PUBLICATION, 'publisher', PUBLISHER, 1)

    def test_server_refuses_unknown_method_and_unauthorized_uid(self):
        service = FakeService()
        with self.assertRaisesRegex(GasBudgetError, 'gas_budget_protocol'):
            _dispatch(service, {'operation': '__getattribute__', 'args': []})
        first, second = socket.socketpair()
        try:
            with patch('gas_budget_bridge._peer_uid', return_value=999999):
                thread = threading.Thread(target=serve_one, args=(first, service, {os.getuid(): {'reserve_pair'}}))
                thread.start()
                second.sendall(json.dumps({'operation': 'reserve_pair', 'args': []}).encode() + b'\n')
                response = second.recv(256)
                thread.join(timeout=3)
            self.assertEqual(json.loads(response), {'error': 'gas_budget_unavailable'})
            self.assertEqual(service.calls, [])
        finally:
            first.close()
            second.close()

    def test_settlement_peer_can_only_attest_and_cannot_reserve(self):
        service = FakeService()
        settlement_uid = os.getuid() + 1
        first, second = socket.socketpair()
        try:
            with patch('gas_budget_bridge._peer_uid', return_value=settlement_uid):
                thread = threading.Thread(target=serve_one, args=(first, service,
                    {settlement_uid: {'attest_settlement_quote'}}))
                thread.start()
                second.sendall(json.dumps({'operation': 'reserve_pair',
                    'args': [PUBLICATION, PUBLISHER, 1, INTENT, OPERATOR, 2]}).encode() + b'\n')
                response = second.recv(256)
                thread.join(timeout=3)
            self.assertEqual(json.loads(response), {'error': 'gas_budget_unavailable'})
            self.assertEqual(service.calls, [])
        finally:
            first.close()
            second.close()
        self.assertEqual(_dispatch(service, {'operation': 'attest_settlement_quote',
            'args': [PUBLICATION, 'publisher']}, {'attest_settlement_quote'}), ATTESTED)

    def test_client_refuses_a_false_authorization_ack(self):
        with patch('gas_budget_bridge._peer_credentials',
                   return_value=(os.getpid(), os.getuid(), os.getgid())):
            with patch('gas_budget_bridge.os.stat') as stat_call, patch('gas_budget_bridge.socket.socket') as socket_call:
                stat_call.return_value.st_mode = stat.S_IFSOCK | 0o660
                stat_call.return_value.st_uid = os.getuid()
                conn = socket_call.return_value.__enter__.return_value
                conn.recv.return_value = b'{"ok":false}\n'
                client = GasBudgetClient('/run/unused.sock', server_uid=os.getuid())
                with self.assertRaisesRegex(GasBudgetError, 'gas_budget_protocol'):
                    client.require_reservation(PUBLICATION, 'publisher', PUBLISHER, 1)

    def test_systemd_listener_identity_requires_pid1_root_and_strict_socket_metadata(self):
        # systemd creates/listens on the socket as PID 1 before handing the FD
        # to the nonroot service. SO_PEERCRED therefore reports (1, 0, 0) on
        # the client side, while the pathname remains owned by the service.
        server_uid = 12345
        client = GasBudgetClient('/run/domino-gas-reservation.sock', server_uid=server_uid)
        cases = (
            ((1, 0, 0), server_uid, 0o660, True),
            ((4321, server_uid, 12345), server_uid, 0o660, True),
            ((4321, 0, 0), server_uid, 0o660, False),
            ((1, 0, 12345), server_uid, 0o660, False),
            ((1, 12346, 0), server_uid, 0o660, False),
            ((1, 0, 0), 12346, 0o660, False),
            ((1, 0, 0), server_uid, 0o666, False),
        )
        with patch('gas_budget_bridge.os.stat') as stat_call, \
                patch('gas_budget_bridge.socket.socket') as socket_call, \
                patch.object(socket, 'SO_PEERCRED', 17, create=True):
            conn = socket_call.return_value.__enter__.return_value
            conn.recv.return_value = b'{"ok":null}\n'
            for peer, owner, mode, allowed in cases:
                with self.subTest(peer=peer, owner=owner, mode=mode):
                    stat_call.return_value.st_mode = stat.S_IFSOCK | mode
                    stat_call.return_value.st_uid = owner
                    conn.getsockopt.return_value = struct.pack('3i', *peer)
                    conn.sendall.reset_mock()
                    if allowed:
                        self.assertIsNone(client.require_reservation(PUBLICATION, 'publisher', PUBLISHER, 1))
                    else:
                        with self.assertRaisesRegex(GasBudgetError, 'gas_budget_unavailable'):
                            client.require_reservation(PUBLICATION, 'publisher', PUBLISHER, 1)
                    self.assertEqual(conn.sendall.called, allowed)
            stat_call.return_value.st_mode = stat.S_IFSOCK | 0o660
            stat_call.return_value.st_uid = server_uid
            conn.getsockopt.return_value = struct.pack('3i', 1, 0, 0)
            conn.sendall.reset_mock()
            alternate = GasBudgetClient('/run/other.sock', server_uid=server_uid)
            with self.assertRaisesRegex(GasBudgetError, 'gas_budget_unavailable'):
                alternate.require_reservation(PUBLICATION, 'publisher', PUBLISHER, 1)
            conn.sendall.assert_not_called()

    def test_server_still_refuses_root_as_a_client(self):
        service = FakeService()
        first, second = socket.socketpair()
        try:
            with patch('gas_budget_bridge._peer_uid', return_value=0):
                thread = threading.Thread(target=serve_one, args=(first, service, {12345: {'reserve_pair'}}))
                thread.start()
                second.sendall(json.dumps({'operation': 'reserve_pair',
                    'args': [PUBLICATION, PUBLISHER, 1, INTENT, OPERATOR, 2]}).encode() + b'\n')
                response = second.recv(256)
                thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(json.loads(response), {'error': 'gas_budget_unavailable'})
            self.assertEqual(service.calls, [])
        finally:
            first.close()
            second.close()


if __name__ == '__main__':
    unittest.main()
