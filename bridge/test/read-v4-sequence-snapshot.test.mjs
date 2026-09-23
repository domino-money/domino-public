import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorker } from '../src/worker.mjs';
import { CONTRACT_VERSION, validateRequest, validateResponse } from '../../api-contracts/read-v4/runtime.mjs';

const origin = 'https://app.example.invalid';
const owner = '0x'+'11'.repeat(20), hash = '0x'+'aa'.repeat(32);
const env = {APP_ORIGIN:origin,GATEWAY_ORIGIN:'https://gateway.example.invalid',
  READ_V4_BRIDGE_ENABLED:'true',ENABLED_V4_READS:'sequence-snapshot',
  ACCESS_CLIENT_ID:'synthetic-service-id',ACCESS_CLIENT_SECRET:'synthetic-service-secret'};
const names = {
  factory:['implementation','implementationCodeHash','poolManager','positionManager','stateView','serviceFeeRecipient','nextOwnerNonce'],
  implementation:['factory','implementation','implementationVersion','poolManager','positionManager','stateView','serviceFeeRecipient','readHelper','executionEngine','readHelperCodeHash','executionEngineCodeHash','poolManagerCodeHash','positionManagerCodeHash','stateViewCodeHash'],
  positionManager:['poolManager'],stateView:['poolManager'],readHelper:['positionManager','stateView'],
  engine:['factory','readHelper','routingHelper','priceGuard','readHelperHash','routingHelperHash','priceGuardHash'],
  priceGuard:['publisher'],
};
const code = Object.fromEntries(['factory','implementation','poolManager','positionManager','stateView','readHelper','engine','routing','priceGuard','operator','pricePublisher'].map(name=>[name,'0x6000']));
const calls = Object.fromEntries(Object.entries(names).map(([role,fields])=>[role,Object.fromEntries(fields.map(name=>[name,'0x'+'00'.repeat(32)]))]));
const sample = {schemaVersion:1,contractVersion:CONTRACT_VERSION,chainId:4663,owner,tokenId:null,
  blockNumber:70_000_000,blockHash:hash,code,calls,recent:[],root:null};
const input = {owner,tokenId:null};
const request = (body=input,url=`${origin}/api/read/v4/sequence-snapshot`) => new Request(url,{method:'POST',
  headers:{Origin:origin,'Content-Type':'application/json','Sec-Fetch-Site':'same-origin'},body:JSON.stringify(body)});
function harness(payload=sample) {
  const calls=[];
  return {calls,worker:createWorker({getClientIp:()=> '203.0.113.7',fetch:async(url,init)=>{
    calls.push({url,init});return new Response(JSON.stringify(payload),{status:200,
      headers:{'Content-Type':'application/json','X-Domino-Read-Contract':CONTRACT_VERSION}});
  }})};
}

test('V4 snapshot stays OFF without its exact flag and sends no upstream request',async()=>{
  const h=harness(), result=await h.worker.fetch(request(),{...env,READ_V4_BRIDGE_ENABLED:'false'});
  assert.equal(result.status,404);assert.deepEqual(await result.json(),{error:'route_not_available'});
  assert.equal(h.calls.length,0);
});

test('V4 forwards only a fixed typed owner/NFT request and validates the complete reply',async()=>{
  assert.equal(validateRequest('sequence-snapshot',input),true);
  assert.equal(validateResponse('sequence-snapshot',sample),true);
  const h=harness(), result=await h.worker.fetch(request(),env);
  assert.equal(result.status,200);assert.deepEqual(await result.json(),sample);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].url,'https://gateway.example.invalid/internal/read/v4/sequence-snapshot');
  assert.equal(new Headers(h.calls[0].init.headers).get('CF-Access-Client-Id'),env.ACCESS_CLIENT_ID);
  assert.equal(new Headers(h.calls[0].init.headers).get('Cookie'),null);
});

test('V4 rejects arbitrary method/address/URL, malformed producer identity and wrong owner',async()=>{
  for (const body of [{...input,method:'eth_call'},{...input,address:owner},{...input,url:'https://evil.invalid'},
    {...input,tokenId:'0'},{...input,owner:owner.toUpperCase()}]) {
    const h=harness();const result=await h.worker.fetch(request(body),env);
    assert.equal(result.status,422);assert.equal(h.calls.length,0);
  }
  for (const url of [`${origin}/api/read/v4/eth_call`,`${origin}/api/read/v4/sequence-snapshot?url=https://evil.invalid`]) {
    const h=harness();assert.equal((await h.worker.fetch(request(input,url),env)).status,404);assert.equal(h.calls.length,0);
  }
  for (const tampered of [{...sample,owner:'0x'+'22'.repeat(20)},{...sample,code:{...sample.code,evil:'0x'}},
    {...sample,blockHash:'0x'+'bb'.repeat(31)}]) {
    const h=harness(tampered),result=await h.worker.fetch(request(),env);
    assert.equal(result.status,502);assert.equal(h.calls.length,1);
  }
});
