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
test('a batch is latched once per owner and operation id across tabs, keeps the wallet id beside its claim, and is freed only by its claim or that id',async()=>{
 const s=storage(),l=locks(),a=createNonceJournal(s,l,token),b=createNonceJournal(s,l,token),op='0x'+'c'.repeat(64),next='0x'+'d'.repeat(64);
 assert.equal(a.batchOffered(owner,op),null);
 const results=await Promise.allSettled([a.claimBatch(owner,op),b.claimBatch(owner,op)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 await assert.rejects(b.claimBatch(owner,op),/wallet_batch_already_offered/);
 const claim=results.find(r=>r.status==='fulfilled').value;
 // Claimed, not yet answered: latched with no id, which the empty id never frees; another operation or owner is free.
 assert.equal(b.batchOffered(owner,op),'');
 await b.releaseBatch(owner,op,'');assert.equal(a.batchOffered(owner,op),'');assert.equal(b.batchOffered(owner,next),null);assert.equal(b.batchOffered(other,op),null);
 // Only the claim records the wallet's id; the id is kept for a reload, and never an address.
 await b.recordBatch(owner,op,token(),'0xfeed');assert.equal(a.batchOffered(owner,op),'');
 await a.recordBatch(owner,op,claim,'0xfeed');assert.equal(createNonceJournal(s,l,token).batchOffered(owner,op),'0xfeed');
 for(const [key,value] of s.map){assert(!key.includes(owner)&&!value.includes(owner));assert.match(key,/^domino.offered-batch.v1.[0-9a-f]{64}$/)}
 await assert.rejects(a.recordBatch(owner,op,claim,'a|b'),/invalid_wallet_batch/);
 await assert.rejects(a.recordBatch(owner,op,claim,''),/invalid_wallet_batch/);
 // Freed by its claim or by the wallet's id; nothing else, the empty id included, frees it.
 for(const wrong of [token(),'0xbeef','']){await a.releaseBatch(owner,op,wrong);assert.equal(a.batchOffered(owner,op),'0xfeed')}
 await a.releaseBatch(owner,op,'0xfeed');assert.equal(a.batchOffered(owner,op),null);
 const again=await a.claimBatch(owner,op);await a.releaseBatch(owner,op,again);assert.equal(a.batchOffered(owner,op),null);
 assert.throws(()=>a.batchOffered(owner,'0x'+'c'.repeat(63)),/invalid_wallet_batch/);
 assert.throws(()=>a.batchOffered('0xABC','0x'+'c'.repeat(64)),/invalid_wallet_batch/);
});
// 2026-09-28: a batch's latch keeps when it was claimed, so one its wallet never settled is freed once its batch cannot execute.
test('a batch latch keeps its claim time beside it, is freed only past its age, and a latch with no time or a future one starts its clock again',async()=>{
 const s=storage(),j=createNonceJournal(s,locks(),token),op='0x'+'c'.repeat(64),next='0x'+'d'.repeat(64);
 await j.claimBatch(owner,op,1000.9);
 const at=[...s.map.keys()].filter(key=>key.startsWith('domino.offered-batch-at.v1.'));
 assert.equal(at.length,1);assert.match(at[0],/^domino.offered-batch-at.v1.[0-9a-f]{64}$/);assert.equal(s.map.get(at[0]),'1000');
 for(const [key,value] of s.map){assert(!key.includes(owner)&&!value.includes(owner))}
 assert.equal(await j.expireBatch(owner,op,1100,100),false);assert.equal(j.batchOffered(owner,op),'');
 assert.equal(await j.expireBatch(owner,op,1101,100),true);assert.equal(j.batchOffered(owner,op),null);
 assert.equal(s.map.size,0,'both entries gone');
 // Released by its claim, the time goes with it; nothing to expire is false and leaves no time behind.
 const again=await j.claimBatch(owner,op,5);await j.recordBatch(owner,op,again,'0xfeed');await j.releaseBatch(owner,op,'0xfeed');
 assert.equal(s.map.size,0);assert.equal(await j.expireBatch(owner,op,10**9,1),false);assert.equal(s.map.size,0);
 // No time beside it (claimed before times were kept): stamped at the first look, freed a full age later.
 await j.claimBatch(owner,op);assert.equal(s.map.size,1);
 assert.equal(await j.expireBatch(owner,op,2000,100),false);assert.equal(await j.expireBatch(owner,op,2100,100),false);
 assert.equal(await j.expireBatch(owner,op,2101,100),true);
 // Claimed in the future (a clock set back): stamped now instead, never freed sooner.
 await j.claimBatch(owner,op,9000);assert.equal(await j.expireBatch(owner,op,3000,100),false);
 assert.equal(await j.expireBatch(owner,op,3100,100),false);assert.equal(await j.expireBatch(owner,op,3101,100),true);
 // Only that operation's latch.
 await j.claimBatch(owner,op,1);await j.claimBatch(owner,next,1);assert.equal(await j.expireBatch(owner,next,10**6,100),true);assert.equal(j.batchOffered(owner,op),'');
 // A time that storage refuses never fails the claim.
 const kept=new Map(),refusing={get length(){return kept.size},key:i=>[...kept.keys()][i]??null,getItem:k=>kept.get(k)??null,setItem:(k,v)=>{if(k.startsWith('domino.offered-batch-at.'))throw new Error('quota');kept.set(k,v)},removeItem:k=>kept.delete(k)};
 const f=createNonceJournal(refusing,locks(),token);
 assert.match(await f.claimBatch(owner,op,1),/^[0-9a-f-]{36}$/);assert.equal(f.batchOffered(owner,op),'');
 assert.equal(await f.expireBatch(owner,op,10**6,100),false,'no time could be kept: the latch stays');
 // The time does not count toward the journal's bound.
 const b=storage(),jb=createNonceJournal(b,locks(),token);
 for(let i=0;i<1024;i++)b.setItem('domino.offered-batch-at.v1.'+i.toString(16).padStart(64,'0'),'1');
 assert(await jb.claimBatch(owner,op,1));
});
test('nonces and batches share one bound on what the journal holds',async()=>{
 const s=storage(),j=createNonceJournal(s,locks(),token);
 for(let i=0;i<1024;i++)s.setItem('domino.offered-batch.v1.'+i.toString(16).padStart(64,'0'),token());
 await assert.rejects(j.claim(owner,1n),/wallet_nonce_journal_full/);
 await assert.rejects(j.claimBatch(owner,'0x'+'c'.repeat(64)),/wallet_nonce_journal_full/);
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
  if(method==='eth_accounts')return [owner];if(method==='eth_chainId')return '0x1237';if(method==='eth_getCode')return params[0]===owner?'0x':code;
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
  // Changed on purpose 2026-10-01 (audit C2): nothing is pending on chain, so this is said as a request still open in the
  // wallet (no longer as a pending transaction to cancel); the latch itself stays, and nothing is sent again.
  await assert.rejects(fixture.fund(fixture.client()),/wallet_request_open/);
  assert.equal(fixture.walletCalls.filter(method=>method==='eth_sendTransaction').length,1);
 }
});
