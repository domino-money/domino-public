"""Explicit operator quarantine of reviewed, provably orphaned Chainlink rows.

Never called by read APIs or collection retries. A private, durably provisioned
archive directory and the reviewed checkpoint digest are required. The archive
keeps the original collection, stored retrieval times and both canonical checks;
normal collection storage can subsequently insert separately reviewed evidence.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import stat

from catalogue import configured_catalogue
from chainlink_checkpoint import Checkpoint
from chainlink_collection import (BudgetRpc, INVOCATION_SECONDS, STORAGE_RPC_REQUESTS,
    canonical, collection_blocks, digest, validate_collection)
from discovery import CHAIN_ID, DataError, ReadRpc, parse_block, quantity
from local_config import load_config
from rpc_config import configured_history_rpc_url
from price_history import CHAINLINK_SOURCE, usd
from read_service import bounded_transport

MAX_ARCHIVE_BYTES = 16 * 1024 * 1024


def private_archive(directory, document):
    """No mkdir: operator provisions and syncs the directory before this operation."""
    raw = canonical(document) + b'\n'
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise DataError('price_quarantine_archive_budget_exhausted')
    checksum = hashlib.sha256(raw).hexdigest()
    name = checksum + '.json'
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory_fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise DataError('private_price_archive_required')
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory_fd)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw);stream.flush();os.fsync(stream.fileno())
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                    stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != len(raw)):
                raise DataError('private_price_archive_required')
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                actual = stream.read(MAX_ARCHIVE_BYTES + 1)
            if actual != raw or hashlib.sha256(actual).hexdigest() != checksum:
                raise DataError('price_quarantine_archive_mismatch')
            os.fsync(fd)  # Retry-existing archives must also be durable before deletion.
        finally:
            os.close(fd)
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    return {'file': name, 'sha256': checksum, 'bytes': len(raw)}


def quarantine_collection(catalogue, collection, rpc, *, reviewed_sha256, archive_directory):
    """Delete only exact reviewed rows with changed publication/predecessor hashes.

    Missing RPC data is an error, never evidence of orphanhood. The catalogue
    writer lock covers selection, proof, archive and deletion. Any error rolls
    back; an already-written archive remains useful evidence and is safe to retry.
    """
    _, expected_rows = validate_collection(collection, complete=True)
    if reviewed_sha256 != digest(collection):
        raise DataError('price_quarantine_review_mismatch')
    expected_blocks = collection_blocks(collection)
    rpc = BudgetRpc(rpc, max_requests=STORAGE_RPC_REQUESTS + 3, seconds=INVOCATION_SECONDS)
    if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
        raise DataError('wrong_chain')
    anchor = asdict(parse_block(rpc.request('eth_getBlockByNumber', ['latest', False])))
    if anchor['number'] < max(expected_blocks):
        raise DataError('price_quarantine_verification_unavailable')

    def check():
        actual_blocks = {}
        for number, expected in sorted(expected_blocks.items()):
            actual = asdict(parse_block(rpc.request('eth_getBlockByNumber', [hex(number), False])))
            if actual['number'] != number or (actual['hash'] == expected['hash'] and actual != expected):
                raise DataError('invalid_price_quarantine_proof')
            actual_blocks[number] = actual
        current = asdict(parse_block(rpc.request('eth_getBlockByNumber', [hex(anchor['number']), False])))
        if current != anchor:
            raise DataError('price_quarantine_chain_changed')
        return actual_blocks

    with catalogue.connection(writer=True, lock=True) as conn:
        stored = conn.execute('''SELECT chain_id AS "chainId",currency,source,observed_at AS timestamp,
          retrieved_at AS "retrievedAt",price_usd AS "priceUsd",provenance
          FROM domino_activity.price_observations WHERE chain_id=%s AND currency=%s AND source=%s
          AND observed_at=ANY(%s) ORDER BY observed_at FOR UPDATE''',
          (CHAIN_ID, collection['currency'], CHAINLINK_SOURCE, [r['timestamp'] for r in expected_rows])).fetchall()
        expected = {row['timestamp']: row for row in expected_rows}
        for row in stored:
            original = expected[row['timestamp']]
            if usd(row['priceUsd']) != usd(original['priceUsd']) or row['provenance'] != original['provenance']:
                raise DataError('price_quarantine_stored_revision_mismatch')
        actual = check()
        orphaned = [row for row in stored if any(
            actual[row['provenance'][key]['number']]['hash'] != row['provenance'][key]['hash']
            for key in ('publicationBlock', 'precedingBlock'))]
        if not orphaned:
            raise DataError('price_quarantine_no_orphans')
        confirmed = check()
        if confirmed != actual:
            raise DataError('price_quarantine_chain_changed')
        archived = private_archive(archive_directory, {
            'schemaVersion': 1, 'mode': 'operator_reviewed_price_quarantine',
            'reason': 'canonical_publication_proof_orphaned', 'collectionSha256': reviewed_sha256,
            'collection': collection, 'storedRows': orphaned, 'canonicalAnchor': anchor,
            'canonicalBlocks': {str(n): b for n, b in actual.items()},
            'verificationPasses': 2, 'productionQualified': False})
        final_anchor = asdict(parse_block(rpc.request('eth_getBlockByNumber', [hex(anchor['number']), False])))
        if final_anchor != anchor:
            raise DataError('price_quarantine_chain_changed')
        for row in orphaned:
            conn.execute('''DELETE FROM domino_activity.price_observations
              WHERE chain_id=%s AND currency=%s AND source=%s AND observed_at=%s''',
              (CHAIN_ID, row['currency'], CHAINLINK_SOURCE, row['timestamp']))
        return {'status': 'orphaned_observations_quarantined', 'observations': len(orphaned),
                'archive': archived, 'rpcRequests': rpc.count, 'productionQualified': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkpoint', required=True, type=Path)
    parser.add_argument('--reviewed-sha256', required=True)
    parser.add_argument('--archive-directory', required=True, type=Path)
    parser.add_argument('--provider-config', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        with Checkpoint(args.checkpoint).lock() as checkpoint:
            collection = checkpoint.load()
        if collection is None or digest(collection) != args.reviewed_sha256:
            raise DataError('price_quarantine_review_mismatch')
        config = load_config(args.provider_config)
        if not config:
            raise DataError('configured_rpc_required')
        catalogue = configured_catalogue()
        if catalogue is None:
            raise DataError('catalogue_not_configured')
        rpc = ReadRpc(configured_history_rpc_url(config), transport=bounded_transport(INVOCATION_SECONDS),
                      max_requests=STORAGE_RPC_REQUESTS + 3)
        print(json.dumps(quarantine_collection(catalogue, collection, rpc,
                         reviewed_sha256=args.reviewed_sha256, archive_directory=args.archive_directory)))
        return 0
    except DataError as error:
        print(json.dumps({'status': 'price_quarantine_failed', 'reason': str(error)}));return 1
    except (OSError, KeyError, TypeError, ValueError):
        print(json.dumps({'status': 'price_quarantine_failed', 'reason': 'local_operation_unavailable'}));return 1


if __name__ == '__main__':
    raise SystemExit(main())
