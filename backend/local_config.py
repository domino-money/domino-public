"""Private development-only provider configuration. Never returned through API."""
import json
import os
from pathlib import Path
import stat
import tempfile

from discovery import DataError
from inventory import inventory_endpoint

CONFIG_PATH = Path(__file__).resolve().parent / 'runtime' / 'providers.json'


def checked_config(data):
    if not isinstance(data, dict) or set(data) != {'version', 'rpcUrl', 'inventoryUrl'} or type(data['version']) is not int or data['version'] != 1:
        raise DataError('invalid_local_provider_config')
    inventory_endpoint(data['rpcUrl'])
    inventory_endpoint(data['inventoryUrl'])
    return data


def load_config(path=CONFIG_PATH):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return {}
    except OSError:
        raise DataError('local_provider_config_unreadable') from None
    try:
        with os.fdopen(fd, 'r') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise DataError('local_provider_config_permissions')
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise DataError('invalid_local_provider_config')
        return checked_config(json.loads(raw))
    except (OSError, ValueError, TypeError):
        raise DataError('local_provider_config_unreadable') from None


def save_config(data, path=CONFIG_PATH):
    data = checked_config(data)
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise DataError('local_provider_directory_permissions')
    if path.is_symlink():
        raise DataError('local_provider_config_unreadable')
    if path.exists():
        load_config(path)  # Do not overwrite an unrelated or insecure file.
    fd, temporary = tempfile.mkstemp(prefix='.providers-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
