"""Synthetic E1 vectors; no addresses, settings or amounts are deployment defaults."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import execution_models as m
from position_accounting import core_position_id


def address(n):
    return '0x' + n.to_bytes(20, 'big').hex()


def identity(n):
    return '0x' + n.to_bytes(32, 'big').hex()


def sequence(*, native=False, reverse=False, owner=1, number=11, manager=6):
    pair = m.PoolKey(currency0=address(0 if native else 16), currency1=address(32),
                     fee_pips=3000, tick_spacing=60, hooks=m.ZERO)
    return m.SequenceIdentity(chainId=4663, owner=address(owner), sequenceId=identity(number),
        vault=address(3), factory=address(4), implementation=address(5), implementationVersion='1',
        poolManager=address(7), positionManager=address(manager), poolKey=pair, poolId=pair.pool_id(),
        baseCurrency=pair.currency1 if reverse else pair.currency0,
        quoteCurrency=pair.currency0 if reverse else pair.currency1, serviceFeeRecipient=address(8))


def position(seq, token=101, parent=None, *, lower=-120, upper=180, generation='1'):
    return m.PositionIdentity(sequence=seq.digest(), tokenId=str(token), generation=generation,
        isRoot=parent is None, parentTokenId=str(parent or 0), tickLower=lower, tickUpper=upper,
        corePositionId=core_position_id(seq.positionManager, lower, upper, identity(token)),
        registrationBaselineId=identity(1000 + token))


def scenario(action=1, *, native=False, reverse=False, owner=1, number=11, manager=6, charged=False):
    seq = sequence(native=native, reverse=reverse, owner=owner, number=number, manager=manager)
    root = position(seq)
    members = [m.CustodyObservation(position=root, holder=seq.owner, individualApproval=seq.vault, active=True)]
    destination = root
    if action == 2:
        destination = position(seq, 102, 101, lower=0, upper=600)
        members.append(m.CustodyObservation(position=destination, holder=seq.vault, individualApproval=m.ZERO, active=True))
    source = m.FeeSourceIdentity(sequence=seq.digest(), position=root.digest(), currency=seq.poolKey.currency0)
    policy = m.SequencePolicy(serviceFeeBps=200, triggerDistanceBps=500, maxOverlapBps=2000,
        minimumIntervalSeconds=600, maxPositions=4, version='1', paused=False,
        limits=m.ExecutionLimits(version='1', baseCurrency=seq.baseCurrency, quoteCurrency=seq.quoteCurrency,
            upsideBps=5000, maxSlippageBps=100, maxPriceImpactBps=100, maxGasCostWei='1000000000000000',
            maxObservationAgeSeconds=120, forecastHorizonSeconds=3600))
    balance = m.SourceBalance(source=source, lotId=identity(201), currency=seq.poolKey.currency0,
        convertedCharged=charged, amountRaw='1300', reservedRaw='100', reconciliationId=identity(202))
    observation = m.Observation(sequence=seq, policy=policy, stateNonce='7', authorityGeneration='1',
        blockNumber='1234', blockHash=identity(301), blockTimestamp='1700000000', sqrtPriceX96=str(2**96),
        operator=address(9), operatorEnabled=True, canonical=True, coverageComplete=True,
        positions=tuple(sorted(members, key=lambda p:p.position.digest())), balances=(balance,), accruals=())
    disabled = m.SwapBounds(enabled=False, adapterId=m.ZERO_HASH, adapterVersion='0', routeCommitment=m.ZERO_HASH,
        currencyIn=m.ZERO, currencyOut=m.ZERO, amountInRaw='0', minAmountOutRaw='0')
    plan = m.ExecutionPlan(sequence=seq, policyHash=policy.digest(), observationHash=observation.digest(),
        action=action, path=0, expectedPolicyVersion='1', expectedStateNonce='7', expectedAuthorityGeneration='1',
        sourceBlockNumber='1234', sourceBlockHash=identity(301), deadline='1700000060',
        allocations=(m.Allocation(lotId=balance.lotId, amountRaw='1000'),), collections=(),
        destination=m.Destination(createChild=action==3, tokenId=destination.tokenId,
            tickLower=0 if action==3 else destination.tickLower, tickUpper=600 if action==3 else destination.tickUpper),
        liquidityIncrease='1', maxGrossFee0='0' if charged else '1000', maxGrossFee1='0',
        maxChargedInput0='1000' if charged else '0', maxChargedInput1='0',
        minNetAdded0='980', minNetAdded1='0', minSqrtPriceX96=str(2**96-1), maxSqrtPriceX96=str(2**96+1),
        maxGasCostWei='1000000000000', swap=disabled)
    credit = m.FeeCredit(source=source.digest(), transactionHash=identity(401), eventIndex=3,
        amountRaw='1300', blockNumber='1234', blockHash=identity(301), canonical=True, finalized=False)
    return observation, plan, credit


def vectors():
    cases = []
    for name, kwargs in [('self', {}), ('redirect', {'action':2}), ('domino', {'action':3}),
                         ('native', {'native':True}), ('reversed', {'reverse':True}),
                         ('other_owner', {'owner':2}), ('other_sequence', {'number':12}),
                         ('other_manager', {'manager':10}), ('charged_residual', {'charged':True})]:
        obs, plan, credit = scenario(**kwargs)
        m.validate_candidate(plan, obs, now=1700000030, actor=obs.operator)
        cases.append({'name':name, 'observation':obs.model_dump(mode='json'), 'plan':plan.model_dump(mode='json'),
                      'credit':credit.model_dump(mode='json'), 'sequenceHash':obs.sequence.digest(),
                      'positionHash':obs.balances[0].source.position, 'sourceHash':obs.balances[0].source.digest(),
                      'creditId':credit.credit_id(), 'creditHash':credit.digest(),
                      'domainHash':'0x'+plan.domain_hash().hex(), 'planHash':plan.digest(), 'intentId':plan.intent_id(),
                      'successorId':plan.successor_id() if plan.action==3 else None})
    return {'version':m.VERSION, 'syntheticOnly':True,
            'encodingTypes':{name:kind.type_string() for name,kind in vars(m).items()
                if isinstance(kind,type) and issubclass(kind,m.Record) and kind is not m.Record},
            'wait':m.WaitDecision(action='wait', observationHash=scenario()[0].digest(), reason='not_due').model_dump(),
            'cases':cases}


def serialized():
    return json.dumps(vectors(), indent=2, sort_keys=True) + '\n'


if __name__ == '__main__':
    target = Path(__file__).parent/'fixtures'/'execution'/'e1-vectors.json'
    if sys.argv[1:] == ['--write']:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(serialized())
    else:
        assert target.read_text() == serialized(), 'execution fixture drift'
        print('Execution candidate fixtures match.')
