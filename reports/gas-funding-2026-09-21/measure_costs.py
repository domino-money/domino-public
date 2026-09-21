"""Read-only Nitro price samples plus gas footprints on an owned Anvil child.

Run with the repository's backend/.venv Python. The source must be a loopback
SSH forward to the project node. Real-chain methods are explicitly read-only;
funding, impersonation and transactions are confined to DepositFork's child.
This measures costs; it implements neither a treasury nor a live gas sponsor.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
import qualify_execution_fork as q


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-url', required=True)
    parser.add_argument('--fork-output', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--lifecycle', action='store_true')
    args = parser.parse_args()
    source = q.Loopback(args.source_url)
    allowed = {'eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_gasPrice'}
    calls = 0

    def read(method, params=()):
        nonlocal calls
        if method not in allowed or calls >= 180:
            raise ValueError('read_only_source_budget')
        calls += 1
        return source.request(method, params)

    if read('eth_chainId') != hex(q.CHAIN_ID):
        raise ValueError('source_chain_mismatch')
    head = read('eth_getBlockByNumber', ['latest', False])
    out = {'capturedAt': datetime.now(timezone.utc).isoformat(),
        'source': 'project Nitro node through authenticated SSH, loopback only',
        'chainId': q.CHAIN_ID, 'head': {k: head[k] for k in ('number', 'hash', 'timestamp', 'baseFeePerGas')},
        'scope': 'Anvil transaction gas units, Nitro L1-data-only quotes and live base fees; not full live deployment estimates',
        'priceHistory': [], 'transactions': []}
    for offset in range(0, 36001, 600):
        b = read('eth_getBlockByNumber', [hex(int(head['number'], 16) - offset), False])
        out['priceHistory'].append({k: b[k] for k in ('number', 'hash', 'timestamp', 'baseFeePerGas')})

    def data_quotes(sender, target, data, value):
        quotes = []
        for tag in ('latest', 'safe'):
            try:
                block = read('eth_getBlockByNumber', [tag, False])
                raw = read('eth_call', [{'from': sender, 'to': '0x00000000000000000000000000000000000000c8',
                    'data': q.calldata('gasEstimateL1Component(address,bool,bytes)',
                        ['address', 'bool', 'bytes'], [target, False, bytes.fromhex(data[2:])]),
                    'value': hex(value)}, {'blockHash': block['hash'], 'requireCanonical': True}])
                gas, base, l1base = q.decode(['uint64', 'uint256', 'uint256'], bytes.fromhex(raw[2:]))
                quotes.append({'tag': tag, 'number': int(block['number'], 16), 'hash': block['hash'],
                    'l1DataGasInL2Units': gas, 'baseFeeWei': str(base), 'l1BaseFeeEstimateWei': str(l1base)})
            except Exception as error:
                quotes.append({'tag': tag, 'unavailable': type(error).__name__})
        return quotes

    class MeasuredExperiment(q.Experiment):
        def plan(self, liquidity_increase, max_added, swap_in=0, action=0, ticks=(0, 0), range_prices=None):
            plan, anchor = super().plan(liquidity_increase, max_added, swap_in, action, ticks, range_prices)
            if not hasattr(self, 'plan_kinds'):
                self.plan_kinds = {}
            self.plan_kinds[plan.calldata()] = 'execute_mint' if action == 3 else 'execute_swap' if swap_in else 'execute_general'
            return plan, anchor

        def send(self, sender, target, data='0x', value=0, gas=10_000_000):
            receipt = super().send(sender, target, data, value, gas)
            kind = None
            if sender == q.PUBLISHER and target == getattr(self, 'guard', None):
                kind = 'publish_observation'
            elif sender == q.OPERATOR and target == getattr(self, 'vault', None):
                kind = self.plan_kinds[data]
            elif sender == q.RECIPIENT and target == q.WETH and data[:10] == q.calldata('withdraw(uint256)', ['uint256'], [1])[:10]:
                kind = 'treasury_unwrap_weth'
            elif sender == q.RECIPIENT and target == q.OPERATOR and data == '0x':
                kind = 'treasury_native_transfer'
            if kind:
                out['transactions'].append({'kind': kind, 'childTransactionHash': receipt['transactionHash'],
                    'status': receipt['status'], 'childGasUsed': int(receipt['gasUsed'], 16),
                    'calldataBytes': (len(data) - 2) // 2, 'calldata': data,
                    'dataQuotes': data_quotes(sender, target, data, value)})
            return receipt

        def deploy_stack(self):
            super().deploy_stack()
            self.fund_native(q.RECIPIENT, 10**20)
            self.fork.request('anvil_impersonateAccount', [q.RECIPIENT])
            self.must(q.RECIPIENT, q.WETH, q.calldata('deposit()'), 10**17, 'treasury measurement wrap')
            self.must(q.RECIPIENT, q.WETH, q.calldata('withdraw(uint256)', ['uint256'], [5 * 10**16]), what='treasury measurement unwrap')
            self.must(q.RECIPIENT, q.OPERATOR, value=10**16, what='treasury measurement transfer')

    q.Experiment = MeasuredExperiment
    status = q.main(['--source-url', args.source_url, '--pool', 'weth-usdg', '--width', '200',
        '--rounds', '40', '--moves', '', '--output', str(args.fork_output)]
        + (['--lifecycle'] if args.lifecycle else []))
    out['forkExitStatus'] = status
    out['sourceReadCalls'] = calls
    out['finishedAt'] = datetime.now(timezone.utc).isoformat()
    with args.out.open('x') as handle:
        json.dump(out, handle, indent=2)
        handle.write('\n')
    return status


if __name__ == '__main__':
    raise SystemExit(main())
