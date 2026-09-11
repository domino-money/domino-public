import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CONTRACT_VERSION, ROUTES, validateRequest, validateResponse, validateError, validateWalletStep} from '../../api-contracts/deposit-v1/runtime.mjs';

const root = new URL('../../api-contracts/deposit-v1/', import.meta.url);
const read = path => JSON.parse(fs.readFileSync(new URL(path, root), 'utf8'));
const clone = value => structuredClone(value);
// Exercise the same receipt through full history and compact lastStep.
function readViews(body) {
  const item = clone(body.operation), history = item.history;
  delete item.history;
  Object.assign(item, {historyCount:history.length, lastStep:history.at(-1) ?? null});
  return [['get', body], ['list', {contractVersion:body.contractVersion, operations:[item],
    hasMore:false, nextBefore:null, serverBroadcastAvailable:false, automationAvailable:false}]];
}

test('all producer requests, responses, errors and variants pass the browser validator', () => {
  assert.equal(CONTRACT_VERSION, '1.1.0-rc.2');
  for (const route of ROUTES) {
    assert.equal(validateRequest(route, read(`fixtures/requests/${route}.json`)), true, route);
    assert.equal(validateResponse(route, read(`fixtures/responses/${route}.json`)), true, route);
  }
  for (const {status, body} of read('fixtures/errors.json')) {
    assert.equal(validateError(status, body), true);
    assert.equal(validateError(200, body), false);
  }
  for (const name of fs.readdirSync(new URL('fixtures/variants/', root))) {
    const data = read(`fixtures/variants/${name}`);
    const route = data.allowances ? 'allowances' : data.walletStep ? 'prepare' : name === 'cancelled.json' ? 'cancel' : 'get';
    assert.equal(validateResponse(route, data), true, name);
    if (data.walletStep) assert.equal(validateWalletStep(data.operation.selection, data.operation.owner, data.walletStep), true, name);
  }
});

test('residual allowance status cannot invent expiry, zeroes, identity or wallet authority', () => {
  const source = read('fixtures/responses/allowances.json');
  for (const change of [{erc20AllowanceRaw:null}, {permit2Status:'active'}, {permit2AllowanceRaw:String(1n<<160n)},
                       {currency:source.operation.owner}, {revocationGuidance:'revoked_automatically'}]) {
    const bad=clone(source);Object.assign(bad.allowances.observations[0],change);
    assert.equal(validateResponse('allowances',bad),false,JSON.stringify(change));
  }
  const superseded=read('fixtures/variants/superseded.json');
  superseded.operation.history[0].receipt=null;
  assert.equal(validateResponse('get',superseded),false);
});

test('unknown identity, signature, receipt claims and unsafe amount/selector inputs are rejected', () => {
  const request = read('fixtures/requests/create.json');
  for (const key of ['owner', 'recipient', 'calldata', 'signature', 'providerUrl']) assert.equal(validateRequest('create', {...request, [key]: 'injected'}), false);
  for (const [key,value] of [['budget0Raw',1000],['budget0Raw',String(1n<<128n)],['maxGasLimitRaw','3000001'],
    ['chainId',true],['tickLower',-121],['independentToken','0x'+'ff'.repeat(20)]]) {
    const bad=clone(request);bad.selection[key]=value;assert.equal(validateRequest('create',bad),false,key);
  }
  assert.equal(validateRequest('report',{...read('fixtures/requests/report.json'),success:true}),false);
});

test('all admitted calldata is bound to exact tokens, recipient, limits and deadline', () => {
  for (const kind of ['erc20_reset','erc20_approval','permit2_approval','mint','native']) {
    const response=read(`fixtures/variants/${kind}.json`);
    for (const mutate of [
      step => {step.transaction.to='0x'+'ff'.repeat(20);},
      step => {step.transaction.valueRaw='999';},
      step => {step.transaction.data+='00';},
      step => {step.transaction.data=step.transaction.data.slice(0,-2)+'ff';},
      step => {step.transaction.nonceRaw=String(1n<<64n);},
      step => {step.preparedDeadline+=4000;},
      step => {step.mintedBounds.amount0MaxRaw='100000000';},
      step => {step.transaction.maxFeePerGasRaw='999';},
    ]) {
      const bad=clone(response);mutate(bad.walletStep);
      assert.equal(validateResponse('prepare',bad),false,kind);
    }
    if (['mint','native','permit2_approval'].includes(kind)) {
      const bad=clone(response);bad.walletStep.preparedDeadline++;
      assert.equal(validateResponse('prepare',bad),false,kind+' encoded deadline');
    }
  }
});

test('wallet payload cannot appear on a durable read or be associated with a different operation owner', () => {
  const prepared=read('fixtures/responses/prepare.json');
  for(const route of ['get','create','cancel','report','reconcile']) assert.equal(validateResponse(route,prepared),false);
  prepared.operation.owner='0x'+'ee'.repeat(20);
  assert.equal(validateResponse('prepare',prepared),false);
});

test('cost and ownership observation fields preserve verified and unavailable values', () => {
  const response=read('fixtures/variants/confirmed.json');
  const receipt=response.operation.history[0].receipt;
  assert.ok(receipt.position.ownershipObservedBlock.hash);
  receipt.totalFeeRaw='0';assert.equal(validateResponse('get',response),false);
  const missing=read('fixtures/variants/confirmed.json');
  missing.operation.history[0].receipt.l1FeeRaw=null;
  missing.operation.history[0].receipt.totalFeeRaw=null;
  assert.equal(validateResponse('get',missing),true);
});

test('compact pagination metadata must match the returned last item', () => {
  const response=read('fixtures/responses/list.json');
  response.hasMore=true;assert.equal(validateResponse('list',response),false);
  response.nextBefore=response.operations.at(-1).id;assert.equal(validateResponse('list',response),true);
  response.operations[0].historyCount=2;assert.equal(validateResponse('list',response),false);
});

test('observed limit flags are exact for every subset and equality', () => {
  const source = read('fixtures/variants/fee_cap_breach.json');
  const fields = [['gasLimit','gasLimitRaw','maxGasLimitRaw'],
    ['maxFeePerGas','maxFeePerGasRaw','maxFeePerGasRaw'],
    ['maxPriorityFeePerGas','maxPriorityFeePerGasRaw','maxPriorityFeePerGasRaw']];
  for (let mask=0;mask<8;mask++) {
    const body=clone(source), observed=body.operation.history[0].receipt.transaction;
    observed.selectedLimitsExceeded=[];
    fields.forEach(([flag,actual,cap],bit) => {
      const exceeds=Boolean(mask & (1<<bit));
      observed[actual]=String(BigInt(body.operation.selection[cap]) + BigInt(exceeds));
      if (exceeds) observed.selectedLimitsExceeded.push(flag);
    });
    for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),true,`${route} mask ${mask}`);
  }
  // A chain observation may exceed the preparation ceiling; it never becomes
  // a new instruction to the wallet or erases the actual receipt.
  const body=clone(source);body.operation.history[0].receipt.transaction.gasLimitRaw='3000001';
  for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),true,route);
});

test('observed flags cannot be omitted, reordered, duplicated or invented', () => {
  const source=read('fixtures/variants/fee_cap_breach.json');
  for (const flags of [[], ['gasLimit'], ['gasLimit','gasLimit','maxFeePerGas'],
    ['maxPriorityFeePerGas','maxFeePerGas','gasLimit'], ['gasLimit','maxFeePerGas','unknown'],
    ['gasLimit','maxFeePerGas','maxPriorityFeePerGas','gasLimit'], null]) {
    const body=clone(source);body.operation.history[0].receipt.transaction.selectedLimitsExceeded=flags;
    for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),false,`${route} ${JSON.stringify(flags)}`);
  }
  const body=read('fixtures/variants/confirmed.json');
  body.operation.history[0].receipt.transaction.selectedLimitsExceeded=['gasLimit'];
  for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),false,route);
});

test('observed envelope nonce and actual costs remain bound', () => {
  const source=read('fixtures/variants/fee_cap_breach.json');
  const changes=[...['6',String(1n<<64n),'05',5].map(value=>['transaction','nonceRaw',value]),
    ['transaction','gasLimitRaw','20999'], ['transaction','maxPriorityFeePerGasRaw','202'],
    ['receipt','gasUsedRaw','300002'], ['receipt','effectiveGasPriceRaw','202'],
    ['receipt','executionFeeRaw','1'], ['receipt','totalFeeRaw','1']];
  for (const [section,field,changed] of changes) {
    const body=clone(source), receipt=body.operation.history[0].receipt;
    (section==='transaction' ? receipt.transaction : receipt)[field]=changed;
    if (['gasUsedRaw','effectiveGasPriceRaw'].includes(field)) {
      receipt.executionFeeRaw=String(BigInt(receipt.gasUsedRaw)*BigInt(receipt.effectiveGasPriceRaw));
      receipt.totalFeeRaw=String(BigInt(receipt.executionFeeRaw)+BigInt(receipt.l1FeeRaw));
    }
    for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),false,`${route} ${field} ${changed}`);
  }
});

test('legacy receipt explicitly retains an unavailable transaction observation', () => {
  const body=read('fixtures/variants/legacy_receipt.json');
  assert.equal(body.operation.history[0].receipt.transaction,null);
  for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),true,route);
  delete body.operation.history[0].receipt.transaction;
  for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),false,route);
});

test('reported conflicts require distinct hashes and other canonical bounded nonces', () => {
  const source=read('fixtures/variants/reported_nonce_conflict.json');
  const step=source.operation.history[0], conflict=step.reportedEffectConflicts[0];
  const badConflicts=[...[step.nonceRaw,String(1n<<64n),'06',6].map(nonceRaw=>[{...conflict,nonceRaw}]),
    [conflict,{...conflict,nonceRaw:'7'}], [{...conflict,transactionHash:'0x1234'}],
    Array.from({length:9},(_,index)=>({transactionHash:'0x'+index.toString(16).padStart(64,'0'),nonceRaw:'6'}))];
  for (const conflicts of badConflicts) {
    const body=clone(source);body.operation.history[0].reportedEffectConflicts=conflicts;
    for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),false,`${route} ${JSON.stringify(conflicts)}`);
  }
});

test('reported conflicts cannot become terminal or draft in history or list lastStep', () => {
  const source=read('fixtures/variants/reported_nonce_conflict.json');
  for (const state of ['attention','cancel_requested']) {
    const body=clone(source);body.operation.state=state;
    for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),true,`${route} ${state}`);
  }
  for (const state of ['draft','awaiting_wallet','pending','confirmed','reverted','cancelled','superseded']) {
    const body=clone(source);Object.assign(body.operation,{state,outstanding:false});
    if (state==='superseded') body.operation.history[0].receipt.position=null;
    // Removing only the conflict makes the envelope valid, so rejection must
    // not be caused by an unrelated outstanding/state constraint.
    const cleared=clone(body);cleared.operation.history[0].reportedEffectConflicts=[];
    for (const [route,value] of readViews(cleared)) assert.equal(validateResponse(route,value),true,`${route} cleared ${state}`);
    for (const [route,value] of readViews(body)) assert.equal(validateResponse(route,value),false,`${route} ${state}`);
  }
});

test('observed fee bumps never relax the caps on a new prepared wallet step', () => {
  const exact=read('fixtures/variants/mint.json');
  const fields=[['gasLimitRaw','maxGasLimitRaw'],['maxFeePerGasRaw','maxFeePerGasRaw'],
    ['maxPriorityFeePerGasRaw','maxPriorityFeePerGasRaw']];
  for (const [actual,cap] of fields) exact.walletStep.transaction[actual]=exact.operation.selection[cap];
  assert.equal(validateResponse('prepare',exact),true);
  assert.equal(validateWalletStep(exact.operation.selection,exact.operation.owner,exact.walletStep),true);
  for (const [actual,cap] of fields) {
    const body=clone(exact);body.walletStep.transaction[actual]=String(BigInt(body.operation.selection[cap])+1n);
    assert.equal(validateResponse('prepare',body),false,actual);
    assert.equal(validateWalletStep(body.operation.selection,body.operation.owner,body.walletStep),false,actual);
  }
});
