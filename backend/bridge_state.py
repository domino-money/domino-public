"""Bounded state for one read gateway. Never authentication or durable holdings."""
from collections import OrderedDict
import base64
import hashlib
import hmac
import ipaddress
import json
import math
import re
import secrets
from threading import Lock
import time

from discovery import CHAIN_ID, ZERO, DataError, address


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate_key')
            result[key] = value
        return result

    def constant(_):
        raise ValueError('nonfinite')
    def number(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError('nonfinite')
        return parsed
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant, parse_float=number)
    except (ValueError, UnicodeError, RecursionError, TypeError):
        raise DataError('invalid_request') from None


class ClientBudgets:
    """One authoritative process, shared by all edge callers; IPs not stored."""
    def __init__(self, *, clock=time.monotonic, capacity=10000, burst=5, per_minute=30):
        self.clock, self.capacity = clock, capacity
        self.burst, self.rate = burst, per_minute / 60
        self.secret, self.items, self.lock = secrets.token_bytes(32), OrderedDict(), Lock()

    def admit(self, client):
        try:
            # Collapse IPv6 /64 to avoid inexpensive per-address budget evasion.
            value = ipaddress.ip_address(client)
            if value.version == 6 and value.ipv4_mapped:
                value = value.ipv4_mapped
            identity = str(ipaddress.ip_network(f'{value}/64', strict=False)) if value.version == 6 else str(value)
        except (ValueError, TypeError):
            raise DataError('invalid_client_identity') from None
        key = hmac.digest(self.secret, identity.encode(), 'sha256')
        with self.lock:
            now = self.clock()
            while self.items and next(iter(self.items.values()))[1] + 300 <= now:
                self.items.popitem(last=False)
            old = self.items.get(key)
            if old is None and len(self.items) >= self.capacity:
                return False
            available = self.burst if old is None else min(self.burst, old[0] + max(0, now - old[1]) * self.rate)
            accepted = available >= 1
            self.items[key] = (available - 1 if accepted else available, now)
            self.items.move_to_end(key)
            return accepted


def cursor_context(body):
    if body.get('autoDiscover', True) is not True:
        raise DataError('invalid_or_expired_cursor')
    wallet = address(body['wallet'])
    tokens = sorted(set(address(v) for v in body.get('tokens', [])) - {ZERO})
    return wallet, tokens


class OpaqueCursors:
    def __init__(self, *, clock=time.time, capacity=2048):
        self.clock, self.capacity = clock, capacity
        self.items, self.generation, self.lock = {}, None, Lock()

    def observe_generation(self, generation):
        if not isinstance(generation, str) or not re.fullmatch(r'[0-9a-f]{32}', generation):
            raise DataError('upstream_invalid_response')
        with self.lock:
            if self.generation != generation:
                self.items.clear()
                self.generation = generation

    def unwrap(self, handle, body):
        if not isinstance(handle, str) or not re.fullmatch(r'[0-9a-f]{64}', handle):
            raise DataError('invalid_or_expired_cursor')
        context = cursor_context(body)
        with self.lock:
            self._expire()
            entry = self.items.get(hashlib.sha256(handle.encode()).digest())
            if entry is None or entry[1] != context or entry[3] != self.generation:
                raise DataError('invalid_or_expired_cursor')
            return entry[0]

    def _expire(self):
        now = self.clock()
        for key in [key for key, entry in self.items.items() if entry[2] <= now]:
            del self.items[key]

    def wrap(self, internal, body):
        context = cursor_context(body)
        try:
            if not isinstance(internal, str) or len(internal) > 4096:
                raise ValueError()
            raw, signature = internal.split('.')
            if not re.fullmatch(r'[A-Za-z0-9_-]+', raw) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', signature):
                raise ValueError()
            data = strict_json(base64.urlsafe_b64decode(raw + '=' * (-len(raw) % 4)))
            expires = data['expires']
            if (type(expires) is not int or not self.clock() < expires <= self.clock() + 300 or
                    data.get('v') != 1 or data.get('chain') != CHAIN_ID or
                    (data.get('wallet'), data.get('tokens')) != context):
                raise ValueError()
        except (ValueError, KeyError, TypeError, DataError):
            raise DataError('upstream_invalid_response') from None
        with self.lock:
            self._expire()
            if self.generation is None:
                raise DataError('upstream_unavailable')
            if len(self.items) >= self.capacity:
                raise DataError('read_capacity_busy')
            handle = secrets.token_hex(32)
            self.items[hashlib.sha256(handle.encode()).digest()] = (internal, context, expires, self.generation)
            return handle
