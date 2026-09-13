"""Synthetic private-card wire examples, never financial qualification evidence."""
from copy import deepcopy

from performance_models import CONTRACT_VERSION, ERROR_STATUS_BY_CODE, PERFORMANCE_REASONS, validate_response


def build_fixtures():
    epoch = '0x'+'11'*32
    empty = {name: None for name in (
        'newTradingFeesUsd', 'externalDepositsUsd', 'externalWithdrawalsUsd', 'reinvestedUsd',
        'actualServiceFeesUsd', 'otherStrategyCostsUsd', 'operatorCostsUsd', 'netFeeIncomeUsd',
        'timeWeightedCapitalUsd', 'grossFeeAprPercent', 'netFeeAprPercent', 'projectedApyPercent')}
    card = {'epochId': epoch, 'kind': 'tracked', 'vault': '0x'+'22'*20,
        'positionManager': '0x'+'33'*20, 'rootTokenId': '101', 'sequenceIdentity': '0x'+'44'*32,
        'baseline': {'blockNumber': 100, 'blockHash': '0x'+'55'*32, 'timestamp': 1000},
        'snapshot': {'blockNumber': 120, 'blockHash': '0x'+'66'*32, 'timestamp': 1060},
        'revision': 3, 'replayGeneration': 1, 'collectionStatus': 'measuring',
        'collectionReason': 'forward_observations_only', 'observedSeconds': 60,
        'snapshotAgeSeconds': 10, 'observations': {'pages': 2, 'receipts': 3, 'events': 5},
        'performanceStatus': 'unavailable', 'performanceReasons': list(PERFORMANCE_REASONS),
        'metrics': empty, 'complete24h': False, 'executionAvailable': False}
    response = {'contractVersion': CONTRACT_VERSION, 'chainId': 4663, 'owner': '0x'+'77'*20,
        'cards': [card], 'refreshAfterSeconds': 30, 'executionAvailable': False}
    return {'cards': {'epochIds': [epoch]}}, {'cards': validate_response('cards', response)}, [
        {'status': status, 'body': {'error': code}} for code, status in sorted(ERROR_STATUS_BY_CODE.items())]


def build_variants():
    _, responses, _ = build_fixtures()
    result = {}
    for name, status, reason, age in (
            ('last-good-read-failed', 'stale', 'latest_read_failed', 10),
            ('dated-snapshot', 'stale', 'snapshot_stale', 180),
            ('canonical-replay', 'partial', 'canonical_replay_required', 10),
            ('baseline-reorged', 'unavailable', 'baseline_reorged', 10)):
        value = deepcopy(responses['cards'])
        card = value['cards'][0]
        card.update(collectionStatus=status, collectionReason=reason, snapshotAgeSeconds=age)
        value['refreshAfterSeconds'] = 60
        result[name] = validate_response('cards', value)
    value = deepcopy(responses['cards'])
    card = value['cards'][0]
    keys = ('epochId', 'performanceStatus', 'performanceReasons', 'metrics', 'complete24h', 'executionAvailable')
    value['cards'] = [{key: card[key] for key in keys} | {
        'kind': 'not_found', 'collectionStatus': 'unavailable', 'collectionReason': 'epoch_not_found'}]
    result['unknown-or-foreign-epoch'] = validate_response('cards', value)
    return result
