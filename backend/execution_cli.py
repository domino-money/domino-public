"""Private signer process protocol: identifiers in, sanitized status out.

Example: python backend/execution_cli.py --config /private/executor.json \
  status --owner 0x... --intent 0x...
No environment fallback, default key, public listener, raw call or free-form tx.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import sys

from execution_signer import ExecutionRpc, RestrictedSigner, SignerPolicy, ExecutionError
from execution_runner import ExecutionRunner
from execution_store import _owner, _hash, _worker, ExecutionStoreError
from gas_budget_bridge import GasBudgetClient
from gas_usd_budget import GasBudgetError


def private_file(path, maximum):
    """No symlink target; private regular file and containing directory owned by uid."""
    target=Path(path)
    if not target.is_absolute():raise ExecutionError('execution_private_configuration')
    parent=target.parent
    # Resolve aliases in ancestors before opening relative to a held directory.
    # Config belongs outside a checkout; parent permissions block other users.
    if parent.resolve()!=parent:raise ExecutionError('execution_private_configuration')
    descriptor=os.open(parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        st=os.fstat(descriptor)
        if st.st_uid!=os.geteuid() or stat.S_IMODE(st.st_mode)&0o077:
            raise ExecutionError('execution_private_configuration')
        fd=os.open(target.name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=descriptor)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or stat.S_IMODE(info.st_mode)&0o077 or info.st_nlink!=1 or info.st_size>maximum:
                raise ExecutionError('execution_private_configuration')
            data=os.read(fd,maximum+1)
            if len(data)>maximum:raise ExecutionError('execution_private_configuration')
            return data
        finally:os.close(fd)
    finally:os.close(descriptor)


def main(argv=None):
    parser=argparse.ArgumentParser(description='Private disabled-by-default execution signer')
    parser.add_argument('--config',required=True)
    parser.add_argument('operation',choices=('status','step','replace','cancel'))
    parser.add_argument('--owner',required=True)
    parser.add_argument('--intent',required=True)
    parser.add_argument('--worker')
    args=parser.parse_args(argv)
    try:
        owner=_owner(args.owner);identifier=_hash(args.intent)
        config=json.loads(private_file(args.config,65536))
        expected={'schemaVersion','database','rpcEndpoint','keyFile','admission','policy','restoreOnly'}
        if type(config) is not dict or set(config) not in (expected,expected|{'priceObservationId'}) or type(config['schemaVersion']) is not int or config['schemaVersion']!=1 or type(config['restoreOnly']) is not bool:
            raise ExecutionError('execution_private_configuration')
        policy=SignerPolicy(**config['policy'])
        key=private_file(config['keyFile'],128).decode('ascii').strip()
        if len(key)!=64 or any(c not in '0123456789abcdef' for c in key):
            raise ExecutionError('execution_private_configuration')
        import execution_models as m
        # The anchor bound to this intent when it was persisted takes precedence:
        # it isolates pools and workers, where one configured id could not. A
        # configured id remains the fallback for intents persisted without one.
        from execution_runner import ExecutionJournal
        bound=ExecutionJournal(config['database']).read(owner,identifier)['intent']['commitments'].get('priceObservationId')
        if bound is not None:_hash(bound)
        rpc=ExecutionRpc(config['rpcEndpoint'])
        signer=RestrictedSigner(rpc,bytes.fromhex(key),config['admission'],policy,
            price_observation_id=bound if bound is not None else config.get('priceObservationId',m.ZERO_HASH),
            gas_budget=GasBudgetClient())
        runner=ExecutionRunner(config['database'],signer,restore_only=config['restoreOnly'])
        if args.operation=='status':result=runner.journal.status(owner,identifier)
        else:
            worker=_worker(args.worker)
            if args.operation=='cancel':
                lease=runner.store.acquire(owner,identifier,worker)
                runner.store.cancel(owner,identifier,worker,lease['fence'])
                result=runner.journal.status(owner,identifier)
            else:result=runner.step(owner,identifier,worker,replace=args.operation=='replace')
        print(json.dumps(result,sort_keys=True,separators=(',',':')))
        return 0
    except (ExecutionError,ExecutionStoreError,GasBudgetError) as error:
        print(json.dumps({'error':error.code}));return 1
    except Exception:
        print('{"error":"execution_unavailable"}');return 1


if __name__=='__main__':sys.exit(main())
