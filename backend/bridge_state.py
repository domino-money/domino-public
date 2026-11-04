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


def client_identity(client):
    """The visitor an edge caller's address stands for: an IPv4 address, or an IPv6 /64."""
    try:
        # Collapse IPv6 /64 to avoid inexpensive per-address budget evasion.
        value = ipaddress.ip_address(client)
        if value.version == 6 and value.ipv4_mapped:
            value = value.ipv4_mapped
        return str(ipaddress.ip_network(f'{value}/64', strict=False)) if value.version == 6 else str(value)
    except (ValueError, TypeError):
        raise DataError('invalid_client_identity') from None


class ClientBudgets:
    """One authoritative process, shared by all edge callers; IPs not stored.

    A full table makes room by dropping its least recently used address, but only one whose budget has refilled
    (3 Nov 2026, launch): until then it refused every new visitor for up to five minutes, whoever filled it. A
    refilled entry says nothing a new one would not, so its address comes back to the same full burst it would have
    found; one still refilling is never dropped, so leaving cannot reset a spent budget. Only while every address
    in the table is still refilling (10,000 of them within the last few seconds) is a new one refused.
    """
    def __init__(self, *, clock=time.monotonic, capacity=10000, burst=5, per_minute=30):
        self.clock, self.capacity = clock, capacity
        self.burst, self.rate = burst, per_minute / 60
        self.secret, self.items, self.lock = secrets.token_bytes(32), OrderedDict(), Lock()

    def _key(self, client):
        return hmac.digest(self.secret, client_identity(client).encode(), 'sha256')

    def retry_after(self, client, *, floor=1, ceiling=10):
        """Seconds until this client holds a whole token again, bounded, never a constant."""
        key = self._key(client)
        with self.lock:
            now = self.clock()
            old = self.items.get(key)
        if old is None:
            return floor
        available = min(self.burst, old[0] + max(0, now - old[1]) * self.rate)
        if available >= 1:
            return floor
        return max(floor, min(ceiling, math.ceil((1 - available) / self.rate)))

    def admit(self, client):
        key = self._key(client)
        with self.lock:
            now = self.clock()
            while self.items and next(iter(self.items.values()))[1] + 300 <= now:
                self.items.popitem(last=False)
            old = self.items.get(key)
            if old is None and len(self.items) >= self.capacity:
                tokens, at = next(iter(self.items.values()))
                if tokens + max(0, now - at) * self.rate < self.burst:
                    return False
                self.items.popitem(last=False)
            available = self.burst if old is None else min(self.burst, old[0] + max(0, now - old[1]) * self.rate)
            accepted = available >= 1
            self.items[key] = (available - 1 if accepted else available, now)
            self.items.move_to_end(key)
            return accepted


class ClientShares:
    """How many reads of one lane each client holds at once; IPs not stored.

    3 Nov 2026 (launch; F-02 of the 21 Oct pentest): a client's budget bounds how often it reads, not how many of its
    reads run together, and the reader's lanes are everyone's. A burst within one address's budget of 30 held all 16
    provider lanes, or all 8 stored ones, and every other visitor was told read_capacity_busy. A client now holds at
    most `share` of a lane at once. Only reads in hand are counted, so the table is never larger than the lanes.
    """
    def __init__(self, share):
        if type(share) is not int or share < 1:
            raise ValueError('invalid_client_share')
        self.share, self.secret, self.held, self.lock = share, secrets.token_bytes(32), {}, Lock()

    def _key(self, client):
        return hmac.digest(self.secret, client_identity(client).encode(), 'sha256')

    def take(self, client):
        key = self._key(client)
        with self.lock:
            held = self.held.get(key, 0)
            if held >= self.share:
                return False
            self.held[key] = held + 1
            return True

    def give(self, client):
        key = self._key(client)
        with self.lock:
            held = self.held.get(key, 0)
            if held < 1:
                raise ValueError('client_share_not_held')
            if held == 1:
                del self.held[key]
            else:
                self.held[key] = held - 1


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
