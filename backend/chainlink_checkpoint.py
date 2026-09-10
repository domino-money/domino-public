"""Private local checkpoints. SHA-256 detects damage; it is not authentication.

Only the current OS user may read/write checkpoints. Original evidence still
requires canonical RPC revalidation before reference use. No provider config is
part of the format. Locks prevent two CLI runs from overwriting each other's work.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile

from chainlink_collection import canonical, digest, validate_collection
from discovery import DataError

MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024


def _private(info):
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise DataError('private_chainlink_checkpoint_required')


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise DataError('invalid_chainlink_checkpoint')
        result[key] = value
    return result


class Checkpoint:
    def __init__(self, path):
        self.path = Path(path)
        self.locked = False

    @contextmanager
    def lock(self):
        parent = self.path.parent
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise DataError('private_chainlink_checkpoint_required')
        fd = os.open(str(self.path)+'.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            _private(os.fstat(fd))
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DataError('chainlink_checkpoint_busy') from None
            self.locked = True
            yield self
        finally:
            self.locked = False
            os.close(fd)

    def load(self):
        if not self.locked:
            raise DataError('chainlink_checkpoint_lock_required')
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd);_private(info)
            if info.st_size > MAX_CHECKPOINT_BYTES:
                raise DataError('chainlink_checkpoint_too_large')
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                raw = stream.read(MAX_CHECKPOINT_BYTES+1)
            if len(raw) > MAX_CHECKPOINT_BYTES:
                raise DataError('chainlink_checkpoint_too_large')
            try:
                result = json.loads(raw, object_pairs_hook=_pairs)
                if (not isinstance(result, dict) or set(result) != {'sha256', 'collection'} or
                        result['sha256'] != digest(result['collection'])):
                    raise DataError('chainlink_checkpoint_hash_mismatch')
                validate_collection(result['collection'])
                return result['collection']
            except (ValueError, TypeError, RecursionError) as error:
                if isinstance(error, DataError):
                    raise
                raise DataError('invalid_chainlink_checkpoint') from None
        finally:
            os.close(fd)

    def save(self, collection):
        if not self.locked:
            raise DataError('chainlink_checkpoint_lock_required')
        validate_collection(collection)
        raw = canonical({'sha256': digest(collection), 'collection': collection}) + b'\n'
        if len(raw) > MAX_CHECKPOINT_BYTES:
            raise DataError('chainlink_checkpoint_too_large')
        try:
            _private(self.path.lstat())
        except FileNotFoundError:
            pass
        fd, temporary = tempfile.mkstemp(prefix='.chainlink-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw);stream.flush();os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
