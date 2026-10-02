"""Shared V2 index fixtures: event logs encoded from the frozen ABIs, a fake
chain that serves blocks, logs and receipts and can reorganize, and a
deployment manifest in #302's format (v2_manifest) whose addresses are
CreateX's CREATE3 addresses.
"""
import copy
from dataclasses import replace
import json
from pathlib import Path
import sys

from eth_abi import encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from v2_chains import default_registry  # noqa: E402
from v2_manifest import (CONTRACT_NAMES, CREATE_X, CREATE_X_CODE_HASH, DEPLOY_ORDER, POLICIES, canonical,  # noqa: E402
                         predict, profile_dependencies)
from v2_events import catalog  # noqa: E402

DEPLOYER = '0x' + '5d' * 20
GOVERNANCE, GUARDIAN, FEE_RECIPIENT = '0x' + '61' * 20, '0x' + '62' * 20, '0x' + '63' * 20
OPERATOR, PUBLISHER = '0x' + '64' * 20, '0x' + '65' * 20


def synthetic_runtime(address):
    """Distinct runtime bytes per component: PUSH20 <address>, POP, STOP."""
    return '0x73' + address[2:] + '5000'


def code_hash(code):
    return '0x' + keccak(bytes.fromhex(code[2:])).hex()


def addresses(deployer=DEPLOYER):
    return predict(deployer)[0]


def build(chain_key='robinhood-4663', source_hashes=None):
    """A build record in the deployment tool's shape."""
    import hashlib
    sources = source_hashes or {'src/v2/DominoV2Types.sol': 'ab' * 32}
    return {'version': '0.8.26+commit.8a97fa7a', 'optimizerRuns': 200, 'viaIR': True, 'evmVersion': 'cancun',
            'bytecodeHash': 'none', 'sourceTreeSha256': hashlib.sha256(canonical(sources).encode()).hexdigest(),
            'workingTreeSourceChanges': False, 'sourceHashes': sources, 'chainProfileSha256': 'cd' * 32}


def manifest(chain_key='robinhood-4663', *, deployer=DEPLOYER, receipts=None, codes=None,
             environment='public-chain-preparation', block_tag='finalized', chain=None):
    """A deployment manifest in the shape scripts/v2/deploy.mjs writes (#301).
    `receipts` maps each component to (block number, block hash, tx hash);
    without them the manifest is only prepared. `chain` overrides the profile."""
    chain = chain or default_registry().chain(chain_key)
    contracts, salts, guarded = predict(deployer)
    codes = codes or {c: synthetic_runtime(a) for c, a in contracts.items()}
    dependencies = profile_dependencies(chain)
    hashes = {c: code_hash(code) for c, code in codes.items()}
    hashes.update({name: chain.verified_codehash(value) for name, value in dependencies.items()})
    document = {
        'schemaVersion': 1, 'kind': 'domino-v2-deployment', 'status': 'prepared', 'environment': environment,
        'chain': {'name': chain.name, 'chainId': chain.chainId, 'nativeCurrency': chain.nativeSymbol},
        'sourceCommit': 'a' * 40, 'releaseTag': 'v2-test',
        'contractNames': dict(CONTRACT_NAMES), 'contracts': contracts, 'dependencies': dependencies,
        'roles': {'deployer': deployer, 'governance': GOVERNANCE, 'guardian': GUARDIAN,
                  'feeRecipient': FEE_RECIPIENT, 'operator': OPERATOR, 'publisher': PUBLISHER},
        'policies': dict(POLICIES),
        'chargeCurrencies': [{'token': c.address, 'rank': c.rank} for c in chain.chargeCurrencies],
        'runtimeCodeHashes': hashes,
        'createx': {'address': CREATE_X, 'runtimeCodeHash': CREATE_X_CODE_HASH, 'salts': salts, 'guardedSalts': guarded},
        'build': build(chain_key), 'deploymentReceipts': {}, 'verification': None,
    }
    if receipts:
        last = max(number for number, _, _ in receipts.values())
        document.update(status='verified', deploymentReceipts={
            c: {'transactionHash': receipts[c][2], 'blockNumber': receipts[c][0], 'blockHash': receipts[c][1],
                'gasUsed': '1000000', 'effectiveGasPrice': '1000000000'} for c in DEPLOY_ORDER},
            verification={'blockNumber': last, 'blockHash': receipts[DEPLOY_ORDER[-1]][1], 'blockTag': block_tag,
                          'codeHashes': 'exact_precomputed_immutable_runtime', 'wiring': 'checked',
                          'checkedAt': '2026-10-02T12:00:00.000Z'})
    return document


def _event(emitter, name):
    for event in catalog().by_kind[emitter].values():
        if event.name == name:
            return event
    raise KeyError(name)


def _abi_value(parameter, value):
    if parameter.components:
        return tuple(_abi_value(child, value[child.name]) for child in parameter.components)
    if parameter.type in ('bytes', 'bytes32'):
        return bytes.fromhex(value[2:])
    return value


def _topic(parameter, value):
    return '0x' + encode([parameter.type], [_abi_value(parameter, value)]).hex()


def encode_log(emitter, name, args, *, address, block_number, block_hash, tx_hash, log_index, tx_index=0):
    """A raw eth_getLogs entry for the named event of that emitter kind."""
    event = _event(emitter, name)
    topics = [event.topic0] + [_topic(p, args[p.name]) for p in event.inputs if p.indexed]
    plain = [p for p in event.inputs if not p.indexed]
    data = encode([p.type for p in plain], [_abi_value(p, args[p.name]) for p in plain]) if plain else b''
    return {'address': address, 'topics': topics, 'data': '0x' + data.hex(), 'blockNumber': hex(block_number),
            'blockHash': block_hash, 'transactionHash': tx_hash, 'transactionIndex': hex(tx_index),
            'logIndex': hex(log_index), 'removed': False}


def block_hash(number, branch=0):
    return '0x' + keccak(f'block:{number}:{branch}'.encode()).hex()


def tx_hash(label):
    return '0x' + keccak(f'tx:{label}'.encode()).hex()


class IndexChain:
    """A JSON-RPC transport over a scripted chain. Blocks have hashes per
    branch; logs are (block number, emitter kind, event, args, address, tx
    label) entries placed on a branch. `reorg(number)` moves every block from
    `number` on to a new branch and drops their logs."""

    def __init__(self, head=100, timestamp0=1_790_000_000, block_time=1, finalized_lag=0):
        self.head, self.timestamp0, self.block_time = head, timestamp0, block_time
        self.finalized_lag = finalized_lag
        self.branch = {}  # number -> branch id (default 0)
        self.entries = []  # (number, branch, raw log without hash)
        self.codes, self.calls, self.receipts = {}, {}, {}
        self.log = []
        self.fail = {}

    # -- chain
    def hash(self, number):
        return block_hash(number, self.branch.get(number, 0))

    def header(self, number):
        if number > self.head:
            return None
        return {'number': hex(number), 'hash': self.hash(number), 'timestamp': hex(self.timestamp0 + number * self.block_time),
                'parentHash': self.hash(number - 1) if number else '0x' + '00' * 32}

    def mine(self, count=1):
        self.head += count

    def reorg(self, number, *, branch=None):
        branch = branch if branch is not None else max([0, *self.branch.values()]) + 1
        for n in range(number, self.head + 1):
            self.branch[n] = branch
        self.entries = [e for e in self.entries if e[0] < number]

    def emit(self, emitter, name, args, *, address, number, tx, log_index=None, tx_index=0):
        """Place one event on the current branch of block `number`."""
        if log_index is None:
            log_index = sum(1 for e in self.entries if e[0] == number)
        raw = encode_log(emitter, name, args, address=address, block_number=number, block_hash='0x' + '00' * 32,
                         tx_hash=tx_hash(tx), log_index=log_index, tx_index=tx_index)
        self.entries.append((number, self.branch.get(number, 0), raw))
        if tx_hash(tx) not in self.receipts:
            self.receipts[tx_hash(tx)] = (number, '0x' + '7e' * 20)
        return raw

    def logs_between(self, low, high, addresses=None, topics=None):
        out = []
        for number, branch, raw in self.entries:
            if not low <= number <= high or branch != self.branch.get(number, 0):
                continue
            if addresses is not None and raw['address'].lower() not in addresses:
                continue
            if topics and topics[0] and raw['topics'][0] not in topics[0]:
                continue
            out.append(dict(raw, blockHash=self.hash(number)))
        return sorted(out, key=lambda r: (int(r['blockNumber'], 16), int(r['logIndex'], 16)))

    # -- transport
    def __call__(self, url, body):
        if isinstance(body, list):
            return [self.answer(item) for item in body]
        return self.answer(body)

    def answer(self, body):
        method, params = body['method'], body['params']
        self.log.append((method, copy.deepcopy(params)))
        reply = {'jsonrpc': '2.0', 'id': body['id']}
        failure = self.fail.get(method)
        if failure:
            reply['error'] = failure
            return reply
        if method == 'eth_getBlockByNumber':
            tag = params[0]
            number = (self.head if tag == 'latest' else max(0, self.head - self.finalized_lag) if tag == 'finalized'
                      else int(tag, 16))
            reply['result'] = self.header(number)
        elif method == 'eth_getLogs':
            query = params[0]
            low, high = int(query['fromBlock'], 16), int(query['toBlock'], 16)
            if high > self.head:
                reply['error'] = {'code': -32000, 'message': 'block range extends beyond current head'}
                return reply
            address = query.get('address')
            addresses = None if address is None else {a.lower() for a in ([address] if isinstance(address, str)
                                                                          else address)}
            reply['result'] = self.logs_between(low, high, addresses, query.get('topics'))
        elif method == 'eth_getCode':
            reply['result'] = self.codes.get(params[0].lower(), '0x')
        elif method == 'eth_getTransactionReceipt':
            found = self.receipts.get(params[0])
            if found is None:
                reply['result'] = None
            else:
                number, sender = found
                reply['result'] = {'transactionHash': params[0], 'blockNumber': hex(number),
                                   'blockHash': self.hash(number), 'from': sender, 'status': '0x1',
                                   'gasUsed': hex(210_000), 'effectiveGasPrice': hex(10**8)}
        elif method == 'eth_call':
            handler = self.calls.get((params[0]['to'].lower(), params[0]['data'][:10]))
            if handler is None:
                reply['error'] = {'code': 3, 'message': 'execution reverted', 'data': '0x'}
            else:
                result = handler(params[0]['data'], params[1])
                if isinstance(result, dict):
                    reply['error'] = result
                else:
                    reply['result'] = result
        else:
            raise AssertionError(method)
        return reply

    def count(self, method):
        return sum(1 for entry in self.log if entry[0] == method)


def local_endpoints(chain, transport):
    """One endpoint that sends to `transport`, as a ChainEndpoints of `chain`."""
    from v2_rpc import ChainEndpoints, Endpoint
    endpoint = Endpoint('local', 'chain.invalid', 'https://chain.invalid/', None, 100, None, None)
    return ChainEndpoints(chain, (endpoint,), 'test', send=transport)


def dumps(document):
    return json.dumps(document, sort_keys=True).encode()


__all__ = ['DEPLOYER', 'IndexChain', 'manifest', 'addresses', 'encode_log', 'local_endpoints', 'synthetic_runtime',
           'code_hash', 'block_hash', 'tx_hash', 'replace']
