"""Reproduce the E3 review fixtures without a provider or live settings.

The frozen summaries are a compatibility check. Independent financial/math
assertions live in test_execution_planner.py; these examples are not its oracle.
"""
import json
from pathlib import Path

from test_execution_planner import NOW, evidence, history, p, setup


def check_vectors():
    document = json.loads((Path(__file__).parent/'fixtures'/'execution'/'planner-vectors.json').read_text())
    assert document['version'] == 'e3-offline-review-1' and document['syntheticOnly'] is True
    settings = p.PlannerSettings.model_validate_json(json.dumps(document['settings']))
    for vector in document['cases']:
        inputs = {**vector['setup'], 'amounts':tuple(vector['setup']['amounts'])}
        observation, _, _ = setup(**inputs)
        samples = history(observation, increment=vector['feeIncrementPer600SecondsPerCurrency'])
        decision = p.plan(observation, samples, settings, evidence(observation, settings), now=NOW)
        candidate = decision.candidates[decision.selected]
        actual = {'action':decision.action, 'liquidityIncrease':candidate.liquidityIncrease,
            'grossConsumed':list(candidate.grossConsumed), 'serviceCut':list(candidate.serviceCut),
            'netAdded':list(candidate.netAdded), 'ownerNetBenefitQuote':candidate.economics.ownerNetBenefitQuote,
            'operatorBufferedCostQuote':candidate.economics.operatorBufferedCostQuote}
        assert actual == vector['expected'], f"planner fixture drift: {vector['name']}"
    return len(document['cases'])


if __name__ == '__main__':
    print(f'E3 synthetic vectors match: {check_vectors()}. No live configuration selected.')
