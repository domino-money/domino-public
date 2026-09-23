import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createNonceJournal}=require('../.test-build/app/src/finance/nonce.js');
const owner='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40);
function storage(){const map=new Map();return {get length(){return map.size},key:i=>[...map.keys()][i]??null,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),map}}
function locks(){const queues=new Map();return {request(key,fn){const prior=queues.get(key)??Promise.resolve();const value=prior.catch(()=>{}).then(fn);queues.set(key,value);return value}}}
const token=()=>crypto.randomUUID();
test('two concurrent tabs can claim a wallet nonce only once, and reload preserves the quarantine',async()=>{
 const s=storage(),l=locks(),a=createNonceJournal(s,l,token),b=createNonceJournal(s,l,token);
 const results=await Promise.allSettled([a.claim(owner,7n),b.claim(owner,7n)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert(createNonceJournal(s,l,token).offered(owner,7n));
 await assert.rejects(b.claim(owner,7n),/already_offered/);
 assert(!b.offered(other,7n));assert(!b.offered(owner,8n));
 for(const [key,value] of s.map){assert(!key.includes(owner));assert(!value.includes(owner));assert.match(key,/^domino.offered-nonce.v1.[0-9a-f]{64}$/)}
});
test('only the holder of a definitely rejected claim can release it',async()=>{
 const s=storage(),j=createNonceJournal(s,locks(),token),claim=await j.claim(owner,9n);
 await j.releaseAfterRejection(owner,9n,token());assert(j.offered(owner,9n));
 await j.releaseAfterRejection(owner,9n,claim);assert(!j.offered(owner,9n));
 assert(await j.claim(owner,9n));
});
test('storage and coordination failures fail before a wallet request can be claimed',async()=>{
 const broken={...storage(),setItem(){throw new Error('storage unavailable')}};
 await assert.rejects(createNonceJournal(broken,locks(),token).claim(owner,1n),/storage unavailable/);
 await assert.rejects(createNonceJournal(storage(),{request(){return Promise.reject(new Error('lock unavailable'))}},token).claim(owner,1n),/lock unavailable/);
 const j=createNonceJournal(storage(),locks(),token);assert.throws(()=>j.offered(owner,2n**64n),/invalid_wallet_nonce/);
});

// Exercise the real SDK around its bounded wallet call, with no chain/provider.
const {createSetupClient,setupAbi}=require('../.test-build/app/src/finance/setup.js');
const {keccak256,decodeFunctionData,encodeFunctionResult}=require('viem');
function setupFixture(){
 const address=n=>'0x'+n.toString(16).padStart(40,'0'),code='0x6000',hash=keccak256(code),operationId='0x'+'a'.repeat(64);
 const deployment={setup:address(2),poolManager:address(3),positionManager:address(4),stateView:address(5),feeRecipient:address(6),setupCodeHash:hash,poolManagerCodeHash:hash,positionManagerCodeHash:hash,stateViewCodeHash:hash,feeBps:65,tariffVersion:'1',expiresAt:10000};
 const journal=createNonceJournal(storage(),locks(),token),walletCalls=[];
 const key={currency0:address(0),currency1:address(9),fee:3000,tickSpacing:60,hooks:address(0)};
 // A funded, unswapped operation of the owner's, and what the setup contract would simulate for its swap.
 const getters={manager:deployment.poolManager,positions:deployment.positionManager,stateView:deployment.stateView,feeRecipient:deployment.feeRecipient,assistedFeeBps:65,tariffVersion:1n,nextOperationId:operationId,
  operation:{owner,key,balance0:5000n,balance1:0n,swapped:false,closed:false,tokenId:0n},recoveryStarted:false,swap:2000n};
 let deferred;
 const wallet={owner,current:()=>true,nonceOffered:n=>journal.offered(owner,n),claimNonce:n=>journal.claim(owner,n),releaseRejectedNonce:(n,t)=>journal.releaseAfterRejection(owner,n,t),request:async(method,params)=>{
  walletCalls.push(method);
  if(method==='eth_accounts')return [owner];if(method==='eth_chainId')return '0x1237';if(method==='eth_getCode')return code;
  if(method==='eth_getTransactionCount')return '0x0';if(method==='eth_estimateGas')return '0x5208';if(method==='eth_getBalance')return '0x100000000000000000000';
  if(method==='eth_sendTransaction')return new Promise((resolve,reject)=>{deferred={resolve,reject}});
  if(method==='eth_call'){const call=decodeFunctionData({abi:setupAbi,data:params[0].data});return call.functionName==='open'?'0x':encodeFunctionResult({abi:setupAbi,functionName:call.functionName,result:getters[call.functionName]});}
  throw new Error('Unexpected fixture method');
 }};
 const gas={maxGas:100000n,maxFeePerGas:1n,maxPriorityFeePerGas:0n,reserveWei:0n};
 return {wallet,journal,walletCalls,get deferred(){return deferred},client:()=>createSetupClient(wallet,deployment,()=>100,async()=>deployment),fund:client=>client.fund(key,1n,0n,gas),
  swap:(client,slippageBps)=>client.swap(operationId,true,1000n,slippageBps,1n,gas)};
}
test('the assisted swap takes the owner’s slippage limit inside the product’s bound only, draws its minimum output with it, and says the limit in the review',async()=>{
 const fixture=setupFixture(),client=fixture.client();
 // 10 to 500 basis points, both ends included (lib/create/slippage.ts): the provider's 0..9999 and the old 1000 are refused before anything is simulated.
 for(const bps of [0,9,501,1000,9999,1.5])await assert.rejects(fixture.swap(client,bps),/invalid_swap_budget/,String(bps));
 assert.equal(fixture.walletCalls.filter(method=>method==='eth_estimateGas').length,0,'nothing outside the bound is simulated');
 const prepared=await fixture.swap(client,250);
 assert.equal(prepared.kind,'swap');
 const {args:[plan]}=decodeFunctionData({abi:setupAbi,data:prepared.transaction.data});
 assert.equal(plan.minOutput,2000n*9750n/10000n,'the minimum output is the simulated output less the 2.5% chosen');
 assert.ok(prepared.summary.some(line=>line.includes('minimum 1950 of')&&line.includes('at your 2.5% slippage limit')),prepared.summary.join('\n'));
 assert.equal((await fixture.swap(fixture.client(),10)).kind,'swap','0.1% itself is allowed');
 assert.equal((await fixture.swap(fixture.client(),500)).kind,'swap','5% itself is allowed');
});
async function timeoutSend(t,fixture,client,prepared){
 t.mock.timers.enable({apis:['setTimeout']});
 const sent=client.send(prepared,true);
 // Allow the fixed, bounded verification requests to settle before timing out
 // the actual wallet prompt. These yields do not advance the fake deadline.
 for(let i=0;i<100&&!fixture.deferred;i++)await new Promise(resolve=>setImmediate(resolve));
 assert(fixture.deferred,'wallet prompt must have opened');
 t.mock.timers.tick(180001);
 await assert.rejects(sent,/wallet_timeout/);
 t.mock.timers.reset();
 assert(fixture.journal.offered(owner,0n));
}
test('late definite4001 after setup timeout releases only its claim and requires a fresh review',async t=>{
 const fixture=setupFixture(),client=fixture.client(),prepared=await fixture.fund(client);
 await timeoutSend(t,fixture,client,prepared);
 fixture.deferred.reject(Object.assign(new Error('User rejected'),{code:4001}));
 await new Promise(resolve=>setImmediate(resolve));
 assert(!fixture.journal.offered(owner,0n));
 await assert.rejects(client.send(prepared,true),/wallet_review_required/);
 assert.equal((await fixture.fund(client)).kind,'fund');
 assert.equal((await fixture.fund(fixture.client())).kind,'fund');
 assert.equal(fixture.walletCalls.filter(method=>method==='eth_sendTransaction').length,1);
});
test('late unknown rejection or returned hash after timeout retains the reload-safe quarantine',async t=>{
 for(const outcome of ['unknown','hash']){
  const fixture=setupFixture(),client=fixture.client(),prepared=await fixture.fund(client);
  await timeoutSend(t,fixture,client,prepared);
  if(outcome==='unknown')fixture.deferred.reject(Object.assign(new Error('Unknown send outcome'),{code:-32000}));
  else fixture.deferred.resolve('0x'+'b'.repeat(64));
  await new Promise(resolve=>setImmediate(resolve));
  assert(fixture.journal.offered(owner,0n));
  await assert.rejects(fixture.fund(fixture.client()),/pending_wallet_transaction/);
  assert.equal(fixture.walletCalls.filter(method=>method==='eth_sendTransaction').length,1);
 }
});
