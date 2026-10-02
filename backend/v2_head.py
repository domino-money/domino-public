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

A ChainReadRpc seeded with the head (v2_rpc, `anchor=`) spends no call on it.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import tempfile
import threading
import time

from discovery import Block, DataError, bytes32, parse_block, quantity
from v2_rpc import ChainEndpoints

MAX_SHARED_BYTES = 4096


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

    def head(self):
        head = self._head
        if self._fresh(head):
            return head
        with self._lock:
            if self._fresh(self._head):
                return self._head
            if self.shared_path is None:
                self._head = self._poll()
                return self._head
            shared = self._read_shared()
            if not self._fresh(shared):
                with self._file_lock():
                    shared = self._read_shared()  # another process may have just read it
                    if not self._fresh(shared):
                        shared = self._poll()
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
        rpc = self.endpoints.read_rpc(max_requests=6)
        raw = rpc.request('eth_getBlockByNumber', ['latest', False])
        if self.lag:
            latest = parse_block(raw)
            if latest.number < self.lag:
                raise DataError('block_unavailable')
            raw = rpc.request('eth_getBlockByNumber', [hex(latest.number - self.lag), False])
        block = parse_block(raw)
        fee = raw.get('baseFeePerGas')
        now = self.clock()
        if not -15 <= now - block.timestamp <= self.max_block_age:
            raise DataError('stale_or_future_block')
        self.polls += 1
        return Head(self.chain_id, block, None if fee is None else quantity(fee), now)

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
