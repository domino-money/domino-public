import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createDepositWorker, DEPOSIT_LIMITS} from '../src/deposit-worker.mjs';
import {ROUTES} from '../../api-contracts/deposit-v1/runtime.mjs';

const root=new URL('../../api-contracts/deposit-v1/fixtures/',import.meta.url);
const read=path=>JSON.parse(fs.readFileSync(new URL(path,root),'utf8'));
const ORIGIN='https://domino.money',SESSION='a'.repeat(43),CSRF='b'.repeat(43);
const ENV={APP_ORIGIN:ORIGIN,DEPOSIT_BRIDGE_ENABLED:'true',DEPOSIT_GATEWAY_ORIGIN:'https://deposit-origin.domino.money',
  DEPOSIT_ACCESS_CLIENT_ID:'synthetic-service-id',DEPOSIT_ACCESS_CLIENT_SECRET:'synthetic-service-secret'};
const HEADERS={'Content-Type':'application/json',Origin:ORIGIN,'Sec-Fetch-Site':'same-origin',
  Cookie:`other=unrelated; __Host-domino-session=${SESSION}`,'X-Domino-CSRF':CSRF};
function request(route='create',body,headers={},method='POST') {
  return new Request(`${ORIGIN}/api/deposit/v1/${route}`,{method,headers:{...HEADERS,...headers},
    ...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body??read(`requests/${route}.json`))}:{})});
}
function reply(data,status=200,headers={}) {
  return new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{
    'Content-Type':'application/json','X-Domino-Deposit-Contract':'1.1.0-rc.3',...headers}});
}
function harness(implementation) {
  const calls=[];
  return {calls,worker:createDepositWorker({getClientIp:()=> '192.0.2.1',fetch:async(url,options)=>{
    calls.push({url,options});return implementation?implementation(url,options):reply(read(`responses/${url.split('/').at(-1)}.json`));
  }})};
}

test('all routes use isolated authenticated origin and closed responses',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1800000000000});
  const h=harness();
  for(const route of ROUTES) {
    const response=await h.worker.fetch(request(route),ENV);
    assert.equal(response.status,200,route+': '+await response.clone().text());
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('X-Domino-Deposit-Contract'),'1.1.0-rc.3');
    assert.equal(response.headers.has('Set-Cookie'),false);
    assert.equal(response.headers.has('Access-Control-Allow-Origin'),false);
  }
  for(const {url,options} of h.calls) {
    assert.match(url,/^https:\/\/deposit-origin\.domino\.money\/internal\/deposit\/v1\//u);
    assert.equal(options.redirect,'manual');
    const headers=new Headers(options.headers);
    assert.equal(headers.get('X-Domino-Session'),SESSION);
    assert.equal(headers.get('X-Domino-CSRF'),CSRF);
    assert.equal(headers.has('Cookie'),false);
    assert.equal(headers.get('CF-Access-Client-Secret'),ENV.DEPOSIT_ACCESS_CLIENT_SECRET);
  }
});

test('disabled and browser origin/credential failures never reach the private backend',async()=>{
  const h=harness();
  assert.equal((await h.worker.fetch(request(),{...ENV,DEPOSIT_BRIDGE_ENABLED:'false'})).status,404);
  for(const headers of [{Origin:'https://evil.example'},{'Sec-Fetch-Site':'cross-site'},
    {Cookie:'other=no-session'},{'X-Domino-CSRF':'invalid'},{Cookie:`__Host-domino-session=${SESSION}; __Host-domino-session=${SESSION}`}]) {
    const response=await h.worker.fetch(request('create',undefined,headers),ENV);
    assert.ok(response.status>=400);
  }
  assert.equal(h.calls.length,0);
});

test('unknown fields, numeric lexemes, unsafe raw money and wrong version are rejected before fetch',async()=>{
  const h=harness(),body=read('requests/create.json');
  for(const raw of [JSON.stringify({...body,owner:'0x'+'dd'.repeat(20)}),
    JSON.stringify(body).replace('4663','4663.0'),JSON.stringify(body).replace('4663','4.663e3'),
    JSON.stringify({...body,selection:{...body.selection,budget0Raw:1000}}),'null','{"x":1,"x":2}','x'.repeat(8193)]) {
    assert.ok((await h.worker.fetch(request('create',raw),ENV)).status>=400);
  }
  for (const version of ['1.0.0','1.1.0-rc.2','2']) {
    assert.equal((await h.worker.fetch(request('create',undefined,{'X-Domino-Deposit-Contract':version}),ENV)).status,502);
  }
  assert.equal(h.calls.length,0);
});

test('creation selection and operation identity/version cannot be substituted',async()=>{
  const changed=read('responses/create.json');changed.operation.selection.amountRaw='99';
  let h=harness(()=>reply(changed));
  assert.equal((await h.worker.fetch(request(),ENV)).status,502);
  const wrong=read('responses/get.json');wrong.operation.id='00000000-0000-4000-8000-000000000099';
  h=harness(()=>reply(wrong));assert.equal((await h.worker.fetch(request('get'),ENV)).status,502);
  const version=read('responses/cancel.json');version.operation.version=99;
  h=harness(()=>reply(version));assert.equal((await h.worker.fetch(request('cancel'),ENV)).status,502);
});

test('wallet payload rejects changed effect and expiry but durable history does not expire',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1800000000000});
  const tampered=read('responses/prepare.json');tampered.walletStep.transaction.to='0x'+'dd'.repeat(20);
  let h=harness(()=>reply(tampered));assert.equal((await h.worker.fetch(request('prepare'),ENV)).status,502);
  t.mock.timers.setTime(1800000031000);
  h=harness();let result=await h.worker.fetch(request('prepare'),ENV);
  assert.equal(result.status,409);assert.deepEqual(await result.json(),{error:'deposit_artifact_expired'});
  result=await h.worker.fetch(request('get'),ENV);assert.equal(result.status,200);
});

test('upstream redirect, bad contract, invalid errors and oversized payloads are not forwarded',async()=>{
  for(const output of [()=>reply('',302,{Location:'https://evil.example'}),
    ()=>reply(read('responses/create.json'),200,{'X-Domino-Deposit-Contract':'2'}),
    ()=>reply({error:'private-stack-trace'},503),()=>reply('x'.repeat(DEPOSIT_LIMITS.responseBytes+1))]) {
    const h=harness(output),result=await h.worker.fetch(request(),ENV);
    assert.ok(result.status>=500);assert.equal(result.headers.has('Location'),false);
    assert.doesNotMatch(await result.text(),/private-stack-trace/u);
  }
});

test('fixed capacity errors preserve retry delay and strip upstream cookies',async()=>{
  const h=harness(()=>reply({error:'deposit_capacity_busy'},429,{'Set-Cookie':'bad=1'}));
  const result=await h.worker.fetch(request(),ENV);
  assert.equal(result.status,429);assert.equal(result.headers.get('Retry-After'),'60');
  assert.equal(result.headers.has('Set-Cookie'),false);
});

test('forged internal headers never override service identity, private owner or ingress IP',async()=>{
  const h=harness();
  const result=await h.worker.fetch(request('create',undefined,{'X-Domino-Session':'forged',
    'X-Domino-Owner':'0x'+'cc'.repeat(20),'CF-Access-Client-Secret':'forged','CF-Connecting-IP':'203.0.113.1'}),ENV);
  assert.equal(result.status,200);
  const headers=new Headers(h.calls[0].options.headers);
  assert.equal(headers.get('X-Domino-Session'),SESSION);assert.equal(headers.get('X-Domino-Client-Id'),'192.0.2.1');
  assert.equal(headers.has('X-Domino-Owner'),false);
});
