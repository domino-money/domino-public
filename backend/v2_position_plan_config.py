"""Configuration of the S1 plan service: deployment manifests, chain routes and the Uniswap API key.

Secrets come from the unit's systemd credentials ($CREDENTIALS_DIRECTORY/<name>,
LoadCredentialEncrypted=) or the environment, never from the repository, a
response or a log line; a setting that fails validation stops the listener
with a code naming the setting, never its value (as crosschain_config).

| Setting | Environment | Credential | Required |
| --- | --- | --- | --- |
| Enabled chains (profile names, comma separated) | DOMINO_POSITION_PLAN_CHAINS | - | yes |
| Deployment manifest per chain (#301 deployment.json) | DOMINO_POSITION_PLAN_MANIFEST_<CHAIN> | - | yes, per enabled chain |
| Uniswap Trading API key (router legs) | DOMINO_UNISWAP_API_KEY | uniswap-api-key | no (pool legs only without it) |
| V2 chain RPC file (Base, Arbitrum) | DOMINO_V2_CHAIN_RPC_FILE | - | for Base/Arbitrum |
| Robinhood provider file | --rpc-config (the read path's file) | - | for Robinhood |
| Head file directory (shared with other V2 services) | DOMINO_V2_HEAD_DIRECTORY | - | no |

`<CHAIN>` is the profile name upper-cased with `-` as `_`: ROBINHOOD_4663,
BASE_8453, ARBITRUM_42161. Hosted endpoint URLs keep v2_rpc's names
(DOMINO_V2_RPC_<CHAIN>_<NAME>) or the RPC file's `url`.

Each chain's manifest is #301's deployment.json, loaded and admitted by
v2_manifest.load_deployment (the one loader on main: #302's format checked rule
for rule, bound to the chain profile, and in production only a verified
public-chain manifest built from committed sources and verified at the
`finalized` tag). The planner proves the code of the zap and the registry it
calls on-chain (Deployment.verify_code) before its first use.
"""
from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import stat

CREDENTIAL = re.compile(r'[a-z0-9][a-z0-9-]{0,62}')
SECRET = re.compile(r'[\x21-\x7e]{1,512}')
MAX_SECRET_BYTES = 2048


class ConfigError(ValueError):
    """position_plan_config_<setting>; never the value."""


def _credential(name, environ):
    directory = environ.get('CREDENTIALS_DIRECTORY')
    if not CREDENTIAL.fullmatch(name) or not directory or not Path(directory).is_absolute():
        return None
    try:
        fd = os.open(Path(directory) / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise ConfigError('position_plan_config_' + name.replace('-', '_')) from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ConfigError('position_plan_config_' + name.replace('-', '_'))
        data = os.read(fd, MAX_SECRET_BYTES + 1)
    finally:
        os.close(fd)
    if len(data) > MAX_SECRET_BYTES:
        raise ConfigError('position_plan_config_' + name.replace('-', '_'))
    try:
        return data.decode('ascii').rstrip('\n')
    except UnicodeError:
        raise ConfigError('position_plan_config_' + name.replace('-', '_')) from None


def _secret(env_name, credential, environ, setting):
    value = _credential(credential, environ)
    if value is None:
        value = environ.get(env_name)
    if value in (None, ''):
        return None
    if not SECRET.fullmatch(value):
        raise ConfigError('position_plan_config_' + setting)
    return value


def manifest_env(chain_key):
    return 'DOMINO_POSITION_PLAN_MANIFEST_' + re.sub(r'[^A-Z0-9]', '_', chain_key.upper())


def load_chain_deployment(path, chain):
    """The production deployment of `chain` from its manifest (v2_manifest), or a
    ConfigError naming the setting and v2_manifest's refusal code."""
    from discovery import DataError
    from v2_manifest import load_deployment
    try:
        return load_deployment(path, chain)
    except DataError as error:
        setting = 'position_plan_config_manifest_' + chain.key.replace('-', '_')
        raise ConfigError(f'{setting}:{error}') from None


@dataclass(frozen=True)
class PlanSettings:
    chains: tuple  # profile names
    manifests: dict  # profile name -> manifest path
    uniswap_api_key: str | None = field(default=None, repr=False)
    chain_rpc_file: str | None = None
    head_directory: str | None = None

    def private_values(self):
        return tuple(value for value in (self.uniswap_api_key,) if value)


def load_settings(environ=None, registry=None):
    from v2_chains import default_registry
    environ = os.environ if environ is None else environ
    registry = registry or default_registry()
    names = [name.strip() for name in environ.get('DOMINO_POSITION_PLAN_CHAINS', '').split(',') if name.strip()]
    if not names or len(set(names)) != len(names):
        raise ConfigError('position_plan_config_chains')
    manifests = {}
    for name in names:
        try:
            chain = registry.chain(name)
        except ValueError:
            raise ConfigError('position_plan_config_chains') from None
        path = environ.get(manifest_env(chain.key), '')
        if not path or not Path(path).is_absolute():
            raise ConfigError('position_plan_config_manifest_' + chain.key.replace('-', '_'))
        manifests[chain.key] = path
    key = _secret('DOMINO_UNISWAP_API_KEY', 'uniswap-api-key', environ, 'uniswap_api_key')
    rpc_file = environ.get('DOMINO_V2_CHAIN_RPC_FILE') or None
    if rpc_file is not None and not Path(rpc_file).is_absolute():
        raise ConfigError('position_plan_config_chain_rpc_file')
    head = environ.get('DOMINO_V2_HEAD_DIRECTORY') or None
    if head is not None and not Path(head).is_absolute():
        raise ConfigError('position_plan_config_head_directory')
    return PlanSettings(tuple(registry.chain(name).key for name in names), manifests, key, rpc_file, head)
