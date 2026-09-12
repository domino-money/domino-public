"""Read-only local APR previews; no listener, wallet access or financial action.

Pool mode accepts an existing pool-market response or reads one pool on demand.
Managed mode accepts already reconciled, valued evidence; it is not a collector.
Input files and output may identify a wallet and must remain private unless they
are explicitly synthetic/public examples. No credential is accepted as an argument.
"""
import argparse
import json
from pathlib import Path
import sys
import time

from discovery import bytes32
from local_config import CONFIG_PATH, configured_rpc_urls, load_config
from managed_performance import calculate_performance
from pool_apr import estimate_pool_apr
from read_deadline import read_deadline
from read_service import ReadService

MAX_INPUT_BYTES = 1_048_576


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError('invalid_arguments')


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_json_key')
        result[key] = value
    return result


def _reject_number(value):
    raise ValueError('non_integer_json_number')


def read_evidence(path):
    with Path(path).open('rb') as stream:
        raw = stream.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError('evidence_too_large')
    result = json.loads(raw, object_pairs_hook=_object, parse_float=_reject_number,
                        parse_constant=_reject_number)
    if not isinstance(result, dict):
        raise ValueError('invalid_evidence')
    return result


def _parser():
    parser = _Parser(description=__doc__, allow_abbrev=False)
    parser.add_argument('kind', choices=('pool', 'managed'))
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--input', type=Path, help='Existing JSON evidence, never credentials')
    inputs.add_argument('--pool-id', help='Read one public Robinhood v4 pool with local providers')
    parser.add_argument('--config-file', type=Path, default=CONFIG_PATH,
                        help='Private local provider configuration (live pool mode only)')
    parser.add_argument('--now', type=int,
                        help='Evaluation timestamp for offline reproduction only')
    return parser


def main(argv=None):
    try:
        args = _parser().parse_args(argv)
        if args.pool_id:
            if args.kind != 'pool' or args.now is not None:
                raise ValueError('invalid_live_mode')
            pool_id = bytes32(args.pool_id)
            config = load_config(args.config_file)
            service = ReadService(rpc_urls=configured_rpc_urls(config))
            with read_deadline(30):
                evidence = service.pool_market(pool_id, include_price_history=False)
        else:
            evidence = read_evidence(args.input)
        now = int(time.time()) if args.now is None else args.now
        if type(now) is not int or not 0 <= now <= 2**53 - 1:
            raise ValueError('invalid_clock')
        calculate = estimate_pool_apr if args.kind == 'pool' else calculate_performance
        output = calculate(evidence, now=now)
        print(json.dumps(output, indent=2, sort_keys=True, allow_nan=False))
        return 0
    except Exception:
        # Do not echo malformed arguments, input values, paths or provider errors.
        print(json.dumps({'status': 'unavailable', 'reason': 'metrics_preview_failed'}),
              file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
