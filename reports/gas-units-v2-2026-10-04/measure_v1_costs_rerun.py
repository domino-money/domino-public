#!/usr/bin/env python3
# A copy of reports/gas-units-v1-2026-09-22/measure_v1_costs.py, rerun on 4 Oct 2026 beside
# measure_v2_costs.py so that both versions are measured on the same fork state. One line differs:
# discovery's public endpoint is now PUBLIC_RPC_URL (#289); this run uses --source-url, not it.
"""Gas units of the automation path on the deployed Domino V1 contracts.

An owned Anvil child, forked from the public endpoint (or a loopback source)
at the head block. The deployed factory, read helper, routing helper, price
guard, engine, implementation and setup are adopted at their mainnet
addresses after their runtime hashes are checked against the release
manifest; nothing but the study's swap driver is deployed. The deployed
operator and publisher addresses are impersonated on the child only. Reads
against the source are bounded; no transaction leaves the child. Units are
Anvil receipts under the explicit ArbSys emulation, as in the 21 September
study: planning figures, not live Nitro estimates.

Run with the repository's backend/.venv Python and DOMINO_COMPOUND_EVM_ROOT
pointing at a checkout with compiled artifacts (contracts/out).
"""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from eth_abi import decode
from eth_hash.auto import keccak

import qualify_execution_fork as q
from deposit_fork import DepositFork
from discovery import DataError, PUBLIC_RPC_URL as RPC_URL
from fork_read_gateway import ForkReadGateway

MANIFEST = ROOT / 'docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json'
NODE_INTERFACE = '0x00000000000000000000000000000000000000c8'
ADOPTED = {'factory': 'factory', 'helper': 'readHelper', 'routing': 'routing', 'guard': 'priceGuard',
           'engine': 'engine', 'implementation': 'implementation', 'setup': 'setup'}
KINDS = {0: 'execute_general', 1: 'execute_general', 2: 'execute_redirect', 3: 'execute_mint'}


class DeployedExperiment(q.Experiment):
    """The study's experiment on the deployed contracts, recording every
    measured transaction by kind with its calldata size and the source's
    L1 data quote."""
    def __init__(self, fork, pool_name, deployment, source, transactions, scenario_seconds):
        super().__init__(fork, pool_name, deployment['policies']['priceGuardMaxSqrtPriceDeviationBps'], scenario_seconds)
        self.deployment, self.source, self.transactions, self.plan_kinds = deployment, source, transactions, {}

    def adopt_stack(self):
        d = self.deployment
        for account in (q.DEPLOYER, q.OWNER, q.OPERATOR, q.PUBLISHER, q.ATTACKER):
            self.fund_native(account, 10**22)
            self.fork.request('anvil_impersonateAccount', [account])
        self.fork.fresh_block()
        for attribute, name in ADOPTED.items():
            setattr(self, attribute, d['contracts'][name])
        pinned = {name: d['contracts'][name] for name in ADOPTED.values()}
        pinned.update({name: d['dependencies'][name] for name in ('poolManager', 'positionManager', 'stateView')})
        observed = {}
        for name, address in pinned.items():
            code = self.fork.request('eth_getCode', [address, 'latest'])
            observed[name] = '0x' + keccak(bytes.fromhex(code[2:])).hex()
            if observed[name] != d['runtimeCodeHashes'][name]:
                raise DataError('deployed_runtime_mismatch:' + name)
        if (q.POOL_MANAGER, q.POSITION_MANAGER, q.STATE_VIEW) != tuple(d['dependencies'][k] for k in ('poolManager', 'positionManager', 'stateView')):
            raise DataError('deployed_dependencies_mismatch')
        if self.call(self.guard, 'publisher()', ['address'])[0] != q.PUBLISHER:
            raise DataError('deployed_publisher_mismatch')
        band = self.call(self.guard, 'maxDeviationBps()', ['uint256'])[0]
        if band != self.band_bps:
            raise DataError('deployed_band_mismatch')
        if self.call(self.factory, 'implementation()', ['address'])[0] != self.implementation:
            raise DataError('deployed_implementation_mismatch')
        for signature, expected in (('factory()', self.factory), ('readHelper()', self.helper),
                                    ('routingHelper()', self.routing), ('priceGuard()', self.guard)):
            if self.call(self.engine, signature, ['address'])[0] != expected:
                raise DataError('deployed_engine_mismatch')
        self.driver = self.deploy(q.ATTACKER, 'OfficialV4Fixture.sol', 'OfficialV4SwapDriver', ['address'], [q.POOL_MANAGER])
        return {'addresses': pinned, 'runtimeCodeHashes': observed, 'guardBandBps': band, 'driver': self.driver,
                'roles': {'operator': q.OPERATOR, 'publisher': q.PUBLISHER, 'feeRecipient': q.RECIPIENT},
                'basis': 'deployed runtime at the mainnet addresses, hashes checked against the release manifest'}

    def plan(self, liquidity_increase, max_added, swap_in=0, action=0, ticks=(0, 0), range_prices=None):
        plan, anchor = super().plan(liquidity_increase, max_added, swap_in, action, ticks, range_prices)
        self.plan_kinds[plan.calldata()] = 'execute_swap' if swap_in else KINDS[action]
        return plan, anchor

    def redirect_plan(self, child, range_prices):
        """Action 2: the root's fees added to an existing child of the sequence."""
        increase, fees = self.feasible_increase(range_prices)
        # The wire carries no range for a redirect (the child's is implicit) and
        # the base builder names the root as destination; only that field changes.
        plan, anchor = super().plan(increase, (2**127 - 1, 2**127 - 1), 0, 2, (0, 0), range_prices)
        plan = plan.model_copy(update={'destinationTokenId': str(child)})
        self.plan_kinds[plan.calldata()] = 'execute_redirect'
        return plan, anchor, increase, fees

    def data_quotes(self, sender, target, data, value):
        quotes = []
        for tag in ('latest', 'safe'):
            try:
                block = self.source.request('eth_getBlockByNumber', [tag, False])
                raw = self.source.request('eth_call', [{'from': sender, 'to': NODE_INTERFACE,
                    'data': q.calldata('gasEstimateL1Component(address,bool,bytes)', ['address', 'bool', 'bytes'],
                                       [target, False, bytes.fromhex(data[2:])]), 'value': hex(value)},
                    {'blockHash': block['hash'], 'requireCanonical': True}])
                gas, base, l1base = decode(['uint64', 'uint256', 'uint256'], bytes.fromhex(raw[2:]))
                quotes.append({'tag': tag, 'number': int(block['number'], 16), 'hash': block['hash'],
                               'l1DataGasInL2Units': gas, 'baseFeeWei': str(base), 'l1BaseFeeEstimateWei': str(l1base)})
            except Exception as error:  # noqa: BLE001 - a quote is evidence, never a run failure
                quotes.append({'tag': tag, 'unavailable': type(error).__name__})
        return quotes

    def send(self, sender, target, data='0x', value=0, gas=10_000_000):
        receipt = super().send(sender, target, data, value, gas)
        kind = None
        if sender == q.PUBLISHER and target == self.guard:
            kind = 'publish_observation'
        elif sender == q.OPERATOR and target == getattr(self, 'vault', None):
            kind = self.plan_kinds.get(data, 'execute_unclassified')
        if kind:
            self.transactions.append({'kind': kind, 'childTransactionHash': receipt['transactionHash'], 'status': receipt['status'],
                                      'childGasUsed': int(receipt['gasUsed'], 16), 'calldataBytes': (len(data) - 2) // 2,
                                      'dataQuotes': self.data_quotes(sender, target, data, value)})
        return receipt


def measure_redirect(x, out):
    """A successor minted near the ceiling, fresh fees on the root, then the
    root's fees redirected into that child: the `fund` unit of the configuration."""
    checkpoint = x.fork.request('evm_snapshot')
    try:
        parent = x.call(x.vault, 'position(uint256)', [q.g.POSITION_TYPE], ['uint256'], [x.token])[0]
        ceiling = q.sqrt_at_tick(x.upper)
        target = int(ceiling * math.sqrt(0.97))
        if x.spot()[0] < target:
            budget = x.balance(x.currencies[1], q.POOL_MANAGER) // 10 if x.currencies[1] != q.ZERO else 10**24
            x.fund_driver(0, budget)
            x.swap(False, x.amount_for_rise(target, budget))
        lower, upper = x.successor_range(parent)
        range_prices = (q.sqrt_at_tick(lower), q.sqrt_at_tick(upper))
        increase, fees = x.feasible_increase(range_prices)
        child = x.call(q.POSITION_MANAGER, 'nextTokenId()', ['uint256'])[0]
        plan, _ = x.plan(increase, (2**127 - 1, 2**127 - 1), action=3, ticks=(lower, upper), range_prices=range_prices)
        mint = x.owner_exit('mint successor (execute, MINT)', plan.calldata(), q.OPERATOR)
        out['mint'] = mint
        if mint['outcome'] != 'executed':
            out['outcome'] = 'mint_refused'
            return out
        # Fresh fees on the root while the spot sits inside both ranges.
        probe = x.amount_for_move(20)
        x.earn_fees(out['rounds'], probe)
        fees = x.accrued()
        out['accruedBeforeRedirect'] = [str(f) for f in fees]
        plan, anchor, increase, _ = x.redirect_plan(child, range_prices)
        out['redirectLiquidityIncrease'] = str(increase)
        step = x.owner_exit('redirect fees into the child (execute, REDIRECT)', plan.calldata(), q.OPERATOR)
        out['redirect'] = step
        out['outcome'] = 'completed' if step['outcome'] == 'executed' else 'redirect_refused'
        return out
    except Exception as error:  # noqa: BLE001 - keep what ran
        out['outcome'] = 'harness-error'
        out['reason'] = type(error).__name__ + ': ' + str(error)[:160]
        return out
    finally:
        x.restore(checkpoint)


def summarize(transactions):
    summary = {}
    for row in transactions:
        if row['status'] != '0x1':
            continue
        entry = summary.setdefault(row['kind'], {'count': 0, 'minGas': None, 'maxGas': None, 'calldataBytes': set(), 'l1DataGasInL2Units': set()})
        entry['count'] += 1
        entry['minGas'] = row['childGasUsed'] if entry['minGas'] is None else min(entry['minGas'], row['childGasUsed'])
        entry['maxGas'] = row['childGasUsed'] if entry['maxGas'] is None else max(entry['maxGas'], row['childGasUsed'])
        entry['calldataBytes'].add(row['calldataBytes'])
        for quote in row['dataQuotes']:
            if 'l1DataGasInL2Units' in quote:
                entry['l1DataGasInL2Units'].add(quote['l1DataGasInL2Units'])
    for entry in summary.values():
        entry['calldataBytes'] = sorted(entry['calldataBytes'])
        entry['l1DataGasInL2Units'] = sorted(entry['l1DataGasInL2Units'])
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    source_options = parser.add_mutually_exclusive_group()
    source_options.add_argument('--source-url', help='loopback JSON-RPC source, e.g. an SSH-forwarded node')
    source_options.add_argument('--public-rpc', action='store_true', help='the official public endpoint (default)')
    parser.add_argument('--block', help='fork block number (hex or decimal); default: the head block')
    parser.add_argument('--rounds', type=int, default=40, help='fee-earning round trips before the compounds')
    parser.add_argument('--root0', default='2000000000000000000', help='root deposit of currency0, raw')
    parser.add_argument('--root1', default='8000000000', help='root deposit of currency1, raw')
    parser.add_argument('--width', type=int, default=200, help='root range half-width, ticks')
    parser.add_argument('--scenario-seconds', type=int, default=300)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    deployment = json.loads(MANIFEST.read_text())
    if deployment['chain']['chainId'] != q.CHAIN_ID:
        raise DataError('manifest_chain_mismatch')
    q.OPERATOR, q.PUBLISHER, q.RECIPIENT = (deployment['roles'][k] for k in ('operator', 'pricePublisher', 'feeRecipient'))
    report = {'tool': 'measure_v1_costs', 'chainId': q.CHAIN_ID, 'pool': 'weth-usdg', 'poolId': q.POOLS['weth-usdg'][0],
              'manifest': {'path': str(MANIFEST.relative_to(ROOT)), 'releaseTag': deployment['releaseTag'],
                           'sourceCommit': deployment['sourceCommit'], 'verifiedBlock': deployment['verifiedBlock']},
              'capturedAt': datetime.now(timezone.utc).isoformat(), 'rounds': args.rounds, 'rootWidthTicks': args.width,
              'scope': 'Anvil receipt gas units on the deployed V1 runtime under explicit ArbSys emulation; NodeInterface L1 data quotes from the source; not live Nitro estimates',
              'controls': 'synthetic owner/attacker and the deployed operator/publisher impersonated on the child; balances set locally; WETH wrapped; USDG moved from the pool manager',
              'transactions': [], 'scenarios': [], 'runStatus': 'started'}

    def save():
        with args.output.open('w') as handle:
            json.dump(report, handle, indent=1)
            handle.write('\n')

    if args.output.exists():
        raise DataError('output_exists')
    try:
        if args.source_url:
            source = q.Loopback(args.source_url)
            report['upstream'] = 'loopback source'
        else:
            source = ForkReadGateway(RPC_URL, max_requests=40_000, total_seconds=3600)
            report['upstream'] = q.urlsplit(RPC_URL).hostname
        with source as gateway:
            if gateway.request('eth_chainId') != hex(q.CHAIN_ID):
                raise DataError('fork_source_chain_mismatch')
            tag = 'latest' if args.block is None else hex(int(args.block, 0))
            block = gateway.request('eth_getBlockByNumber', [tag, False])
            report['source'] = {k: block[k] for k in ('number', 'hash', 'timestamp', 'baseFeePerGas')}
            with DepositFork(gateway, block=block, total_seconds=1800, max_requests=40_000) as fork:
                report['anvilVersion'] = fork.version
                x = DeployedExperiment(fork, 'weth-usdg', deployment, gateway, report['transactions'], args.scenario_seconds)
                report['chainSemantics'] = x.emulate_arbsys()
                report['stack'] = x.adopt_stack()
                report['artifactProvenance'] = x.artifact_provenance
                report['root'] = x.open_root(int(args.root0), int(args.root1), args.width)
                x.create_vault()
                report['vault'] = x.vault
                print(json.dumps({'stage': 'vault', 'vault': x.vault, 'token': x.token}), flush=True)
                x.fund_driver(10**24, 0)
                probe = x.amount_for_move(20)
                price_start = x.spot()[0]
                x.earn_fees(args.rounds, probe)
                fees = x.accrued()
                report['fees'] = {'rounds': args.rounds, 'legCurrency0': str(probe), 'accrued': [str(f) for f in fees],
                                  'sqrtPriceBefore': str(price_start), 'sqrtPriceAfter': str(x.spot()[0])}
                print(json.dumps({'stage': 'fees', **report['fees']}), flush=True)
                if fees[0] == 0 and fees[1] == 0:
                    raise DataError('fork_no_fees_accrued')
                reference = x.spot()[0]
                honest, honest_added = x.run_scenario('honest', 0, False, False, reference, (0, 0))
                report['scenarios'].append(honest)
                save()
                print(json.dumps({'stage': 'scenario', **{k: honest.get(k) for k in ('scenario', 'outcome', 'reason', 'gasUsed', 'liquidityAdded')}}), flush=True)
                try:
                    control, _ = x.run_scenario('swap-honest', 0, False, False, reference, honest_added, True)
                except Exception as error:  # noqa: BLE001
                    control = {'scenario': 'swap-honest', 'outcome': 'harness-error', 'reason': type(error).__name__ + ': ' + str(error)[:120]}
                report['scenarios'].append(control)
                save()
                print(json.dumps({'stage': 'scenario', **{k: control.get(k) for k in ('scenario', 'outcome', 'reason', 'gasUsed', 'liquidityAdded')}}), flush=True)
                report['lifecycle'] = x.lifecycle()
                save()
                print(json.dumps({'stage': 'lifecycle', 'outcome': report['lifecycle'].get('outcome'), 'reason': report['lifecycle'].get('reason'),
                                  'steps': [(s['step'], s['outcome'], s.get('gasUsed'), s.get('reason')) for s in report['lifecycle'].get('steps', [])]}), flush=True)
                report['redirect'] = measure_redirect(x, {'rounds': max(1, args.rounds // 4)})
                save()
                print(json.dumps({'stage': 'redirect', **{k: v for k, v in report['redirect'].items() if k in ('outcome', 'reason', 'mint', 'redirect')}}), flush=True)
        report['summary'] = summarize(report['transactions'])
        report['runStatus'] = 'complete'
    except BaseException as error:
        report['runStatus'] = 'failed'
        report['failure'] = type(error).__name__ + ': ' + str(error)[:200]
        raise
    finally:
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        report['summary'] = summarize(report['transactions'])
        save()
    print(json.dumps({'stage': 'done', 'output': str(args.output), 'summary': report['summary']}), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
