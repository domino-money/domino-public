"""Configuration of the cross-chain deposit service, from the environment and systemd credentials.

Secrets (API keys, keyed RPC URLs) are read from the unit's systemd credentials
($CREDENTIALS_DIRECTORY/<name>, LoadCredentialEncrypted=) when present, else from
the environment; nothing secret is ever committed, logged or returned. A value
that fails validation stops the listener with a code that names the setting and
never its value. docs/v2/F5_BRIDGE.md lists every name.

| Setting | Environment | Credential | Required |
| --- | --- | --- | --- |
| Domino's app-fee recipient (EVM address) | DOMINO_CROSSCHAIN_FEE_RECIPIENT | - | yes |
| Relay API key | DOMINO_RELAY_API_KEY | relay-api-key | no (needed for /requests/v3) |
| Across API key | DOMINO_ACROSS_API_KEY | across-api-key | production |
| Across integrator id (0x + 4 hex) | DOMINO_ACROSS_INTEGRATOR_ID | - | production |
| Provider timeout, seconds (2-15) | DOMINO_CROSSCHAIN_PROVIDER_TIMEOUT_SECONDS | - | no, 10 |
| Requests per minute per provider | DOMINO_RELAY_REQUESTS_PER_MINUTE, DOMINO_ACROSS_REQUESTS_PER_MINUTE | - | no |
| Destination RPC for the Across fee proof | DOMINO_CROSSCHAIN_RPC_URL_<chainId> | crosschain-rpc-<chainId> | no |
| V2 chain RPC file (F6), Base's and Arbitrum's fee proofs | DOMINO_V2_CHAIN_RPC_FILE | v2-rpc-<chain>-<name> | no |

A destination's own RPC URL wins over the V2 chain RPC file, whose URLs are its v2-rpc-* credentials (v2_rpc).
"""
from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit

ZERO = '0x' + '00' * 20
CREDENTIAL = re.compile(r'[a-z0-9][a-z0-9-]{0,62}')
SECRET = re.compile(r'[\x21-\x7e]{1,512}')
MAX_SECRET_BYTES = 2048
DESTINATION_RPC_CHAINS = (4663, 8453, 42161)


class ConfigError(ValueError):
    """crosschain_config_<setting>; never the value."""


def _credential(name, environ):
    directory = environ.get('CREDENTIALS_DIRECTORY')
    if not CREDENTIAL.fullmatch(name) or not directory or not Path(directory).is_absolute():
        return None
    try:
        fd = os.open(Path(directory) / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise ConfigError('crosschain_config_' + name.replace('-', '_')) from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ConfigError('crosschain_config_' + name.replace('-', '_'))
        data = os.read(fd, MAX_SECRET_BYTES + 1)
    finally:
        os.close(fd)
    if len(data) > MAX_SECRET_BYTES:
        raise ConfigError('crosschain_config_' + name.replace('-', '_'))
    try:
        return data.decode('ascii').rstrip('\n')
    except UnicodeError:
        raise ConfigError('crosschain_config_' + name.replace('-', '_')) from None


def _secret(env_name, credential, environ, setting):
    value = _credential(credential, environ)
    if value is None:
        value = environ.get(env_name)
    if value in (None, ''):
        return None
    if not SECRET.fullmatch(value):
        raise ConfigError('crosschain_config_' + setting)
    return value


def _integer(environ, name, default, low, high):
    value = environ.get(name)
    if value in (None, ''):
        return default
    if not re.fullmatch(r'[0-9]{1,5}', value) or not low <= int(value) <= high:
        raise ConfigError('crosschain_config_' + name.lower().removeprefix('domino_'))
    return int(value)


def rpc_url(value, setting):
    """An HTTPS JSON-RPC endpoint; its path or query may carry a key, so it is treated as a secret."""
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme == 'https' and bool(parsed.hostname) and not parsed.username
                 and not parsed.password and not parsed.fragment and len(value) <= 1536
                 and all(33 <= ord(char) <= 126 for char in value))
    except ValueError:
        valid = False
    if not valid:
        raise ConfigError('crosschain_config_' + setting)
    return value


@dataclass(frozen=True)
class CrosschainSettings:
    fee_recipient: str
    relay_api_key: str | None = field(default=None, repr=False)
    across_api_key: str | None = field(default=None, repr=False)
    across_integrator_id: str | None = None
    provider_timeout: int = 10
    relay_per_minute: int = 20
    across_per_minute: int = 10
    rpc_urls: dict = field(default_factory=dict, repr=False)
    chain_rpc_file: str | None = None

    def private_values(self):
        """Values that must never appear in a response or a log line."""
        return tuple(value for value in (self.relay_api_key, self.across_api_key, self.across_integrator_id,
                                         *self.rpc_urls.values()) if value)


def load_settings(environ=None):
    environ = os.environ if environ is None else environ
    recipient = environ.get('DOMINO_CROSSCHAIN_FEE_RECIPIENT', '')
    if not re.fullmatch(r'0x[0-9a-fA-F]{40}', recipient) or recipient.lower() == ZERO:
        raise ConfigError('crosschain_config_fee_recipient')
    relay_key = _secret('DOMINO_RELAY_API_KEY', 'relay-api-key', environ, 'relay_api_key')
    across_key = _secret('DOMINO_ACROSS_API_KEY', 'across-api-key', environ, 'across_api_key')
    integrator = environ.get('DOMINO_ACROSS_INTEGRATOR_ID') or None
    if integrator is not None and not re.fullmatch(r'0x[0-9a-fA-F]{4}', integrator):
        raise ConfigError('crosschain_config_across_integrator_id')
    rpc_urls = {}
    for chain in DESTINATION_RPC_CHAINS:
        value = _secret(f'DOMINO_CROSSCHAIN_RPC_URL_{chain}', f'crosschain-rpc-{chain}', environ, f'rpc_url_{chain}')
        if value is not None:
            rpc_urls[chain] = rpc_url(value, f'rpc_url_{chain}')
    chain_rpc_file = environ.get('DOMINO_V2_CHAIN_RPC_FILE') or None
    if chain_rpc_file is not None and not Path(chain_rpc_file).is_absolute():
        raise ConfigError('crosschain_config_chain_rpc_file')
    # Relay documents 50 quotes per minute for a default key; keyless and Across limits are unpublished.
    return CrosschainSettings(
        fee_recipient=recipient.lower(), relay_api_key=relay_key, across_api_key=across_key,
        across_integrator_id=integrator.lower() if integrator else None,
        provider_timeout=_integer(environ, 'DOMINO_CROSSCHAIN_PROVIDER_TIMEOUT_SECONDS', 10, 2, 15),
        relay_per_minute=_integer(environ, 'DOMINO_RELAY_REQUESTS_PER_MINUTE', 45 if relay_key else 20, 1, 600),
        across_per_minute=_integer(environ, 'DOMINO_ACROSS_REQUESTS_PER_MINUTE', 60 if across_key else 10, 1, 600),
        rpc_urls=rpc_urls, chain_rpc_file=chain_rpc_file)
