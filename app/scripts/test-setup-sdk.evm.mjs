// Actual wallet SDK requests against a fresh, local Anvil fixture. No real keys.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const fixture=JSON.parse(readFileSync(0,'utf8'));
const {createSetupClient,deploymentFrom,SIGN_WINDOW_S}=await import(pathToFileURL(process.env.DOMINO_SETUP_SDK_MODULE).href);
let now=fixture.now, current=true, rejectOnce=false, unknownOnce=false, lateRejectOnce=false;
let admissionMode='available', admissionCalls=0, admissionChecks=0;
const calls=[];
const rpc=async(method,params=[])=>{
  const response=await fetch(fixture.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const data=await response.json();if(data.error)throw Object.assign(new Error(data.error.message),data.error);return data.result;
};
const claims=new Map();
const wallet={nonceOffered:n=>claims.has(String(n)),claimNonce:async n=>{if(claims.has(String(n)))throw new Error('already_offered');const token=String(n);claims.set(String(n),token);return token},releaseRejectedNonce:async(n,token)=>{if(claims.get(String(n))===token)claims.delete(String(n))},owner:fixture.owner,current:()=>current,request:async(method,params)=>{
  calls.push(method);
  if(rejectOnce&&method==='eth_sendTransaction'){rejectOnce=false;throw Object.assign(new Error('User rejected'),{code:4001});}
  if(unknownOnce&&method==='eth_sendTransaction'){unknownOnce=false;throw new Error('wallet_outcome_unknown');}
  if(lateRejectOnce&&method==='eth_sendTransaction'){lateRejectOnce=false;now+=SIGN_WINDOW_S-0.001;return new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(new Error('late_rejection'),{code:4001})),50));}
  return rpc(method,params);
}};
const deployment=deploymentFrom(fixture.release,now);
async function currentAdmission(){
  admissionCalls++;
  if(admissionMode==='offline')throw new Error('public_release_offline');
  if(admissionMode==='off')return null;
  if(admissionMode==='changed')return {...deployment,feeBps:64};
  return deployment;
}
let client=createSetupClient(wallet,deployment,()=>now,currentAdmission);
const key=fixture.key;
const gas={maxGas:15_000_000n,maxFeePerGas:10_000_000_000n,maxPriorityFeePerGas:1_000_000_000n,reserveWei:100_000_000_000_000n};
async function refuseOff(prepared){
  const sends=calls.filter(x=>x==='eth_sendTransaction').length;
  admissionMode='off';
  await assert.rejects(client.send(prepared,true),/setup_admission_unavailable/);
  assert.equal(calls.filter(x=>x==='eth_sendTransaction').length,sends);
  assert.equal(wallet.nonceOffered(BigInt(prepared.transaction.nonce)),false);
  admissionMode='available';admissionChecks++;
}
async function settle(prepared){
  const hash=await client.send(prepared,true);
  await rpc('anvil_mine',['0x40']);
  now=Number(BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp));
  const receipt=await client.receipt(hash);
  assert.equal(receipt.state,'finalized');
  await assert.rejects(client.send(prepared,true));
  return hash;
}
async function fund(amount0,amount1){
  for(let step=0;step<5;step++){
    const prepared=await client.fund(key,amount0,amount1,gas);
    await refuseOff(prepared);
    if(prepared.kind==='approve'){
      assert(prepared.summary.some(s=>s.includes('Exact allowance')||s.includes('Reset')));
      await settle(prepared);continue;
    }
    assert.equal(prepared.kind,'fund');await settle(prepared);return prepared.operationId;
  }
  assert.fail('bounded funding did not finish');
}
const first=await client.fund(key,100_000_000_000_000_000_000n,100_000_000_000_000_000_000n,gas);
await refuseOff(first);
admissionMode='off';await assert.rejects(client.fund(key,1n,0n,gas),/setup_admission_unavailable/);admissionChecks++;
admissionMode='offline';await assert.rejects(client.send(first,true),/setup_admission_unavailable/);admissionChecks++;
admissionMode='changed';await assert.rejects(client.send(first,true),/setup_admission_unavailable/);admissionChecks++;
admissionMode='available';
await assert.rejects(createSetupClient(wallet,deployment,()=>now).fund(key,1n,0n,gas),/setup_admission_unavailable/);admissionChecks++;
await assert.rejects(client.send(first,false),/wallet_review_required/);
await assert.rejects(client.send({...first},true),/wallet_review_required/);
rejectOnce=true;await assert.rejects(client.send(first,true),/User rejected/);
// A definite owner rejection must allow a fresh review with that unchanged nonce.
const id=await fund(100_000_000_000_000_000_000n,100_000_000_000_000_000_000n);
let op=await client.inspect(id);assert.equal(op.closed,false);
const price=2n**96n;
const mintPlan={tickLower:-600,tickUpper:600,liquidity:1_000_000_000_000_000_000n,
  maxAmount0:op.balance0,maxAmount1:op.balance1,minSqrtPriceX96:price/2n,maxSqrtPriceX96:price*2n,initialSqrtPriceX96:price};
const mint=await client.mint(id,mintPlan,gas);
await refuseOff(mint);
admissionMode='off';await assert.rejects(client.mint(id,mintPlan,gas),/setup_admission_unavailable/);admissionMode='available';admissionChecks++;
assert(mint.summary.some(s=>s.includes('initial relative token price')));
const mintHash=await settle(mint);op=await client.inspect(id);assert.equal(op.closed,true);assert(op.tokenId>0n);
const second=await fund(1_000_000_000_000_000n,0n);
const swap=await client.swap(second,true,100_000_000_000_000n,100,4_295_128_740n,gas);
await refuseOff(swap);
admissionMode='off';await assert.rejects(client.swap(second,true,100_000_000_000_000n,100,4_295_128_740n,gas),/setup_admission_unavailable/);admissionMode='available';admissionChecks++;
assert(swap.summary.some(s=>s.includes('650000000000')));await settle(swap);
op=await client.inspect(second);assert.equal(op.swapped,true);assert(op.balance1>0n);assert.equal(op.balance0,900_000_000_000_000n);
const afterSwap={balance0:op.balance0.toString(),balance1:op.balance1.toString()};
// Reload discovers an existing owner operation without replaying the swap.
client=createSetupClient(wallet,{...deployment,expiresAt:0},()=>now,currentAdmission);
admissionMode='offline';const beforeRecovery=admissionCalls;
assert((await client.recent()).some(x=>x.id===second&&x.operation.swapped));
assert.equal((await client.receipt(mintHash,id)).state,'finalized');admissionChecks++;
const cancel=await client.cancel(second,gas);const cancelHash=await settle(cancel);
op=await client.inspect(second);assert.equal(op.closed,true);assert.equal(op.balance0,0n);assert.equal(op.balance1,0n);
assert.equal(admissionCalls,beforeRecovery,'reads, cancel, send-cancel and receipt require no public API');admissionChecks++;
await assert.rejects(client.swap(second,true,1n,0,4_295_128_740n,gas));
// The SDK must not label an unrelated successful transaction a setup receipt.
const unrelated=await rpc('eth_sendTransaction',[{from:fixture.owner,to:fixture.owner,value:'0x0'}]);
await rpc('anvil_mine',['0x40']);now=Number(BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp));
await assert.rejects(client.receipt(unrelated));
admissionMode='available';client=createSetupClient(wallet,deployment,()=>now,currentAdmission);
// Independent currency recovery crosses the real SDK, ABI and contract even
// after all optional services disappear. Only the isolated Anvil is altered.
const isolated=await fund(1_000_000n,2_000_000n);
const dependencyCodes=new Map();
for(const address of [deployment.poolManager,deployment.positionManager,deployment.stateView]) {
  dependencyCodes.set(address,await rpc('eth_getCode',[address,'latest']));
  await rpc('anvil_setCode',[address,'0x']);
}
admissionMode='offline';client=createSetupClient(wallet,{...deployment,expiresAt:0},()=>now,currentAdmission);
const independent=await client.recover(isolated,key.currency0,1_000_000n,gas);
const independentHash=await settle(independent);
op=await client.inspect(isolated);
assert.equal(op.recoveryStarted,true);assert.equal(op.closed,false);
assert.equal(op.balance0,0n);assert.equal(op.balance1,2_000_000n);
client=createSetupClient(wallet,{...deployment,expiresAt:0},()=>now,currentAdmission);
assert.equal((await client.receipt(independentHash,isolated)).state,'finalized');
await settle(await client.recover(isolated,key.currency1,2_000_000n,gas));
op=await client.inspect(isolated);assert.equal(op.closed,true);assert.equal(op.balance1,0n);
for(const [address,code] of dependencyCodes)await rpc('anvil_setCode',[address,code]);
admissionChecks++;
admissionMode='available';client=createSetupClient(wallet,deployment,()=>now,currentAdmission);
const late=await client.fund(key,1n,0n,gas);lateRejectOnce=true;
await assert.rejects(client.send(late,true),/wallet_timeout/);assert.equal(wallet.nonceOffered(BigInt(late.transaction.nonce)),true);
await new Promise(resolve=>setTimeout(resolve,75));assert.equal(wallet.nonceOffered(BigInt(late.transaction.nonce)),false);
await assert.rejects(client.send(late,true),/wallet_review_required/);
const uncertain=await client.fund(key,1n,0n,gas);unknownOnce=true;await assert.rejects(client.send(uncertain,true),/wallet_outcome_unknown/);
client=createSetupClient(wallet,deployment,()=>now,currentAdmission);
await assert.rejects(client.fund(key,1n,0n,gas),/pending_wallet_transaction/);
current=false;await assert.rejects(client.recent(),/wallet_action_expired|wallet_identity_changed/);
process.stdout.write(JSON.stringify({passed:true,admissionChecks,operationId:id,tokenId:op.tokenId.toString(),mintHash,cancelHash,afterSwap,calls:calls.length}));
