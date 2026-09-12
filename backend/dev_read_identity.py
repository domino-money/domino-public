"""Private operator configuration and one authenticated development principal.

The profile/admission directory MUST be mounted read-only in the service's
namespace (bind the directory, not admission.json's inode). The operator updates
the backing admission file atomically. Ownership/modes alone do not prevent the
service UID from changing its own files. This module never provisions access.
"""
from dataclasses import dataclass
import math
import os
from pathlib import Path
import re
import stat
from threading import Lock
import time

from bridge_identity import AccessVerifier
from bridge_state import strict_json
from discovery import DataError

READER_PORT, GATEWAY_PORT = 8890, 8891


def private_directory(path):
    """Open an existing private directory without following any symlink."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise DataError('invalid_dev_configuration')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            # Root-owned sticky temporary ancestors are safe for private test
            # directories; a writable non-sticky ancestor is not accepted.
            if (info.st_uid not in (0, os.getuid()) or
                    info.st_mode & 0o022 and not (info.st_uid == 0 and info.st_mode & stat.S_ISVTX)):
                raise DataError('invalid_dev_configuration')
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise DataError('invalid_dev_configuration')
        return fd
    except BaseException:
        os.close(fd)
        raise


def private_json(path):
    path = Path(path)
    directory = private_directory(path.parent)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or
                    stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096):
                raise DataError('invalid_dev_configuration')
            raw = stream.read(4097)
            if len(raw) > 4096:
                raise DataError('invalid_dev_configuration')
            return strict_json(raw)
    finally:
        os.close(directory)


@dataclass(frozen=True)
class DevProfile:
    issuer: str
    audience: str
    service_id: str
    reader_commit: str
    gateway_commit: str
    contract_manifest_sha256: str
    requests_per_minute: int = 6
    burst: int = 2

    def __post_init__(self):
        # Configuration validation only; constructing AccessVerifier fetches no keys.
        AccessVerifier(self.issuer, self.audience, self.service_id)
        if (not all(isinstance(v, str) and re.fullmatch(r'[0-9a-f]{40}', v)
                    for v in (self.reader_commit, self.gateway_commit)) or
                not isinstance(self.contract_manifest_sha256, str) or
                not re.fullmatch(r'[0-9a-f]{64}', self.contract_manifest_sha256) or
                type(self.requests_per_minute) is not int or not 1 <= self.requests_per_minute <= 30 or
                type(self.burst) is not int or not 1 <= self.burst <= 5):
            raise DataError('invalid_dev_configuration')

    @classmethod
    def load(cls, path):
        value = private_json(path)
        expected = {'version', 'issuer', 'audience', 'serviceId', 'gatewayPort', 'readerPort',
                    'readerCommit', 'gatewayCommit', 'contractManifestSha256', 'requestsPerMinute', 'burst'}
        if (not isinstance(value, dict) or set(value) != expected or type(value['version']) is not int or
                value['version'] != 1 or type(value['gatewayPort']) is not int or value['gatewayPort'] != GATEWAY_PORT or
                type(value['readerPort']) is not int or value['readerPort'] != READER_PORT):
            raise DataError('invalid_dev_configuration')
        return cls(value['issuer'], value['audience'], value['serviceId'], value['readerCommit'],
                   value['gatewayCommit'], value['contractManifestSha256'], value['requestsPerMinute'], value['burst'])


class Admission:
    """No cached grants. Missing, invalid, disabled or expired means revoked."""
    def __init__(self, path, service_id, *, clock=time.time):
        self.path, self.service_id, self.clock = Path(path), service_id, clock

    def allowed(self):
        try:
            value = private_json(self.path)
            now = self.clock()
            return (isinstance(value, dict) and set(value) == {'version', 'enabled', 'serviceId', 'expiresAt'} and
                    type(value['version']) is int and value['version'] == 1 and value['enabled'] is True and
                    value['serviceId'] == self.service_id and type(value['expiresAt']) is int and
                    type(now) in (int, float) and math.isfinite(now) and 0 < now < value['expiresAt'])
        except (DataError, OSError, ValueError, TypeError):
            return False

    def check(self):
        if not self.allowed():
            raise DataError('service_identity_invalid')


class PrincipalBudget:
    """One process-wide bucket; socket/proxy/IP headers cannot create new keys."""
    def __init__(self, profile, admission, *, clock=time.monotonic):
        self.principal, self.admission, self.clock = profile.service_id, admission, clock
        self.burst, self.rate = profile.burst, profile.requests_per_minute / 60
        self.available, self.at, self.lock = float(self.burst), clock(), Lock()

    def admit(self, principal):
        self.admission.check()
        if principal != self.principal:
            raise DataError('invalid_client_identity')
        with self.lock:
            now = self.clock()
            if not math.isfinite(now) or now < self.at:
                return False
            self.available = min(self.burst, self.available + (now - self.at) * self.rate)
            self.at = now
            if self.available < 1:
                return False
            self.available -= 1
            return True


class RevocableVerifier:
    def __init__(self, verifier, admission):
        self.verifier, self.admission = verifier, admission

    def verify(self, assertion):
        self.admission.check()
        self.verifier.verify(assertion)
        self.admission.check()
        return True
