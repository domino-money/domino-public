"""The latest head of one V2 chain, read once and shared by every service.

Hosted RPC bills every call, and on Robinhood most of today's calls are head,
code and chain-id polling. So a V2 service never polls the head for itself: it
asks its chain's HeadFollower, which returns the head it holds while that is
younger than max_age_seconds, and otherwise reads it once for every caller.
With a shared file, every process of the host shares one head: the first to
find the file older than max_age_seconds takes the file's lock, reads the head
and replaces the file, and the others read the file. The file holds public
chain data only (number, hash, timestamp, base fee and when it was read).

A head is refused, as V1's reader refuses it, when its block is more than
max_block_age_seconds old: a stalled node is unavailable, never current.
`lag_blocks` serves the block that many below the latest, for providers that
balance requests across nodes, where a block one node has just produced may be
missing on the next: a read pinned slightly below the latest finds it on every
node. That costs a second call per poll.

An endpoint is judged by its own head. The endpoints are asked in order, as a
client fails over (v2_rpc: a transport failure cools one down), and the first
current head is served. One whose head is outside the window, behind or ahead
of this clock, is set aside: the chain's clients pass over it, so a pass reads,
presimulates and sends where its head came from. On 9 Oct 2026 Domino's node
came back from a hard power-off about 520,000 blocks behind, answering every
call, and every V2 pass on Robinhood refused its head for 38 minutes while
Alchemy, the next endpoint, was current. A poll asks a set-aside endpoint again
before the next, and takes it back once its head is current; the head may then
move back once, by less than max_block_age_seconds, as after a transport
failover. An endpoint after the one serving keeps its standing until a poll
reaches it. Only when no endpoint has a current head is the head refused, and
that refusal holds for max_age_seconds, so a stalled chain costs a round of
calls per max_age_seconds, not one per caller. While its clients pass over a
set-aside endpoint, a process neither shares its head (another process's
clients would not pass over that endpoint) nor reads the shared one: it reads
the head itself until it takes the endpoint back.

A ChainReadRpc seeded with the head (v2_rpc, `anchor=`) spends no call on it.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import logging
import os
from pathlib import Path
import tempfile
import threading
import time

from discovery import Block, DataError, bytes32, parse_block, quantity
from rpc_failover import RETRYABLE
from v2_rpc import ChainEndpoints

MAX_SHARED_BYTES = 4096
_LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class Head:
    chain_id: int
    block: Block
    base_fee_per_gas: int | None
    observed_at: float  # wall-clock seconds when it was read, comparable across processes


class HeadFollower:
    def __init__(self, endpoints, *, max_age_seconds, lag_blocks=0, max_block_age_seconds=120,
                 shared_path=None, clock=time.time):
        if (not isinstance(endpoints, ChainEndpoints) or type(max_age_seconds) not in (int, float)
                or not 0 < max_age_seconds <= 600 or type(lag_blocks) is not int or not 0 <= lag_blocks <= 10000
                or type(max_block_age_seconds) is not int or not max_age_seconds < max_block_age_seconds <= 3600):
            raise DataError('invalid_v2_head_follower')
        self.endpoints, self.chain_id = endpoints, endpoints.chain.chainId
        self.max_age, self.lag, self.max_block_age = max_age_seconds, lag_blocks, max_block_age_seconds
        self.shared_path = Path(shared_path) if shared_path is not None else None
        self.clock, self.polls = clock, 0
        self._head, self._lock = None, threading.Lock()
        self._refused_at = None  # when a poll last found no current head

    def head(self):
        head = self._head
        if self._fresh(head):
            return head
        with self._lock:
            if self._fresh(self._head):
                return self._head
            if self._refused_at is not None and -5 <= self.clock() - self._refused_at <= self.max_age:
                raise DataError('stale_or_future_block')
            if self.shared_path is None or self.endpoints.passes_over():
                self._head = self._poll()
                return self._head
            shared = self._read_shared()
            if not self._fresh(shared):
                with self._file_lock():
                    shared = self._read_shared()  # another process may have just read it
                    if not self._fresh(shared):
                        shared = self._poll()
                        if not self.endpoints.passes_over():
                            self._write_shared(shared)
            self._head = shared
            return shared

    def _fresh(self, head):
        if head is None:
            return False
        now = self.clock()
        return (-5 <= now - head.observed_at <= self.max_age
                and -15 <= now - head.block.timestamp <= self.max_block_age)

    def _poll(self):
        """The first current head of the endpoints, asked in order. Its endpoint
        is taken back if it was set aside, those whose heads were outside the
        window are set aside, and every other keeps its standing."""
        candidates = self.endpoints.head_candidates()
        if not candidates:
            raise DataError('v2_rpc_endpoints_cooling')
        outside, ages, failure = [], {}, None
        for position, endpoint in enumerate(candidates):
            try:
                raw = self._latest(endpoint)
            except DataError as error:
                if str(error) not in RETRYABLE:
                    raise
                # The transport cooled it down: the next one is asked, as a client fails over.
                failure = error
                if position + 1 < len(candidates):
                    _LOG.warning('v2_rpc_failover chain=%s endpoint=%s reason=%s', self.endpoints.chain.key,
                                 candidates[position + 1].name, error)
                continue
            block = parse_block(raw)
            now = self.clock()
            if -15 <= now - block.timestamp <= self.max_block_age:
                self._settle(endpoint, outside, ages)
                self.polls += 1
                fee = raw.get('baseFeePerGas')
                return Head(self.chain_id, block, None if fee is None else quantity(fee), now)
            outside.append(endpoint)
            ages[endpoint.name] = int(now - block.timestamp)
        if outside:
            self._refused_at = self.clock()
            raise DataError('stale_or_future_block')
        raise failure

    def _latest(self, endpoint):
        """The endpoint's latest header, or the one lag_blocks below it."""
        rpc = self.endpoints.read_rpc(only=endpoint.name, max_requests=2)
        raw = rpc.request('eth_getBlockByNumber', ['latest', False])
        if self.lag:
            latest = parse_block(raw)
            if latest.number < self.lag:
                raise DataError('block_unavailable')
            raw = rpc.request('eth_getBlockByNumber', [hex(latest.number - self.lag), False])
        return raw

    def _settle(self, current, outside, ages):
        aside = ({e.url for e in self.endpoints.aside()} - {current.url}) | {e.url for e in outside}
        added, restored = self.endpoints.set_aside([e for e in self.endpoints.endpoints if e.url in aside])
        for name in added:
            _LOG.warning('v2_head_set_aside chain=%s endpoint=%s head_age_seconds=%d', self.endpoints.chain.key,
                         name, ages[name])
        for name in restored:
            _LOG.warning('v2_head_taken_back chain=%s endpoint=%s', self.endpoints.chain.key, name)

    @contextmanager
    def _file_lock(self):
        with open(str(self.shared_path) + '.lock', 'a') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _read_shared(self):
        """The shared head, or None when it is absent or not a valid head of this chain."""
        try:
            with open(self.shared_path, 'rb') as stream:
                raw = stream.read(MAX_SHARED_BYTES + 1)
            if len(raw) > MAX_SHARED_BYTES:
                return None
            data = json.loads(raw)
            if (type(data) is not dict
                    or set(data) != {'chainId', 'number', 'hash', 'timestamp', 'baseFeePerGas', 'observedAt'}
                    or type(data['chainId']) is not int or data['chainId'] != self.chain_id
                    or type(data['number']) is not int or type(data['timestamp']) is not int
                    or type(data['observedAt']) not in (int, float)
                    or data['baseFeePerGas'] is not None and type(data['baseFeePerGas']) is not int):
                return None
            block = Block(data['number'], bytes32(data['hash']), data['timestamp'])
            if block.number < 0 or block.timestamp < 0:
                return None
            return Head(self.chain_id, block, data['baseFeePerGas'], data['observedAt'])
        except (OSError, ValueError, UnicodeError):
            return None

    def _write_shared(self, head):
        data = {'chainId': head.chain_id, 'number': head.block.number, 'hash': head.block.hash,
                'timestamp': head.block.timestamp, 'baseFeePerGas': head.base_fee_per_gas,
                'observedAt': head.observed_at}
        fd, temporary = tempfile.mkstemp(prefix='.head-', dir=self.shared_path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(data, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o644)  # public chain data, read by the host's other services
            os.replace(temporary, self.shared_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
