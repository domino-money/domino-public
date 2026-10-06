"""Shared Domino V2 backend fixtures: profile copies and a fake chain.

The real profiles record the code hashes of the deployed contracts. A fake
chain cannot serve code with those hashes, so tests that prove code use a copy
of a profile whose verified hashes are those of synthetic code the fake serves.
The fake answers eth_call from handlers registered against the frozen V2 ABI
exports, so a call reaches a handler only if its selector and argument types
are exactly the exported ones.
"""
import copy
import json
from pathlib import Path
import sys

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from v2_chains import load_balance_registry, load_registry  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CHAINS = ROOT / 'api-contracts/v2/chains'
BALANCE_CHAINS = ROOT / 'api-contracts/v2/balance-chains'
HEAD = {'number': '0x64', 'hash': '0x' + 'ab' * 32, 'timestamp': '0x6500'}


def documents():
    return {path.name: json.loads(path.read_text()) for path in sorted(CHAINS.glob('*.json'))}


def balance_documents():
    return {path.name: json.loads(path.read_text()) for path in sorted(BALANCE_CHAINS.glob('*.json'))}


def write_registry(directory, docs):
    directory = Path(directory)
    for name, document in docs.items():
        (directory / name).write_text(json.dumps(document, indent=2))
    return load_registry(directory)


def write_balance_registry(directory, docs, domino=None):
    directory = Path(directory)
    for name, document in docs.items():
        (directory / name).write_text(json.dumps(document, indent=2))
    return load_balance_registry(directory, domino=domino)


def synthetic_code(contract):
    """Distinct runtime bytes per address: PUSH20 <address>, POP, STOP."""
    return '0x73' + contract[2:].lower() + '5000'


def code_hash(code):
    return '0x' + keccak(bytes.fromhex(code[2:])).hex()


def with_synthetic_code(document, *, replace=None):
    """The profile with every verified hash that of synthetic_code. `replace`
    maps a checksummed profile address to another, everywhere it appears."""
    text = json.dumps(document)
    for old, new in (replace or {}).items():
        text = text.replace(old, new)
    document = json.loads(text)
    for record in document['verification']['contracts']:
        if not record.get('absent'):
            record['codehash'] = code_hash(synthetic_code(record['address']))
    deployer = document.get('deployer')  # a balance chain's profile has none
    if deployer is not None:
        deployer['codehash'] = next(record['codehash'] for record in document['verification']['contracts']
                                    if record['address'] == deployer['address'])
    return document


class Revert(Exception):
    """Raised by a handler: the fake answers with an execution-reverted error."""


class FakeChain:
    """A JSON-RPC transport over a scripted chain, single requests and batches."""

    def __init__(self, chain_id, *, head=HEAD):
        self.chain_id, self.head = chain_id, dict(head)
        self.chain_ids, self.blocks, self.codes, self.handlers = {}, {}, {}, {}
        self.fail, self.log, self.envelopes = {}, [], 0
        # Per URL: the widest log range and batch it admits, and the lowest
        # block whose state it still keeps (a pruned node).
        self.log_limits, self.batch_limits, self.pruned_below = {}, {}, {}
        self.logs, self.codes_at = [], {}  # codes_at: (address, block tag) -> code there
        # A call budget: once `budget` calls were answered (each of a batch counted, as providers bill them), any
        # further call fails the test instead of being answered. None: no budget.
        self.budget = None

    def serve_code(self, profile_document):
        for record in profile_document['verification']['contracts']:
            if not record.get('absent'):
                self.codes[record['address'].lower()] = synthetic_code(record['address'])

    def on(self, target, fn, handler):
        """Answer `fn` (a v2_abi Function) at `target` with handler(*arguments)."""
        self.handlers[(target.lower(), fn.selector)] = (fn, handler)

    def block(self, tag):
        if tag in self.blocks:
            return self.blocks[tag]
        if tag in ('latest', self.head['number']):
            return self.head
        return None

    def __call__(self, url, body):
        self.envelopes += 1
        if isinstance(body, list):
            if len(body) > self.batch_limits.get(url, 10**6):
                raise AssertionError('batch above the endpoint limit reached the provider')
            return [self.answer(url, item) for item in body]
        return self.answer(url, body)

    def calls(self, method=None):
        return [entry for entry in self.log if method in (None, entry[1])]

    def answer(self, url, body):
        method, params = body['method'], body['params']
        if self.budget is not None and len(self.log) >= self.budget:
            raise AssertionError(f'call {len(self.log) + 1} ({method}) is past the budget of {self.budget}')
        self.log.append((url, method, copy.deepcopy(params)))
        failure = self.fail.get((url, method))
        if failure:
            from discovery import DataError
            raise DataError(failure)
        reply = {'jsonrpc': '2.0', 'id': body['id']}
        if method == 'eth_chainId':
            reply['result'] = hex(self.chain_ids.get(url, self.chain_id))
        elif method == 'eth_getBlockByNumber':
            reply['result'] = copy.deepcopy(self.block(params[0]))
        elif method in ('eth_getCode', 'eth_call') and self._pruned(url, params[-1]):
            reply['error'] = {'code': -32000, 'message': 'missing trie node ' + 'a' * 64 + ' (path 00) not available'}
        elif method == 'eth_getCode':
            reply['result'] = self.codes_at.get(tuple(params), self.codes.get(params[0], '0x'))
        elif method == 'eth_getBalance':
            reply['result'] = '0x0'
        elif method == 'eth_getLogs':
            query = params[0]
            if 'blockHash' in query:
                reply['result'] = []
                return reply
            low, high = (int(self.head['number'] if query[key] == 'latest' else query[key], 16)
                         for key in ('fromBlock', 'toBlock'))
            if high - low + 1 > self.log_limits.get(url, 10**12):
                reply['error'] = {'code': -32005, 'message': 'block range too large'}
            else:
                reply['result'] = [log for log in self.logs if low <= int(log['blockNumber'], 16) <= high]
        elif method == 'eth_call':
            target, data = params[0]['to'], params[0]['data']
            fn, handler = self.handlers.get((target, data[:10]), (None, None))
            if fn is None:
                reply['result'] = '0x'  # no code there, as a real node answers
                return reply
            arguments = decode(list(fn.inputs), bytes.fromhex(data[10:]))
            try:
                values = handler(*arguments)
            except Revert:
                reply['error'] = {'code': 3, 'message': 'execution reverted', 'data': '0x08c379a0'}
                return reply
            reply['result'] = '0x' + encode(list(fn.outputs), list(values)).hex()
        else:
            raise AssertionError(method)
        return reply

    def _pruned(self, url, tag):
        return (url in self.pruned_below and isinstance(tag, str) and tag.startswith('0x')
                and int(tag, 16) < self.pruned_below[url])
