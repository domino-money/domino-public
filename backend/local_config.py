"""Private development-only provider configuration. Never returned through API."""
import json
import os
from pathlib import Path
import stat
import tempfile

from discovery import DataError
from inventory import inventory_endpoint
from rpc_config import (DEFAULT_RPC_HOSTS, LOCAL_RPC_HOST, MAX_RPC_ENDPOINTS,
                        rpc_endpoint, rpc_hosts, configured_rpc_urls)
from urllib.parse import urlsplit

CONFIG_PATH = Path(__file__).resolve().parent / 'runtime' / 'providers.json'


def checked_config(data):
    if not isinstance(data, dict) or type(data.get('version')) is not int:
        raise DataError('invalid_local_provider_config')
    legacy = {'version', 'rpcUrl', 'inventoryUrl'}
    modern = legacy | {'rpcFallbackUrls', 'rpcAllowedHosts'}
    if (data['version'] == 1 and set(data) == legacy):
        hosts, fallbacks = DEFAULT_RPC_HOSTS, []
    elif ((data['version'] == 2 and set(data) == modern) or
          (data['version'] == 3 and set(data) == modern | {'historicalRpcUrl'})):
        hosts = rpc_hosts(data['rpcAllowedHosts'])
        fallbacks = data['rpcFallbackUrls']
        if not isinstance(fallbacks, list) or len(fallbacks) >= MAX_RPC_ENDPOINTS:
            raise DataError('invalid_rpc_fallback_urls')
    else:
        raise DataError('invalid_local_provider_config')
    rpc_endpoint(data['rpcUrl'], hosts)
    if data['version'] == 3:
        history = rpc_endpoint(data['historicalRpcUrl'], hosts, field='historical_rpc_url')
        if urlsplit(history).hostname == LOCAL_RPC_HOST:
            raise DataError('historical_rpc_requires_archive_source')
    for url in fallbacks:
        rpc_endpoint(url, hosts, field='rpc_fallback_url')
    if len(set([data['rpcUrl'], *fallbacks])) != len(fallbacks) + 1:
        raise DataError('duplicate_rpc_endpoint')
    if data['inventoryUrl'] is not None or data['version'] == 1:
        try:
            inventory_endpoint(data['inventoryUrl'])
        except (DataError, TypeError, AttributeError):
            raise DataError('invalid_inventory_url') from None
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
            raw = stream.read(8193)
        if len(raw) > 8192:
            raise DataError('invalid_local_provider_config')
        return checked_config(json.loads(raw))
    except DataError:
        raise
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
