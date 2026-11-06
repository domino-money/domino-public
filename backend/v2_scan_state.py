"""Where the automation's log scans stopped, kept across processes (one private JSON file per chain).

VaultDiscovery and MandateWatcher read the factories' VaultCreated and the module's MandateRegistered logs from the
deployment block on, a window at a time, under the pass's request budget. Kept only in memory, every process started
again from the deployment block. Once the chain had grown past what one pass's budget reads, `status`, `plan` and
`run-once` could never finish a scan, and `serve` never got past its first pass. This file keeps each scan's next
block and what it found, written after every scan, including one that stopped on its budget, so the next pass or
process goes on from there.

The file belongs to the automation's identity: it sits in the journal's private directory, mode 0600, replaced
atomically. It is bound to the deployment's chain and to the addresses it scans: a file for anything else is ignored,
never trusted. The block it records stays REORG_MARGIN blocks behind what was read, so a short reorganization is read
again; records are keyed, so reading a block twice adds nothing.
"""
import json
import os
from pathlib import Path
import re
import stat
import tempfile

from discovery import DataError

VERSION = 1
REORG_MARGIN = 64
MAX_BYTES = 8 * 1024 * 1024
ADDRESS = re.compile(r'^0x[0-9a-f]{40}$')
HASH = re.compile(r'^0x[0-9a-f]{64}$')


def identity(deployment):
    """What the scans depend on: the chain and the contracts whose logs they read (its vault factories, one on a chain
    with one Uniswap version, and the auto-exit module)."""
    return {'chainId': deployment.chain.chainId,
            **{f'vaultFactory.v{dex}': deployment.factory(dex) for dex in deployment.chain.dexes},
            'autoExit': deployment.auto_exit}


class ScanState:
    """One chain's scan positions and findings; `scans` maps a scan's name to {'next': block, 'items': {...}}."""

    def __init__(self, path, deployment):
        path = Path(path)
        if not path.is_absolute():
            raise DataError('v2_scan_state_path')
        info = os.stat(path.parent)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise DataError('v2_scan_state_directory_not_private')
        self.path, self.identity = path, identity(deployment)
        self.scans = self._load()

    def _load(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {}
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077
                    or info.st_size > MAX_BYTES):
                raise DataError('v2_scan_state_file_not_private')
            try:
                saved = json.loads(stream.read())
            except ValueError:
                return {}
        if not isinstance(saved, dict) or saved.get('version') != VERSION or saved.get('identity') != self.identity:
            return {}
        scans = saved.get('scans')
        if not isinstance(scans, dict):
            return {}
        kept = {}
        for name, scan in scans.items():
            if (isinstance(name, str) and isinstance(scan, dict) and isinstance(scan.get('next'), int)
                    and not isinstance(scan.get('next'), bool) and scan['next'] >= 0
                    and isinstance(scan.get('items'), dict)):
                kept[name] = {'next': scan['next'], 'items': scan['items']}
        return kept

    def get(self, name):
        return self.scans.get(name)

    def put(self, name, next_block, end, items):
        """Records a scan that read through `next_block - 1` of a chain whose head was `end`. The next process
        starts REORG_MARGIN blocks back at most; the reader keeps it at or after its deployment block."""
        self.scans[name] = {'next': max(0, min(next_block, end + 1 - REORG_MARGIN)), 'items': items}

    def save(self):
        payload = json.dumps({'version': VERSION, 'identity': self.identity, 'scans': self.scans},
                             sort_keys=True, separators=(',', ':')).encode()
        fd, temporary = tempfile.mkstemp(prefix='.' + self.path.name + '.', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise


def valid_address(value):
    return isinstance(value, str) and ADDRESS.fullmatch(value) is not None


def valid_hash(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None
