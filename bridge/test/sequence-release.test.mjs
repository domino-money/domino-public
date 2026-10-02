import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupRelease} from '../src/setup-release.mjs';
const contracts=['factory','implementation','poolManager','positionManager','stateView','readHelper','engine','routing','priceGuard'];
const address=n=>'0x'+n.toString(16).padStart(40,'0');
const d={...Object.fromEntries([...contracts,'serviceFeeRecipient','operator','pricePublisher'].map((k,i)=>[k,address(i+1)])),serviceFeeBps:200,dominoServiceFeeBps:400,expiresAt:Math.floor(Date.now()/1000)+600,codeHashes:Object.fromEntries(['vault',...contracts].map((k,i)=>[k,'0x'+(i+1).toString(16).padStart(64,'0')]))};
const req=(path='/api/setup/v1/sequence-release',headers={})=>new Request('https://domino.money'+path,{headers:{'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty',...headers}});
const env=value=>({SEQUENCE_WALLET_ENABLED:'true',SEQUENCE_DEPLOYMENT_JSON:JSON.stringify(value)});
test('sequence profile routes through the real setup Worker, defaults OFF, and has no private credentials',async()=>{
  assert.deepEqual(await setupRelease(req(),{}).json(),{contractVersion:'1.0.0-rc.1',chainId:4663,available:false,deployment:null});
  const response=setupRelease(req(),env(d));
  assert.equal(response.status,200);assert.deepEqual((await response.json()).deployment,d);
  assert.equal(response.headers.get('X-Domino-Setup-Contract'),'1.0.0-rc.1');assert.equal(response.headers.get('Set-Cookie'),null);
});
test('sequence identities reject profile drift, operator/publisher collision, missing code pins and altered fee',()=>{
  for(const value of [{...d,secret:'x'},{...d,factory:d.engine},{...d,operator:d.pricePublisher},{...d,pricePublisher:d.routing},{...d,serviceFeeBps:201},{...d,dominoServiceFeeBps:200},{...d,dominoServiceFeeBps:undefined},{...d,expiresAt:1},{...d,codeHashes:{...d.codeHashes,vault:undefined}},{...d,codeHashes:{...d.codeHashes,extra:d.codeHashes.vault}},{...d,operator:address(0)}]) assert.equal(setupRelease(req(),env(value)).status,503);
});
test('sequence release never accepts a mutation, query, navigation or cross-site request',()=>{
  assert.equal(setupRelease(req('/api/setup/v1/sequence-release?x=1'),env(d)).status,404);
  assert.equal(setupRelease(new Request(req(),{method:'POST',body:'{}'}),env(d)).status,404);
  assert.equal(setupRelease(req('/api/setup/v1/sequence-release',{'Origin':'https://evil.invalid'}),env(d)).status,403);
  assert.equal(setupRelease(req('/api/setup/v1/sequence-release',{'Sec-Fetch-Mode':'navigate'}),env(d)).status,403);
});
// 2026-10-01 (audit C13): the same as the setup profile for a browser that sends no Fetch Metadata (iOS before 16.4).
test('sequence release reaches a browser without Fetch Metadata, and still refuses a present foreign value',async()=>{
  const response=setupRelease(new Request('https://domino.money/api/setup/v1/sequence-release'),env(d));
  assert.equal(response.status,200);assert.deepEqual((await response.json()).deployment,d);
  for(const headers of [{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Mode':'navigate'},{'Sec-Fetch-Dest':'document'},{'Sec-Fetch-User':'?1'},{Origin:'https://evil.invalid'}]){
    assert.equal(setupRelease(new Request('https://domino.money/api/setup/v1/sequence-release',{headers}),env(d)).status,403,JSON.stringify(headers));
  }
});
