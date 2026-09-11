"""Explicit operator archival of old terminal evidence; never an API capability.

The complete evidence is durably written and read back before its database rows
are removed. The operator must provision a durable private directory beforehand,
including its ancestor directory entries. A crash before database commit can
leave a duplicate archive. Preserve the directory in the operator's backup policy.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

import psycopg
from psycopg.rows import dict_row

from deposit_store import LOCK_ID
from discovery import DataError

RETENTION_DAYS = 90
MAX_BATCH = 16
MAX_ARCHIVE_BYTES = 40 * 1024 * 1024


def _json(value):
    if isinstance(value, (datetime, uuid.UUID)):
        return str(value)
    raise TypeError('unsupported_archive_value')


def archive_terminal(settings, directory, *, operator_role, connect=psycopg.connect):
    """Caller supplies a trusted operator role; the application has no DELETE."""
    if (type(settings) is not dict or set(settings) != {'host', 'port', 'dbname'}
            or not re.fullmatch('[a-z_][a-z0-9_]{0,62}', operator_role)
            or operator_role == 'domino_deposit_service'):
        raise ValueError('invalid_archive_configuration')
    directory = Path(directory)
    # Provisioning and persisting ancestor directory entries is an operator
    # prerequisite. Fsyncing a newly created leaf directory alone is insufficient.
    try:
        info = directory.lstat()
    except FileNotFoundError as error:
        raise ValueError('private_archive_directory_required') from error
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('private_archive_directory_required')
    with connect(**settings, user=operator_role, connect_timeout=3, row_factory=dict_row,
            options='-c statement_timeout=5000 -c lock_timeout=1000 -c TimeZone=UTC') as conn:
        conn.execute('SELECT pg_advisory_xact_lock(%s)', (LOCK_ID,))
        rows = conn.execute('''SELECT * FROM domino_deposits.intents
          WHERE NOT outstanding AND state IN ('confirmed','reverted','cancelled','superseded')
            AND updated_at < clock_timestamp()-interval '90 days'
          ORDER BY updated_at,id LIMIT %s FOR UPDATE''', (MAX_BATCH,)).fetchall()
        if not rows:
            return {'archived': 0, 'sha256': None, 'path': None}
        payload = json.dumps({'schemaVersion': 1, 'kind': 'domino_terminal_deposit_evidence',
            'retentionDays': RETENTION_DAYS, 'records': rows}, default=_json,
            sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        if len(payload) > MAX_ARCHIVE_BYTES:
            raise ValueError('deposit_archive_size_exceeded')
        digest = hashlib.sha256(payload).hexdigest()
        path = directory / (digest + '.json')
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                    or stream.read(MAX_ARCHIVE_BYTES + 1) != payload):
                raise ValueError('deposit_archive_verification_failed')
            # Also make a verified pre-existing/idempotent archive durable.
            # Directory fsync alone does not persist a copied file's contents.
            os.fsync(stream.fileno())
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        # Eligibility and row contents cannot change while locked. Existing
        # triggers decrement both retained evidence and active admission counts.
        conn.execute('DELETE FROM domino_deposits.intents WHERE id=ANY(%s)',
                     ([row['id'] for row in rows],))
        return {'archived': len(rows), 'sha256': digest, 'path': str(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--operator-role', required=True)
    args = parser.parse_args()
    try:
        from catalogue import database_settings
        print(json.dumps(archive_terminal(database_settings(), args.directory, operator_role=args.operator_role)))
        return 0
    except (DataError, ValueError, OSError, psycopg.Error):
        print(json.dumps({'error': 'deposit_archive_failed', 'verifyArchiveAndDatabaseBeforeRetry': True}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
