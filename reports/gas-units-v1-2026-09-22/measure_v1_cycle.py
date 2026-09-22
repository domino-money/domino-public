#!/usr/bin/env python3
"""The automation cycle end to end on the deployed Domino V1 contracts, on an
owned Anvil fork of the chain, with its own disposable PostgreSQL.

The vault is created through the deployed factory on the real WETH/USDG pool;
the guard's publisher is rotated to a synthetic key through the deployed
guardian, impersonated on the child only; the vault's operator is a synthetic
key. Then `SequenceCycle` runs exactly as the service would, with real
Chainlink references, against the fork's RPC: observe, sample, decide, publish,
execute through the durable executor, reconcile. The gas units come from the
cycle's own cost records, for whichever actions the planner chose. No key,
address or transaction leaves the child; reads against the source are bounded.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'backend/tests'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_account import Account

import execution_models as m
import qualify_execution_fork as q
from automation_config import validate_config
from automation_cycle import SequenceCycle
from automation_fixtures import deep_update, sample_config
from chainlink_history import ETH_FEED, USDG_FEED, USDG, WETH
from deposit_fork import DepositFork
from discovery import DataError, RPC_URL
from evm_harness import LocalRpc, POLICY_TYPE, calldata
from execution_pg import ExecutionPostgres
from execution_runner import ExecutionJournal
from fork_read_gateway import ForkReadGateway
import measure_v1_costs as costs

OPERATOR_KEY = bytes([66]) * 32   # published synthetic local test keys; never funded remotely
PUBLISHER_KEY = bytes([77]) * 32
DIRECT_POLICY = (400, 100, 1000, 1, 4, 2, False)     # 1 % trigger: fresh fees route to the root
SUCCESSOR_POLICY = (400, 1000, 1000, 1, 4, 3, False)  # 10 % trigger: the spot counts as near the ceiling


class Harness:
    def __init__(self, fork, gateway, x, rpc, report):
        self.fork, self.gateway, self.x, self.rpc, self.report = fork, gateway, x, rpc, report

    def advance(self, seconds):
        """A block `seconds` past the head, never ahead of the wall clock: the
        intent store validates observation times against its own clock, so a
        chain that automined itself ahead of real time has to be waited for."""
        head = self.rpc.request('eth_getBlockByNumber', ['latest', False])
        target = max(int(head['timestamp'], 16) + seconds, int(time.time()))
        while time.time() < target:
            time.sleep(min(0.25, max(0.01, target - time.time())))
        self.rpc.request('evm_setNextBlockTimestamp', [target])
        self.rpc.request('evm_mine', [])

    def shift_price(self, legs, leg):
        """One-way legs that move the spot away from the range's centre, so the
        add at the new price wants a different composition than the fees have."""
        for _ in range(legs):
            self.x.swap(True, leg)
        self.rpc.request('evm_mine', [])

    def trade(self, rounds, leg, *, reverse=True):
        """Round trips (or one-way legs) of the driver against the real pool,
        closed with an empty block so the observed price is settled."""
        for _ in range(rounds):
            self.x.swap(True, leg)
            if reverse:
                received = self.x.balance(self.x.key.currency1, self.x.driver)
                self.x.swap(False, received)
        self.rpc.request('evm_mine', [])

    def restore_price(self, reference):
        """Sell the driver's currency1 back until the spot is at or above the reference."""
        for _ in range(12):
            if self.x.spot()[0] >= reference:
                break
            held = self.x.balance(self.x.key.currency1, self.x.driver)
            if held == 0:
                break
            self.x.swap(False, held // 4 or held)
        self.rpc.request('evm_mine', [])


def build_config(deployment, pg, fork_url, vault, operator, publisher, usdg_decimals, out_dir):
    now = int(time.time())
    hashes = {k: v for k, v in deployment['runtimeCodeHashes'].items() if k != 'setup'}
    contracts, deps = deployment['contracts'], deployment['dependencies']
    admission = {'poolManager': deps['poolManager'], 'positionManager': deps['positionManager'], 'stateView': deps['stateView'],
                 'factory': contracts['factory'], 'readHelper': contracts['readHelper'], 'routing': contracts['routing'],
                 'priceGuard': contracts['priceGuard'], 'engine': contracts['engine'], 'implementation': contracts['implementation'],
                 'serviceFeeRecipient': deployment['roles']['feeRecipient'], 'operator': operator, 'pricePublisher': publisher,
                 'serviceFeeBps': 200, 'dominoServiceFeeBps': 400, 'expiresAt': now + 86400, 'codeHashes': hashes}
    raw = sample_config(currencies=(WETH, USDG), feeds={WETH: ETH_FEED.proxy, USDG: USDG_FEED.proxy, m.ZERO: ETH_FEED.proxy})
    raw = deep_update(raw, {
        'configVersion': 'v1-fork-measurement-2026-09-22',
        'database': dict(pg.settings), 'rpcEndpoint': fork_url, 'deployment': admission,
        'sequences': [{'owner': q.OWNER, 'vault': vault, 'expiresAt': now + 86400, 'suspended': False}],
        'operator': {'keyFile': str(out_dir / 'operator.key'), 'policy': {'max_gas': 6_000_000, 'max_fee_per_gas': 10**11, 'priority_fee_per_gas': 1,
                     'max_total_cost': 10**17, 'max_replacements': 2, 'bump_bps': 1250, 'enabled': True}},
        'publisher': {'keyFile': str(out_dir / 'publisher.key'), 'maxGas': 400000, 'maxFeePerGas': 10**11, 'priorityFeePerGas': 1,
                      'maxTotalCostWei': 10**16, 'expirySeconds': 600, 'enabled': True},
        'references': {'feeds': {WETH: {'description': ETH_FEED.description, 'heartbeatSeconds': 86400},
                                 USDG: {'description': USDG_FEED.description, 'heartbeatSeconds': 86400},
                                 m.ZERO: {'description': ETH_FEED.description, 'heartbeatSeconds': 86400}},
                       'tokenDecimals': {WETH: 18, USDG: usdg_decimals, m.ZERO: 18}, 'maxAgeSeconds': 86400, 'maxDivergenceBps': 300},
        'gas': {'publishGasUnits': 157278, 'executeGasUnits': {'direct': 1200000, 'swap': 1500000, 'mint': 1900000, 'fund': 1300000},
                'l1DataComponent': 'attested_none', 'priorityFeePerGasWei': 1},
        'planner': {'minimumSamples': 3, 'minimumSampleSeconds': 2, 'maximumMeasurementSeconds': 120, 'maximumSampleAgeSeconds': 300},
        'scheduling': {'executionWaitSeconds': 5, 'publicationWaitSeconds': 30, 'evaluationIntervalSeconds': 1, 'minimumBackoffSeconds': 1,
                       'maximumBackoffSeconds': 2, 'maxSourceBlockAge': 200, 'cycleBudgetSeconds': 600, 'leaseSeconds': 120},
        'history': {'sampleIntervalSeconds': 1, 'maximumSampleGapSeconds': 900},
    })
    return validate_config(raw)


def decision_view(summary):
    decision = summary.get('decision') or {}
    chosen = decision.get('chosen') or {}
    return {'outcome': summary.get('outcome'), 'reason': summary.get('reason'), 'action': decision.get('action'),
            'reasons': decision.get('reasons'), 'evidenceReasons': decision.get('evidenceReasons'),
            'diagnostics': decision.get('observationDiagnostics'), 'chosenAction': chosen.get('action'), 'chosenSwap': chosen.get('swap'),
            'candidates': decision.get('candidatesEvaluated'), 'samples': decision.get('historySamples')}


def run_cycle(name, h, cycle, entry, pg, *, warm_passes, rounds, leg, reverse, max_passes, log):
    """Warm the measurement window with trades and samples, then let the cycle
    act and drive it to reconciliation. Returns what happened, never raises."""
    out = {'name': name, 'passes': [], 'outcome': 'not_started'}
    owner = entry.owner
    try:
        for _ in range(warm_passes):
            h.advance(2)
            h.trade(rounds, leg, reverse=reverse)
            summary = cycle.run(entry, act=False)
            out['passes'].append(decision_view(summary))
            log({'stage': name, 'warm': decision_view(summary)})
        acted = None
        for _ in range(max_passes):
            h.advance(2)
            h.trade(rounds, leg, reverse=reverse)
            summary = cycle.run(entry)
            view = decision_view(summary)
            out['passes'].append(view)
            log({'stage': name, 'pass': view})
            if summary['outcome'] in ('executing', 'completed'):
                acted = summary
                break
            if summary['outcome'] in ('suspended', 'skipped'):
                out['outcome'] = summary['outcome']
                out['reason'] = summary.get('reason')
                return out
        if acted is None:
            out['outcome'] = 'never_acted'
            return out
        out['cycleId'], out['intentId'], out['observationId'] = acted['cycleId'], acted['intentId'], acted['observationId']
        out['decision'] = decision_view(acted)
        done = acted
        for _ in range(max_passes):
            if done['outcome'] == 'completed':
                break
            h.rpc.request('anvil_mine', ['0x4', '0x0'])
            h.advance(2)
            done = cycle.run(entry)
            log({'stage': name, 'drive': decision_view(done)})
        out['outcome'] = done['outcome']
        out['reason'] = done.get('reason')
        record = cycle.store.cycle(owner, acted['cycleId'])
        out['cost'] = record['cost']
        status = ExecutionJournal(pg.settings).status(owner, acted['intentId'])
        receipt = status.get('receipt') or {}
        out['journalState'] = (status.get('journal') or {}).get('state')
        out['action'] = receipt.get('action')
        out['transactionHash'] = receipt.get('transactionHash')
        if receipt.get('transactionHash'):
            tx = h.rpc.request('eth_getTransactionByHash', [receipt['transactionHash']])
            out['calldataBytes'] = (len(tx['input']) - 2) // 2
            out['executeDataQuotes'] = h.x.data_quotes(cycle.config.deployment.operator, entry.vault, tx['input'], 0)
        if acted.get('observationId'):
            publication = cycle.journal.status(acted['observationId'])
            out['publication'] = {k: publication.get(k) for k in ('state', 'gasUsedRaw', 'effectiveGasPriceRaw', 'transactionHash')}
        out['ledger'] = cycle.status(entry).get('ledger')
        return out
    except Exception as error:  # noqa: BLE001 - one cycle's failure is a result, not the run's
        out['outcome'] = 'harness-error'
        out['reason'] = type(error).__name__ + ': ' + str(error)[:200]
        return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--source-url', help='loopback JSON-RPC source instead of the public endpoint')
    parser.add_argument('--block', help='fork block number; default: the head block')
    parser.add_argument('--rounds', type=int, default=10, help='driver round trips per warm-up pass')
    parser.add_argument('--root0', default='2000000000000000000')
    parser.add_argument('--root1', default='8000000000')
    parser.add_argument('--width', type=int, default=200)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    if args.output.exists():
        raise DataError('output_exists')
    deployment = json.loads(costs.MANIFEST.read_text())
    operator, publisher = Account.from_key(OPERATOR_KEY).address.lower(), Account.from_key(PUBLISHER_KEY).address.lower()
    report = {'tool': 'measure_v1_cycle', 'chainId': q.CHAIN_ID, 'pool': 'weth-usdg', 'poolId': q.POOLS['weth-usdg'][0],
              'manifest': {'path': str(costs.MANIFEST.relative_to(ROOT)), 'releaseTag': deployment['releaseTag'], 'sourceCommit': deployment['sourceCommit']},
              'capturedAt': datetime.now(timezone.utc).isoformat(),
              'scope': 'the automation cycle (publish, execute, reconcile, ledger) on the deployed V1 runtime, on an Anvil fork under explicit ArbSys emulation, with real Chainlink references; gas from receipts; not live Nitro estimates',
              'controls': 'synthetic owner/attacker/operator/publisher keys funded on the child; the guard publisher rotated through the impersonated deployed guardian; USDG moved from the pool manager',
              'syntheticRoles': {'operator': operator, 'publisher': publisher, 'owner': q.OWNER},
              'cycles': [], 'runStatus': 'started'}

    def save():
        with args.output.open('w') as handle:
            json.dump(report, handle, indent=1)
            handle.write('\n')

    def log(event):
        print(json.dumps(event, default=str)[:1200], flush=True)

    out_dir = args.output.resolve().parent
    pg = None
    try:
        # The deployed operator/publisher addresses are only needed to adopt the stack; the cycle signs with synthetic keys.
        q.OPERATOR, q.PUBLISHER, q.RECIPIENT = operator, deployment['roles']['pricePublisher'], deployment['roles']['feeRecipient']
        source = q.Loopback(args.source_url) if args.source_url else ForkReadGateway(RPC_URL, max_requests=40_000, total_seconds=3600)
        report['upstream'] = 'loopback source' if args.source_url else q.urlsplit(RPC_URL).hostname
        with source as gateway:
            if gateway.request('eth_chainId') != hex(q.CHAIN_ID):
                raise DataError('fork_source_chain_mismatch')
            block = gateway.request('eth_getBlockByNumber', ['latest' if args.block is None else hex(int(args.block, 0)), False])
            report['source'] = {k: block[k] for k in ('number', 'hash', 'timestamp', 'baseFeePerGas')}
            with DepositFork(gateway, block=block, total_seconds=1800, max_requests=40_000) as fork:
                report['anvilVersion'] = fork.version
                rpc = LocalRpc(fork.url)
                x = costs.DeployedExperiment(fork, 'weth-usdg', deployment, gateway, [], 300)
                report['chainSemantics'] = x.emulate_arbsys()
                report['stack'] = x.adopt_stack()
                # The guard's publisher becomes the synthetic key through the deployed guardian's two-step handshake.
                guardian = deployment['roles']['priceGuardGuardian']
                x.fund_native(guardian, 10**20); fork.request('anvil_impersonateAccount', [guardian])
                x.fund_native(publisher, 10**20); fork.request('anvil_impersonateAccount', [publisher])
                x.fund_native(operator, 10**20)
                x.must(guardian, x.guard, calldata('proposePublisher(address)', ['address'], [publisher]), what='proposePublisher')
                x.must(publisher, x.guard, calldata('acceptPublisher()'), what='acceptPublisher')
                if x.call(x.guard, 'publisher()', ['address'])[0] != publisher:
                    raise DataError('publisher_rotation_failed')
                q.PUBLISHER = publisher
                report['root'] = x.open_root(int(args.root0), int(args.root1), args.width)
                x.create_vault()
                report['vault'] = x.vault
                x.must(q.OWNER, x.vault, calldata('setPolicy(' + POLICY_TYPE + ')', [POLICY_TYPE], [DIRECT_POLICY]), what='setPolicy')
                usdg_decimals = x.call(USDG, 'decimals()', ['uint8'])[0]
                log({'stage': 'vault', 'vault': x.vault, 'token': x.token, 'usdgDecimals': usdg_decimals})
                x.fund_driver(10**24, 0)
                leg = x.amount_for_move(20)
                report['driverLegCurrency0'] = str(leg)
                pg = ExecutionPostgres().start()
                with pg.admin() as conn:
                    for name in ('019_execution_journal', '028_automation_cycle', '029_ledger_index'):
                        conn.execute((ROOT / 'backend/migrations' / f'{name}.sql').read_text())
                    for role in ('domino_execution_signer', 'domino_execution_publisher'):
                        conn.execute(f'ALTER ROLE {role} LOGIN')
                config = build_config(deployment, pg, fork.url, x.vault, operator, publisher, usdg_decimals, out_dir)
                report['configVersion'] = config.configVersion
                cycle = SequenceCycle(config, rpc=rpc, operator_key=OPERATOR_KEY, publisher_key=PUBLISHER_KEY)
                entry = config.sequences[0]
                h = Harness(fork, gateway, x, rpc, report)
                h.advance(1); h.advance(1)
                log({'stage': 'status', 'status': {k: v for k, v in cycle.status(entry).items() if k in ('sequenceHash', 'head', 'balances', 'paused')}})
                reference = x.spot()[0]
                report['cycles'].append(run_cycle('direct', h, cycle, entry, pg, warm_passes=4, rounds=args.rounds, leg=leg, reverse=True, max_passes=6, log=log))
                save()
                # The spot shifted about one percent off the range's centre, then
                # round trips as before: the add's composition no longer matches the
                # fees', which is what makes the planner quote a swap.
                h.shift_price(5, leg)
                report['swapShiftSqrtPrice'] = str(x.spot()[0])
                report['cycles'].append(run_cycle('swap', h, cycle, entry, pg, warm_passes=4, rounds=args.rounds, leg=leg, reverse=True, max_passes=6, log=log))
                save()
                h.restore_price(reference)
                x.must(q.OWNER, x.vault, calldata('setPolicy(' + POLICY_TYPE + ')', [POLICY_TYPE], [SUCCESSOR_POLICY]), what='setPolicy successor')
                report['cycles'].append(run_cycle('mint', h, cycle, entry, pg, warm_passes=5, rounds=args.rounds, leg=leg * 2, reverse=True, max_passes=6, log=log))
                save()
                report['cycles'].append(run_cycle('fund', h, cycle, entry, pg, warm_passes=5, rounds=args.rounds, leg=leg * 2, reverse=True, max_passes=6, log=log))
                save()
        report['runStatus'] = 'complete'
    except BaseException as error:
        report['runStatus'] = 'failed'
        report['failure'] = type(error).__name__ + ': ' + str(error)[:300]
        raise
    finally:
        if pg is not None:
            pg.close()
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        report['summary'] = [{'name': c['name'], 'outcome': c.get('outcome'), 'action': c.get('action'), 'chosen': (c.get('decision') or {}).get('chosenAction'),
                              'swap': (c.get('decision') or {}).get('chosenSwap'), 'executionGas': ((c.get('cost') or {}).get('execution') or {}).get('gasUsedRaw'),
                              'publicationGas': ((c.get('cost') or {}).get('publication') or {}).get('gasUsedRaw'), 'calldataBytes': c.get('calldataBytes')}
                             for c in report['cycles']]
        save()
    log({'stage': 'done', 'summary': report['summary']})
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
