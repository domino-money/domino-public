"""Keyless, bounded receipt settlement under the isolated settlement OS peer.

This command never loads the automation signers' config or keys. The service
and timer that invoke it are installed disabled; each run scans at most 32
claims and leaves unresolved claims reserved against the daily cap.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import sys

from bridge_state import strict_json
from execution_signer import ExecutionRpc
from execution_status_runtime import private_file
from gas_receipt_settlement import GasSettlementError, GasSettlementService


class _ReadOnlyRpc:
    def __init__(self, endpoint):
        self.rpc = ExecutionRpc(endpoint)

    def request(self, method, params):
        if method not in ('eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
                          'eth_getTransactionReceipt', 'eth_getTransactionByHash'):
            raise GasSettlementError('gas_receipt_rpc_unavailable')
        return self.rpc.request(method, params)


def service(config):
    if (type(config) is not dict or set(config) != {'schemaVersion', 'kind', 'database', 'rpcEndpoint'}
            or type(config['schemaVersion']) is not int or config['schemaVersion'] != 1
            or config['kind'] != 'domino-gas-settlement'
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
        raise GasSettlementError('gas_settlement_configuration')
    return GasSettlementService(config['database'], _ReadOnlyRpc(config['rpcEndpoint']))


def main(argv=None):
    parser = argparse.ArgumentParser(description='Isolated keyless gas settlement pass')
    parser.add_argument('--config', required=True)
    parser.add_argument('--limit', type=int, default=8)
    args = parser.parse_args(argv)
    try:
        if (os.geteuid() != pwd.getpwnam('domino-gas-settlement').pw_uid
                or not 1 <= args.limit <= 32):
            raise GasSettlementError('gas_settlement_configuration')
        config = strict_json(private_file(args.config, 8192))
        result = service(config).sweep(limit=args.limit)
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
        return 0 if result['attention'] == 0 else 1
    except Exception:
        print('{"error":"gas_settlement_unavailable"}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
