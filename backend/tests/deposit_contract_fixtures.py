"""Synthetic direct-deposit producer examples. No real owner or transaction."""
from copy import deepcopy
from dataclasses import asdict

from deposit_models import CONTRACT_VERSION, validate_request, validate_response, ERROR_STATUS_BY_CODE
from test_lp_mint_inspection import fixture, plan, set_plan, OWNER, TOKEN0

NOW = 1800000000
INTENT = '00000000-0000-4000-8000-000000000040'
IDEMPOTENCY = '00000000-0000-4000-8000-000000000041'
HASH = '0x' + 'ab'*32


def selection(native=False):
    _, context = fixture(native=native)
    return {'chainId': 4663, 'poolId': context['pool_id'], 'poolKey': asdict(context['pool_key']),
        'independentToken': context['pool_key'].currency0, 'amountRaw': '100',
        'tickLower': -120, 'tickUpper': 180, 'slippageBps': 50,
        'budget0Raw': '1000', 'budget1Raw': '1000', 'nativeGasReserveRaw': '1000000',
        'maxGasLimitRaw': '500000', 'maxFeePerGasRaw': '10', 'maxPriorityFeePerGasRaw': '1'}


def artifact(native=False, now=NOW):
    tx, _ = fixture(native=native)
    actions, params, _ = plan(tx)
    set_plan(tx, actions, params, deadline=now+120)
    return {'kind': 'mint', 'transaction': {'chainId':4663, 'from':OWNER, 'to':tx['to'],
        'data':tx['data'], 'valueRaw':'101' if native else '0', 'nonceRaw':'7',
        'gasLimitRaw':'120000', 'maxFeePerGasRaw':'10', 'maxPriorityFeePerGasRaw':'1'},
        'sourceBlock':{'number':100, 'hash':HASH, 'timestamp':now-1},
        'expiresAt':now+30, 'preparedDeadline':now+120,
        'mintedBounds':{'amount0MaxRaw':'101','amount1MaxRaw':'202','mintLiquidityRaw':'12345',
                        'nativeValueRaw':'101' if native else '0'},
        'balances':{'nativeRaw':'100000000','token0Raw':'100000000' if native else '10000','token1Raw':'10000'},
        'admission':{'manifestId':'ab'*32,'policyVersion':'direct_existing_pool_v1'},
        'simulation':{'status':'passed','estimatedGasRaw':'100000','blockNumber':100,'blockHash':HASH}}


def operation(*, ready=False, native=False, now=NOW):
    result = {'id':INTENT,'idempotencyKey':IDEMPOTENCY,'owner':OWNER,'chainId':4663,
        'selection':selection(native), 'state':'awaiting_wallet' if ready else 'draft',
        'version':2 if ready else 1,'outstanding':ready,'createdAt':now,'updatedAt':now,
        'history':[], 'serviceFeeBps':0}
    if ready:
        result['history']=[{'step':1,'kind':'mint','issuedAt':now,'expiresAt':now+30,
            'nonceRaw':'7','transactionHash':None,'reconciliationState':None,'receipt':None,
            'reportedEffectConflicts':[]}]
    return result


def response(*, ready=False, native=False, now=NOW):
    return {'contractVersion':CONTRACT_VERSION,'operation':operation(ready=ready,native=native,now=now),
        'walletStep':artifact(native,now) if ready else None,
        'serverBroadcastAvailable':False,'automationAvailable':False}


def allowance_report(native=False, now=NOW):
    from deposit_receipt import PERMIT2
    from discovery import POSITION_MANAGER, ZERO
    key = selection(native)['poolKey']
    return {'snapshot': {'number': 100, 'hash': HASH, 'timestamp': now},
        'basis': 'pinned_contract_reads_not_token_admission', 'observations': [
            {'currency': currency, 'erc20Spender': PERMIT2, 'permit2Spender': POSITION_MANAGER,
             'erc20Status': 'observed', 'erc20AllowanceRaw': '17',
             'permit2Status': 'expired', 'permit2AllowanceRaw': '11', 'permit2Expiration': now-1,
             'revocationGuidance': 'wallet_erc20_approve_zero_and_permit2_approve_zero'}
            for currency in (key['currency0'], key['currency1']) if currency != ZERO]}


def build_fixtures():
    requests = {'create':{'idempotencyKey':IDEMPOTENCY,'selection':selection()},
        'get':{'intentId':INTENT},'list':{'limit':20},
        **{route:{'intentId':INTENT,'version':1} for route in ('prepare','reconcile','cancel')},
        'report':{'intentId':INTENT,'version':1,'transactionHash':HASH}, 'allowances': {'intentId': INTENT}}
    responses = {route:response(ready=route=='prepare') for route in requests}
    summary=operation();summary.pop('history')
    summary.update(historyCount=0,lastStep=None)
    responses['list']={'contractVersion':CONTRACT_VERSION,'operations':[summary], 'hasMore':False,'nextBefore':None,
                       'serverBroadcastAvailable':False,'automationAvailable':False}
    responses['allowances']['allowances'] = allowance_report()
    for route in requests:
        validate_request(route,requests[route]);validate_response(route,responses[route])
    errors=[{'status':status,'body':{'error':code}} for code,status in sorted(ERROR_STATUS_BY_CODE.items())]
    return requests,responses,errors


def build_variants():
    values={'native':('prepare',response(ready=True,native=True))}
    cancelled=response();cancelled['operation']['state']='cancelled'
    values['cancelled']=('cancel',cancelled)
    pending=response(ready=True);pending['walletStep']=None
    pending['operation']['state']='pending'
    pending['operation']['history'][0].update(transactionHash=HASH,reconciliationState='pending')
    values['pending']=('get',pending)
    from deposit_receipt import ReceiptReconciler, receipt_summary
    from test_deposit_receipt import context, Rpc, HASH as receipt_hash, synthetic_review
    for kind in ('erc20_reset','erc20_approval','permit2_approval','mint'):
        selected,prepared=context(kind=kind)
        body=response(ready=True,now=prepared['sourceBlock']['timestamp'])
        body['operation']['selection']=selected
        body['walletStep']=prepared
        body['operation']['history'][0].update(kind=kind,expiresAt=prepared['expiresAt'],nonceRaw=prepared['transaction']['nonceRaw'])
        values[kind]=('prepare',body)
    confirmed=deepcopy(values['mint'][1]);confirmed['walletStep']=None
    confirmed['operation'].update(state='confirmed',outstanding=False,version=3)
    receipt=receipt_summary(ReceiptReconciler(Rpc(), token_guard=synthetic_review).reconcile(OWNER,*context(),known_hashes=[receipt_hash]))
    confirmed['operation']['history'][0].update(transactionHash=receipt_hash,reconciliationState='confirmed',receipt=receipt)
    values['confirmed']=('get',confirmed)
    # Explicitly synthetic proxy review states for consumer migration tests.
    proxy = deepcopy(values['mint'][1])
    proxy['walletStep']['admission'].update(policyVersion='direct_existing_pool_v2',
        tokenReviews=[{'address': proxy['operation']['selection']['poolKey'][f'currency{i}'],
                       'reviewId': ('cd' if i == 0 else 'ef') * 32} for i in (0, 1)])
    values['reviewed-proxy'] = ('prepare', proxy)
    proxy_receipt = deepcopy(confirmed)
    for i in (0, 1):
        proxy_receipt['operation']['history'][0]['receipt']['position'][f'amount{i}Basis'] = 'reviewed_proxy_transfer_events'
    values['proxy-event-amounts'] = ('get', proxy_receipt)
    changed = deepcopy(confirmed)
    for i in (0, 1):
        position = changed['operation']['history'][0]['receipt']['position']
        position[f'amount{i}Raw'] = None
        position[f'amount{i}Basis'] = 'token_review_changed'
    values['token-review-changed'] = ('get', changed)
    bumped = deepcopy(confirmed)
    rpc = Rpc()
    rpc.transaction.update(gas=hex(300001), maxFeePerGas=hex(201), maxPriorityFeePerGas=hex(101))
    bumped['operation']['history'][0]['receipt'] = receipt_summary(
        ReceiptReconciler(rpc, token_guard=synthetic_review).reconcile(OWNER, *context(), known_hashes=[receipt_hash]))
    values['fee_cap_breach'] = ('get', bumped)
    legacy = deepcopy(confirmed)
    legacy['operation']['history'][0]['receipt']['transaction'] = None
    values['legacy_receipt'] = ('get', legacy)
    conflict = deepcopy(confirmed)
    conflict['operation'].update(state='attention', outstanding=True)
    conflict['operation']['history'][0].update(reconciliationState='mismatched',
        reportedEffectConflicts=[{'transactionHash': '0x'+'cd'*32, 'nonceRaw': '6'}])
    values['reported_nonce_conflict'] = ('get', conflict)
    superseded = deepcopy(confirmed)
    superseded['operation']['state'] = 'superseded'
    superseded['operation']['history'][-1]['reconciliationState'] = 'mismatched'
    superseded['operation']['history'][-1]['receipt']['position'] = None
    values['superseded'] = ('get', superseded)
    allowances = {**response(), 'allowances': allowance_report()}
    allowances['allowances']['observations'][0].update(erc20Status='unavailable', erc20AllowanceRaw=None)
    values['partial_allowances'] = ('allowances', allowances)
    for route,body in values.values(): validate_response(route,body)
    return values
