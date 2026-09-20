"""Explicit bounded Chainlink slices; resume the same historical snapshot only."""
import argparse
import json
from pathlib import Path

from catalogue import configured_catalogue
from chainlink_checkpoint import Checkpoint
from chainlink_collection import (BudgetRpc, DEFAULT_SLICE_SECONDS, INVOCATION_RPC_REQUESTS,
    INVOCATION_SECONDS, MAX_STEPS, STORAGE_RPC_REQUESTS, advance_collection, begin_collection,
    integer, store_collection, validate_collection)
from discovery import DataError, address
from local_config import load_config
from rpc_failover import HistoricalReadRpc as ReadRpc
from rpc_config import configured_history_rpc_source
from read_service import bounded_transport

RUNTIME = Path(__file__).resolve().parent/'runtime'


def collect(args, *, rpc=None, clock=None):
    currency = address(args.currency)
    integer(args.max_steps, 1, MAX_STEPS)
    integer(args.slice_seconds, 1, DEFAULT_SLICE_SECONDS)
    # CLI checkpoints must stay in this checkout's ignored runtime directory.
    if not args.checkpoint.resolve().is_relative_to(RUNTIME.resolve()):
        raise DataError('ignored_chainlink_checkpoint_path_required')
    checkpoint = Checkpoint(args.checkpoint)
    with checkpoint.lock():
        collection = checkpoint.load()
        if collection is not None:
            if (collection['currency'] != currency or collection['startTimestamp'] != args.start or
                    collection['endTimestamp'] != args.end or
                    (args.block_number is not None and collection['snapshot']['number'] != args.block_number)):
                raise DataError('chainlink_collection_identity_mismatch')
        request_budget = INVOCATION_RPC_REQUESTS + (STORAGE_RPC_REQUESTS if args.store_observations else 0)
        if rpc is None:
            config = load_config(args.provider_config) if args.provider_config is not None else load_config()
            if args.provider_config is not None and not config:
                raise DataError('configured_rpc_required')
            rpc = ReadRpc(configured_history_rpc_source(config), transport=bounded_transport(INVOCATION_SECONDS),
                          max_requests=request_budget)
        rpc = BudgetRpc(rpc, max_requests=request_budget, seconds=INVOCATION_SECONDS)
        if collection is None:
            collection = begin_collection(currency, args.start, args.end, rpc, block_number=args.block_number)
            checkpoint.save(collection)
        steps = 0
        for _ in range(args.max_steps):
            next_start, _ = validate_collection(collection)
            if next_start == collection['endTimestamp']:
                break
            kwargs = {'clock': clock} if clock is not None else {}
            collection = advance_collection(collection, rpc, slice_seconds=args.slice_seconds, **kwargs)
            checkpoint.save(collection)
            steps += 1
        next_start, rows = validate_collection(collection)
        complete = next_start == collection['endTimestamp']
        saved = False
        if args.store_observations and complete:
            catalogue = configured_catalogue()
            if catalogue is None:
                raise DataError('catalogue_not_configured')
            store_collection(catalogue, collection, rpc)
            saved = True
        return {'status': 'observed_unqualified' if complete else 'collection_incomplete',
                'collectionId': collection['collectionId'], 'snapshot': collection['snapshot'],
                'nextStartTimestamp': next_start, 'endTimestamp': collection['endTimestamp'],
                'stepsCompleted': steps, 'sliceCount': len(collection['slices']), 'observations': len(rows),
                'rpcRequests': rpc.count, 'observationsSaved': saved, 'productionQualified': False,
                'referenceCoverageAssessed': False, 'executionAvailable': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--currency', required=True)
    parser.add_argument('--start', required=True, type=int)
    parser.add_argument('--end', required=True, type=int)
    parser.add_argument('--block-number', type=int)
    parser.add_argument('--max-steps', type=int, default=1)
    parser.add_argument('--slice-seconds', type=int, default=DEFAULT_SLICE_SECONDS)
    parser.add_argument('--checkpoint', required=True, type=Path)
    parser.add_argument('--provider-config', type=Path)
    parser.add_argument('--store-observations', action='store_true')
    args = parser.parse_args(argv)
    try:
        result = collect(args)
        print(json.dumps(result))
        return 0 if result['status'] == 'observed_unqualified' else 2
    except DataError as error:
        result = {'status': 'chainlink_collection_failed', 'reason': str(error)}
        if str(error) == 'chainlink_slice_too_dense':
            result['nextAction'] = 'Resume the same checkpoint with a smaller --slice-seconds value (minimum 1).'
        print(json.dumps(result));return 1
    except (OSError, KeyError, TypeError, ValueError, RecursionError):
        print(json.dumps({'status': 'chainlink_collection_failed', 'reason': 'local_operation_unavailable'}));return 1


if __name__ == '__main__':
    raise SystemExit(main())
