"""Local Uniswap API credential; separate from Alchemy and never serialized to API output."""
import json
import os
from pathlib import Path
import stat
import tempfile

from discovery import DataError

CONFIG_PATH=Path(__file__).resolve().parent/'runtime'/'uniswap-api.json'


def checked(data):
    if (not isinstance(data,dict) or set(data)!={'version','apiKey'} or
            type(data['version']) is not int or data['version']!=1):
        raise DataError('invalid_uniswap_config')
    key=data['apiKey']
    if (not isinstance(key,str) or not 1<=len(key)<=512 or
            any(not 33<=ord(char)<=126 for char in key)):
        raise DataError('invalid_uniswap_key')
    return data


def load_config(path=CONFIG_PATH):
    try:
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError:
        return {}
    except OSError:
        raise DataError('uniswap_config_unreadable') from None
    try:
        with os.fdopen(fd) as stream:
            info=os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:
                raise DataError('uniswap_config_permissions')
            raw=stream.read(4097)
        if len(raw)>4096:
            raise DataError('invalid_uniswap_config')
        return checked(json.loads(raw))
    except DataError:
        raise
    except (OSError,ValueError,TypeError):
        raise DataError('uniswap_config_unreadable') from None


def save_config(data,path=CONFIG_PATH):
    data=checked(data);path=Path(path)
    path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    parent=path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.getuid() or parent.st_mode&0o077:
        raise DataError('uniswap_directory_permissions')
    if path.is_symlink():
        raise DataError('uniswap_config_unreadable')
    if path.exists():
        load_config(path)
    fd,temporary=tempfile.mkstemp(prefix='.uniswap-',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(data,stream);stream.write('\n');stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)
