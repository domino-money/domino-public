"""Why a vault or a mandate waits, as the V2 automation recorded it (owner, 2 Oct 2026).

The automation (docs/v2/V2_AUTOMATION_BACKEND.md, "Why a vault or a mandate
waits") keeps a `waiting` table in its journal, keyed by (chain_id, kind,
subject), with each subject's latest reason (a fixed code: `too_soon`,
`gas_not_covered`, `trigger_not_reached`, `reverted_<contract error>`, ...),
since when it has held (`since`, `sinceBlock`: the first pass that gave it,
reset when it changes), the head's time and block of the pass that decided it
(`at`, `block`), and the last decoded presimulation revert. After each pass it
writes the same content as one public JSON file per chain (`waitingFile`, kind
`domino-v2-automation-waiting`). The indexer reads that file, never the journal
(v2_indexer, --waiting-file), and keeps it in the V2 index (domino_v2.waiting);
the read API serves it as `waiting: {reason, since, sinceBlock, ...}`
(v2_read_contract).

A file that is missing, too large or malformed in any part is `unavailable` as
a whole, never read in part.
"""
import json
from pathlib import Path
import re

KIND = 'domino-v2-automation-waiting'
MAX_FILE_BYTES = 4_000_000
ENTRY_KEYS = frozenset({'reason', 'since', 'sinceBlock', 'at', 'block', 'lastRevert'})
# The automation's own rule for a recorded code (v2_executor.record_waiting).
_CODE = re.compile(r'[a-z0-9_]{1,100}')
_ADDRESS = re.compile(r'0x[0-9a-f]{40}')
_HASH = re.compile(r'0x[0-9a-f]{64}')


def _uint(value):
    if type(value) is not int or not 0 <= value <= 2**53 - 1:
        raise ValueError('waiting_number')
    return value


def _entry(value):
    if type(value) is not dict or set(value) != ENTRY_KEYS:
        raise ValueError('waiting_entry')
    if type(value['reason']) is not str or not _CODE.fullmatch(value['reason']):
        raise ValueError('waiting_reason')
    revert = value['lastRevert']
    if revert is not None:
        if type(revert) is not dict or set(revert) != {'code', 'at', 'block'} or type(revert['code']) is not str \
                or not _CODE.fullmatch(revert['code']):
            raise ValueError('waiting_revert')
        revert = {'code': revert['code'], 'at': _uint(revert['at']), 'block': _uint(revert['block'])}
    at, block = _uint(value['at']), _uint(value['block'])
    since, since_block = _uint(value['since']), _uint(value['sinceBlock'])
    if since > at or since_block > block:
        raise ValueError('waiting_since')
    return {'reason': value['reason'], 'since': since, 'sinceBlock': since_block, 'at': at, 'block': block,
            'lastRevert': revert}


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('waiting_duplicate_key')
        result[key] = value
    return result


def checked_waiting(document, chain_id):
    """The file's content for `chain_id`, or ValueError."""
    if (type(document) is not dict or set(document) != {'schemaVersion', 'kind', 'chainId', 'block', 'timestamp',
                                                         'vaults', 'mandates'}
            or document['schemaVersion'] != 1 or type(document['schemaVersion']) is not int
            or document['kind'] != KIND or document['chainId'] != chain_id or type(document['chainId']) is not int):
        raise ValueError('waiting_document')
    vaults, mandates = document['vaults'], document['mandates']
    if type(vaults) is not dict or type(mandates) is not dict:
        raise ValueError('waiting_document')
    if any(not _ADDRESS.fullmatch(key) for key in vaults) or any(not _HASH.fullmatch(key) for key in mandates):
        raise ValueError('waiting_subject')
    return {'block': _uint(document['block']), 'timestamp': _uint(document['timestamp']),
            'vaults': {key: _entry(value) for key, value in vaults.items()},
            'mandates': {key: _entry(value) for key, value in mandates.items()}}


def read_waiting_file(path, chain_id):
    """('read', content) or ('unavailable', code) for the automation's file of `chain_id`."""
    try:
        raw = Path(path).read_bytes()
    except OSError:
        return 'unavailable', 'v2_waiting_file_unreadable'
    if len(raw) > MAX_FILE_BYTES:
        return 'unavailable', 'v2_waiting_file_too_large'
    try:
        return 'read', checked_waiting(json.loads(raw, object_pairs_hook=_unique), chain_id)
    except (ValueError, UnicodeError, RecursionError):
        return 'unavailable', 'v2_waiting_file_invalid'


def waiting_rows(content):
    """The rows a file read keeps: (kind, subject) -> {reason, since, since_block,
    at, block, revert, revert_at, revert_block}."""
    out = {}
    for kind, entries in (('vault', content['vaults']), ('mandate', content['mandates'])):
        for subject, entry in entries.items():
            revert = entry['lastRevert']
            out[(kind, subject)] = {
                'reason': entry['reason'], 'since': entry['since'], 'since_block': entry['sinceBlock'],
                'at': entry['at'], 'block': entry['block'], 'revert': None if revert is None else revert['code'],
                'revert_at': None if revert is None else revert['at'],
                'revert_block': None if revert is None else revert['block']}
    return out
