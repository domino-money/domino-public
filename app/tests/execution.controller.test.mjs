import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import * as runtime from '../../api-contracts/execution-v1/runtime.mjs';
const require=createRequire(import.meta.url);
const {createExecutionController,EXECUTION_STATE_TEXT,EXECUTION_STATE_NOTE,EXECUTION_SETTLED,EXECUTION_READ_FLOOR_MS,EXECUTION_RETRY_MS,EXECUTION_STATUS_MAX_MS,EXECUTION_STATUS_TRIES}=require('../.test-build/app/src/finance/execution.js');
const {REASK_TRIES,FINAL_FAILURES,reaskWait}=require('../.test-build/app/src/finance/reask.js');
const f=JSON.parse(readFileSync(new URL('../../api-contracts/execution-v1/fixtures/status-wire.json',import.meta.url)));
const reserved=f.responses['status.reserved'].item;
const page={...f.responses['list.empty'],items:[reserved]};
const headers={'Content-Type':'application/json','X-Domino-Execution-Contract':runtime.CONTRACT_VERSION};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
const stalled=(url,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('abort'))));
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
/** The fixture's status answer for `item` (status.reserved when omitted), checked against the contract first. */
const statusOf=(item=reserved)=>{const body={...f.responses['status.reserved'],item};assert.ok(runtime.validateResponse('status',body),`status fixture for ${item?.state}`);return body};
function harness(handler=(url)=>response(url.endsWith('/status')?statusOf():page),{signedIn=true,visible:shown=true}={}) {
 let now=0,visible=shown;
 const signed={kind:'signed_in',owner:page.owner,chainId:4663,epoch:1,connectorUid:'one'};
 let identity=signedIn?signed:{kind:'signed_out'};
 const listeners=new Set(),calls=[],timers=new Set(),denials=[];
 const clock={monoMs:()=>now,wallMs:()=>now,setTimer(fn,ms){const t={at:now+ms,fn};timers.add(t);return()=>timers.delete(t)}};
 const session={getSnapshot:()=>identity,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},withCsrf:async(e,fn)=>fn('memory-only-csrf'),reportDenial(code,epoch){denials.push({code,epoch})}};
 const c=createExecutionController({session,runtime,clock,visible:()=>visible,fetch:async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return handler(url,init,calls.length)}});
 const stop=c.start();
 return {c,calls,stop,denials,signed,
  change(value){identity=value;listeners.forEach(fn=>fn())},
  hide(){visible=false;c.visibilityChanged()},
  show(){visible=true;c.visibilityChanged()},
  async advance(ms){const end=now+ms;for(;;){const due=[...timers].filter(t=>t.at<=end).sort((a,b)=>a.at-b.at)[0];if(!due)break;now=due.at;timers.delete(due);due.fn();await flush()}now=end;await flush()}};
}
test('signed in and visible, the first page reads itself with the CSRF, bound to the owner, at most once per 30 s',async()=>{
 const h=harness();await flush();
 assert.equal(h.calls.length,1,'no control to press: the read starts on its own');
 assert.equal(h.calls[0].url,'/api/execution/v1/list');assert.equal(h.calls[0].init.headers['X-Domino-CSRF'],'memory-only-csrf');
 assert.equal(h.calls[0].init.credentials,'same-origin');assert.deepEqual(h.calls[0].body,{afterIntentId:null,limit:10});
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items.length,h.c.getSnapshot().reason],['ready',1,null]);
 await h.c.refresh();assert.equal(h.calls.length,1,'inside the floor nothing is sent');
 h.hide();assert.deepEqual(h.c.getSnapshot().items,[],'a hidden tab clears what was shown');
 h.show();await flush();assert.equal(h.calls.length,1,'visible again inside 30 s: the read waits for the floor');
 await h.advance(29_999);assert.equal(h.calls.length,1);
 await h.advance(1);assert.equal(h.calls.length,2,'then it reads again by itself');
 assert.equal(h.c.getSnapshot().items.length,1);
 // A page that was read is not read again; its open receipt is refreshed through status instead (G13).
 await h.advance(600_000);
 assert.deepEqual(h.calls.filter(call=>call.url.endsWith('/list')).length,2,'a page that was read is not read again');
 assert.ok(h.calls.slice(2).every(call=>call.url==='/api/execution/v1/status'),'after the page, only status refreshes');
 h.stop();
});
test('nothing is read while signed out or hidden; signing in or showing the tab reads once',async()=>{
 const out=harness(undefined,{signedIn:false});await out.advance(120_000);
 assert.deepEqual([out.calls.length,out.c.getSnapshot().state],[0,'signed_out']);
 out.change(out.signed);await flush();assert.equal(out.calls.length,1);out.stop();
 const hidden=harness(undefined,{visible:false});await hidden.advance(120_000);
 assert.equal(hidden.calls.length,0);
 hidden.show();await flush();assert.equal(hidden.calls.length,1);assert.equal(hidden.c.getSnapshot().state,'ready');hidden.stop();
});
test('foreign owner and unqualified effect are never rendered',async()=>{
 for(const value of [{...page,owner:'0x'+'b'.repeat(40)},{...page,items:[{...reserved,state:'reconciled'}]}]){
  const h=harness(()=>response(value));await flush();assert.equal(h.c.getSnapshot().items.length,0);assert.equal(h.c.getSnapshot().state,'unavailable');assert(h.c.getSnapshot().reason);h.stop();
 }
});
test('account switch and hidden tabs clear data and discard a late response',async()=>{
 let release;const h=harness(()=>new Promise(resolve=>{release=resolve}));await flush();assert.equal(h.calls.length,1);
 h.change({kind:'signed_out'});release(response(page));await flush();
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().scope,h.c.getSnapshot().state,h.c.getSnapshot().busy],[0,null,'signed_out',false]);h.stop();
 const next=harness();await flush();assert.equal(next.c.getSnapshot().items.length,1);next.hide();assert.equal(next.c.getSnapshot().items.length,0);await next.c.refresh();assert.equal(next.calls.length,1);next.stop();
});
// Changed on purpose (review:wallet, receipts polling): a switched-off route used to be asked again every 60 s for as long as the tab stayed
// visible. It cannot change without a deploy, so it is not asked again on a timer; the owner coming back to the tab asks once more.
test('a switched-off service leaves the card empty with its reason for the title, is not asked again on a timer, and is found when the tab is shown again',async()=>{
 assert.ok(runtime.validateError(404,{error:'route_not_available'}));
 const h=harness((url,init,n)=>n===1?response({error:'route_not_available'},404):response(page));await flush();
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().reason,h.c.getSnapshot().items.length,h.c.getSnapshot().busy],['unavailable','route_not_available',0,false]);
 assert.deepEqual(h.denials,[]);
 await h.advance(600_000);assert.equal(h.calls.length,1,'nothing is asked again on its own');
 h.hide();h.show();await flush();
 assert.equal(h.calls.length,2,'switched on meanwhile: coming back to the tab finds it with nothing pressed');
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().reason,h.c.getSnapshot().items.length],['ready',null,1]);
 h.stop();
 const bare=harness(()=>new Response('<!doctype html>',{status:200,headers:{'Content-Type':'text/html'}}));await flush();
 assert.equal(bare.c.getSnapshot().reason,'feature_unavailable','no Worker route: the page fallback is not an answer');
 bare.hide();await bare.advance(600_000);assert.equal(bare.calls.length,1,'a hidden tab is not asked again');
 bare.show();await flush();assert.equal(bare.calls.length,2);bare.stop();
});

/** Advances one second at a time and records when each call left, so a test can pin the waits between them. */
async function callTimes(h,until,calls=()=>h.calls.length){
 const at=[];
 for(let t=0,seen=calls();t<until;t+=1_000){await h.advance(1_000);if(calls()>seen){seen=calls();at.push(t+1_000)}}
 return at;
}

test('a failure asking again cannot fix sends one list read in an hour; coming back to the tab asks once more, and only then',async()=>{
 assert.equal(REASK_TRIES,3);
 for(const code of ['route_not_available','feature_unavailable','contract_mismatch','owner_or_cursor_mismatch','invalid_response'])assert.ok(FINAL_FAILURES.has(code),code);
 assert.deepEqual([reaskWait('route_not_available',0,60_000),reaskWait('timeout',0,60_000),reaskWait('timeout',2,60_000),reaskWait('timeout',3,60_000)],[null,60_000,240_000,null]);
 const cases=[
  ['switched off',()=>response({error:'route_not_available'},404),'route_not_available'],
  ['no Worker route',()=>new Response('<!doctype html>',{status:200,headers:{'Content-Type':'text/html'}}),'feature_unavailable'],
  ['another contract',()=>new Response(JSON.stringify(page),{status:200,headers:{'Content-Type':'application/json','X-Domino-Execution-Contract':'0.0.0-other'}}),'contract_mismatch'],
  ['another owner',()=>response({...page,owner:'0x'+'b'.repeat(40)}),'owner_or_cursor_mismatch'],
  ['not the contract',()=>response({...page,executionAvailable:true}),'invalid_response'],
 ];
 for(const [label,handler,reason] of cases){
  const h=harness(handler);await flush();
  assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().reason],['unavailable',reason],label);
  await h.advance(3_600_000);
  assert.equal(h.calls.length,1,`${label}: one POST in an hour of a visible tab`);
  h.hide();await h.advance(5_000);h.show();await flush();
  assert.equal(h.calls.length,2,`${label}: the owner came back, so it is asked once more`);
  await h.advance(3_600_000);
  assert.equal(h.calls.length,2,`${label}: and not again on its own`);
  h.stop();
 }
});

test('a failure that can pass is asked again at most three times, 60, 120 then 240 s later: four POSTs in an hour; a good page, a sign-in or the tab shown again starts the count over',async()=>{
 assert.ok(runtime.validateError(503,{error:'execution_store_unavailable'}));
 let failing=true;
 const h=harness((url)=>url.endsWith('/status')?response(statusOf()):failing?response({error:'execution_store_unavailable'},503):response(page));await flush();
 const lists=()=>h.calls.filter(call=>call.url.endsWith('/list')).length;
 assert.equal(EXECUTION_RETRY_MS,60_000);
 assert.deepEqual([0,...await callTimes(h,3_600_000)],[0,60_000,180_000,420_000],'the first read, then three asks further apart each time, then none');
 assert.deepEqual([h.calls.length,h.c.getSnapshot().state,h.c.getSnapshot().reason],[4,'unavailable','execution_store_unavailable']);
 // Shown again: the count starts over, as soon as the contract's floor allows.
 h.hide();h.show();await flush();
 assert.equal(lists(),5);
 assert.deepEqual(await callTimes(h,300_000,lists),[60_000,180_000],'asked again on its own, counted afresh');
 // Switched on meanwhile: the next ask finds it.
 failing=false;await h.advance(120_000);
 assert.deepEqual([lists(),h.c.getSnapshot().state],[8,'ready']);
 // The good page started the count over: failing again after it, three more asks.
 failing=true;h.hide();await h.advance(30_000);h.show();await flush();
 assert.deepEqual([lists(),h.c.getSnapshot().state],[9,'unavailable']);
 assert.deepEqual(await callTimes(h,3_600_000,lists),[60_000,180_000,420_000],'three asks again after the good page');
 // A new sign-in starts over too, at once.
 h.change({...h.signed,epoch:2});await flush();
 assert.equal(lists(),13,'a new session reads its first page at once');
 await h.advance(60_000);assert.equal(lists(),14,'and its failure is asked again like a first one');
 h.stop();
});
test('stalled transport aborts at 20s; the next read waits 60s and is not polled any faster',async()=>{
 const h=harness(stalled);await flush();await h.advance(20_000);
 assert.equal(h.c.getSnapshot().busy,false);assert.equal(h.c.getSnapshot().reason,'timeout');await h.c.refresh();assert.equal(h.calls.length,1);
 await h.advance(59_999);assert.equal(h.calls.length,1);await h.advance(1);assert.equal(h.calls.length,2);h.stop();
});
test('a session denial reaches the session port once and nothing asks for a signature',async()=>{
 const h=harness((url,init,n)=>n===1?response({error:'csrf_invalid'},403):response(page));await flush();
 assert.deepEqual(h.denials,[{code:'csrf_invalid',epoch:1}]);assert.equal(h.c.getSnapshot().reason,'csrf_invalid');h.stop();
});
test('the next page is added below the first, and asked inside the floor it waits for it',async()=>{
 const second={...reserved,intentId:'0x'+'34'.repeat(32)};
 const first={...page,nextAfterIntentId:reserved.intentId};
 assert.ok(runtime.validateResponse('list',first));
 const h=harness((url,init,n)=>response(n===1?first:{...page,items:[second]}));await flush();
 assert.equal(h.c.getSnapshot().more,true);
 h.c.nextPage();assert.equal(h.c.getSnapshot().busy,true);assert.equal(h.calls.length,1,'inside the floor the page waits');
 h.c.nextPage();await h.advance(29_999);assert.equal(h.calls.length,1,'a second press adds nothing');
 await h.advance(1);assert.equal(h.calls.length,2);
 assert.deepEqual(h.calls[1].body,{afterIntentId:reserved.intentId,limit:10});
 assert.deepEqual(h.c.getSnapshot().items.map(item=>item.intentId),[reserved.intentId,second.intentId]);
 assert.deepEqual([h.c.getSnapshot().more,h.c.getSnapshot().busy],[false,false]);
 h.stop();
});
test('started again after a stop, the controller reads again instead of keeping the dropped read (development double mount)',async()=>{
 const h=harness((url,init,n)=>n===1?stalled(url,init):response(page));await flush();
 h.stop();assert.equal(h.c.getSnapshot().busy,false);
 const again=h.c.start();await flush();
 assert.equal(h.calls.length,2);assert.equal(h.c.getSnapshot().state,'ready');again();
});
test('every intent state has words and a sentence, and none of them is a code',()=>{
 const states=['planned','reserved','cancelled','signing','signed','submitted','broadcast_unknown','included','reconciled','reverted','attention','reorged'];
 assert.deepEqual(Object.keys(EXECUTION_STATE_TEXT).sort(),[...states].sort());
 assert.deepEqual(Object.keys(EXECUTION_STATE_NOTE).sort(),[...states].sort());
 for(const text of [...Object.values(EXECUTION_STATE_TEXT),...Object.values(EXECUTION_STATE_NOTE)])assert.doesNotMatch(text,/_|not connected|not enabled|coming soon/i);
 // 2026-09-27 (round 5 review): the sentence a receipt's detail shows is for people new to pools, with no engineer's word.
 for(const text of Object.values(EXECUTION_STATE_NOTE))assert.doesNotMatch(text,/revert|nonce|canonical|finality|inclusion|broadcast|slot|block|chain/i,text);
});

// ---- G13: one receipt refreshed in place through status, over status-wire.json ----------------------------

/** The fixture's reserved intent carried on through signing to a finalized receipt, each step valid for the contract. */
const signing={...reserved,state:'signing',canCancel:false,signer:'0x'+'56'.repeat(20),nonceRaw:'7'};
const reconciled={...signing,state:'reconciled',attempts:[{ordinal:0,transactionHash:'0x'+'ab'.repeat(32)}],receipt:{
 transactionHash:'0x'+'ab'.repeat(32),blockNumberRaw:'123456',blockHash:'0x'+'cd'.repeat(32),canonical:true,finalized:true,serviceFeeBps:200,
 serviceFeeRecipient:'0x'+'78'.repeat(20),liquidityIncreaseRaw:'1000000',fullL2CostWei:null,
 sources:[{sourceId:'0x'+'9a'.repeat(32),currency:'0x'+'11'.repeat(20),grossOriginalConsumedRaw:'500000',chargedConsumedRaw:'0',serviceFeeRaw:'10000',liquidityAddedRaw:'490000',originalAfterRaw:'0',chargedAfterRaw:'0'}]}};
const planned={...reserved,intentId:'0x'+'34'.repeat(32),state:'planned'};
const statuses=(calls)=>calls.filter(call=>call.url.endsWith('/status'));

test('status fixtures: the reserved intent can still be stopped, the finalized one carries its receipt identity, and only settled states are left alone',()=>{
 assert.equal(f.requests.status.intentId,reserved.intentId,'the fixture asks for the intent it answers');
 assert.equal(reserved.canCancel,true);
 for(const item of [signing,reconciled,planned])statusOf(item);
 assert.ok(!runtime.validateResponse('status',{...statusOf(),item:{...signing,canCancel:true}}),'a signed intent can never claim it can be stopped');
 assert.ok(runtime.validateResponse('list',{...page,items:[reserved,planned]}));
 assert.deepEqual([...EXECUTION_SETTLED].sort(),['cancelled','reconciled','reverted']);
 assert.equal(EXECUTION_READ_FLOOR_MS,30_000);assert.equal(EXECUTION_STATUS_MAX_MS,300_000);
});

test('an open receipt is refreshed in place through status at the 30 s floor, waits longer while unchanged, and is left alone once finalized',async()=>{
 const answers=[statusOf(),statusOf(),statusOf(signing),statusOf(reconciled)];
 const h=harness((url)=>response(url.endsWith('/status')?answers.shift()??statusOf(reconciled):page));await flush();
 assert.equal(h.calls.length,1);
 await h.advance(29_999);assert.equal(h.calls.length,1,'no status inside the floor of the list read');
 await h.advance(1);assert.equal(h.calls.length,2);
 assert.deepEqual([h.calls[1].url,h.calls[1].body,h.calls[1].init.headers['X-Domino-CSRF'],h.calls[1].init.headers['X-Domino-Execution-Contract']],['/api/execution/v1/status',f.requests.status,'memory-only-csrf',runtime.CONTRACT_VERSION]);
 assert.equal(h.calls[1].init.credentials,'same-origin');
 assert.equal(h.c.getSnapshot().busy,false,'a refresh in place does not mark the card busy');
 await h.advance(29_999);assert.equal(h.calls.length,2);
 await h.advance(1);assert.equal(h.calls.length,3,'unchanged once: asked again 30 s later');
 await h.advance(59_999);assert.equal(h.calls.length,3);
 await h.advance(1);assert.equal(h.calls.length,4,'unchanged twice: 60 s later');
 assert.deepEqual(h.c.getSnapshot().items.map(item=>[item.intentId,item.state]),[[reserved.intentId,'signing']],'replaced where it stands');
 await h.advance(29_999);assert.equal(h.calls.length,4);
 await h.advance(1);assert.equal(h.calls.length,5,'it changed: back to the floor');
 const shown=h.c.getSnapshot().items[0];
 assert.deepEqual(shown.receipt,reconciled.receipt);
 assert.deepEqual([shown.state,shown.canCancel,h.c.getSnapshot().state,h.c.getSnapshot().reason],['reconciled',false,'ready',null]);
 await h.advance(3_600_000);assert.equal(h.calls.length,5,'a finalized receipt is never asked again');
 assert.equal(statuses(h.calls).length,4);
 h.stop();
});

test('status item:null removes that receipt; another owner or another intent is refused, keeps the receipt and gives its code to the title only',async()=>{
 const two={...page,items:[reserved,planned]};
 const answers=[{...statusOf(),owner:'0x'+'b'.repeat(40)},statusOf(reserved),f.responses['status.missing'],statusOf(planned)];
 assert.ok(runtime.validateResponse('status',f.responses['status.missing']));
 const h=harness((url)=>response(url.endsWith('/status')?answers.shift():two));await flush();
 await h.advance(30_000);
 assert.deepEqual(statuses(h.calls).map(call=>call.body.intentId),[reserved.intentId]);
 assert.deepEqual(h.c.getSnapshot().refreshFailed,{[reserved.intentId]:'owner_or_intent_mismatch'});
 assert.deepEqual(h.c.getSnapshot().items.map(item=>item.state),['reserved','planned'],'a refused refresh changes nothing shown');
 await h.advance(30_000);
 assert.deepEqual(statuses(h.calls).map(call=>call.body.intentId),[reserved.intentId,planned.intentId]);
 assert.deepEqual(h.c.getSnapshot().refreshFailed,{[reserved.intentId]:'owner_or_intent_mismatch',[planned.intentId]:'owner_or_intent_mismatch'},'an answer about another intent is refused');
 await h.advance(30_000);
 assert.deepEqual(h.c.getSnapshot().items.map(item=>item.intentId),[planned.intentId],'missing or foreign: no longer shown');
 assert.deepEqual(h.c.getSnapshot().refreshFailed,{[planned.intentId]:'owner_or_intent_mismatch'});
 await h.advance(30_000);
 assert.deepEqual(statuses(h.calls).map(call=>call.body.intentId),[reserved.intentId,planned.intentId,reserved.intentId,planned.intentId]);
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().refreshFailed,h.c.getSnapshot().state],[1,{},'ready']);
 h.stop();
});

test('a failed refresh keeps the receipt as it was read and waits 60 s, then longer each time, never past five minutes; a denial reaches the session port',async()=>{
 const refused=[response({error:'csrf_invalid'},403)];
 const h=harness((url)=>url.endsWith('/status')?(refused.shift()??response({error:'execution_store_unavailable'},503)):response(page));await flush();
 const at=[];const count=()=>statuses(h.calls).length;
 for(let t=0,seen=0;t<=1_100_000;t+=1_000){await h.advance(1_000);if(count()>seen){seen=count();at.push(t+1_000)}}
 assert.deepEqual(at,[30_000,90_000,210_000,450_000,750_000,1_050_000]);
 assert.deepEqual(h.denials,[{code:'csrf_invalid',epoch:1}]);
 assert.deepEqual([h.c.getSnapshot().items,h.c.getSnapshot().refreshFailed,h.c.getSnapshot().reason],[[reserved],{[reserved.intentId]:'execution_store_unavailable'},null]);
 assert.equal(h.calls.filter(call=>call.url.endsWith('/list')).length,1,'the page itself is not read again');
 h.stop();
});

test('an open receipt that keeps answering the same, or keeps failing, is refreshed six times in a visit and then left as it stands, until a list read or the tab shown again',async()=>{
 assert.equal(EXECUTION_STATUS_TRIES,6);
 let failing=false;
 const first={...page,nextAfterIntentId:reserved.intentId};
 const h=harness((url,init)=>{
  if(!url.endsWith('/status'))return response(init.body.includes('"afterIntentId":null')?first:{...page,items:[planned]});
  if(failing)return response({error:'execution_store_unavailable'},503);
  return response(statusOf(JSON.parse(init.body).intentId===planned.intentId?planned:reserved));
 });await flush();
 const asked=(intentId)=>statuses(h.calls).filter(call=>call.body.intentId===intentId).length;
 const lists=()=>h.calls.filter(call=>call.url.endsWith('/list')).length;
 assert.deepEqual(await callTimes(h,900_000),[30_000,60_000,120_000,240_000,480_000,780_000],'at the pace its unchanged answers set, six times');
 await h.advance(8*3_600_000);
 assert.deepEqual([asked(reserved.intentId),lists()],[6,1],'nothing more in eight hours of a visible tab');
 assert.deepEqual(h.c.getSnapshot().items.map(item=>item.state),['reserved'],'left as it was last read');
 // The owner asks for more receipts: that list read resumes the shown receipt, beside the new one.
 h.c.nextPage();await flush();
 await h.advance(8*3_600_000);
 assert.deepEqual([asked(reserved.intentId),asked(planned.intentId),lists()],[12,6,2]);
 // Hidden and shown again: the first page is read again and its receipt resumes; failed answers count the same way.
 failing=true;
 h.hide();h.show();await flush();
 await h.advance(8*3_600_000);
 assert.deepEqual([asked(reserved.intentId),asked(planned.intentId),lists()],[18,6,3]);
 assert.deepEqual([h.c.getSnapshot().items.map(item=>item.state),h.c.getSnapshot().refreshFailed],[['reserved'],{[reserved.intentId]:'execution_store_unavailable'}]);
 h.stop();
});

test('a next page asked while a receipt refresh is on the wire waits for that answer and then for the floor',async()=>{
 const first={...page,nextAfterIntentId:reserved.intentId};
 let release;
 const h=harness((url,init)=>url.endsWith('/status')?new Promise(resolve=>{release=()=>resolve(response(statusOf()))}):response(init.body.includes('"afterIntentId":null')?first:{...page,items:[planned]}));await flush();
 await h.advance(30_000);assert.equal(statuses(h.calls).length,1);
 h.c.nextPage();assert.equal(h.c.getSnapshot().busy,true);
 await flush();assert.equal(h.calls.length,2,'nothing overlaps the refresh on the wire');
 release();await flush();
 await h.advance(29_999);assert.equal(h.calls.length,2);
 await h.advance(1);assert.equal(h.calls.length,3);
 assert.deepEqual(h.calls[2].body,{afterIntentId:reserved.intentId,limit:10});
 assert.deepEqual([h.c.getSnapshot().items.map(item=>item.intentId),h.c.getSnapshot().busy],[[reserved.intentId,planned.intentId],false]);
 h.stop();
});

test('hiding the tab stops refreshes and drops the receipts; shown again, the page is read before any status',async()=>{
 const h=harness();await flush();
 await h.advance(10_000);h.hide();
 await h.advance(600_000);assert.equal(h.calls.length,1);
 h.show();await flush();
 assert.deepEqual(h.calls.map(call=>call.url),['/api/execution/v1/list','/api/execution/v1/list']);
 await h.advance(30_000);assert.equal(h.calls.at(-1).url,'/api/execution/v1/status');
 h.stop();
});

test('receipts that are already settled are never refreshed, and signing out mid-refresh drops the answer',async()=>{
 const settled=harness((url)=>response(url.endsWith('/status')?statusOf(reconciled):{...page,items:[reconciled]}));await flush();
 await settled.advance(900_000);assert.equal(settled.calls.length,1);settled.stop();
 let release;
 const h=harness((url)=>url.endsWith('/status')?new Promise(resolve=>{release=()=>resolve(response(statusOf(signing)))}):response(page));await flush();
 await h.advance(30_000);h.change({kind:'signed_out'});release();await flush();
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items,h.c.getSnapshot().refreshFailed],['signed_out',[],{}]);
 h.stop();
});
