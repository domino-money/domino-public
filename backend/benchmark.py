"""Replay recorded rate estimates through proposed public-service cost checks.

Read only. Export no addresses, NFT IDs, hashes, raw transactions or credentials.
This is NOT a transaction backtest: historical rate estimates are evaluated
under hypothetical gas, balanced fees, a constant price and no new market data.
"""
import argparse
from collections import Counter, deque
from decimal import Decimal, ROUND_CEILING
import json
from pathlib import Path
from statistics import median

from domain import compound_preview, money_units, money_string


def summarize(path, gas):
    money_units(gas)
    rates, reasons, dropped = [], Counter(), 0
    with Path(path).open() as stream:
        lines = deque(stream, maxlen=10_000)
    for line in lines:
        try:
            row = json.loads(line)
            for position in row.get('sequence', {}).get('positions', []):
                if not position.get('in_range'):
                    reasons['outside_range'] += 1
                    continue
                if position.get('coverage_seconds', 0) < 600:
                    reasons['insufficient_history'] += 1
                    continue
                capital = Decimal(str(position['capital']))
                apr = Decimal(str(position['fee_apr_percent']))
                if not capital.is_finite() or not apr.is_finite() or capital <= 0 or apr <= 0:
                    reasons['no_positive_rate'] += 1
                    continue
                daily = capital * apr / 100 / 365
                capital_text = str(capital.quantize(Decimal('.000001')))
                decision = compound_preview(dict(availableFeesUsd='1000000', positionValueUsd=capital_text, gasUsd=gas))
                if decision['decision'] != 'eligible':
                    reasons['available_fees_do_not_cover_cost'] += 1
                    continue
                seconds = Decimal(decision['minimumFeesUsd']) / daily * 86400
                rates.append(int(seconds.to_integral_value(rounding=ROUND_CEILING)))
        except (ValueError, KeyError, TypeError, ArithmeticError, AttributeError):
            dropped += 1
    return dict(kind='historical_rate_cost_sensitivity', liveExecution=False,
                hypotheticalGasUsd=gas, proposedServiceFeeBps=200, gasBufferBps=1500,
                minimumCoverageSeconds=600, eligibleObservationCount=len(rates),
                excludedObservations=dict(reasons), malformedRows=dropped,
                estimatedSecondsToCostCoverage=dict(min=min(rates), median=median(rates), max=max(rates)) if rates else None,
                limitations=['Recorded rate estimates overlap; observations are not independent returns.',
                             'Assumes balanced fee assets, constant price and unchanged accrual.',
                             'Does not assess price integrity, token ratios, owner advantage or signing eligibility.',
                             'This is not a forecast or an execution backtest.'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--observations', required=True)
    parser.add_argument('--gas-usd', default='0.25')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    report = summarize(args.observations, args.gas_usd)
    Path(args.output).write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))
