"""Per-chain RPC endpoints for Domino V2: ordered, limited, and frugal with billed calls.

Owner decisions (1 and 2 Oct 2026). Robinhood keeps Domino's own Nitro node.
Base and Arbitrum One read hosted providers, in order: Chainstack first, dRPC,
Alchemy pay-as-you-go, and public endpoints only as a last resort. Hosted RPC
bills every call, each call inside a batch included, so this module spends as
few as it can and never more than each endpoint admits.

Where a chain's endpoints come from. A V2 service serves one chain (v2_chains):
- Robinhood (4663): the read path's own private provider file (local_config),
  version 4 only. Domino's node at rpc.domino.money is the first endpoint
  (`local`), then the file's fallbacks (`fallback-1`, `fallback-2`). Robinhood
  cannot be named in the V2 file, so V2 never reads the public Robinhood RPC by
  default.
- Every other enabled chain: the private V2 chain RPC file (0600, in a 0700
  directory outside any checkout). It lists each chain's endpoints in order,
  each with its name, host and limits:

      {"schemaVersion": 1, "kind": "domino-v2-chain-rpc",
       "chains": {"base-8453": {"endpoints": [
           {"name": "chainstack", "host": "<provider host>", "archive": true,
            "maxBatchItems": 100, "maxLogBlocks": 10000, "requestsPerSecond": 25},
           ...]}}}

  An endpoint's URL, which carries the provider's key, is exactly one of:
  the entry's `url`; the unit's systemd credential v2-rpc-<chain>-<name>
  ($CREDENTIALS_DIRECTORY, LoadCredentialEncrypted=), for example
  v2-rpc-base-8453-chainstack, so the key is sealed on the VM like every other
  secret; or the environment variable DOMINO_V2_RPC_<CHAIN>_<NAME>, for
  example DOMINO_V2_RPC_BASE_8453_CHAINSTACK. It must be HTTPS on exactly the
  entry's host. A chain the file does not name has no endpoint, and its
  services refuse to start instead of falling back to anything.
- The balance chains (v2_chains.BalanceChainProfile: Ethereum, OP Mainnet),
  which read-v6's chain-balances alone reads: a file of the same schema, read
  against the balance registry (`ethereum-1`, `optimism-10`), with credentials
  v2-rpc-ethereum-1-<name> and v2-rpc-optimism-10-<name>. Each file names only
  its own registry's chains, so a fault in one never reaches the other's.

Limits, enforced per endpoint by the chain's shared transport:
- maxBatchItems: a JSON-RPC batch goes out in envelopes of at most this many calls;
- maxLogBlocks: an eth_getLogs range wider than this is split into windows
  (null: no limit, as on Alchemy's paid plans);
- requestsPerSecond: calls are paced to this rate, each call of a batch counted
  (null: not paced);
- archive: whether the endpoint serves state at any block. A hosted full node
  keeps about RECENT_STATE_BLOCKS of recent state.
A 429, a 5xx or a network failure cools the endpoint down for 1 s, doubling up
to 60 s while it keeps failing. A call to a cooling endpoint, or one the pace
would hold for more than MAX_PACE_WAIT_SECONDS, is refused locally as http_429:
nothing is sent or billed, and the client fails over to the next endpoint.

Clients. ChainReadRpc (current state) and ChainHistoryRpc (pinned historical
reads) are the read path's failover clients (rpc_failover): one deadline and
request budget across endpoints, every pinned block proven again on each
switch. Each takes the first three endpoints that are not cooling down. They
never request eth_chainId: the chain id is the profile's. An endpoint proves
its chain once, when `check` is run on it after provisioning, and the code-hash
proofs of what a service reads would fail on any other chain. A history read of
state older than an endpoint keeps starts at the first endpoint that keeps it,
which is V1's rule for the own pruned node, generalized. A head the chain's
follower already observed (v2_head) can seed a current client, so a read spends
no call on the head, and the chain's code-hash cache spares eth_getCode.

URLs never enter an error, a log line or a repr; only endpoint names do.
"""
import argparse
from copy import deepcopy
from dataclasses import dataclass, field
import json
import logging
import os
from pathlib import Path
import re
import stat
import sys
import threading
import time
from urllib.parse import urlsplit

from eth_hash.auto import keccak

from discovery import (CHAIN_ID, Block, DataError, ReadRpc, RpcStateUnavailable, parse_block,
                       prefetched, quantity, rpc_http)
from execution_status_runtime import private_file
from local_config import CONFIG_PATH, checked_config, load_config
from read_deadline import current_read_deadline, read_deadline
from rpc_config import LOCAL_STATE_BLOCKS, MAX_RPC_ENDPOINTS, configured_rpc_urls, own_node, rpc_hosts
from rpc_failover import RETRYABLE, FailoverReadRpc, HistoricalReadRpc
from v2_chains import BalanceChainProfile, ChainProfile, default_balance_registry, default_registry

KIND = 'domino-v2-chain-rpc'
ENV_PREFIX = 'DOMINO_V2_RPC_'
CREDENTIAL_PREFIX = 'v2-rpc-'
CREDENTIAL_NAME = re.compile(r'[a-z0-9][a-z0-9-]{0,62}')
MAX_CREDENTIAL_BYTES = 2048
MAX_CHAIN_RPC_BYTES = 65536
MAX_ENDPOINTS = 6
# A hosted full node keeps recent state only: the geth and Nitro default of 128
# blocks (32 s on Arbitrum, 4 min on Base). Older state needs an archive endpoint.
RECENT_STATE_BLOCKS = 128
# What the own Robinhood routes admit today: the V1 indexers send batches of up
# to 100 reads to the same routes, and their log spans are bounded by indexer_io.
ROBINHOOD_BATCH_ITEMS = 100
COOLDOWN_SECONDS, MAX_COOLDOWN_SECONDS = 1, 60
MAX_PACE_WAIT_SECONDS = 2
MAX_LOG_WINDOWS = 1000
CHECK_DEADLINE_SECONDS = 120
CHECK_MAX_HEAD_AGE_SECONDS = 180
ENDPOINT_KEYS = {'name', 'host', 'archive', 'maxBatchItems', 'maxLogBlocks', 'requestsPerSecond'}
# The profiles a chain's endpoints may serve: a Domino chain's, or a balance chain's (chain-balances only).
PROFILES = (ChainProfile, BalanceChainProfile)
_LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class Endpoint:
    """One provider route of a chain. The URL holds a credential: no repr."""
    name: str
    host: str
    url: str = field(repr=False)
    state_blocks: int | None  # how far below the head state is served; None: archive
    max_batch_items: int
    max_log_blocks: int | None
    requests_per_second: int | None

    @property
    def archive(self):
        return self.state_blocks is None


def env_name(chain, name):
    """The documented environment variable that may hold an endpoint's URL."""
    return ENV_PREFIX + re.sub(r'[^A-Z0-9]', '_', f'{chain.key}_{name}'.upper())


def credential_name(chain, name):
    """The systemd credential that may hold an endpoint's URL: v2-rpc-<profile>-<endpoint>."""
    return f'{CREDENTIAL_PREFIX}{chain.key}-{name}'


def _credential(name, environ):
    """One systemd credential of this unit (LoadCredentialEncrypted=, decrypted
    by systemd under $CREDENTIALS_DIRECTORY for this process alone), or None
    when the unit has none of that name. A regular file only, never a link; one
    trailing newline is dropped. Its value is never part of an error."""
    directory = environ.get('CREDENTIALS_DIRECTORY')
    if not directory:
        return None
    if not CREDENTIAL_NAME.fullmatch(name) or not Path(directory).is_absolute():
        raise DataError('v2_rpc_credential_unreadable')
    try:
        fd = os.open(Path(directory) / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise DataError('v2_rpc_credential_unreadable') from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise DataError('v2_rpc_credential_unreadable')
        raw = os.read(fd, MAX_CREDENTIAL_BYTES + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_CREDENTIAL_BYTES:
        raise DataError('v2_rpc_credential_unreadable')
    try:
        value = raw.decode('ascii')
    except UnicodeError:
        raise DataError('v2_rpc_credential_unreadable') from None
    return value[:-1] if value.endswith('\n') else value


def _bounded(value, low, high):
    return type(value) is int and low <= value <= high


def endpoint_url(url, host):
    """HTTPS on exactly the admitted host: no userinfo, port or fragment. A
    query is admitted, since some providers take their key there."""
    try:
        parsed = urlsplit(url)
        valid = (type(url) is str and 1 <= len(url) <= 2048 and all(33 <= ord(c) <= 126 for c in url)
                 and '\\' not in url and parsed.scheme == 'https' and parsed.netloc == host
                 and not parsed.fragment)
    except (ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        raise DataError('invalid_v2_rpc_url')
    return url


def _checked_endpoint(chain, entry, environ):
    if (type(entry) is not dict or not ENDPOINT_KEYS <= set(entry) <= ENDPOINT_KEYS | {'url'}
            or type(entry['name']) is not str or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', entry['name'])
            or type(entry['archive']) is not bool or not _bounded(entry['maxBatchItems'], 1, 1000)
            or not (entry['maxLogBlocks'] is None or _bounded(entry['maxLogBlocks'], 1, 10**8))
            or not (entry['requestsPerSecond'] is None or _bounded(entry['requestsPerSecond'], 1, 10**5))):
        raise DataError('invalid_v2_chain_rpc_config')
    host, = rpc_hosts([entry['host']])
    # Exactly one source: the file, the unit's sealed credential, or the environment.
    sources = [value for value in (entry.get('url'), _credential(credential_name(chain, entry['name']), environ),
                                   environ.get(env_name(chain, entry['name']))) if value is not None]
    if len(sources) > 1:
        raise DataError('v2_rpc_url_ambiguous')
    if not sources:
        raise DataError('v2_rpc_url_missing')
    url = endpoint_url(sources[0], host)
    return Endpoint(entry['name'], host, url, None if entry['archive'] else RECENT_STATE_BLOCKS,
                    entry['maxBatchItems'], entry['maxLogBlocks'], entry['requestsPerSecond'])


@dataclass(frozen=True)
class ChainRpcConfig:
    """A checked V2 chain RPC file: profile name to its ordered endpoints."""
    chains: dict = field(repr=False)

    def __repr__(self):
        return f'ChainRpcConfig(chains={sorted(self.chains)!r})'


def checked_chain_rpc_config(document, registry=None, environ=None):
    registry = registry or default_registry()
    environ = os.environ if environ is None else environ
    if (type(document) is not dict or set(document) != {'schemaVersion', 'kind', 'chains'}
            or type(document['schemaVersion']) is not int or document['schemaVersion'] != 1
            or document['kind'] != KIND or type(document['chains']) is not dict):
        raise DataError('invalid_v2_chain_rpc_config')
    chains = {}
    for name, entry in document['chains'].items():
        chain = registry.chain(name)
        if chain.chainId == CHAIN_ID:
            # Robinhood keeps the read path's provider file: one source of truth.
            raise DataError('v2_robinhood_routes_come_from_provider_file')
        if (type(entry) is not dict or set(entry) != {'endpoints'} or type(entry['endpoints']) is not list
                or not 1 <= len(entry['endpoints']) <= MAX_ENDPOINTS):
            raise DataError('invalid_v2_chain_rpc_config')
        endpoints = tuple(_checked_endpoint(chain, item, environ) for item in entry['endpoints'])
        if (len({e.name for e in endpoints}) != len(endpoints)
                or len({e.url for e in endpoints}) != len(endpoints)):
            raise DataError('duplicate_v2_rpc_endpoint')
        chains[name] = endpoints
    return ChainRpcConfig(chains)


def load_chain_rpc_config(path, registry=None, environ=None):
    """The operator's private V2 chain RPC file, or with the balance registry (v2_chains.default_balance_registry) the
    balance chain RPC file; never a default path."""
    try:
        raw = private_file(path, MAX_CHAIN_RPC_BYTES)
    except (OSError, ValueError):
        raise DataError('v2_chain_rpc_config_unreadable') from None

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_json_key')
            result[key] = value
        return result
    try:
        document = json.loads(raw, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        raise DataError('invalid_v2_chain_rpc_config') from None
    return checked_chain_rpc_config(document, registry, environ)


def provider_file_endpoints(chain, provider_config):
    """Robinhood's endpoints: the read path's provider file, version 4 only."""
    if chain.chainId != CHAIN_ID:
        raise DataError('v2_provider_file_serves_robinhood_only')
    if type(provider_config) is not dict or provider_config.get('version') != 4:
        raise DataError('v2_local_first_provider_file_required')
    # checked_config refuses a version 4 file whose primary is not the own node.
    urls = configured_rpc_urls(checked_config(provider_config))
    # The own node is pruned (LOCAL_STATE_BLOCKS) over its VM-local proxy and its
    # public route alike; the other fallbacks serve old state.
    return tuple(Endpoint('local' if index == 0 else f'fallback-{index}', urlsplit(url).hostname, url,
                          LOCAL_STATE_BLOCKS if own_node(url) else None, ROBINHOOD_BATCH_ITEMS, None, None)
                 for index, url in enumerate(urls))


class CodeCache:
    """Runtime code hashes proven at an address, valid from the lowest block
    they were proven at onward: since Cancun (EIP-6780) deployed code cannot
    change, so one eth_getCode proves every later block."""
    def __init__(self):
        self._since, self._lock = {}, threading.Lock()

    def proven(self, contract, codehash, block_number):
        since = self._since.get((contract, codehash))
        return since is not None and since <= block_number

    def record(self, contract, codehash, block_number):
        with self._lock:
            key = (contract, codehash)
            self._since[key] = min(self._since.get(key, block_number), block_number)


@dataclass
class _EndpointState:
    endpoint: Endpoint
    failures: int = 0
    cooling_until: float = 0.0
    next_free: float = 0.0
    calls: int = 0


class ChainEndpoints:
    """One chain's ordered endpoints, shared by every client of a process.

    It is also their transport: whatever a client sends through it respects the
    endpoint's batch size, log range and pace, and counts as billed calls.
    """
    def __init__(self, chain, endpoints, source, *, send=rpc_http, clock=time.monotonic, sleep=time.sleep):
        if (not isinstance(chain, PROFILES) or not endpoints or len(endpoints) > MAX_ENDPOINTS
                or any(not isinstance(e, Endpoint) for e in endpoints)
                or len({e.url for e in endpoints}) != len(endpoints)):
            raise DataError('invalid_v2_chain_endpoints')
        self.chain, self.endpoints, self.source = chain, tuple(endpoints), source
        self._send, self._clock, self._sleep = send, clock, sleep
        self._states = {e.url: _EndpointState(e) for e in self.endpoints}
        self._lock = threading.Lock()
        self.code = CodeCache()

    def __repr__(self):
        return (f'ChainEndpoints(chain={self.chain.key!r}, endpoints={[e.name for e in self.endpoints]!r}, '
                f'source={self.source!r})')

    def calls(self):
        """Calls sent to each endpoint by this process, each call of a batch counted."""
        with self._lock:
            return {state.endpoint.name: state.calls for state in self._states.values()}

    def usable(self):
        """The first endpoints a client may use, in order, skipping cooling ones."""
        now = self._clock()
        with self._lock:
            ready = [s.endpoint for s in self._states.values() if s.cooling_until <= now]
        if not ready:
            raise DataError('v2_rpc_endpoints_cooling')
        return tuple(ready[:MAX_RPC_ENDPOINTS])

    def select(self, only=None):
        """The endpoints a new client uses: usable() or exactly the one named."""
        if only is None:
            return self.usable()
        named = tuple(e for e in self.endpoints if e.name == only)
        if not named:
            raise DataError('v2_rpc_endpoint_unknown')
        return named

    def read_rpc(self, *, anchor=None, **kwargs):
        return ChainReadRpc(self, anchor=anchor, **kwargs)

    def history_rpc(self, **kwargs):
        return ChainHistoryRpc(self, **kwargs)

    # -------------------------------------------------------------- transport
    def _admit(self, state, count):
        """Cooldown and pace, or refuse locally: nothing is sent or billed."""
        rate = state.endpoint.requests_per_second
        with self._lock:
            now = self._clock()
            if state.cooling_until > now:
                raise DataError('http_429')
            wait = 0.0
            if rate is not None:
                start = max(now, state.next_free)
                wait = start - now
                limit = MAX_PACE_WAIT_SECONDS
                deadline = current_read_deadline()
                if deadline is not None:
                    limit = min(limit, deadline.remaining())
                if wait > limit:
                    raise DataError('http_429')
                state.next_free = start + count / rate
            state.calls += count
        if wait > 0:
            self._sleep(wait)

    def _sent(self, state, error=None):
        with self._lock:
            if error is None:
                state.failures = 0
            elif str(error) in RETRYABLE:
                state.failures += 1
                pause = min(MAX_COOLDOWN_SECONDS, COOLDOWN_SECONDS * 2 ** (state.failures - 1))
                state.cooling_until = self._clock() + pause

    def _post(self, state, url, body, count):
        self._admit(state, count)
        try:
            payload = self._send(url, body)
        except DataError as error:
            self._sent(state, error)
            raise
        self._sent(state)
        return payload

    def _windows(self, endpoint, item):
        """An eth_getLogs block range split to the endpoint's limit, or None."""
        limit = endpoint.max_log_blocks
        if limit is None or not isinstance(item, dict) or item.get('method') != 'eth_getLogs':
            return None
        params = item.get('params')
        if not isinstance(params, list) or len(params) != 1 or not isinstance(params[0], dict):
            return None
        try:
            start, end = quantity(params[0].get('fromBlock')), quantity(params[0].get('toBlock'))
        except DataError:
            return None  # a tag or a blockHash filter goes as it is
        if end - start < limit:
            return None  # within the limit, or an empty range the provider answers itself
        if -(-(end - start + 1) // limit) > MAX_LOG_WINDOWS:
            raise DataError('v2_log_range_too_wide')
        return [(low, min(end, low + limit - 1)) for low in range(start, end + 1, limit)]

    def __call__(self, url, body):
        state = self._states.get(url)
        if state is None:
            raise DataError('v2_rpc_endpoint_unknown')
        endpoint = state.endpoint
        single = isinstance(body, dict)
        items = [body] if single else list(body)
        plans = [self._windows(endpoint, item) for item in items]
        if single and plans[0] is None:
            return self._post(state, url, body, 1)
        # Every part gets its own id; the reply is put back in the caller's shape.
        parts, owners = [], []
        for index, (item, windows) in enumerate(zip(items, plans)):
            for window in windows or [None]:
                part = deepcopy(item)
                if window is not None:
                    part['params'][0].update(fromBlock=hex(window[0]), toBlock=hex(window[1]))
                part['id'] = len(parts) + 1
                parts.append(part)
                owners.append(index)
        replies = {}
        for low in range(0, len(parts), endpoint.max_batch_items):
            chunk = parts[low:low + endpoint.max_batch_items]
            payload = self._post(state, url, chunk, len(chunk))
            if not isinstance(payload, list):
                raise DataError('invalid_rpc_envelope')
            for reply in payload:
                if (not isinstance(reply, dict) or type(reply.get('id')) is not int
                        or not low < reply['id'] <= low + len(chunk) or reply['id'] in replies):
                    raise DataError('invalid_rpc_envelope')
                replies[reply['id']] = reply
        if len(replies) != len(parts):
            raise DataError('invalid_rpc_envelope')
        merged = []
        for index, item in enumerate(items):
            mine = [replies[part['id']] for part, owner in zip(parts, owners) if owner == index]
            failed = next((reply for reply in mine if 'error' in reply), None)
            if failed is not None:
                merged.append({'jsonrpc': '2.0', 'id': item.get('id'), 'error': failed['error']})
            elif plans[index] is None:
                merged.append({**mine[0], 'id': item.get('id')})
            else:
                if any(not isinstance(reply.get('result'), list) for reply in mine):
                    raise DataError('invalid_rpc_envelope')
                merged.append({'jsonrpc': '2.0', 'id': item.get('id'),
                               'result': [log for reply in mine for log in reply['result']]})
        return merged[0] if single else merged


def configured_endpoints(chain, *, provider_config=None, chain_rpc_config=None, **kwargs):
    """The endpoints a service on `chain` reads through, in order: a balance chain's come from the balance chain RPC
    file, loaded against the balance registry."""
    if not isinstance(chain, PROFILES):
        raise DataError('v2_chain_profile_required')
    if chain.chainId == CHAIN_ID:
        return ChainEndpoints(chain, provider_file_endpoints(chain, provider_config), 'provider_file', **kwargs)
    if not isinstance(chain_rpc_config, ChainRpcConfig) or chain.key not in chain_rpc_config.chains:
        raise DataError('v2_chain_rpc_not_configured')
    return ChainEndpoints(chain, chain_rpc_config.chains[chain.key], 'v2_chain_rpc_file', **kwargs)


# --------------------------------------------------------------------- clients
class _ChainClient:
    """The chain id is the profile's and is never requested (a billed call)."""
    METHODS = ReadRpc.METHODS - {'eth_chainId'}

    def _bind(self, endpoints, chosen):
        self.endpoints, self.chain, self.chain_id = endpoints, endpoints.chain, endpoints.chain.chainId
        self.names, self.code_cache = tuple(e.name for e in chosen), endpoints.code

    def _batch_specs(self, calls):
        specs = super()._batch_specs(calls)
        if any(method not in self.METHODS for method, _ in specs):
            raise DataError('method_not_read_only')
        return specs

    def _switch(self, error):
        self.index += 1
        self.url, self.verified = self.urls[self.index], False
        reason = 'historical_state_unavailable' if isinstance(error, RpcStateUnavailable) else str(error)
        # Endpoint names only; never a URL.
        _LOG.warning('v2_rpc_failover chain=%s endpoint=%s reason=%s', self.chain.key, self.names[self.index], reason)


def _chosen(endpoints, only):
    if not isinstance(endpoints, ChainEndpoints):
        raise DataError('v2_chain_endpoints_required')
    return endpoints, endpoints.select(only)


class ChainReadRpc(_ChainClient, FailoverReadRpc):
    """Current-state reads on one chain. `anchor` is a head the chain's
    follower observed: reads may pin it at once, with no call for the head;
    a switch to another endpoint proves it again."""
    def __init__(self, endpoints, *, anchor=None, only=None, **kwargs):
        endpoints, chosen = _chosen(endpoints, only)
        kwargs.setdefault('transport', endpoints)
        super().__init__(tuple(e.url for e in chosen), **kwargs)
        self._bind(endpoints, chosen)
        if anchor is not None:
            if not isinstance(anchor, Block):
                raise DataError('block_unavailable')
            self._record_block(self.anchors, anchor)
            self.verified = True

    def _verify(self):
        for tag, expected in self.anchors.items():
            if parse_block(ReadRpc.request(self, 'eth_getBlockByNumber', [tag, False])) != expected:
                raise DataError('snapshot_reorganized')
        self.verified = True


class ChainHistoryRpc(_ChainClient, HistoricalReadRpc):
    """Pinned historical reads on one chain, with the history client's bounded
    continuity proof. Each operation starts at the first endpoint that keeps
    the state it reads: on Robinhood the own node within LOCAL_STATE_BLOCKS of
    the head and the fallback beyond, exactly as in V1."""
    def __init__(self, endpoints, *, only=None, **kwargs):
        endpoints, chosen = _chosen(endpoints, only)
        kwargs.setdefault('transport', endpoints)
        super().__init__(tuple(e.url for e in chosen), **kwargs)
        self._bind(endpoints, chosen)
        self._state_blocks = tuple(e.state_blocks for e in chosen)

    def _verify(self):
        if self.anchors:
            expected = max(self.anchors.values(), key=lambda block: block.number)
            if parse_block(ReadRpc.request(self, 'eth_getBlockByNumber', [expected.tag, False])) != expected:
                raise DataError('snapshot_reorganized')
        self.verified = True

    def _start(self, calls):
        if not self.anchors:
            return 0
        head = max(block.number for block in self.anchors.values())
        depth = 0
        for _, params in calls:
            try:
                depth = max(depth, head - quantity(params[-1] if params else None))
            except DataError:
                pass  # not a numeric state block: headers, logs and EIP-1898 pins
        return next((index for index, kept in enumerate(self._state_blocks) if kept is None or depth <= kept), 0)

    def _begin_operation(self, calls):
        if self._operation_depth == 0 and not self.failure:
            start = self._start(calls)
            if self.index != start:
                self.index = start
                self.url, self.verified = self.urls[start], False
        self._operation_depth += 1


class ChainIndexRpc(ChainHistoryRpc):
    """A history client that also reads logs, for indexers. A range wider than
    an endpoint admits is split by the transport."""
    METHODS = ChainHistoryRpc.METHODS | {'eth_getLogs'}
    MAX_BATCH_ITEMS = 100


# ----------------------------------------------------------------------- check
def batched_reads(rpc, specs):
    """Independent reads, one envelope per MAX_BATCH_ITEMS when the client
    batches, else one request each. A refused item comes back in its place."""
    if getattr(rpc, 'batch_reads', False) is not True:
        return [rpc.request(method, params) for method, params in specs]
    results = []
    for start in range(0, len(specs), rpc.MAX_BATCH_ITEMS):
        results.extend(rpc.batch(specs[start:start + rpc.MAX_BATCH_ITEMS], item_errors=True))
    return results


def _codehash(raw):
    code = prefetched(raw)
    if type(code) is not str or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', code):
        raise DataError('invalid_code_response')
    return None if code == '0x' else '0x' + keccak(bytes.fromhex(code[2:])).hex()


def check_endpoint(endpoints, endpoint, *, clock=None):
    """Prove one provisioned endpoint: its chain id (the one eth_chainId V2
    sends), a fresh head, the code hash of every contract the profile verified
    at that head, and, for an archive endpoint, the profile's code at the
    profile's own verification block. Read-only; the report names no URL."""
    chain = endpoints.chain
    reply = endpoints(endpoint.url, {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_chainId', 'params': []})
    if not isinstance(reply, dict) or 'result' not in reply or quantity(reply['result']) != chain.chainId:
        raise DataError('wrong_chain')
    rpc = ChainReadRpc(endpoints, only=endpoint.name, batch_reads=True,
                       max_requests=2 * len(chain.verification.contracts) + 8)
    head = parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))
    records = chain.verification.contracts
    codes = batched_reads(rpc, [('eth_getCode', [record.address, head.tag]) for record in records])
    contracts = {record.name: 'match' if _codehash(raw) == record.codehash else 'mismatch'
                 for record, raw in zip(records, codes)}
    rpc.request('eth_getBlockByNumber', [head.tag, False])  # the head is still canonical
    report = {'endpoint': endpoint.name, 'archive': endpoint.archive, 'block': head.number,
              'headAgeSeconds': int((clock or time.time)()) - head.timestamp, 'contracts': contracts}
    if endpoint.archive:
        history = ChainHistoryRpc(endpoints, only=endpoint.name, max_requests=8)
        probe = chain.uniswap.v4.poolManager
        observed = _codehash(history.request('eth_getCode', [probe, hex(chain.verification.block)]))
        report['archiveProbe'] = 'match' if observed == chain.verified_codehash(probe) else 'mismatch'
    report['ok'] = (all(status == 'match' for status in contracts.values())
                    and -15 <= report['headAgeSeconds'] <= CHECK_MAX_HEAD_AGE_SECONDS
                    and report.get('archiveProbe', 'match') == 'match')
    return report


def named_chain(name):
    """The profile `name` names, and the registry its RPC file is read against: a Domino chain's, else a balance
    chain's (`ethereum-1`, `optimism-10`)."""
    registry = default_registry()
    try:
        return registry.chain(name), registry
    except DataError as error:
        if str(error) != 'v2_chain_unknown':
            raise
    balances = default_balance_registry()
    return balances.chain(name), balances


def main(argv=None, *, send=None):
    parser = argparse.ArgumentParser(description='Validate or check Domino V2 chain RPC endpoints.')
    parser.add_argument('command', choices=('validate', 'check'))
    parser.add_argument('--chain', required=True, help='profile name, e.g. base-8453, or a balance chain: ethereum-1')
    parser.add_argument('--chain-rpc-file', help='the private V2 chain RPC file (chains other than Robinhood), or the '
                                                 'balance chain RPC file for ethereum-1 and optimism-10')
    parser.add_argument('--provider-file', default=str(CONFIG_PATH), help='the read path provider file (Robinhood)')
    parser.add_argument('--endpoint', help='check only this endpoint')
    args = parser.parse_args(argv)
    options = {} if send is None else {'send': send}
    try:
        chain, registry = named_chain(args.chain)
        if chain.chainId == CHAIN_ID:
            endpoints = configured_endpoints(chain, provider_config=load_config(args.provider_file), **options)
        else:
            if not args.chain_rpc_file:
                raise DataError('v2_chain_rpc_not_configured')
            endpoints = configured_endpoints(
                chain, chain_rpc_config=load_chain_rpc_config(args.chain_rpc_file, registry), **options)
        selected = [e for e in endpoints.endpoints if args.endpoint in (None, e.name)]
        if not selected:
            raise DataError('v2_rpc_endpoint_unknown')
        if args.command == 'validate':
            report = {'chain': chain.key, 'source': endpoints.source,
                      'endpoints': [{'name': e.name, 'host': e.host, 'archive': e.archive,
                                     'maxBatchItems': e.max_batch_items, 'maxLogBlocks': e.max_log_blocks,
                                     'requestsPerSecond': e.requests_per_second} for e in selected]}
        else:
            results = []
            for endpoint in selected:
                try:
                    with read_deadline(CHECK_DEADLINE_SECONDS):
                        results.append(check_endpoint(endpoints, endpoint))
                except DataError as error:
                    results.append({'endpoint': endpoint.name, 'error': str(error), 'ok': False})
            report = {'chain': chain.key, 'source': endpoints.source, 'endpoints': results,
                      'calls': endpoints.calls(), 'ok': all(result['ok'] for result in results)}
    except DataError as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report.get('ok', True) else 1


if __name__ == '__main__':
    sys.exit(main())
