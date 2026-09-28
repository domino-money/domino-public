import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import * as runtime from '../../api-contracts/execution-v1/runtime.mjs';
const require=createRequire(import.meta.url);
const {createExecutionController,EXECUTION_STATE_TEXT,EXECUTION_STATE_NOTE,EXECUTION_SETTLED,EXECUTION_READ_FLOOR_MS,EXECUTION_RETRY_MS,EXECUTION_STATUS_MAX_MS,EXECUTION_STATUS_TRIES,
 EXECUTION_LIST_EVERY_MS,EXECUTION_LIST_PAGES,EXECUTION_PAGE_SIZE}=require('../.test-build/app/src/finance/execution.js');
const {REASK_TRIES,FINAL_FAILURES,reaskWait}=require('../.test-build/app/src/finance/privateCards.js');
const f=JSON.parse(readFileSync(new URL('../../api-contracts/execution-v1/fixtures/status-wire.json',import.meta.url)));
const reserved=f.responses['status.reserved'].item;
const page={...f.responses['list.empty'],items:[reserved]};
const headers={'Content-Type':'application/json','X-Domino-Execution-Contract':runtime.CONTRACT_VERSION};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
const stalled=(url,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('abort'))));
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve()};
/** The fixture's status answer for `item` (status.reserved when omitted), checked against the contract first. */
const statusOf=(item=reserved)=>{const body={...f.responses['status.reserved'],item};assert.ok(runtime.validateResponse('status',body),`status fixture for ${item?.state}`);return body};
function harness(handler=(url)=>response(url.endsWith('/status')?statusOf():page),{signedIn=true,visible:shown=true,cache}={}) {
 let now=0,visible=shown;
 const signed={kind:'signed_in',owner:page.owner,chainId:4663,epoch:1,connectorUid:'one'};
 let identity=signedIn?signed:{kind:'signed_out'};
 const listeners=new Set(),calls=[],timers=new Set(),denials=[];
 const clock={monoMs:()=>now,wallMs:()=>now,setTimer(fn,ms){const t={at:now+ms,fn};timers.add(t);return()=>timers.delete(t)}};
 const session={getSnapshot:()=>identity,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},withCsrf:async(e,fn)=>fn('memory-only-csrf'),reportDenial(code,epoch){denials.push({code,epoch})}};
 const c=createExecutionController({session,runtime,clock,visible:()=>visible,cache,fetch:async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return handler(url,init,calls.length)}});
 // Every snapshot the controller published, in order (2026-09-27, round 6: nothing shown may blank between them).
 const seen=[];c.subscribe(()=>seen.push(c.getSnapshot()));
 const stop=c.start();
 return {c,calls,stop,denials,signed,seen,now:()=>now,
  change(value){identity=value;listeners.forEach(fn=>fn())},
  hide(){visible=false;c.visibilityChanged()},
  show(){visible=true;c.visibilityChanged()},
  async advance(ms){const end=now+ms;for(;;){const due=[...timers].filter(t=>t.at<=end).sort((a,b)=>a.at-b.at)[0];if(!due)break;now=due.at;timers.delete(due);due.fn();await flush()}now=end;await flush()}};
}
// Changed on purpose (the owner, 2026-09-27, round 6: the receipts blanked whenever the tab was hidden, and came back only with the
// next read): twenty receipts to a page, the contract's most (was ten); a hidden tab keeps what it shows and reads nothing; shown
// again inside five minutes it reads no list, and its open receipt goes on through status at the floor.
test('signed in and visible, the first page reads itself with the CSRF, bound to the owner, at most once per 30 s; a hidden tab keeps it',async()=>{
 const h=harness();await flush();
 assert.equal(h.calls.length,1,'no control to press: the read starts on its own');
 assert.equal(h.calls[0].url,'/api/execution/v1/list');assert.equal(h.calls[0].init.headers['X-Domino-CSRF'],'memory-only-csrf');
 assert.equal(EXECUTION_PAGE_SIZE,20);
 assert.equal(h.calls[0].init.credentials,'same-origin');assert.deepEqual(h.calls[0].body,{afterIntentId:null,limit:20});
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items.length,h.c.getSnapshot().reason],['ready',1,null]);
 h.hide();assert.deepEqual(h.c.getSnapshot().items,[reserved],'a hidden tab keeps what was shown');
 await h.advance(20_000);assert.equal(h.calls.length,1,'and reads nothing');
 h.show();await flush();assert.equal(h.calls.length,1,'visible again inside 30 s: nothing goes before the floor');
 await h.advance(9_999);assert.equal(h.calls.length,1);
 await h.advance(1);assert.deepEqual(h.calls.map(call=>call.url.split('/').at(-1)),['list','status'],'then its open receipt is refreshed in place, not the list');
 assert.deepEqual(h.c.getSnapshot().items,[reserved]);
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
// Changed on purpose (the owner, 2026-09-27, round 6): a hidden tab keeps what it shows; only another account or a sign-out clears it.
test('an account switch clears data and discards a late response; a hidden tab keeps what it shows and reads nothing',async()=>{
 let release;const h=harness(()=>new Promise(resolve=>{release=resolve}));await flush();assert.equal(h.calls.length,1);
 h.change({kind:'signed_out'});release(response(page));await flush();
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().scope,h.c.getSnapshot().state,h.c.getSnapshot().busy],[0,null,'signed_out',false]);h.stop();
 const next=harness();await flush();assert.equal(next.c.getSnapshot().items.length,1);next.hide();assert.equal(next.c.getSnapshot().items.length,1);
 await next.advance(3_600_000);assert.equal(next.calls.length,1);next.stop();
 // 2026-09-27, round 6: while the wallet's session is checked the card is neither signed out nor empty-for-good.
 const checking=harness(undefined,{signedIn:false});checking.change({kind:'pending'});
 assert.deepEqual([checking.c.getSnapshot().state,checking.calls.length],['checking',0]);
 checking.change(checking.signed);await flush();assert.deepEqual([checking.c.getSnapshot().state,checking.calls.length],['ready',1]);checking.stop();
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
 // Changed on purpose (2026-09-27, round 6): a good page is read again five minutes after it, not when the tab comes back
 // sooner. Failing then, it keeps what it shows, and the good page started the count over: three more asks.
 failing=true;
 assert.deepEqual(await callTimes(h,3_600_000,lists),[300_000,360_000,480_000,720_000],'five minutes on, then three asks again after the good page');
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items],['unavailable',[reserved]],'what was shown stays');
 // A new sign-in starts over too, at once.
 h.change({...h.signed,epoch:2});await flush();
 assert.equal(lists(),13,'a new session reads its first page at once');
 await h.advance(60_000);assert.equal(lists(),14,'and its failure is asked again like a first one');
 h.stop();
});
test('stalled transport aborts at 20s; the next read waits 60s and is not polled any faster',async()=>{
 const h=harness(stalled);await flush();await h.advance(20_000);
 assert.equal(h.c.getSnapshot().busy,false);assert.equal(h.c.getSnapshot().reason,'timeout');assert.equal(h.calls.length,1);
 await h.advance(59_999);assert.equal(h.calls.length,1);await h.advance(1);assert.equal(h.calls.length,2);h.stop();
});
test('a session denial reaches the session port once and nothing asks for a signature',async()=>{
 const h=harness((url,init,n)=>n===1?response({error:'csrf_invalid'},403):response(page));await flush();
 assert.deepEqual(h.denials,[{code:'csrf_invalid',epoch:1}]);assert.equal(h.c.getSnapshot().reason,'csrf_invalid');h.stop();
});
// Changed on purpose (the owner, 2026-09-27, round 6: Show more vanished and the rest never came): the list read takes the pages
// after the first by itself, one per floor, without a press; Show more reads past them (see the paging test at the end).
// Changed on purpose (2026-09-28, round 6 review): a first read with more pages on the way offers Show more at once (it was not
// offered until the whole read ended, so the button went away while the rest was on its way), and a press is answered by that
// read's next page.
test('the next page is added below the first by itself, once the floor allows it; Show more meanwhile waits for it',async()=>{
 const second={...reserved,intentId:'0x'+'34'.repeat(32)};
 const first={...page,nextAfterIntentId:reserved.intentId};
 assert.ok(runtime.validateResponse('list',first));
 const h=harness((url,init)=>response(url.endsWith('/status')?statusOf():init.body.includes('"afterIntentId":null')?first:{...page,items:[second]}));await flush();
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().more,h.c.getSnapshot().busy],[1,true,false],'more on its way: Show more is offered');
 h.c.nextPage();assert.equal(h.c.getSnapshot().busy,true);
 await h.advance(29_999);assert.equal(h.calls.length,1,'inside the floor the page waits');
 await h.advance(1);assert.equal(h.calls.length,2);
 assert.deepEqual(h.calls[1].body,{afterIntentId:reserved.intentId,limit:20},'the read’s own next page, not a second read of it');
 assert.deepEqual(h.c.getSnapshot().items.map(item=>item.intentId),[reserved.intentId,second.intentId]);
 assert.deepEqual([h.c.getSnapshot().more,h.c.getSnapshot().busy],[false,false],'answered, and the end');
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

// Changed on purpose (2026-09-27, round 6): the list is read again every five minutes, so it answers as the receipt now stands.
test('an open receipt is refreshed in place through status at the 30 s floor, waits longer while unchanged, and is left alone once finalized',async()=>{
 const answers=[statusOf(),statusOf(),statusOf(signing),statusOf(reconciled)];let listed=reserved;
 const h=harness((url)=>{if(!url.endsWith('/status'))return response({...page,items:[listed]});const answer=answers.shift()??statusOf(reconciled);listed=answer.item;return response(answer)});await flush();
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
 await h.advance(3_600_000);assert.equal(statuses(h.calls).length,4,'a finalized receipt is never asked again');
 assert.equal(h.calls.filter(call=>call.url.endsWith('/list')).length,13,'the list, every five minutes');
 assert.deepEqual(h.c.getSnapshot().items.map(item=>item.state),['reconciled']);
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
 // Changed on purpose (2026-09-27, round 6): the list is read again every five minutes, and finds the receipt as it was.
 assert.equal(h.calls.filter(call=>call.url.endsWith('/list')).length,4,'the list, every five minutes');
 h.stop();
});

// Changed on purpose (2026-09-27, round 6): the list is read again every five minutes; a read that finds the receipt as it was
// leaves it alone, one that finds it changed follows it again, and so does the tab shown again.
test('an open receipt that keeps answering the same, or keeps failing, is refreshed six times in a visit and then left as it stands, until a list read finds it changed or the tab is shown again',async()=>{
 assert.equal(EXECUTION_STATUS_TRIES,6);
 let failing=false,listed=reserved;
 const h=harness((url)=>{
  if(!url.endsWith('/status'))return response({...page,items:[listed]});
  if(failing)return response({error:'execution_store_unavailable'},503);
  return response(statusOf(listed));
 });await flush();
 const asked=()=>statuses(h.calls).length;
 const lists=()=>h.calls.filter(call=>call.url.endsWith('/list')).length;
 assert.deepEqual(await callTimes(h,900_000,asked),[30_000,60_000,120_000,240_000,480_000,780_000],'at the pace its unchanged answers set, six times');
 await h.advance(8*3_600_000);
 assert.equal(asked(),6,'nothing more in eight hours of a visible tab');
 assert.equal(lists(),1+Math.floor((900_000+8*3_600_000)/EXECUTION_LIST_EVERY_MS),'while the list is read every five minutes, and finds it as it was');
 assert.deepEqual(h.c.getSnapshot().items.map(item=>item.state),['reserved'],'left as it was last read');
 // A list read finds it moved on: it is followed again, from the floor.
 listed=signing;
 await h.advance(EXECUTION_LIST_EVERY_MS);
 assert.equal(h.c.getSnapshot().items[0].state,'signing');
 const moved=asked();
 await h.advance(3_600_000);
 assert.equal(asked()-moved,6,'six more asks at its pace, then left alone again');
 // Hidden and shown again: its receipt resumes; failed answers count the same way.
 failing=true;
 h.hide();h.show();await flush();
 const shown=asked();
 await h.advance(8*3_600_000);
 assert.equal(asked()-shown,6);
 assert.deepEqual([h.c.getSnapshot().items.map(item=>item.state),h.c.getSnapshot().refreshFailed],[['signing'],{[reserved.intentId]:'execution_store_unavailable'}]);
 h.stop();
});

// Changed on purpose (2026-09-27, round 6): the list's pages come by themselves; what holds is that no read overlaps another.
test('a list read that comes due while a receipt refresh is on the wire waits for that answer',async()=>{
 let release;
 const h=harness((url)=>url.endsWith('/status')?new Promise(resolve=>{release=()=>resolve(response(statusOf()))}):response(page));await flush();
 await h.advance(30_000);assert.equal(statuses(h.calls).length,1,'the open receipt is on the wire');
 await h.advance(EXECUTION_LIST_EVERY_MS);assert.equal(h.calls.length,2,'the list came due meanwhile: nothing overlaps the refresh on the wire');
 release();await flush();
 assert.deepEqual(h.calls.map(call=>call.url.split('/').at(-1)),['list','status','list'],'answered: the list goes, the floor long past');
 assert.deepEqual(h.calls[2].body,{afterIntentId:null,limit:20});
 h.stop();
});

// Changed on purpose (the owner, 2026-09-27, round 6): hidden, the receipts stay; shown again after longer than five minutes, the
// list is read at once, before any status.
test('hiding the tab stops refreshes and keeps the receipts; shown again after five minutes and more, the list is read before any status',async()=>{
 const h=harness();await flush();
 await h.advance(10_000);h.hide();
 assert.deepEqual(h.c.getSnapshot().items,[reserved]);
 await h.advance(600_000);assert.equal(h.calls.length,1);
 h.show();await flush();
 assert.deepEqual(h.calls.map(call=>call.url),['/api/execution/v1/list','/api/execution/v1/list']);
 await h.advance(30_000);assert.equal(h.calls.at(-1).url,'/api/execution/v1/status');
 h.stop();
});

test('receipts that are already settled are never refreshed, and signing out mid-refresh drops the answer',async()=>{
 const settled=harness((url)=>response(url.endsWith('/status')?statusOf(reconciled):{...page,items:[reconciled]}));await flush();
 // Changed on purpose (2026-09-27, round 6): the list itself is read again every five minutes.
 await settled.advance(900_000);assert.deepEqual([statuses(settled.calls).length,settled.calls.length],[0,4]);settled.stop();
 let release;
 const h=harness((url)=>url.endsWith('/status')?new Promise(resolve=>{release=()=>resolve(response(statusOf(signing)))}):response(page));await flush();
 await h.advance(30_000);h.change({kind:'signed_out'});release();await flush();
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items,h.c.getSnapshot().refreshFailed],['signed_out',[],{}]);
 h.stop();
});

// ---- 2026-09-27, round 6 (the owner: the receipts blanked on every refresh, Show more vanished and the rest never came) --------

/** A finalized receipt numbered `n`, valid for the contract. */
const settledItem=(n)=>({...reconciled,intentId:'0x'+n.toString(16).padStart(64,'0')});
/** The list route over `items()` as the service's keyset answers it: in id order, `size` to a page, each page's cursor its last id. */
const pagesOf=(items,size=EXECUTION_PAGE_SIZE)=>(url,init)=>{
 if(url.endsWith('/status'))return response(f.responses['status.missing']);
 const after=JSON.parse(init.body).afterIntentId;
 const rest=items().filter(item=>after===null||item.intentId>after).sort((a,b)=>a.intentId<b.intentId?-1:1),shown=rest.slice(0,size);
 return response({...page,items:shown,nextAfterIntentId:rest.length>size?shown.at(-1).intentId:null});
};

// Changed on purpose (2026-09-28, round 6 review): a later read from the first page reads on past the pages Show more reached (it
// read the first five only, and moved Show more back to page six), so every row it shows is listed again and Show more goes on.
test('a list read takes the pages after the first by itself, one per floor, up to five; Show more reads on past them at the same pace, and a later read covers what it brought',async()=>{
 assert.equal(EXECUTION_LIST_PAGES,5);
 const all=Array.from({length:7*EXECUTION_PAGE_SIZE},(_,n)=>settledItem(n+1));
 const h=harness(pagesOf(()=>all));await flush();
 const lists=()=>h.calls.filter(call=>call.url.endsWith('/list'));
 assert.deepEqual(await callTimes(h,120_000),[30_000,60_000,90_000,120_000],'four more pages, one per floor, and no press');
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().more,h.c.getSnapshot().busy],[100,true,false],'five pages read; more wait past them');
 // Show more: the next page, at the floor's pace; a second press adds nothing.
 h.c.nextPage();assert.equal(h.c.getSnapshot().busy,true);
 h.c.nextPage();await h.advance(29_999);assert.equal(lists().length,5,'inside the floor the page waits');
 await h.advance(1);assert.equal(lists().length,6);
 assert.deepEqual(lists()[5].body,{afterIntentId:all[99].intentId,limit:EXECUTION_PAGE_SIZE});
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().more,h.c.getSnapshot().busy],[120,true,false]);
 h.c.nextPage();await h.advance(30_000);
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().more,h.c.getSnapshot().busy],[140,false,false],'the last page: nothing more');
 // Five minutes after the whole read, the list again, as far as Show more reached (here its end): every row stays, in place.
 await h.advance(EXECUTION_LIST_EVERY_MS+120_000);
 assert.equal(lists().length,14,'the seven pages, read again');
 assert.deepEqual(lists().slice(7).map(call=>call.body.afterIntentId),[null,...[20,40,60,80,100,120].map(n=>all[n-1].intentId)]);
 assert.deepEqual(h.c.getSnapshot().items.map(item=>item.intentId),all.map(item=>item.intentId),'every row stays, in place');
 assert.deepEqual([h.c.getSnapshot().more,h.c.getSnapshot().busy],[false,false]);
 h.stop();
});

// 2026-09-28, round 6 review: past five pages (more than 100 receipts), Show more after a later read brought a page already shown,
// and one pressed during a later read waited for the whole read (up to 150 s of "Loading more…").
test('past five pages, Show more after a later read brings the next page past every row shown, within one floor',async()=>{
 const all=Array.from({length:7*EXECUTION_PAGE_SIZE},(_,n)=>settledItem(n+1));
 const h=harness(pagesOf(()=>all));await flush();
 const lists=()=>h.calls.filter(call=>call.url.endsWith('/list'));
 await h.advance(120_000);
 h.c.nextPage();await h.advance(30_000);
 assert.equal(h.c.getSnapshot().items.length,120,'Show more: page six');
 // The quiet read five minutes on reads the first page and on past page six.
 await h.advance(EXECUTION_LIST_EVERY_MS+120_000);
 assert.equal(lists().length,12,'six pages read again');
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().more,h.c.getSnapshot().busy],[120,true,false]);
 h.c.nextPage();await h.advance(30_000);
 assert.deepEqual(lists().at(-1).body,{afterIntentId:all[119].intentId,limit:EXECUTION_PAGE_SIZE},'page seven, never a page shown');
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().more,h.c.getSnapshot().busy],[140,false,false]);
 h.stop();
});

test('past five pages, a new session for the same wallet keeps where Show more reached: its first read covers it, and Show more goes on past it',async()=>{
 const all=Array.from({length:8*EXECUTION_PAGE_SIZE},(_,n)=>settledItem(n+1));
 const h=harness(pagesOf(()=>all));await flush();
 const lists=()=>h.calls.filter(call=>call.url.endsWith('/list'));
 await h.advance(120_000);h.c.nextPage();await h.advance(30_000);
 assert.equal(h.c.getSnapshot().items.length,120);
 // Another tab signed in again: a new epoch for the same wallet through the same connector.
 h.change({...h.signed,epoch:2});
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().more],[120,true],'the same rows, and Show more still offered');
 await h.advance(5*EXECUTION_READ_FLOOR_MS);
 assert.deepEqual(lists().slice(6).map(call=>call.body.afterIntentId),[null,...[20,40,60,80,100].map(n=>all[n-1].intentId)],'its first read covers page six too');
 h.c.nextPage();await h.advance(EXECUTION_READ_FLOOR_MS);
 assert.deepEqual(lists().at(-1).body.afterIntentId,all[119].intentId,'then page seven, never a page shown');
 assert.equal(h.c.getSnapshot().items.length,140);
 h.stop();
});

test('past five pages, Show more pressed during a later read is its next read, answered within one floor; the read then goes on and covers it',async()=>{
 const all=Array.from({length:7*EXECUTION_PAGE_SIZE},(_,n)=>settledItem(n+1));
 const h=harness(pagesOf(()=>all));await flush();
 const lists=()=>h.calls.filter(call=>call.url.endsWith('/list'));
 await h.advance(120_000);
 // The later read has begun: its first page went.
 await h.advance(EXECUTION_LIST_EVERY_MS+1);
 assert.deepEqual([lists().length,lists().at(-1).body.afterIntentId,h.c.getSnapshot().more],[6,null,true]);
 h.c.nextPage();
 const pressed=h.now(),rows=h.c.getSnapshot().items.length;
 while(h.c.getSnapshot().busy)await h.advance(1_000);
 assert.ok(h.now()-pressed<=EXECUTION_READ_FLOOR_MS,`answered in ${(h.now()-pressed)/1000} s`);
 assert.deepEqual([rows,h.c.getSnapshot().items.length],[100,120]);
 assert.deepEqual(lists()[6].body.afterIntentId,all[99].intentId,'page six, ahead of the read’s own pages');
 // The read goes on from its second page and on past page six; every row stays.
 await h.advance(6*EXECUTION_READ_FLOOR_MS);
 assert.deepEqual(lists().slice(7).map(call=>call.body.afterIntentId),[20,40,60,80,100].map(n=>all[n-1].intentId));
 assert.deepEqual([h.c.getSnapshot().items.length,h.c.getSnapshot().more,h.c.getSnapshot().busy],[120,true,false]);
 h.stop();
});

test('nothing shown ever blanks: a list read again, a failed read, a hidden tab, a view shown again and Show more keep every row, and none shows loading again',async()=>{
 let failing=false;const all=Array.from({length:2*EXECUTION_PAGE_SIZE+5},(_,n)=>settledItem(n+1));
 const pages=pagesOf(()=>all,20);
 const h=harness((url,init)=>failing&&url.endsWith('/list')?response({error:'execution_store_unavailable'},503):pages(url,init));await flush();
 await h.advance(60_000);assert.equal(h.c.getSnapshot().items.length,45);
 failing=true;await h.advance(EXECUTION_LIST_EVERY_MS);
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().reason,h.c.getSnapshot().items.length],['unavailable','execution_store_unavailable',45],'a failed read keeps what is shown');
 h.hide();await h.advance(600_000);h.show();await flush();
 failing=false;
 h.stop();const again=h.c.start();await flush();
 all.push(settledItem(999));
 await h.advance(3_600_000);
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items.length],['ready',46],'a new receipt joined');
 // From the moment the whole list was shown (its pages arrive one per floor, each adding rows below).
 const first=h.seen.findIndex(view=>view.items.length===45);
 assert.ok(first>=0);
 assert.ok(h.seen.slice(0,first).every((view,n,views)=>n===0||view.items.length>=views[n-1].items.length),'the first read only ever adds rows');
 assert.deepEqual(h.seen.slice(first).filter(view=>view.items.length<45||view.state==='loading'||view.state==='checking').length,0,'once shown, never fewer rows, and never loading again');
 again();
});

test('signed in, the card shows this browser’s copy at once, before any read answers; each read is merged into it and kept, and another wallet never sees it',async()=>{
 const kept=[settledItem(1),settledItem(2)],saved=[],asked=[];
 const cache={load:(owner)=>{asked.push(owner);return owner===page.owner?kept:null},save:(owner,items)=>saved.push([owner,items.map(item=>item.intentId)])};
 let release;
 const h=harness(()=>new Promise(resolve=>{release=()=>resolve(response({...page,items:[settledItem(2),settledItem(3)]}))}),{cache});await flush();
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items],['loading',kept],'painted from the copy, the read still on its way');
 assert.deepEqual([asked,saved],[[page.owner],[]],'the copy is read for this wallet, and not written back unread');
 release();await flush();
 assert.deepEqual(h.c.getSnapshot().items.map(item=>item.intentId),[2,3].map(n=>settledItem(n).intentId),'merged: the one the whole read no longer lists is gone, the new one joined');
 assert.deepEqual(saved,[[page.owner,[2,3].map(n=>settledItem(n).intentId)]],'and kept');
 h.change({...h.signed,owner:'0x'+'b'.repeat(40),epoch:2});
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items,asked.at(-1)],['loading',[],'0x'+'b'.repeat(40)],'another wallet: its own copy only, here none');
 h.change({kind:'signed_out'});assert.deepEqual(h.c.getSnapshot().items,[]);
 h.stop();
});

// 2026-09-27, round 6: the copy is display only and never outlives a sign-in; a new session of the same wallet keeps the rows.
// Changed on purpose (2026-09-28, round 6 review): the controller is no longer told of each session change to forget the copy; it
// stops once no view shows it, so a sign-out elsewhere never reached it. The wallet island forgets every private copy instead, on
// any page (finance/privateCards.ts forgetPrivate, pinned below and in tests/finance.browser.test.mjs).
test('a new session for the same wallet and connector keeps every row and reads the list at once; another connector or a sign-out starts over',async()=>{
 const loads=[];
 const cache={load:(owner)=>{loads.push(owner);return null},save(){}};
 const h=harness(pagesOf(()=>[settledItem(1),settledItem(2)]),{cache});await flush();
 assert.deepEqual([h.c.getSnapshot().items.length,h.calls.length,loads],[2,1,[page.owner]]);
 const views=h.seen.length;
 // Another tab signed out and in again: a new epoch for the same wallet through the same connector.
 h.change({...h.signed,epoch:2});
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items.length,loads.length],['loading',2,1],'the same rows, no copy read over them');
 assert.ok(h.seen.slice(views).every(view=>view.items.length===2),'never blank on the way');
 await flush();assert.equal(h.calls.length,2,'and the list read at once, for the new session');
 // The same address through another connector is another scope: it starts from this browser's copy, not from these rows.
 h.change({...h.signed,epoch:3,connectorUid:'two'});
 assert.deepEqual([h.c.getSnapshot().items,loads.length],[[],2]);
 await flush();
 // Signed out: nothing is shown.
 h.change({kind:'signed_out'});
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items],['signed_out',[]]);
 h.stop();
});

// 2026-09-27, round 6: the chunk loads once the wallet is usually signed in; its first paint must not be a signed-out line.
test('created while the wallet is signed in or checked, the first paint is where the session stands, from this browser’s copy, and nothing is read before the start',async()=>{
 const kept=[settledItem(1)],calls=[];
 const cache={load:(owner)=>owner===page.owner?kept:null,save(){}};
 const clock={monoMs:()=>0,wallMs:()=>0,setTimer:()=>()=>{}};
 const make=(snapshot)=>createExecutionController({session:{getSnapshot:()=>snapshot,subscribe:()=>()=>{},withCsrf:async()=>{},reportDenial(){}},runtime,clock,visible:()=>true,cache,fetch:async(url)=>{calls.push(url);return response(page)}});
 const signed=make({kind:'signed_in',owner:page.owner,chainId:4663,epoch:1,connectorUid:'one'}).getSnapshot();
 assert.deepEqual([signed.state,signed.items,signed.scope],['loading',kept,`1|one|${page.owner}`]);
 assert.equal(make({kind:'pending'}).getSnapshot().state,'checking');
 assert.equal(make({kind:'signed_out'}).getSnapshot().state,'signed_out');
 await flush();assert.deepEqual(calls,[],'nothing read before a view starts it');
});

test('a view shown again keeps what it showed and reads at its own time, not at once',async()=>{
 const h=harness(pagesOf(()=>[settledItem(1)]));await flush();
 await h.advance(60_000);h.stop();
 await h.advance(30_000);const again=h.c.start();await flush();
 assert.deepEqual([h.c.getSnapshot().state,h.c.getSnapshot().items.length,h.calls.length],['ready',1,1],'shown again: the same rows, and no read');
 await h.advance(EXECUTION_LIST_EVERY_MS-90_000-1);assert.equal(h.calls.length,1);
 await h.advance(1);assert.equal(h.calls.length,2,'the list at its five minutes');
 again();
});

// ---- 2026-09-27, round 6: this browser's copy of the private cards (finance/privateCards.ts), and their shared start ---------

const {readKept,keep,keepFirst,walletName,forgetPrivate,sharedStart}=require('../.test-build/app/src/finance/privateCards.js');
/** A browser's localStorage in memory: its entries are its own keys, as Object.keys(localStorage) lists them. */
function memoryStorage(){
 const store=Object.create({getItem(key){return Object.hasOwn(this,key)?this[key]:null},setItem(key,value){this[key]=String(value)},removeItem(key){delete this[key]}});
 return store;
}

// Changed on purpose (2026-09-28, round 6 review): an emptied list is kept empty (it kept its last rows, which painted again on the
// next visit), and one forgetting drops every wallet's private copies at once (was a wallet at a time, from the controllers).
test('this browser’s copy: kept by name with its time, read back only while young enough and accepted by its check; an old, refused, unreadable or oversized entry is dropped, and blocked storage keeps nothing',()=>{
 const realNow=Date.now;let now=1_000_000;
 const store=globalThis.localStorage=memoryStorage();
 const keys=()=>Object.keys(store).sort();
 Date.now=()=>now;
 try{
  const any=data=>data;
  keep('receipts.4663.0xabc',[1,2]);
  assert.deepEqual(keys(),['domino.kept.v1.receipts.4663.0xabc'],'one versioned entry per name');
  assert.deepEqual(readKept('receipts.4663.0xabc',1_000,any),[1,2]);
  now+=1_001;assert.equal(readKept('receipts.4663.0xabc',1_000,any),null,'too old');assert.equal(keys().length,0,'and dropped');
  keep('refused',{a:1});assert.equal(readKept('refused',1_000,()=>null),null,'refused by its check');assert.equal(keys().length,0,'and dropped');
  store['domino.kept.v1.garbled']='{not json';assert.equal(readKept('garbled',1_000,any),null,'unreadable');assert.equal(keys().length,0,'and dropped');
  store['domino.kept.v1.ahead']=JSON.stringify({at:now+5_000,data:1});assert.equal(readKept('ahead',10_000,any),null,'kept in the future: a clock moved, not trusted');
  keep('big',1);keep('big','x'.repeat(130_000));assert.equal(Object.hasOwn(store,'domino.kept.v1.big'),false,'a copy too large to keep drops the old one');
  store['domino.kept.v1.huge']=JSON.stringify({at:now,data:'x'.repeat(130_000)});assert.equal(readKept('huge',1_000,any),null,'nor is one read back');
  // 2026-09-27, round 6: as many of the first rows as fit are kept.
  assert.equal(keep('small',[1]),true);
  const rows=Array.from({length:60},(_,n)=>({n,pad:'x'.repeat(3_000)}));
  keepFirst('rows',rows);assert.deepEqual(readKept('rows',1_000,any).map(row=>row.n),rows.slice(0,30).map(row=>row.n),'halved until it fits: the first thirty');
  // 2026-09-28, round 6 review: one receipt kept, then the list read answers none: the copy is the empty list, never the last row.
  keepFirst('receipts.4663.0xabc',[{intentId:'0x1'}]);assert.deepEqual(readKept('receipts.4663.0xabc',1_000,any),[{intentId:'0x1'}]);
  keepFirst('receipts.4663.0xabc',[]);assert.deepEqual(readKept('receipts.4663.0xabc',1_000,any),[],'emptied: kept empty');
  keepFirst('one',[{pad:'x'.repeat(130_000)}]);assert.deepEqual(readKept('one',1_000,any),[],'not even one row fits: none kept');
  const owner='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40);
  assert.deepEqual([walletName('receipts',owner),walletName('managed',owner)],[`receipts.4663.${owner}`,`managed.4663.${owner}`]);
  // Signed out, let go or refused, on any page: every wallet's receipts and Managed positions go; the public token details stay.
  for(const who of [owner,other]){keep(walletName('receipts',who),[1]);keep(walletName('managed',who),{})}
  keep('tokens',[]);store['other.app.key']='1';
  forgetPrivate();
  assert.deepEqual(keys().filter(key=>/\.(receipts|managed)\./.test(key)),[],'no private copy is left');
  assert.ok(keys().includes('domino.kept.v1.tokens')&&keys().includes('other.app.key'),'the rest stays');
  const blocked=()=>{throw new Error('blocked')};
  globalThis.localStorage={getItem:blocked,setItem:blocked,removeItem:blocked};
  assert.equal(keep('x',1),false);keepFirst('x',rows);keepFirst('x',[]);
  assert.equal(readKept('x',1_000,any),null,'blocked storage keeps nothing and throws nothing');
  globalThis.localStorage=new Proxy({},{ownKeys:blocked});forgetPrivate();
 }finally{Date.now=realNow;delete globalThis.localStorage}
});

test('a shared start: the first view starts the controller, a view shown as another leaves keeps it running, and it stops once none is left; the tab’s visibility reaches it',async()=>{
 const heard=[];globalThis.document={addEventListener:(type,listener)=>heard.push([type,listener])};
 let starts=0,stops=0,changes=0;const watch=sharedStart({start:()=>{starts++;return()=>{stops++}},visibilityChanged:()=>{changes++}});
 delete globalThis.document;
 assert.deepEqual(heard.map(([type])=>type),['visibilitychange']);heard[0][1]();assert.equal(changes,1);
 const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
 const a=watch(),b=watch();a();b();const c=watch();
 await tick();assert.deepEqual([starts,stops],[1,0],'a route change: one view left just before the next came');
 c();await tick();assert.deepEqual([starts,stops],[1,1],'none left: stopped');
 watch()();await tick();assert.deepEqual([starts,stops],[2,2]);
});
