#!/usr/bin/env python3
"""Write the read-v5 shared fixtures: valid answers, and invalid answers with one defect each.

The valid answers are what the producer serves (featured_contract.build_response)
for stored revisions; each invalid answer is the valid `current` answer with a
single defect, named by its file. A consumer's validator (the Worker's
runtime.mjs, the app) must accept every file under valid/ and refuse every file
under invalid/, exactly as backend/featured_contract.py does
(featured-pools v1 §10.2; rc.2 adds featured-policy v2). `--check` compares
instead of writing.
"""
import argparse
import copy
from datetime import date
import json
from pathlib import Path
import sys

from eth_abi import encode
from eth_hash.auto import keccak

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from discovery import KEY_TYPES
from featured_contract import build_response, validate_featured_response
from featured_pools import list_id
from featured_selector import list_entry

DEST = ROOT / 'api-contracts/read-v5/fixtures'
ZERO = '0x' + '0' * 40
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571'
# Synthetic tokens: the fixtures describe the wire, not real listings.
TOKEN_B = '0x' + 'b1' * 20
TOKEN_C = '0x' + '1c' * 20
SELECTED_AT, EFFECTIVE_AT, SERVED_AT = 1790422200, 1790424000, 1790431234
DAY = date(2026, 9, 26)
METHOD = 'fixed_lp_fee_x_volume24h_over_reported_tvl_annualized_365'
# featured-policy v2 (backend/featured_policy.json): today's APR ranks, a null rule is off.
RULES = {'rankBy': 'feeAprEstimate24hPercent', 'estimateMethod': METHOD, 'marketSource': 'geckoterminal',
         'minVolume24hUsd': '1000000', 'minTvlUsd': '100000', 'minReferenceDepthUsd': None,
         'maxAprPercent': None, 'maxTurnover24h': None, 'minPoolAgeHours': None, 'size': 6}
# featured-policy v1: the lower of today's and the previous day's APR ranks; every rule is on.
RULES_V1 = {'rankBy': 'min_fresh_and_previous_day_feeAprEstimate24hPercent', 'estimateMethod': METHOD,
            'marketSource': 'geckoterminal', 'minVolume24hUsd': '250000', 'minTvlUsd': '250000',
            'minReferenceDepthUsd': '10000', 'maxAprPercent': '1000', 'maxTurnover24h': '25',
            'minPoolAgeHours': 72, 'size': 6}


def pool(token, symbol, decimals, *, slot, source, fee=3000, spacing=60, identity='catalogue_hint',
         age='provider_pool_created_at', initialize_block=None, rank=None, prev=None, depth='41000.5'):
    """A stored list entry, made by the selector's own list_entry from one evaluation."""
    currencies = sorted((token, USDG))
    symbols = {token: (symbol, decimals), USDG: ('USDG', 6)}
    evaluation = {
        'poolKey': {'currency0': currencies[0], 'currency1': currencies[1], 'fee_pips': fee,
                    'tick_spacing': spacing, 'hooks': ZERO, 'feeMode': 'fixed'},
        'tokens': [{'address': currency, 'symbol': symbols[currency][0], 'decimals': symbols[currency][1]}
                   for currency in currencies],
        'identitySource': identity, 'ageSource': age, 'initializeBlock': initialize_block, 'reference': USDG,
        'block': {'number': 73400000, 'hash': '0x' + 'ab' * 32, 'timestamp': SELECTED_AT + 60},
        'sqrtPriceX96': str(2 ** 96), 'rankApr': rank, 'freshApr': '551.0', 'prevApr': prev,
        'volume24hUsd': '1170000', 'reportedLiquidityUsd': '620000', 'referenceDepthUsd': depth}
    pool_id = '0x' + keccak(encode(KEY_TYPES, (*currencies, fee, spacing, ZERO))).hex()
    return list_entry({'slot': slot, 'source': source, 'poolId': pool_id}, evaluation)


def revision(number, status, pools, *, withdrawn=(), selected=True, rules=RULES,
             policy='featured-v1:3f9c2a1b7d0e', rejected=(('hooked_pool_unsupported', 13), ('tvl_below_floor', 63))):
    """A stored featured_lists row: selected lists state how they were chosen, owner lists do not."""
    payload = {'schemaVersion': 1, 'phase': 'live', 'pools': pools, 'listId': list_id(pools),
               'generatedAt': SELECTED_AT, 'withdrawn': list(withdrawn)}
    if selected:
        payload.update(
            policyVersion=policy, window={'start': SELECTED_AT - 86400, 'end': SELECTED_AT},
            coverage={'source': 'geckoterminal_dex_pools_by_h24_volume', 'pages': 10,
                      'lastListedVolume24hUsd': '513000', 'truncated': True, 'stoppedBy': None, 'rejectedItems': 0},
            rules=dict(rules),
            evaluation={'candidates': 212, 'shortlisted': 38, 'eligible': 25, 'rejectedByReason': dict(rejected)})
    return {'revision': number, 'status': status, 'list_id': payload['listId'], 'selection_date': DAY,
            'generated_at': SELECTED_AT, 'effective_at': EFFECTIVE_AT, 'valid_until': EFFECTIVE_AT + 36 * 3600,
            'payload': payload}


def stored():
    pinned = pool(PONS, 'PONS', 18, slot=1, source='pinned')
    # Ranked by today's APR, first evaluated today (no previous APR), its depth not measured.
    ranked = pool(TOKEN_B, 'TKNB', 18, slot=2, source='ranked', identity='catalogue_event',
                  age='catalogue_event', initialize_block=57898668, rank='551.0', prev=None, depth=None)
    ranked_v1 = pool(TOKEN_B, 'TKNB', 18, slot=2, source='ranked', identity='catalogue_event',
                     age='catalogue_event', initialize_block=57898668, rank='546.1', prev='546.1')
    fallback = pool(TOKEN_C, 'TKNC', 9, slot=2, source='fallback', fee=2500, spacing=50, identity='position_manager',
                    age=None)
    withdrawn = {'poolId': ranked['poolId'], 'reason': 'tvl_collapse', 'at': SERVED_AT - 600}
    earlier = {'poolId': '0x' + '22' * 32, 'reason': 'excluded_by_owner', 'at': SERVED_AT - 3 * 86400}
    return {
        'current': revision(41, 'current', [pinned, ranked], withdrawn=[earlier]),
        # A list chosen under featured-policy v1, as stored before v2: served as it was recorded.
        'current-policy-v1': revision(40, 'current', [pinned, ranked_v1], withdrawn=[earlier], rules=RULES_V1,
                                      policy='featured-v1:8e2d51c07a94',
                                      rejected=(('pool_too_young', 55), ('tvl_below_floor', 63))),
        # The ranked pool left during the day; a pool of the embedded list took its slot.
        'repaired': revision(42, 'repaired', [pinned, fallback], withdrawn=[earlier, withdrawn]),
        'manual': revision(43, 'manual', [{**pinned, 'source': 'manual'}], selected=False),
        # Mode off: no pools, but the week's removals stay (a withdrawn pool opened by link stays blocked).
        'none-with-withdrawn': revision(44, 'none', [], withdrawn=[earlier, withdrawn], selected=False),
        # Nothing was ever served.
        'none': None,
    }


def valid():
    return {name: build_response(row, now=SERVED_AT) for name, row in stored().items()}


def invalid(current):
    def defect(change):
        body = copy.deepcopy(current)
        change(body)
        return body

    def pool_(index):
        return lambda body: body['pools'][index]

    def many(body):
        body['pools'] = [{**body['pools'][0], 'slot': slot, 'poolId': '0x%064x' % slot} for slot in range(1, 14)]

    def unsorted(body):
        entry = body['pools'][1]
        key, tokens = entry['poolKey'], entry['tokens']
        key['currency0'], key['currency1'] = key['currency1'], key['currency0']
        tokens.reverse()

    first, second = pool_(0), pool_(1)
    return {
        'extra-key': defect(lambda b: b.update(cached=True)),
        'missing-key': defect(lambda b: b.pop('limitations')),
        'wrong-chain': defect(lambda b: b.update(chainId=1)),
        'wrong-contract-version': defect(lambda b: b.update(contractVersion='1.0.0-rc.3')),
        'wrong-schema-version': defect(lambda b: b.update(schemaVersion=2)),
        'wrong-mode': defect(lambda b: b.update(mode='live_featured_pools')),
        'unknown-status': defect(lambda b: b.update(status='stale')),
        'none-with-pools': defect(lambda b: b.update(status='none')),
        'current-without-pools': defect(lambda b: b.update(pools=[])),
        'too-many-pools': defect(many),
        'slot-gap': defect(lambda b: second(b).update(slot=3)),
        'slot-from-zero': defect(lambda b: (first(b).update(slot=0), second(b).update(slot=1))),
        'duplicate-pool': defect(lambda b: second(b).update(poolId=first(b)['poolId'])),
        'uppercase-pool-id': defect(lambda b: first(b).update(poolId=first(b)['poolId'].upper().replace('0X', '0x'))),
        'currencies-unsorted': defect(unsorted),
        'token-address-mismatch': defect(lambda b: second(b)['tokens'][0].update(address=TOKEN_C)),
        'hooked-pool': defect(lambda b: second(b)['poolKey'].update(hooks='0x' + '11' * 20)),
        'dynamic-fee': defect(lambda b: second(b)['poolKey'].update(feeMode='dynamic')),
        'fee-out-of-range': defect(lambda b: second(b)['poolKey'].update(fee_pips=1_000_000)),
        'tick-spacing-zero': defect(lambda b: second(b)['poolKey'].update(tick_spacing=0)),
        'tick-spacing-too-wide': defect(lambda b: second(b)['poolKey'].update(tick_spacing=32768)),
        'integration-class': defect(lambda b: second(b).update(integrationClass='hooked')),
        # On the pinned pool, which has no rank inputs: only the source's enum refuses it.
        'unknown-source': defect(lambda b: first(b).update(source='promoted')),
        'unknown-identity-source': defect(lambda b: second(b).update(identitySource='provider')),
        'empty-symbol': defect(lambda b: second(b)['tokens'][1].update(symbol='')),
        'long-symbol': defect(lambda b: second(b)['tokens'][1].update(symbol='T' * 33)),
        'bidi-symbol': defect(lambda b: second(b)['tokens'][1].update(symbol='TKN‮B')),
        'control-symbol': defect(lambda b: second(b)['tokens'][1].update(symbol='TKN\u0007B')),
        'spaced-symbol': defect(lambda b: second(b)['tokens'][1].update(symbol='TKN B')),
        'null-symbol': defect(lambda b: second(b)['tokens'][1].update(symbol=None)),
        'decimals-above-36': defect(lambda b: second(b)['tokens'][1].update(decimals=37)),
        'short-block-hash': defect(lambda b: second(b)['verifiedAt'].update(hash='0x' + 'ab' * 31)),
        'effective-before-generated': defect(lambda b: b.update(effectiveAt=b['generatedAt'] - 1)),
        'valid-until-before-effective': defect(lambda b: b.update(validUntil=b['effectiveAt'] - 1)),
        'generated-after-served': defect(lambda b: b.update(servedAt=b['generatedAt'] - 1)),
        'served-without-revision': defect(lambda b: b.update(revision=None)),
        'bad-selection-date': defect(lambda b: b.update(selectionDate='2026-02-30')),
        'bad-policy-version': defect(lambda b: b.update(policyVersion='featured-v2:3f9c2a1b7d0e')),
        'too-many-withdrawn': defect(lambda b: b.update(withdrawn=[{**b['withdrawn'][0], 'poolId': '0x%064x' % n}
                                                                   for n in range(25)])),
        'unknown-withdrawn-reason': defect(lambda b: b['withdrawn'][0].update(reason='vibes')),
        'listed-and-withdrawn': defect(lambda b: b['withdrawn'][0].update(poolId=second(b)['poolId'])),
        'unknown-rejection-reason': defect(lambda b: b['evaluation']['rejectedByReason'].update(vibes=1)),
        # rc.2: a market rule may be off (null); the rank, the floors and what they read may not.
        'unknown-rank-by': defect(lambda b: b['rules'].update(rankBy='volume24hUsd')),
        'null-min-volume': defect(lambda b: b['rules'].update(minVolume24hUsd=None)),
        'null-min-tvl': defect(lambda b: b['rules'].update(minTvlUsd=None)),
        'null-rank-apr': defect(lambda b: second(b)['rankInputs'].update(rankApr=None)),
        'null-fresh-apr': defect(lambda b: second(b)['rankInputs'].update(freshApr=None)),
        'null-rank-volume': defect(lambda b: second(b)['rankInputs'].update(volume24hUsd=None)),
        'null-rank-liquidity': defect(lambda b: second(b)['rankInputs'].update(reportedLiquidityUsd=None)),
        'numeric-decimal': defect(lambda b: second(b)['rankInputs'].update(volume24hUsd=1170000)),
        'numeric-apr': defect(lambda b: second(b)['rankInputs'].update(rankApr=546.1)),
        'rank-inputs-on-pin': defect(lambda b: first(b).update(rankInputs=second(b)['rankInputs'])),
        'ranked-without-rank-inputs': defect(lambda b: second(b).update(rankInputs=None)),
        'suggested': defect(lambda b: b.update(suggested=True)),
        'execution-available': defect(lambda b: b.update(executionAvailable=True)),
        # rc.1 never exposes the day's draft: the daily note reads it on the VM.
        'upcoming-draft': defect(lambda b: b.update(upcoming={'revision': 42, 'effectiveAt': b['effectiveAt'],
                                                              'poolIds': [], 'entering': [], 'leaving': []})),
        'unknown-limitation': defect(lambda b: b['limitations'].append('audited')),
    }


def text(value):
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + '\n'


def files():
    answers = valid()
    defects = invalid(answers['current'])
    for name, body in defects.items():
        try:
            validate_featured_response('featured-pools', body)
        except ValueError:
            continue
        raise SystemExit(f'invalid fixture {name} is accepted by the producer')
    return {**{f'valid/{name}.json': text(body) for name, body in answers.items()},
            **{f'invalid/{name}.json': text(body) for name, body in defects.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    expected = files()
    present = {path.relative_to(DEST).as_posix() for path in DEST.glob('*/*.json')}
    if args.check:
        stale = sorted(name for name in expected if not (DEST / name).is_file()
                       or (DEST / name).read_text() != expected[name])
        extra = sorted(present - set(expected))
        if stale or extra:
            raise SystemExit('read-v5 fixtures differ: ' + ', '.join(stale + extra))
        return
    for name in present - set(expected):
        (DEST / name).unlink()
    for name, content in expected.items():
        (DEST / name).parent.mkdir(parents=True, exist_ok=True)
        (DEST / name).write_text(content)


if __name__ == '__main__':
    main()
