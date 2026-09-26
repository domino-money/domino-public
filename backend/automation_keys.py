"""The automation's two signer keys, from encrypted Ethereum V3 keystores.

The keystore sits in the private configuration directory. Its password is a
systemd credential the unit decrypts for this process alone
(`LoadCredentialEncrypted=`, read under `$CREDENTIALS_DIRECTORY`), so neither
the key nor the password is ever a plain file on disk. A keystore that names an address
must name the role's before any key derivation runs, the key it decrypts to must
be the role's, and its scrypt cost is bounded, so a substituted file can neither
sign as another account nor exhaust the unit's memory. Decisions of the owner, 26 September 2026: keys in a
keystore, the password as an encrypted credential of the VM's systemd.
"""
import os
from pathlib import Path
import re
import stat

from eth_account import Account

from bridge_state import strict_json
from execution_cli import private_file
from execution_signer import ExecutionError

MAX_KEYSTORE_BYTES = 65536
MAX_PASSWORD_BYTES = 1024
# geth's standard scrypt cost (n = 2**18, r = 8, p = 1) is the ceiling: 256 MiB,
# inside the automation unit's 512 MiB, and no wider parameter is accepted.
MAX_SCRYPT_N, MAX_SCRYPT_R, MAX_SCRYPT_P = 2**18, 8, 1
CREDENTIAL = re.compile(r'[a-z0-9][a-z0-9-]{0,62}')


def refuse(code):
    raise ExecutionError(code)


def credential(name):
    """One systemd credential of this unit: a regular file under $CREDENTIALS_DIRECTORY, one trailing newline dropped."""
    directory = os.environ.get('CREDENTIALS_DIRECTORY')
    if type(name) is not str or not CREDENTIAL.fullmatch(name) or not directory or not Path(directory).is_absolute():
        refuse('automation_keystore_credential_missing')
    try:
        fd = os.open(Path(directory) / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        refuse('automation_keystore_credential_missing')
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
            refuse('automation_keystore_credential_missing')
        raw = os.read(fd, MAX_PASSWORD_BYTES + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_PASSWORD_BYTES:
        refuse('automation_keystore_credential_missing')
    return raw[:-1] if raw.endswith(b'\n') else raw


def _positive(value, ceiling):
    return type(value) is int and 0 < value <= ceiling


def checked_keystore(raw, expected):
    """A V3 scrypt keystore of this address, or of none named, with a bounded cost; nothing is derived yet."""
    try:
        keystore = strict_json(raw)
    except ValueError:
        refuse('automation_keystore_invalid')
    crypto = keystore.get('crypto', keystore.get('Crypto')) if type(keystore) is dict else None
    params = crypto.get('kdfparams') if type(crypto) is dict else None
    if (type(keystore) is not dict or keystore.get('version') != 3 or type(crypto) is not dict
            or crypto.get('kdf') != 'scrypt' or crypto.get('cipher') != 'aes-128-ctr' or type(params) is not dict
            or not _positive(params.get('n'), MAX_SCRYPT_N) or params['n'] & (params['n'] - 1)
            or not _positive(params.get('r'), MAX_SCRYPT_R) or not _positive(params.get('p'), MAX_SCRYPT_P)
            or params.get('dklen') != 32):
        refuse('automation_keystore_invalid')
    # geth names the account; Foundry's `cast wallet import` does not. A named
    # address must be the role's before any derivation, and keystore_key checks
    # the derived key against the role's address either way.
    if 'address' in keystore:
        address = keystore['address']
        if type(address) is not str or ('0x' + address.lower().removeprefix('0x')) != expected:
            refuse('automation_keystore_address_mismatch')
    return keystore


def keystore_key(path, credential_name, expected):
    """The key of `expected`, decrypted from its keystore with its credential."""
    if type(expected) is not str or not re.fullmatch(r'0x[0-9a-f]{40}', expected):
        refuse('automation_keystore_address_mismatch')
    keystore = checked_keystore(private_file(path, MAX_KEYSTORE_BYTES), expected)
    password = credential(credential_name)
    try:
        key = bytes(Account.decrypt(keystore, password))
    except Exception:
        refuse('automation_keystore_password')
    if len(key) != 32 or Account.from_key(key).address.lower() != expected:
        refuse('automation_keystore_address_mismatch')
    return key
