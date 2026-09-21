// Actual official V4 contracts; fixture and accounts exist only on local Anvil.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decodeFunctionData, zeroAddress } from 'viem';
const f=JSON.parse(readFileSync(0,'utf8'));
assert.match(f.url,/^http:\/\/127\.0\.0\.1:[0-9]+$/);
const {createSequenceClient:createClient,sequenceDeploymentFrom,sequenceIdentity,sequenceAbi}=await import(pathToFileURL(process.env.DOMINO_SEQUENCE_SDK_MODULE).href);
let now=f.now, current=true, admitted=true, mode='normal', checks=0;
const createSequenceClient=(wallet,deployment,clock)=>createClient(wallet,deployment,clock,async()=>admitted?sequenceDeploymentFrom(f.release,clock()):null);
const claims=new Map(), calls=[];
async function rpc(method,params=[]){
  const response=await fetch(f.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10_000)});
  const data=await response.json();if(data.error)throw Object.assign(new Error(data.error.message),data.error);return data.result;
}
const wallet={owner:f.owner,current:()=>current,nonceOffered:n=>claims.has(String(n)),claimNonce:async n=>{if(claims.has(String(n)))throw new Error('nonce_already_offered');const token=String(n);claims.set(String(n),token);return token},releaseRejectedNonce:async(n,t)=>{if(claims.get(String(n))===t)claims.delete(String(n))},request:async(method,params)=>{
  calls.push({method,params});
  if(method==='eth_sendTransaction'&&mode==='reject'){mode='normal';throw Object.assign(new Error('rejected'),{code:4001})}
  if(method==='eth_sendTransaction'&&mode==='unknown'){mode='normal';throw new Error('outcome_unknown')}
  if(method==='eth_sendTransaction'&&mode==='late-reject'){mode='normal';now+=29.999;return new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(new Error('late_rejected'),{code:4001})),50))}
  if(method==='eth_getCode'&&mode==='wrongcode'&&params[0]===f.release.deployment.routing)return '0x6000';
  if(method==='eth_getTransactionCount'&&mode==='pending'&&params[1]==='pending')return `0x${(BigInt(await rpc(method,params))+1n).toString(16)}`;
  const value=await rpc(method,params);
  if(method==='eth_getBlockByNumber'&&mode==='reorg'&&params[0]!=='latest'&&params[0]!=='finalized')return {...value,hash:`0x${'ff'.repeat(32)}`};
  if(method==='eth_getTransactionByHash'&&mode==='wrongreceipt')return {...value,input:'0x'};
  return value;
}};
const d=sequenceDeploymentFrom(f.release,now),client=createSequenceClient(wallet,d,()=>now);
const options={automationMode:'domino',rootTokenId:BigInt(f.root),baseIsCurrency0:!f.native,consentToUncollectedFees:true,triggerDistanceBps:1000,maxOverlapBps:1000,minimumIntervalSeconds:60,maxPositions:4,upsideBps:5000,maxSlippageBps:100,maxPriceImpactBps:100,maxGasCostWei:10n**16n,maxObservationAgeSeconds:120,forecastHorizonSeconds:3600};
const gas={maxGas:15_000_000n,maxFeePerGas:10_000_000_000n,maxPriorityFeePerGas:1_000_000_000n,reserveWei:10n**14n};
const check=()=>checks++;
async function settle(c,step){
  const hash=await c.send(step,true);await rpc('anvil_mine',['0x40']);
  now=Number(BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp));
  assert.equal((await c.receipt(hash)).state,'finalized');check();return hash;
}
assert.equal(sequenceDeploymentFrom({...f.release,available:false,deployment:null},now),null);check();
assert.throws(()=>sequenceDeploymentFrom({...f.release,deployment:{...f.release.deployment,serviceFeeBps:201}},now));check();
for(const change of [{dominoServiceFeeBps:undefined},{dominoServiceFeeBps:200},{dominoServiceFeeBps:'400'},{serviceFeeBps:400}]){
  assert.throws(()=>sequenceDeploymentFrom({...f.release,deployment:{...f.release.deployment,...change}},now),/invalid_sequence_release/);check();
}
assert.throws(()=>sequenceDeploymentFrom({...f.release,deployment:{...f.release.deployment,operator:d.pricePublisher}},now));check();
assert.throws(()=>sequenceDeploymentFrom({...f.release,deployment:{...f.release.deployment,codeHashes:{...d.codeHashes,vault:`0x${'01'.repeat(32)}`}}},now),/clone_template/);check();
assert.equal((await client.recent()).at(0).vault,f.oldVault);check();
const root=await client.inspectRoot(BigInt(f.root));assert.equal(root.vault,sequenceIdentity(d,f.owner,1n).vault);check();
await assert.rejects(client.create({...options,consentToUncollectedFees:false},gas),/consent/);check();
await assert.rejects(client.create({...options,triggerDistanceBps:2001},gas),/policy/);check();
await assert.rejects(client.create({...options,automationMode:undefined},gas),/invalid_sequence_policy/);check();
await assert.rejects(client.create({...options,automationMode:'compound'},gas),/simple_compound_position_limit/);check();
mode='wrongcode';await assert.rejects(client.create(options,gas),/deployment_code_changed/);mode='normal';check();
mode='pending';await assert.rejects(client.create(options,gas),/pending_wallet_transaction/);mode='normal';check();
await assert.rejects(client.create(options,{...gas,maxGas:21000n}),/gas_budget_exceeded/);check();
const approval=await client.create(options,gas);assert.equal(approval.kind,'approve-root');
const decoded=decodeFunctionData({abi:sequenceAbi,data:approval.transaction.data});assert.equal(decoded.functionName,'approve');assert.equal(decoded.args[0].toLowerCase(),root.vault);assert.equal(decoded.args[1],BigInt(f.root));check();
await assert.rejects(client.send(approval,false),/review_required/);await assert.rejects(client.send({...approval},true),/review_required/);check();
mode='reject';await assert.rejects(client.send(approval,true),/rejected/);assert.equal(wallet.nonceOffered(BigInt(approval.transaction.nonce)),false);check();
const rejectedRetry=await client.create(options,gas),approvalHash=await settle(client,rejectedRetry);
await assert.rejects(client.send(rejectedRetry,true),/review_required/);check();
const simpleCreation=await client.create({...options,automationMode:'compound',maxPositions:1},gas);
assert.equal(simpleCreation.kind,'create');
const simpleParams=decodeFunctionData({abi:sequenceAbi,data:simpleCreation.transaction.data}).args[0];
assert.equal(simpleParams.policy.serviceFeeBps,200);assert.equal(simpleParams.policy.maxPositions,1);
assert(simpleCreation.summary.some(x=>x.startsWith('Auto-compound: 2%')));check();
const creation=await client.create(options,gas);assert.equal(creation.kind,'create');
const params=decodeFunctionData({abi:sequenceAbi,data:creation.transaction.data}).args[0];
assert.equal(params.policy.paused,true);assert.equal(params.policy.serviceFeeBps,400);assert.equal(params.consentToUncollectedFees,true);
assert(creation.summary.some(x=>x.startsWith('Domino-compound: 4%')));
assert.equal(params.baseCurrency.toLowerCase(),options.baseIsCurrency0?root.key.currency0:root.key.currency1);check();
const createHash=await settle(client,creation);
const created=await client.inspect(root.vault);assert.equal(created.paused,true);assert.equal(created.rootPermissionValid,true);assert.equal(created.rootTokenId,BigInt(f.root));assert.equal(created.serviceFeeBps,400);assert.equal(created.automationMode,'domino');check();
const activation=await client.resume(root.vault,gas);assert.equal(activation.kind,'resume');assert(activation.summary.some(x=>x.includes('Policy version 1')));assert(activation.summary.some(x=>x.includes('Execution gas cost cap')));
await assert.rejects(client.send(activation,false),/review_required/);check();
admitted=false;const beforeOff=calls.filter(x=>x.method==='eth_sendTransaction').length;
await assert.rejects(client.send(activation,true),/sequence_admission_unavailable/);
await assert.rejects(client.create(options,gas),/sequence_admission_unavailable/);
assert.equal(calls.filter(x=>x.method==='eth_sendTransaction').length,beforeOff);admitted=true;check();
mode='wrongcode';await assert.rejects(client.send(activation,true),/deployment_code_changed/);mode='normal';check();
await settle(client,activation);assert.equal((await client.inspect(root.vault)).paused,false);check();
await assert.rejects(client.resume(root.vault,gas),/sequence_activation_unavailable/);check();
await settle(client,await client.recover(root.vault,'pause',gas));
// An owner chooses a mode explicitly. Omission preserves it; every change
// advances policy/state versions and invalidates already reviewed actions.
const policyOptions={triggerDistanceBps:900,maxOverlapBps:1000,minimumIntervalSeconds:60,maxPositions:1};
await assert.rejects(client.setPolicy(root.vault,{...policyOptions,automationMode:null},gas),/invalid_sequence_policy/);check();
await assert.rejects(client.setPolicy(root.vault,{...policyOptions,automationMode:'compound',maxPositions:2},gas),/simple_compound_position_limit/);check();
await assert.rejects(client.setPolicy(f.oldVault,{...policyOptions,automationMode:'compound'},gas),/position_limit_below_membership/);check();
const stalePolicy=await client.setPolicy(root.vault,{...policyOptions,automationMode:'domino',maxPositions:4},gas);
const toSimple=await client.setPolicy(root.vault,{...policyOptions,automationMode:'compound'},gas);
const simplePolicy=decodeFunctionData({abi:sequenceAbi,data:toSimple.transaction.data}).args[0];
assert.equal(simplePolicy.serviceFeeBps,200);assert.equal(simplePolicy.version,2n);assert.equal(simplePolicy.paused,true);
assert(toSimple.summary.some(x=>x.includes('Service fee: 4%')&&x.includes('New Auto-compound policy: 2%')));
await assert.rejects(client.send(toSimple,false),/review_required/);check();
await settle(client,toSimple);
let policyState=await client.inspect(root.vault);assert.equal(policyState.serviceFeeBps,200);assert.equal(policyState.automationMode,'compound');
const beforeStale=calls.filter(x=>x.method==='eth_sendTransaction').length;
await assert.rejects(client.send(stalePolicy,true),/sequence_preparation_changed/);
assert.equal(calls.filter(x=>x.method==='eth_sendTransaction').length,beforeStale);check();
const preserved=await client.setPolicy(root.vault,policyOptions,gas);
assert.equal(decodeFunctionData({abi:sequenceAbi,data:preserved.transaction.data}).args[0].serviceFeeBps,200);
await settle(client,preserved);
const simpleActivation=await client.resume(root.vault,gas);
assert(simpleActivation.summary.some(x=>x.startsWith('Auto-compound: 2%')));check();
const toDomino=await client.setPolicy(root.vault,{...policyOptions,automationMode:'domino',maxPositions:4},gas);
assert(toDomino.summary.some(x=>x.includes('Service fee: 2%')&&x.includes('New Domino-compound policy: 4%')));
await settle(client,toDomino);
await assert.rejects(client.send(simpleActivation,true),/sequence_preparation_changed/);check();
policyState=await client.inspect(root.vault);assert.equal(policyState.serviceFeeBps,400);assert.equal(policyState.automationMode,'domino');
const preservedDomino=await client.setPolicy(root.vault,{...policyOptions,maxPositions:4},gas);
assert.equal(decodeFunctionData({abi:sequenceAbi,data:preservedDomino.transaction.data}).args[0].serviceFeeBps,400);check();
mode='wrongreceipt';await assert.rejects(client.receipt(createHash),/deployment_identity_changed/);mode='normal';check();
mode='reorg';assert.equal((await client.receipt(approvalHash)).state,'reorged');mode='normal';check();
await assert.rejects(createSequenceClient(wallet,d,()=>now).receipt(createHash),/receipt_not_from_this_review/);check();
// Recovery ignores expiry and a missing engine, but still verifies clone/owner.
const recovery=createSequenceClient(wallet,{...d,expiresAt:0},()=>now);
await assert.rejects(recovery.create(options,gas),/sequence_release_expired/);check();
await assert.rejects(recovery.resume(root.vault,gas),/sequence_release_expired/);check();
const originalEngine=await rpc('eth_getCode',[d.engine,'latest']);await rpc('anvil_setCode',[d.engine,'0x']);
admitted=false;
const ownerOnlyStart=calls.length;
assert.equal((await recovery.inspect(root.vault)).rootPermissionValid,false);
await settle(recovery,await recovery.recover(root.vault,'revoke-operator',gas));
await settle(recovery,await recovery.recover(root.vault,'revoke-root',gas));
await settle(recovery,await recovery.recover(f.oldVault,'pause',gas));
await settle(recovery,await recovery.recover(f.oldVault,'withdraw-child',gas,{tokenId:BigInt(f.child)}));
const reserves=await recovery.reserves(f.oldVault,BigInt(f.root)),balance=reserves.balances.find(x=>x.original>0n);
assert.ok(balance);await settle(recovery,await recovery.recover(f.oldVault,'withdraw-fees',gas,{...balance,original:1n,charged:0n}));
assert.equal((await recovery.reserves(f.oldVault,BigInt(f.root))).balances.find(x=>x.sourceId===balance.sourceId&&x.currency===balance.currency).original,balance.original-1n);check();
assert.equal(calls.slice(ownerOnlyStart).some(x=>x.method==='eth_getCode'&&x.params[0]===d.engine),false);check();
await assert.rejects(recovery.recover(f.oldVault,'withdraw-child',gas,{tokenId:BigInt(f.root)}),/invalid_child/);check();
await assert.rejects(recovery.recover(f.oldVault,'withdraw-fees',gas,{...balance,original:balance.original+1n,charged:0n}),/fee_reserve_insufficient/);check();
await rpc('anvil_setCode',[d.engine,originalEngine]);
admitted=true;
await assert.rejects(client.resume(root.vault,gas),/sequence_activation_unavailable/);check();
// A definite rejection arriving after our UI timeout releases that exact
// claim. The UI still requires a newly prepared and acknowledged review.
const late=await recovery.recover(f.oldVault,'revoke-operator',gas);mode='late-reject';await assert.rejects(recovery.send(late,true),/wallet_timeout/);
assert.equal(wallet.nonceOffered(BigInt(late.transaction.nonce)),true);
await new Promise(resolve=>setTimeout(resolve,75));assert.equal(wallet.nonceOffered(BigInt(late.transaction.nonce)),false);
await assert.rejects(recovery.send(late,true),/review_required/);check();
// Unknown wallet outcome must survive a new SDK instance (shared nonce guard).
const revoke=await recovery.recover(f.oldVault,'revoke-operator',gas);mode='unknown';await assert.rejects(recovery.send(revoke,true),/outcome_unknown/);
await assert.rejects(createSequenceClient(wallet,d,()=>now).recover(f.oldVault,'revoke-operator',gas),/pending_wallet_transaction/);check();
const other=(await rpc('eth_accounts',[]))[4],otherWallet={...wallet,owner:other,request:async(method,params)=>method==='eth_accounts'?[other]:rpc(method,params)};
await assert.rejects(createSequenceClient(otherWallet,d,()=>now).inspect(f.oldVault),/deployment_identity_changed/);check();
current=false;await assert.rejects(client.recent(),/wallet_action_expired/);check();
assert.equal(calls.some(x=>x.method==='personal_sign'||x.method==='eth_signTypedData_v4'),false);
assert.equal(calls.some(x=>x.method==='eth_sendTransaction'&&x.params[0].value!=='0x0'),false);
assert.equal(calls.some(x=>x.method==='eth_sendTransaction'&&decodeFunctionData({abi:sequenceAbi,data:x.params[0].data}).functionName==='setApprovalForAll'),false);check();
process.stdout.write(JSON.stringify({passed:true,checks,native:f.native,calls:calls.length}));
