"""One structured line per served request; never a body, address or credential.

docs/API_READ_BRIDGE.md requires request id, route, contract version, duration,
status, safe reason and the cache/limiter outcome, and forbids JSON bodies,
full addresses/cursors, cookie values, signatures, Access assertions and
upstream payloads. Emission enforces the boundary here rather than trusting
every call site: a fixed key allowlist, scalar values only, bounded text, and
anything shaped like an address or long hex is cut to a short prefix. The
services keep access_log disabled on purpose — raw paths and peers never reach
the journal; this line is the record.

Records go to stderr so a CLI that runs one of these apps in process keeps its
own stdout contract. Retention follows the spec: application diagnostics seven
days, aggregate counts up to thirty.
"""
from contextvars import ContextVar
import json
import re
import sys

# The record's whole vocabulary. A key outside this set is dropped, never
# logged, so a future call site cannot widen the surface by accident.
ALLOWED_KEYS = frozenset((
    'service', 'requestId', 'route', 'contractVersion', 'method', 'status',
    'durationMs', 'reason', 'gate', 'admitted', 'upstreamStatus', 'upstreamMs',
    'budget', 'cache', 'limiter', 'mode'))
LONG_HEX = re.compile(r'0x[0-9a-fA-F]{12,}')
MAX_TEXT = 64
REQUEST_ID = re.compile(r'[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')

_NOTES = ContextVar('domino_hop_notes', default=None)


def safe_value(value):
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if -2**53 < value < 2**53 else str(value)[:MAX_TEXT]
    text = LONG_HEX.sub(lambda match: match.group()[:8] + '…', str(value))
    return text[:MAX_TEXT]


def checked_request_id(value):
    """A propagated id is transport metadata: exact shapes only, never echoed raw."""
    return value if isinstance(value, str) and REQUEST_ID.fullmatch(value) else None


def open_notes():
    return _NOTES.set({})


def note(**fields):
    current = _NOTES.get()
    if current is not None:
        current.update(fields)


def close_notes(token):
    notes = _NOTES.get() or {}
    _NOTES.reset(token)
    return notes


def emit(**fields):
    record = {key: safe_value(value) for key, value in fields.items()
              if key in ALLOWED_KEYS and value is not None}
    # stderr, not stdout: several CLIs build these apps in process and their
    # callers parse stdout as one JSON document. Both streams reach the journal.
    print(json.dumps(record, separators=(',', ':'), allow_nan=False), file=sys.stderr, flush=True)
