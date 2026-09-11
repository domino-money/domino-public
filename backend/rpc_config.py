"""Operator-owned RPC routing; never populated by an HTTP request."""
import ipaddress
import re
from urllib.parse import urlsplit

from discovery import DataError, RPC_URL

DEFAULT_RPC_HOSTS = ('rpc.mainnet.chain.robinhood.com', 'robinhood-mainnet.g.alchemy.com')
MAX_RPC_ENDPOINTS = 3
MAX_RPC_HOSTS = 8


def rpc_hosts(values):
    if not isinstance(values, (list, tuple)) or not 1 <= len(values) <= MAX_RPC_HOSTS:
        raise DataError('invalid_rpc_allowed_hosts')
    for host in values:
        if (not isinstance(host, str) or len(host) > 253 or host != host.lower() or
                not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', host) or
                host.endswith(('.localhost', '.local', '.internal'))):
            raise DataError('invalid_rpc_allowed_hosts')
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise DataError('invalid_rpc_allowed_hosts')
    if len(set(values)) != len(values):
        raise DataError('invalid_rpc_allowed_hosts')
    return tuple(values)


def rpc_endpoint(url, allowed_hosts=DEFAULT_RPC_HOSTS, *, field='rpc_url'):
    hosts = rpc_hosts(allowed_hosts)
    try:
        parsed = urlsplit(url)
        valid = (isinstance(url, str) and 1 <= len(url) <= 1536 and
                 all(33 <= ord(c) <= 126 for c in url) and '\\' not in url and
                 parsed.scheme == 'https' and parsed.netloc == parsed.hostname and
                 parsed.hostname in hosts and not parsed.username and not parsed.password and
                 not parsed.query and not parsed.fragment and '%' not in parsed.netloc)
        # Alchemy inventory and RPC use the same known endpoint shape, while
        # separately admitted providers may use their own credential path.
        if valid and parsed.hostname == 'robinhood-mainnet.g.alchemy.com':
            valid = re.fullmatch(r'/v2/[A-Za-z0-9_-]{1,128}', parsed.path) is not None
        if valid and parsed.hostname == 'rpc.mainnet.chain.robinhood.com':
            valid = parsed.path in ('', '/')
    except (ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        raise DataError('invalid_' + field)
    return url


def configured_rpc_urls(config, override=None):
    """A trusted environment override selects one endpoint, never silent fallbacks."""
    hosts = config.get('rpcAllowedHosts', DEFAULT_RPC_HOSTS)
    if override:
        return (rpc_endpoint(override, hosts),)
    primary = config.get('rpcUrl', RPC_URL)
    return (rpc_endpoint(primary, hosts), *(
        rpc_endpoint(url, hosts, field='rpc_fallback_url') for url in config.get('rpcFallbackUrls', [])))
