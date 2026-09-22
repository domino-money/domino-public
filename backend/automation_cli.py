"""Private automation-cycle commands: identifiers in, sanitized JSON out.

Example: python backend/automation_cli.py --config /private/automation.json status
Keys are read by path from the private configuration, only for the commands
that need them; evaluate and status never open one. No environment fallback,
no listener, no free-form transaction.
"""
import argparse
import json
import signal
import sys

from automation_config import load_config
from automation_cycle import CycleError, SequenceCycle, serve
from automation_ledger import LedgerIndexer, catch_up
from automation_observer import ObservationError, derive_admission
from automation_plan import PlanError
from execution_cli import private_file
from execution_signer import ExecutionError
from execution_store import ExecutionStoreError


def read_key(path):
    key = private_file(path, 128).decode('ascii').strip()
    if len(key) != 64 or any(c not in '0123456789abcdef' for c in key):
        raise ExecutionError('execution_private_configuration')
    return bytes.fromhex(key)


def select(config, spec):
    if spec is None:
        return list(config.sequences)
    owner, _, vault = spec.partition(':')
    chosen = [s for s in config.sequences if s.owner == owner.lower() and s.vault == vault.lower()]
    if not chosen:
        raise CycleError('automation_sequence_not_admitted')
    return chosen


def main(argv=None):
    parser = argparse.ArgumentParser(description='Private automation cycle worker')
    parser.add_argument('--config', required=True)
    parser.add_argument('operation', choices=('status', 'evaluate', 'run-once', 'serve', 'pause', 'resume', 'suspend', 'unsuspend', 'publications',
                                              'index', 'ledger', 'acknowledge'))
    parser.add_argument('--sequence', help='owner:vault, both lowercase hex')
    parser.add_argument('--reason', default='operator')
    parser.add_argument('--from-block', type=int, help='index: rescan from this block instead of the cursor')
    parser.add_argument('--exception', help='acknowledge: the exception id')
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        needs_keys = args.operation in ('run-once', 'serve')
        cycle = SequenceCycle(config, operator_key=read_key(config.operator.keyFile) if needs_keys else None,
                              publisher_key=read_key(config.publisher.keyFile) if needs_keys else None)
        if args.operation == 'status':
            result = [cycle.status(entry) for entry in select(config, args.sequence)]
        elif args.operation == 'evaluate':
            result = [cycle.run(entry, act=False) for entry in select(config, args.sequence)]
        elif args.operation == 'run-once':
            result = {'publications': cycle.recover_publications(), 'cycles': [cycle.run(entry) for entry in select(config, args.sequence)]}
        elif args.operation == 'serve':
            stopping = []
            for name in (signal.SIGTERM, signal.SIGINT):
                signal.signal(name, lambda *_: stopping.append(True))
            cycle.recover_publications()
            serve(cycle, stop=lambda: bool(stopping))
            result = {'stopped': True}
        elif args.operation in ('pause', 'resume'):
            owner = config.sequences[0].owner if config.sequences else config.deployment.operator
            cycle.store.set_control(owner, 'paused', args.operation == 'pause')
            result = {'paused': args.operation == 'pause'}
        elif args.operation in ('suspend', 'unsuspend'):
            result = []
            for entry in select(config, args.sequence):
                status = cycle.status(entry)
                seq_hash = status['sequenceHash']
                lease = cycle.store.acquire_sequence(entry.owner, seq_hash, cycle.worker, lease_seconds=30)
                result.append(cycle.store.update_sequence(entry.owner, seq_hash, cycle.worker, lease['fence'], release=True,
                    suspended=args.operation == 'suspend', suspension_reason=args.reason if args.operation == 'suspend' else ''))
        elif args.operation in ('index', 'ledger'):
            ledger = config.ledger
            indexer = LedgerIndexer(cycle.reader, cycle.index_store, max_blocks=ledger.maxBlocksPerPass, max_logs=ledger.maxLogsPerPass)
            result = []
            for entry in select(config, args.sequence):
                cycle.reader.reset()
                admission = derive_admission(cycle.reader, config.deployment, entry.owner, entry.vault, cycle.reader.head())
                seq_hash = admission.sequence.digest()
                if args.operation == 'index':
                    result.append({'vault': entry.vault, 'sequenceHash': seq_hash,
                                   'passes': catch_up(indexer, entry.owner, admission, from_block=args.from_block)})
                else:
                    result.append({'vault': entry.vault, 'sequenceHash': seq_hash, 'cursor': cycle.index_store.cursor(entry.owner, seq_hash),
                                   'withdrawals': cycle.index_store.withdrawals(entry.owner, seq_hash),
                                   'exceptions': cycle.index_store.exceptions(entry.owner, seq_hash)})
        elif args.operation == 'acknowledge':
            if args.sequence is None or args.exception is None:
                raise CycleError('automation_acknowledgement_incomplete')
            entry = select(config, args.sequence)[0]
            result = cycle.index_store.acknowledge(entry.owner, args.exception, args.reason)
        else:
            result = cycle.journal.live(config.deployment.pricePublisher)
        print(json.dumps(result, sort_keys=True, separators=(',', ':'), default=str))
        return 0
    except (ExecutionError, ExecutionStoreError, CycleError, ObservationError, PlanError) as error:
        print(json.dumps({'error': getattr(error, 'code', 'automation_unavailable')}))
        return 1
    except Exception:
        print('{"error":"automation_unavailable"}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
