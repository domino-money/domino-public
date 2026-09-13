import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import * as runtime from '../../api-contracts/execution-v1/runtime.mjs';
const require=createRequire(import.meta.url);
const {createExecutionController}=require('../.test-build/app/src/finance/execution.js');
const f=JSON.parse(readFileSync(new URL('../../api-contracts/execution-v1/fixtures/status-wire.json',import.meta.url)));
const page={...f.responses['list.empty'],items:[f.responses['status.reserved'].item]};
const response=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json','X-Domino-Execution-Contract':runtime.CONTRACT_VERSION}});
function harness(handler=()=>response(page)) {
 let now=0,visible=true,identity={kind:'signed_in',owner:page.owner,chainId:4663,epoch:1,connectorUid:'one'};
 const listeners=new Set(),calls=[],timers=new Set();
 const clock={monoMs:()=>now,wallMs:()=>now,setTimer(fn,ms){const t={at:now+ms,fn};timers.add(t);return()=>timers.delete(t)}};
 const session={getSnapshot:()=>identity,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},withCsrf:async(e,fn)=>fn('memory-only-csrf'),reportDenial(){}};
 const c=createExecutionController({session,runtime,clock,visible:()=>visible,fetch:async(url,init)=>{calls.push({url,init});return handler(url,init)}});
 const stop=c.start();return {c,calls,stop,change(value){identity=value;listeners.forEach(fn=>fn())},hide(){visible=false;c.visibilityChanged()},advance(ms){now+=ms;for(const t of [...timers])if(t.at<=now){timers.delete(t);t.fn()}}};
}
test('explicit receipt read uses CSRF, owner-bound page and one call per 30s',async()=>{
 const h=harness();assert.equal(h.calls.length,0);await h.c.refresh();assert.equal(h.c.getSnapshot().items.length,1);
 assert.equal(h.calls[0].url,'/api/execution/v1/list');assert.equal(h.calls[0].init.headers['X-Domino-CSRF'],'memory-only-csrf');
 assert.equal(h.calls[0].init.credentials,'same-origin');await h.c.refresh();assert.equal(h.calls.length,1);
 h.advance(30000);await h.c.refresh();assert.equal(h.calls.length,2);h.stop();
});
test('foreign owner and unqualified effect are never rendered',async()=>{
 for(const value of [{...page,owner:'0x'+'b'.repeat(40)},{...page,items:[{...page.items[0],state:'reconciled'}]}]){
  const h=harness(()=>response(value));await h.c.refresh();assert.equal(h.c.getSnapshot().items.length,0);assert(h.c.getSnapshot().reason);h.stop();
 }
});
test('account switch and hidden tabs clear data and discard a late response',async()=>{
 let release;const h=harness(()=>new Promise(resolve=>{release=resolve}));const pending=h.c.refresh();await Promise.resolve();
 h.change({kind:'signed_out'});release(response(page));await pending;assert.equal(h.c.getSnapshot().items.length,0);assert.equal(h.c.getSnapshot().scope,null);h.stop();
 const next=harness();await next.c.refresh();next.hide();assert.equal(next.c.getSnapshot().items.length,0);await next.c.refresh();assert.equal(next.calls.length,1);next.stop();
});
test('stalled transport aborts at 20s and cannot be retried for 60s',async()=>{
 const h=harness((url,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('abort')))));
 const pending=h.c.refresh();await Promise.resolve();h.advance(20000);await pending;
 assert.equal(h.c.getSnapshot().busy,false);assert.equal(h.c.getSnapshot().reason,'timeout');await h.c.refresh();assert.equal(h.calls.length,1);h.stop();
});
