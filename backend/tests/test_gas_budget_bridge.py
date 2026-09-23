"""Local IPC boundary: a request cannot bypass the peer or claim an ack."""
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gas_budget_bridge import GasBudgetClient, _dispatch, serve_one
from gas_usd_budget import GasBudgetError


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

    def require_reservation(self, *args):
        self.calls.append(('require_reservation', args))

    def attest_settlement_quote(self, *args):
        self.calls.append(('attest_settlement_quote', args))
        return ATTESTED


class BridgeTests(unittest.TestCase):
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
                with patch('gas_budget_bridge._peer_uid', return_value=os.getuid()):
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
        with patch('gas_budget_bridge._peer_uid', return_value=os.getuid()):
            with patch('gas_budget_bridge.os.stat') as stat_call, patch('gas_budget_bridge.socket.socket') as socket_call:
                import stat
                stat_call.return_value.st_mode = stat.S_IFSOCK | 0o660
                stat_call.return_value.st_uid = os.getuid()
                conn = socket_call.return_value.__enter__.return_value
                conn.recv.return_value = b'{"ok":false}\n'
                client = GasBudgetClient('/run/unused.sock', server_uid=os.getuid())
                with self.assertRaisesRegex(GasBudgetError, 'gas_budget_protocol'):
                    client.require_reservation(PUBLICATION, 'publisher', PUBLISHER, 1)


if __name__ == '__main__':
    unittest.main()
