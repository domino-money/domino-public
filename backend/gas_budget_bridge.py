"""Fixed local IPC boundary for the publisher/operator gas reservation cap.

Only the reservation peer process opens the budget database role. Signers ask
it for bounded reservation operations over an OS-owned Unix socket. The
settlement peer may request only a fresh quote attestation by claim ID. The socket
is installed OFF; its systemd socket and service must be started explicitly.
The peer process has neither signing keys nor the settlement database role.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import struct
import sys

from bridge_state import strict_json
from execution_signer import ExecutionRpc
from execution_status_runtime import private_file
from gas_usd_budget import GasBudgetError, GasBudgetService
from read_deadline import read_timeout


SOCKET_PATH = '/run/domino-gas-reservation.sock'
SERVER_USER = 'domino-gas-reservation'
SIGNING_CLIENT_USERS = ('domino-automation', 'domino-execution-signer')
SETTLEMENT_CLIENT_USER = 'domino-gas-settlement'
MAX_MESSAGE = 4096
OPERATIONS = {
    'health': 0,
    'reserve_pair': 6,
    'reserve_one': 4,
    'require_reservation': 4,
    'require_existing_reservation': 4,
    'attest_settlement_quote': 2,
}
SIGNING_OPERATIONS = frozenset(OPERATIONS) - {'attest_settlement_quote'}
SETTLEMENT_OPERATIONS = frozenset({'attest_settlement_quote'})


def _uid(user):
    try:
        return pwd.getpwnam(user).pw_uid
    except KeyError:
        raise GasBudgetError('gas_budget_unavailable') from None


def _peer_credentials(conn):
    # Linux SO_PEERCRED is mandatory here. Refuse other platforms rather than
    # accidentally accepting an unauthenticated local socket peer.
    if not hasattr(socket, 'SO_PEERCRED'):
        raise GasBudgetError('gas_budget_unavailable')
    raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    if len(raw) != 12:
        raise GasBudgetError('gas_budget_unavailable')
    return struct.unpack('3i', raw)


def _peer_uid(conn):
    return _peer_credentials(conn)[1]


def _read_message(conn):
    data = bytearray()
    while len(data) <= MAX_MESSAGE:
        part = conn.recv(min(1024, MAX_MESSAGE + 1 - len(data)))
        if not part:
            break
        data.extend(part)
        if b'\n' in part:
            if not data.endswith(b'\n') or data.count(b'\n') != 1:
                raise GasBudgetError('gas_budget_protocol')
            return strict_json(bytes(data[:-1]))
    raise GasBudgetError('gas_budget_protocol')


def _write_message(conn, payload):
    raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode() + b'\n'
    if len(raw) > MAX_MESSAGE:
        raise GasBudgetError('gas_budget_protocol')
    conn.sendall(raw)


def _dispatch(service, request, allowed_operations=None):
    if (type(request) is not dict or set(request) != {'operation', 'args'}
            or request['operation'] not in OPERATIONS
            or type(request['args']) is not list
            or len(request['args']) != OPERATIONS[request['operation']]):
        raise GasBudgetError('gas_budget_protocol')
    if allowed_operations is not None and request['operation'] not in allowed_operations:
        raise GasBudgetError('gas_budget_unavailable')
    return getattr(service, request['operation'])(*request['args'])


def _valid_reservation(value):
    return (type(value) is dict and set(value) == {'day', 'reservedUsdMicros', 'state'}
            and type(value['day']) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value['day'])
            and type(value['reservedUsdMicros']) is int
            and 0 < value['reservedUsdMicros'] <= 20_000_000
            and value['state'] in ('reserved', 'settled'))


def _valid_attestation(value):
    return (type(value) is dict and set(value) == {'answerRaw', 'roundId',
            'answerUpdatedAt', 'blockNumber', 'blockHash', 'blockTimestamp'}
            and all(type(value[key]) is int and value[key] > 0 for key in
                    ('answerRaw', 'roundId', 'answerUpdatedAt', 'blockNumber', 'blockTimestamp'))
            and type(value['blockHash']) is str
            and re.fullmatch(r'0x[0-9a-f]{64}', value['blockHash']) is not None)


class GasBudgetClient:
    """No database settings or RPC endpoint enter the signing process here."""

    def __init__(self, path=SOCKET_PATH, *, server_uid=None):
        if type(path) is not str or not path.startswith('/') or '..' in Path(path).parts:
            raise GasBudgetError('gas_budget_configuration')
        self.path = path
        self.server_uid = server_uid

    def _request(self, operation, args, *, timeout=30):
        if operation not in OPERATIONS or len(args) != OPERATIONS[operation]:
            raise GasBudgetError('gas_budget_protocol')
        if type(timeout) not in (int, float) or not 0 < timeout <= 30:
            raise GasBudgetError('gas_budget_protocol')
        server_uid = _uid(SERVER_USER) if self.server_uid is None else self.server_uid
        try:
            info = os.stat(self.path, follow_symlinks=False)
            if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != server_uid
                    or stat.S_IMODE(info.st_mode) != 0o660):
                raise GasBudgetError('gas_budget_unavailable')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
                conn.settimeout(read_timeout(timeout))
                conn.connect(self.path)
                peer = _peer_credentials(conn)
                # With systemd socket activation PID 1 calls listen(), so Linux
                # SO_PEERCRED reports PID 1's credentials even after the socket
                # is passed to the unprivileged reservation service. The
                # pathname socket must still belong to that service with the
                # exact installed mode, checked above.
                if peer[1] != server_uid and not (self.path == SOCKET_PATH and peer == (1, 0, 0)):
                    raise GasBudgetError('gas_budget_unavailable')
                _write_message(conn, {'operation': operation, 'args': list(args)})
                result = _read_message(conn)
            if type(result) is not dict or len(result) != 1:
                raise GasBudgetError('gas_budget_protocol')
            if set(result) == {'error'} and type(result['error']) is str and re.fullmatch(r'gas_[a-z0-9_]{1,64}', result['error']):
                raise GasBudgetError(result['error'])
            if set(result) != {'ok'}:
                raise GasBudgetError('gas_budget_protocol')
            value = result['ok']
            if (operation.startswith('require_') and value is not None
                    or operation == 'health' and type(value) is not bool
                    or operation == 'reserve_one' and not _valid_reservation(value)
                    or operation == 'reserve_pair' and
                    (type(value) is not dict or set(value) != {'publisher', 'operator'}
                     or not all(_valid_reservation(value[leg]) for leg in ('publisher', 'operator')))
                    or operation == 'attest_settlement_quote' and not _valid_attestation(value)):
                raise GasBudgetError('gas_budget_protocol')
            return value
        except GasBudgetError:
            raise
        except (OSError, ValueError, TypeError, KeyError):
            raise GasBudgetError('gas_budget_unavailable') from None

    def health(self):
        """Read-only peer/DB/quote check, with no claim or signer authority."""
        return self._request('health', (), timeout=8)

    def reserve_pair(self, publication_id, publisher, publisher_max_wei,
                     intent_id, operator, operator_max_wei):
        return self._request('reserve_pair', (publication_id, publisher, publisher_max_wei,
                                              intent_id, operator, operator_max_wei))

    def reserve_one(self, cycle_id, leg, signer, maximum_wei):
        return self._request('reserve_one', (cycle_id, leg, signer, maximum_wei))

    def require_reservation(self, cycle_id, leg, signer, required_wei):
        return self._request('require_reservation', (cycle_id, leg, signer, required_wei))

    def require_existing_reservation(self, cycle_id, leg, signer, required_wei):
        return self._request('require_existing_reservation', (cycle_id, leg, signer, required_wei))

    def attest_settlement_quote(self, cycle_id, leg):
        return self._request('attest_settlement_quote', (cycle_id, leg))


class _QuoteRpc:
    """The reservation peer cannot use its RPC adapter to send transactions."""
    def __init__(self, endpoint):
        self.rpc = ExecutionRpc(endpoint)

    def request(self, method, params):
        if method not in ('eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'):
            raise GasBudgetError('gas_quote_rpc_unavailable')
        return self.rpc.request(method, params)


def _service(config):
    if (type(config) is not dict or set(config) != {'schemaVersion', 'kind', 'database', 'rpcEndpoint'}
            or type(config['schemaVersion']) is not int or config['schemaVersion'] != 1
            or config['kind'] != 'domino-gas-reservation'
            or type(config['database']) is not dict
            or set(config['database']) != {'host', 'port', 'dbname'}
            or type(config['database']['host']) is not str
            or not re.fullmatch(r'/[A-Za-z0-9_/.-]{1,200}', config['database']['host'])
            or '..' in Path(config['database']['host']).parts
            or type(config['database']['port']) is not int
            or not 1024 <= config['database']['port'] <= 65535
            or config['database']['dbname'] != 'domino_catalogue'
            or type(config['rpcEndpoint']) is not str
            or not 1 <= len(config['rpcEndpoint']) <= 2048):
        raise GasBudgetError('gas_budget_configuration')
    return GasBudgetService(config['database'], _QuoteRpc(config['rpcEndpoint']))


def serve_one(conn, service, allowed_clients):
    """Handle one request; errors are sanitized and never disclose RPC/config."""
    conn.settimeout(30)
    try:
        operations = allowed_clients.get(_peer_uid(conn))
        if operations is None:
            raise GasBudgetError('gas_budget_unavailable')
        result = _dispatch(service, _read_message(conn), operations)
        _write_message(conn, {'ok': result})
    except GasBudgetError as error:
        try:
            _write_message(conn, {'error': error.code})
        except OSError:
            pass
    except Exception:
        try:
            _write_message(conn, {'error': 'gas_budget_unavailable'})
        except OSError:
            pass


def serve(config):
    if (os.geteuid() != _uid(SERVER_USER) or os.environ.get('LISTEN_PID') != str(os.getpid())
            or os.environ.get('LISTEN_FDS') != '1'):
        raise GasBudgetError('gas_budget_unavailable')
    allowed_clients = {_uid(name): SIGNING_OPERATIONS for name in SIGNING_CLIENT_USERS}
    allowed_clients[_uid(SETTLEMENT_CLIENT_USER)] = SETTLEMENT_OPERATIONS
    service = _service(config)
    with socket.socket(fileno=3) as listener:
        if listener.family != socket.AF_UNIX or listener.type != socket.SOCK_STREAM:
            raise GasBudgetError('gas_budget_unavailable')
        while True:
            conn, _ = listener.accept()
            with conn:
                serve_one(conn, service, allowed_clients)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Private gas reservation peer')
    parser.add_argument('--config', required=True)
    parser.add_argument('operation', choices=('serve',))
    args = parser.parse_args(argv)
    try:
        config = strict_json(private_file(args.config, 8192))
        serve(config)
    except Exception:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
