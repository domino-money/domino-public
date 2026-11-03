"""The Domino V2 indexer: one chain, its deployment, reorg-safe ranges.

What it follows. The deployment manifest (v2_manifest, issue #301's format,
admitted for production, a fork rehearsal or a local test) names the
components; the registry, the price anchor, both vault factories, both zaps and
the auto-exit module emit events, and so does every vault a factory creates
(VaultCreated), from its creation on. One eth_getLogs per window covers all of
them: the addresses (in chunks of MAX_LOG_ADDRESSES) and every topic the frozen
interfaces declare (v2_events), so the provider's bloom filter does the work
and no address is polled. A vault created inside a window is followed in the
same window, from its creation block.

How a range commits. V1's indexers set the pattern (catalogue_indexer,
activity_indexer): before reading, the range's start must continue the last
checkpoint's hash; its boundary headers are read before and after the logs, and
any difference means the chain moved under the read (index_snapshot_reorganized,
nothing is written, the next pass reconciles). Every event's block hash must
equal its header's, which also gives each event its exact timestamp. The range
then commits with its checkpoint in one transaction (v2_index_store).

Reorganizations. Each pass first checks the latest checkpoint's hash against
the chain. On a difference it walks back through up to RECONCILE_DEPTH earlier
checkpoints and rewinds to the newest one the chain still has, or to the
deployment's base when none matches, deleting everything derived above it. A
base the chain no longer has means the deployment itself was reorganized away:
the indexer stops (v2_deployment_reorganized) for the operator.

What each pass costs. The head comes from the chain's shared follower (v2_head)
when one is given. A pass that indexes reads two boundary headers before and
after the logs, one eth_getLogs per address chunk (the transport splits a range
wider than an endpoint admits), and one header per distinct block holding an
event. A caught-up pass reads the latest checkpoint's header only. Enrichment
(v2_snapshots) then spends at most its own budget per pass. With a waiting file
(the chain's automation's, v2_waiting), each pass also reads that local file.
"""
import argparse
from dataclasses import dataclass
from fractions import Fraction
import hashlib
import json
import math
import sys
import time
from types import MappingProxyType

from discovery import Block, DataError, parse_block
from indexer_io import MAX_CHUNK_EVENTS, read_headers
from v2_activity import Context, derive_transaction, positions_seen
from v2_chains import DEX_V3, DEX_V4
from v2_events import catalog as event_catalog, decode_log
from v2_manifest import COMPONENTS, DEPENDENCIES, canonical
from v2_rpc import ChainIndexRpc, _codehash, batched_reads
import v2_snapshots
from v2_waiting import read_waiting_file, waiting_rows

MAX_LOG_ADDRESSES = 100
DEFAULT_SPAN, MAX_SPAN = 10_000, 100_000
RECONCILE_DEPTH = 64
# Blocks a follower stays below the head: about this many seconds of chain.
LAG_SECONDS = 10
DEFAULT_MAX_REQUESTS = 400
DEFAULT_REFRESH_SECONDS = 1800
ENRICHMENT_LIMITS = {'transactions': 25, 'mandates': 25, 'vaults': 10, 'positions': 10, 'tokens': 20}
# The chain's `finalized` block is read at most this often: one more call, for
# the receipts' finality (app spec §6.2).
FINALITY_INTERVAL_SECONDS = 60
# What each deployment component (v2_manifest.COMPONENTS) emits on its own
# (v2_events). None: code reached only by DELEGATECALL or never initialized:
# the implementations, their executors, the swap module and the v4 zap's steps;
# their events carry the vault's or zap's address.
COMPONENT_EMITTERS = MappingProxyType({
    'registry': 'registry', 'priceAnchor': 'price_anchor', 'autoExit': 'auto_exit', 'vaultSwap': None,
    'vault.v3': None, 'vault.v4': None, 'vaultFactory.v3': 'vault_factory', 'vaultFactory.v4': 'vault_factory',
    'zap.v4.steps': None, 'zap.v3': 'zap', 'zap.v4': 'zap', 'vaultExecutor.v3': None, 'vaultExecutor.v4': None})
FACTORY_DEX = MappingProxyType({'vaultFactory.v3': DEX_V3, 'vaultFactory.v4': DEX_V4})
ZAP_DEX = MappingProxyType({'zap.v3': DEX_V3, 'zap.v4': DEX_V4})
if set(COMPONENT_EMITTERS) != set(COMPONENTS):
    raise ImportError('v2_indexer_components_out_of_date')


def manifest_sha256(deployment):
    """The admitted manifest's identity: SHA-256 of its canonical JSON (deploy.mjs `canonical`)."""
    return hashlib.sha256(canonical(deployment.manifest).encode()).hexdigest()


def first_block(deployment):
    """The first block that can hold a component's event: the earliest deployment receipt."""
    return min(receipt['blockNumber'] for receipt in deployment.receipts.values())


def contract_rows(deployment):
    """(address, component, emitter kind, dex) of the 13 components."""
    return [(deployment.address(component), component, COMPONENT_EMITTERS[component],
             FACTORY_DEX.get(component, ZAP_DEX.get(component))) for component in COMPONENTS]


class V2IndexRpc(ChainIndexRpc):
    """The chain's index client, plus transaction receipts (gas of a receipt's transaction)."""
    METHODS = ChainIndexRpc.METHODS | {'eth_getTransactionReceipt'}


def default_lag(chain):
    return max(1, math.ceil(Fraction(LAG_SECONDS) / chain.block_time))


@dataclass(frozen=True)
class Followed:
    """What one address is to the indexer."""
    kind: str  # the emitter kind (v2_events)
    component: str | None  # the deployment component, or None for a vault
    dex: int | None


class V2Indexer:
    def __init__(self, store, chain, endpoints, *, head=None, lag_blocks=None, max_requests=DEFAULT_MAX_REQUESTS,
                 refresh_seconds=DEFAULT_REFRESH_SECONDS, enrichment=None, clock=time.time, catalog=None,
                 waiting_file=None):
        if endpoints.chain.chainId != chain.chainId:
            raise DataError('v2_rpc_chain_mismatch')
        lag = default_lag(chain) if lag_blocks is None else lag_blocks
        if type(lag) is not int or not 0 <= lag <= 100_000 or type(max_requests) is not int or max_requests < 16:
            raise DataError('invalid_v2_indexer_config')
        if type(refresh_seconds) is not int or not 60 <= refresh_seconds <= 7 * 86400:
            raise DataError('invalid_v2_indexer_config')
        self.store, self.chain, self.endpoints = store, chain, endpoints
        self.chain_id, self.lag, self.max_requests = chain.chainId, lag, max_requests
        self.refresh_seconds, self.clock = refresh_seconds, clock
        self.limits = dict(ENRICHMENT_LIMITS, **(enrichment or {}))
        self.catalog = catalog or event_catalog()
        self._head = head
        # The chain's automation waitingFile (v2_waiting), read once a pass when given.
        self.waiting_file = waiting_file

    def rpc(self):
        return V2IndexRpc(self.endpoints, max_requests=self.max_requests, batch_reads=True)

    def head(self, rpc):
        if self._head is not None:
            block = self._head()
            return block.block if hasattr(block, 'block') else block
        return parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))

    # ---------------------------------------------------------- register
    def register(self, deployment):
        """Prove the manifest (a v2_manifest.Deployment) on the chain, then follow
        it from its first receipt: every receipt's block and the verification
        block are canonical, and every Domino runtime (and, outside a local test,
        every dependency) has the code hash the manifest names."""
        if deployment.chain.chainId != self.chain_id:
            raise DataError('v2_deployment_chain_mismatch')
        manifest, start = deployment.manifest, first_block(deployment)
        rpc = self.rpc()
        head = self.head(rpc)
        anchors = {r['blockNumber']: r['blockHash'] for r in deployment.receipts.values()}
        verification = manifest['verification']
        if anchors.setdefault(verification['blockNumber'], verification['blockHash']) != verification['blockHash']:
            raise DataError('v2_deployment_not_canonical')
        numbers = sorted({start - 1, *anchors})
        if numbers[-1] > head.number:
            raise DataError('v2_deployment_not_canonical')
        headers = read_headers(rpc, numbers)
        if any(headers[number].hash != block_hash for number, block_hash in anchors.items()):
            raise DataError('v2_deployment_not_canonical')
        anchor = parse_block(rpc.request('eth_getBlockByNumber', [head.tag, False]))
        if anchor != head:
            raise DataError('index_snapshot_reorganized')
        proven = {component: deployment.address(component) for component in COMPONENTS}
        if manifest['environment'] != 'local-test':
            proven.update({name: manifest['dependencies'][name] for name in DEPENDENCIES})
        names = sorted(proven)
        codes = batched_reads(rpc, [('eth_getCode', [proven[name], head.tag]) for name in names])
        for name, raw in zip(names, codes):
            if _codehash(raw) != manifest['runtimeCodeHashes'][name]:
                raise DataError('v2_deployment_code_mismatch')
        with self.store.writer(self.chain_id) as writer:
            created = writer.register(manifest_sha256(deployment), manifest, start, headers[start - 1].hash,
                                      contract_rows(deployment))
        return {'status': 'registered' if created else 'already_registered', 'chainId': self.chain_id,
                'environment': manifest['environment'], 'startBlock': start,
                'manifestSha256': manifest_sha256(deployment), 'codeProvenAt': head.number, 'codesProven': len(names)}

    # -------------------------------------------------------------- step
    def step(self, *, through=None, span=DEFAULT_SPAN, enrich=True):
        if type(span) is not int or not 1 <= span <= MAX_SPAN or (through is not None and type(through) is not int):
            raise DataError('invalid_v2_indexer_bounds')
        rpc = self.rpc()
        head = self.head(rpc)
        target = head.number - self.lag if through is None else min(through, head.number)
        with self.store.writer(self.chain_id) as writer:
            try:
                state = writer.state()
                if state is None:
                    raise DataError('v2_deployment_not_registered')
                now = self.clock()
                writer.observe_head(head, now)
                self._observe_finality(writer, now)
                result = self._index(writer, rpc, state, target, span, head)
            except DataError as error:
                if str(error) not in ('v2_deployment_not_registered',):
                    writer.record_error(str(error), self.clock())
                raise
            if enrich and result['status'] != 'rewound':
                result['enrichment'] = self.enrich(writer)
            if self.waiting_file is not None:
                result['waiting'] = self.ingest_waiting(writer)
        return result

    def ingest_waiting(self, writer):
        """The automation's waiting file into the index, replaced whole when its
        pass changed. A file that cannot be read leaves the chain's waiting
        unavailable, never the pass."""
        now = int(self.clock())
        status, value = read_waiting_file(self.waiting_file, self.chain_id)
        if status != 'read':
            writer.save_waiting_unavailable(value, now)
            return {'status': 'unavailable', 'reason': value}
        if writer.waiting_pass() == {'block': value['block'], 'timestamp': value['timestamp']}:
            writer.touch_waiting(now)
            return {'status': 'unchanged', 'block': value['block']}
        kept = waiting_rows(value)
        writer.save_waiting(value['block'], value['timestamp'], kept, now)
        return {'status': 'read', 'block': value['block'], 'subjects': len(kept)}

    def _observe_finality(self, writer, now):
        """The chain's finalized block, once a minute at most, on its own client:
        a provider that cannot answer leaves the last one standing."""
        last = writer.finalized_observed_at()
        if last is not None and now - last < FINALITY_INTERVAL_SECONDS:
            return
        try:
            block = parse_block(self.rpc().request('eth_getBlockByNumber', ['finalized', False]))
        except DataError:
            return
        writer.observe_finalized(block, now)

    def _standing(self, rpc, checkpoint, head):
        """The checkpoint is still on the chain: its block is at or below the head
        and has its hash. A head below it is a reorganization to a shorter chain."""
        return (checkpoint['end_block'] <= head.number
                and self._header(rpc, checkpoint['end_block']).hash == checkpoint['end_hash'])

    def _reconcile(self, writer, rpc, state, head):
        checkpoints = writer.checkpoints(RECONCILE_DEPTH)
        if checkpoints:
            if self._standing(rpc, checkpoints[0], head):
                return None
            for checkpoint in checkpoints[1:]:
                if self._standing(rpc, checkpoint, head):
                    return writer.rewind(checkpoint['end_block']) - 1
        base = self._header(rpc, state['start_block'] - 1)
        if base.hash != state['base_hash']:
            raise DataError('v2_deployment_reorganized')
        if not checkpoints:
            return None
        return writer.rewind(state['start_block'] - 1) - 1

    @staticmethod
    def _header(rpc, number):
        block = parse_block(rpc.request('eth_getBlockByNumber', [hex(number), False]))
        if block.number != number:
            raise DataError('unexpected_block_number')
        return block

    def followed(self, writer):
        out = {}
        for row in writer.contracts():
            if row['emitter'] is not None:
                out[row['address']] = Followed(row['emitter'], row['component'], row['dex'])
        for vault, (_, dex, _) in writer.vaults().items():
            out[vault] = Followed('vault', None, dex)
        return out

    def _logs(self, rpc, addresses, start, end):
        raw = []
        topics = self.catalog.topics()
        ordered = sorted(addresses)
        for low in range(0, len(ordered), MAX_LOG_ADDRESSES):
            chunk = ordered[low:low + MAX_LOG_ADDRESSES]
            logs = rpc.request('eth_getLogs', [{'address': chunk, 'topics': [topics],
                                                'fromBlock': hex(start), 'toBlock': hex(end)}])
            if not isinstance(logs, list) or len(raw) + len(logs) > MAX_CHUNK_EVENTS:
                raise DataError('v2_log_budget_exhausted')
            raw.extend(logs)
        return raw

    def _decode(self, raw, followed, start, end):
        decoded, seen = [], {}
        for entry in raw:
            log = decode_log(self.catalog, entry, lambda a: followed[a].kind if a in followed else None)
            if not start <= log.block_number <= end:
                raise DataError('v2_event_outside_range')
            key = (log.block_number, log.log_index)
            if key in seen:
                if seen[key] != log:
                    raise DataError('v2_conflicting_duplicate_log')
                continue
            seen[key] = log
            decoded.append(log)
        return decoded

    def _index(self, writer, rpc, state, target, span, head):
        rewound = self._reconcile(writer, rpc, state, head)
        if rewound is not None:
            return {'status': 'rewound', 'through': rewound}
        state = writer.state()
        start = state['next_block']
        if start > target:
            return {'status': 'caught_up_to_target', 'through': start - 1}
        end = min(start + span - 1, target)
        bounds = read_headers(rpc, [start - 1, end])
        before, last = bounds[start - 1], bounds[end]
        tail = writer.tail()
        if before.hash != (tail['end_hash'] if tail else state['base_hash']):
            raise DataError('index_snapshot_reorganized')
        followed = self.followed(writer)
        logs = self._decode(self._logs(rpc, list(followed), start, end), followed, start, end)
        new_vaults = []
        for log in logs:
            if log.event != 'VaultCreated':
                continue
            source = followed[log.address]
            vault = log.args['vault']
            if (log.args['dex'] != FACTORY_DEX[source.component] or vault in followed
                    or log.args['rootTokenId'] == 0):
                raise DataError('v2_vault_creation_invalid')
            new_vaults.append((log, source.dex))
        if new_vaults:
            created = {log.args['vault']: Followed('vault', None, dex) for log, dex in new_vaults}
            followed = {**followed, **created}
            first = min(log.block_number for log, _ in new_vaults)
            extra = self._decode(self._logs(rpc, list(created), first, end), followed, first, end)
            births = {log.args['vault']: log.block_number for log, _ in new_vaults}
            if any(log.block_number < births[log.address] for log in extra):
                raise DataError('v2_event_before_vault_creation')
            known = {(log.block_number, log.log_index) for log in logs}
            logs += [log for log in extra if (log.block_number, log.log_index) not in known]
        logs.sort(key=lambda log: (log.block_number, log.log_index))
        headers = read_headers(rpc, sorted({log.block_number for log in logs}))
        for log in logs:
            if headers[log.block_number].hash != log.block_hash:
                raise DataError('index_snapshot_reorganized')
        after = read_headers(rpc, [start - 1, end])
        if after[start - 1] != before or after[end] != last:
            raise DataError('index_snapshot_reorganized')
        timestamps = {number: header.timestamp for number, header in headers.items()}
        vaults = writer.vaults()
        for log, dex in new_vaults:
            a = log.args
            vaults[a['vault']] = (a['owner'], dex, a['rootTokenId'])
        registered = {log.args['mandateHash']: (log.args['owner'], log.args['vault'])
                      for log in logs if log.event == 'MandateRegistered'}
        revoked = [log.args['mandateHash'] for log in logs if log.event == 'MandateRevoked']
        stored = writer.mandates([h for h in revoked if h not in registered])
        mandates = {**stored, **registered}
        auto_exit = next((a for a, f in followed.items() if f.kind == 'auto_exit'), None)
        zap_dex = {a: f.dex for a, f in followed.items() if f.kind == 'zap'}
        ctx = Context(vault=vaults.get, mandate=mandates.get, auto_exit=auto_exit, zap_dex=zap_dex)
        items = []
        by_tx = {}
        for log in logs:
            by_tx.setdefault(log.tx_hash, []).append(log)
        for tx_logs in by_tx.values():
            items.extend(derive_transaction(tx_logs, ctx))
        seen, touched = positions_seen(logs, ctx)

        def dex_of(log):
            if log.emitter == 'vault':
                return vaults[log.address][1]
            if log.emitter == 'zap':
                return zap_dex[log.address]
            if log.emitter == 'vault_factory':
                return log.args['dex']
            if log.emitter == 'auto_exit' and log.args.get('vault') in vaults:
                return vaults[log.args['vault']][1]
            return None
        writer.commit(state, start, last, logs, timestamps, new_vaults, items, seen, touched, dex_of)
        return {'status': 'indexed', 'fromBlock': start, 'through': end, 'events': len(logs),
                'vaultsCreated': len(new_vaults), 'items': len(items), 'endHash': last.hash}

    # ---------------------------------------------------------- enrichment
    def enrich(self, writer):
        """Bounded reads at the latest checkpoint; stops at the first transient failure.

        The work is chosen from the store first: a pass with nothing due spends
        no call at all.
        """
        tail = writer.tail()
        done = {name: 0 for name in self.limits}
        if tail is None:
            return {'status': 'nothing_indexed', **done}
        pinned = Block(tail['end_block'], tail['end_hash'], tail['end_timestamp'])
        now = int(self.clock())
        work = {'transactions': writer.pending_transactions(self.limits['transactions']),
                'mandates': writer.pending_mandates(self.limits['mandates']),
                'vaults': writer.due_vaults(self.limits['vaults'], now=now, refresh_seconds=self.refresh_seconds),
                'positions': writer.due_positions(self.limits['positions'], now=now,
                                                  refresh_seconds=self.refresh_seconds),
                'tokens': writer.unknown_tokens(self.limits['tokens'])}
        if not any(work.values()):
            return {'status': 'done', **done}
        rpc = self.rpc()
        try:
            if self._header(rpc, pinned.number) != pinned:
                return {'status': 'checkpoint_moved', **done}
            for row in work['transactions']:
                receipt = v2_snapshots.read_receipt(rpc, row['tx_hash'], row['block_number'], row['block_hash'])
                done['transactions'] += writer.save_transaction(pinned, receipt)
            module = next((r['address'] for r in writer.contracts() if r['component'] == 'autoExit'), None)
            for row in work['mandates']:
                terms = v2_snapshots.read_mandate(rpc, pinned, module, row['mandate_hash'], row['args'])
                done['mandates'] += writer.save_mandate(pinned, row['mandate_hash'], row['block_number'], terms)
            for row in work['vaults']:
                try:
                    state = v2_snapshots.read_vault(rpc, pinned, row['vault'])
                    if state['owner'] != row['owner'] or state['factory'] != row['factory']:
                        raise DataError('v2_vault_state_mismatch')
                    status, reason = 'read', None
                except DataError as error:
                    if v2_snapshots.transient(error):
                        raise
                    state, status, reason = None, 'unavailable', str(error)[:80]
                done['vaults'] += writer.save_vault_snapshot(pinned, row['vault'], status, state, reason, now)
            for row in work['positions']:
                token_id = int(row['token_id'])
                status, owner, state, reason = v2_snapshots.read_position(
                    rpc, self.chain, pinned, row['dex'], token_id, row['last_event_block'])
                done['positions'] += writer.save_position_snapshot(pinned, row['dex'], token_id, status, owner,
                                                                   state, reason, now)
            tokens = list(work['tokens'])
            native, metadata = v2_snapshots.native_token(self.chain)
            if native in tokens:
                writer.save_token(pinned.number, native, *metadata)
                tokens.remove(native)
                done['tokens'] += 1
            for token, values in v2_snapshots.read_tokens(rpc, pinned, tokens).items():
                writer.save_token(pinned.number, token, *values)
                done['tokens'] += 1
        except DataError as error:
            return {'status': 'interrupted', 'reason': str(error), **done}
        return {'status': 'done', **done}


# ---------------------------------------------------------------------- CLI
def _endpoints(chain, args):
    from local_config import load_config
    from v2_rpc import configured_endpoints, load_chain_rpc_config
    if chain.chainId == 4663:
        return configured_endpoints(chain, provider_config=load_config(args.provider_file))
    if not args.chain_rpc_file:
        raise DataError('v2_chain_rpc_not_configured')
    return configured_endpoints(chain, chain_rpc_config=load_chain_rpc_config(args.chain_rpc_file))


def main(argv=None):
    from catalogue import database_settings
    from local_config import CONFIG_PATH
    from v2_chains import default_registry
    from v2_head import HeadFollower
    from v2_manifest import ADMISSIONS, load_deployment
    from v2_index_store import V2Store
    parser = argparse.ArgumentParser(description='Index one chain of a Domino V2 deployment.')
    parser.add_argument('command', choices=('register', 'step', 'follow', 'status'))
    parser.add_argument('--chain', required=True, help='profile name, e.g. base-8453')
    parser.add_argument('--deployment', help='the deployment manifest (register)')
    parser.add_argument('--admission', choices=ADMISSIONS, default='production',
                        help='which manifests register admits (v2_manifest): production unless rehearsing or testing')
    parser.add_argument('--chain-rpc-file', help='the private V2 chain RPC file (chains other than Robinhood)')
    parser.add_argument('--provider-file', default=str(CONFIG_PATH), help='the read path provider file (Robinhood)')
    parser.add_argument('--head-file', help="the chain's shared head file (v2_head)")
    parser.add_argument('--waiting-file', help="the chain's automation waitingFile (V2_AUTOMATION_BACKEND.md)")
    parser.add_argument('--lag', type=int, help='blocks below the head (default: about %d s)' % LAG_SECONDS)
    parser.add_argument('--span', type=int, default=DEFAULT_SPAN)
    parser.add_argument('--refresh', type=int, default=DEFAULT_REFRESH_SECONDS,
                        help='seconds before a vault or position is read again without a new event')
    parser.add_argument('--poll', type=float, default=15, help='follow: seconds between passes when caught up')
    parser.add_argument('--max-passes', type=int, default=0, help='follow: 0 runs until stopped')
    args = parser.parse_args(argv)
    try:
        chain = default_registry().chain(args.chain)
        settings = database_settings()
        if settings is None:
            raise DataError('catalogue_not_configured')
        store = V2Store(settings)
        if args.command == 'status':
            with store.reader() as reader:
                rows = [row for row in reader.deployments() if row['chain_id'] == chain.chainId]
            print(json.dumps(rows[0] if rows else {'chainId': chain.chainId, 'status': 'not_registered'},
                             default=str, indent=2, sort_keys=True))
            return 0
        endpoints = _endpoints(chain, args)
        # One head per chain for every service on the host when --head-file
        # names the shared file; otherwise this process's own cache.
        follower = HeadFollower(endpoints, max_age_seconds=2, shared_path=args.head_file)
        indexer = V2Indexer(store, chain, endpoints, lag_blocks=args.lag, refresh_seconds=args.refresh,
                            head=lambda: follower.head().block, waiting_file=args.waiting_file)
        if args.command == 'register':
            if not args.deployment:
                raise DataError('v2_deployment_required')
            report = indexer.register(load_deployment(args.deployment, chain, admission=args.admission))
        elif args.command == 'step':
            report = indexer.step(span=args.span)
        else:
            from followers import follow
            report = follow(lambda through: indexer.step(through=through, span=args.span),
                            lambda: {'number': indexer.head(indexer.rpc()).number},
                            lag=indexer.lag, max_passes=args.max_passes, poll_seconds=args.poll,
                            on_pass=lambda entry: print(json.dumps(entry, default=str, sort_keys=True), flush=True))
    except DataError as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(report, default=str, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
