"""Read-only local-RPC qualification for the fixed Domino V1 sequence snapshot."""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from local_config import load_config, configured_rpc_urls
from read_service import ReadService
from sequence_snapshot import SequenceSnapshotRequest, validate_snapshot_response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--token-id')
    args = parser.parse_args()
    request = SequenceSnapshotRequest.model_validate({'owner': args.owner, 'tokenId': args.token_id})
    configured = load_config()
    service = ReadService(rpc_urls=configured_rpc_urls(configured),
                          snapshot_rpc_version=configured.get('version'))
    started = time.monotonic()
    result = service.sequence_snapshot(request.owner, request.tokenId)
    validate_snapshot_response('sequence-snapshot', result)
    elapsed_ms = round((time.monotonic() - started) * 1000)
    # No provider URL, calldata, code, owner or raw response is printed.
    print(json.dumps({'contractVersion': result['contractVersion'], 'chainId': result['chainId'],
                      'blockNumber': result['blockNumber'], 'blockHash': result['blockHash'],
                      'elapsedMs': elapsed_ms, 'recentCount': len(result['recent']),
                      'rootIncluded': result['root'] is not None,
                      'withinGatewayBudget': elapsed_ms < 15000}, sort_keys=True))
    if elapsed_ms >= 15000:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
