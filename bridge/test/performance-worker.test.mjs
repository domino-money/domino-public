import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createPerformanceWorker} from '../src/performance-worker.mjs';
import * as runtime from '../../api-contracts/performance-v2/runtime.mjs';
const origin='https://app.example.invalid', session='s'.repeat(43), csrf='c'.repeat(43);
const env={APP_ORIGIN:origin,PERFORMANCE_BRIDGE_ENABLED:'true',PERFORMANCE_GATEWAY_ORIGIN:'https://private.example.invalid',
  PERFORMANCE_ACCESS_CLIENT_ID:'synthetic-performance-client',PERFORMANCE_ACCESS_CLIENT_SECRET:'synthetic-performance-secret'};
const fixture=(name)=>JSON.parse(readFileSync(new URL('../../api-contracts/performance-v2/fixtures/'+name+'.json',import.meta.url)));
const request=(route,changes={})=>new Request(origin+'/api/performance/v2/'+route,{method:'POST',headers:{Origin:origin,
  'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty','Content-Type':'application/json',
  Cookie:'__Host-domino-session='+session,'X-Domino-CSRF':csrf,...changes.headers},body:JSON.stringify(changes.body??fixture('requests/'+route))});
function harness(route,body=fixture('responses/'+route)) {
  const calls=[];
  return {calls,worker:createPerformanceWorker({getClientIp:()=> '192.0.2.1',fetch:async(url,init)=>{
    calls.push({url,init});
    return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json','X-Domino-Performance-Contract':runtime.CONTRACT_VERSION}});
  }})};
}
for(const route of runtime.ROUTES) test(route+' forwards only session authorization and exact typed data',async()=>{
  const h=harness(route), result=await h.worker.fetch(request(route,{headers:{Cookie:'__Host-domino-session='+session+'; beta=unrelated; __Host-domino-preauth=unrelated'}}),env);
  assert.equal(result.status,200,await result.clone().text());
  assert.deepEqual(await result.json(),fixture('responses/'+route));
  assert.equal(h.calls[0].url,env.PERFORMANCE_GATEWAY_ORIGIN+'/internal/performance/v2/'+route);
  const headers=new Headers(h.calls[0].init.headers);
  assert.equal(headers.get('X-Domino-Session'),session); assert.equal(headers.get('X-Domino-CSRF'),csrf);
  for(const name of ['Cookie','Authorization','Origin']) assert.equal(headers.get(name),null);
  assert.equal(result.headers.get('Set-Cookie'),null);
});
test('disabled, sessionless, missing CSRF and caller owner fail before upstream',async()=>{
  for(const [settings,changes,status] of [[{...env,PERFORMANCE_BRIDGE_ENABLED:'false'},{},404],
    [env,{headers:{Cookie:''}},401],[env,{headers:{'X-Domino-CSRF':''}},403],
    [env,{body:{...fixture('requests/enroll'),owner:'0x'+'f'.repeat(40)}},400]]){
    const h=harness('enroll'); assert.equal((await h.worker.fetch(request('enroll',changes),settings)).status,status); assert.equal(h.calls.length,0);
  }
});
test('response epoch substitution and unqualified APR cannot pass',async()=>{
  const wrong=fixture('responses/cards'); wrong.cards[0].epochId='0x'+'f'.repeat(64);
  assert.equal((await harness('cards',wrong).worker.fetch(request('cards'),env)).status,502);
  const stale=fixture('variants/stale'); stale.cards[0].metrics.netFeeAprPercent='12';
  assert.equal(runtime.validateResponse('cards',stale),false);
});
test('all checked fixtures and exact strings validate',()=>{
  for(const route of runtime.ROUTES){assert.ok(runtime.validateRequest(route,fixture('requests/'+route)));assert.ok(runtime.validateResponse(route,fixture('responses/'+route)));}
  for(const name of ['stale','unqualified-prices']) assert.ok(runtime.validateResponse('cards',fixture('variants/'+name)));
  const body=fixture('responses/cards'); body.cards[0].metrics.newTradingFeesUsd=10;
  assert.equal(runtime.validateResponse('cards',body),false);
});
