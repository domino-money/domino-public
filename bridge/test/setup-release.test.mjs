import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupRelease} from '../src/setup-release.mjs';
const address=n=>'0x'+String(n).repeat(40),hash=n=>'0x'+String(n).repeat(64);
const d={setup:address(1),setupCodeHash:hash(1),poolManager:address(2),poolManagerCodeHash:hash(2),positionManager:address(3),positionManagerCodeHash:hash(3),stateView:address(4),stateViewCodeHash:hash(4),feeRecipient:address(5),feeBps:65,tariffVersion:'1',expiresAt:Math.floor(Date.now()/1000)+1000};
const req=(path='/api/setup/v1/release',headers={})=>new Request('https://domino.money'+path,{headers:{'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty',...headers}});
const env=value=>({SETUP_WALLET_ENABLED:'true',SETUP_DEPLOYMENT_JSON:JSON.stringify(value)});
test('release default is explicitly unavailable, and enabled profile contains public identities only',async()=>{assert.deepEqual(await setupRelease(req(),{}).json(),{contractVersion:'1.0.0-rc.1',chainId:4663,available:false,deployment:null});const r=setupRelease(req(),env(d));assert.equal(r.status,200);assert.deepEqual((await r.json()).deployment,d);assert.equal(r.headers.get('Set-Cookie'),null)});
test('no unknown values, arbitrary destinations, expired tariff or fee above policy cap',()=>{for(const value of [{...d,key:'secret'},{...d,feeBps:66},{...d,expiresAt:1},{...d,setup:address(0)},{...d,setupCodeHash:hash(0)},{...d,tariffVersion:'18446744073709551616'},{...d,positionManagerCodeHash:undefined}])assert.equal(setupRelease(req(),env(value)).status,503)});
test('no cross-site, navigation, query or mutation surface',()=>{assert.equal(setupRelease(req('/api/setup/v1/release',{Origin:'https://evil.invalid'}),env(d)).status,403);assert.equal(setupRelease(req('/api/setup/v1/release?x=1'),env(d)).status,404);assert.equal(setupRelease(new Request(req(),{method:'POST',body:'{}'}),env(d)).status,404)});
// 2026-10-01 (audit C13): Safari and iOS WebViews before 16.4, wallet apps' browsers on those iPhones included, send no
// Fetch Metadata. Their GET gets the profile; a header present with another value is refused as before.
test('a browser without Fetch Metadata gets the profile; a present value other than the page’s fetch is still refused',async()=>{
  const bare=new Request('https://domino.money/api/setup/v1/release');
  assert.equal(bare.headers.get('Sec-Fetch-Site'),null);
  const r=setupRelease(bare,env(d));assert.equal(r.status,200);assert.deepEqual((await r.json()).deployment,d);
  for(const [name,value] of [['Sec-Fetch-Site','cross-site'],['Sec-Fetch-Site','same-site'],['Sec-Fetch-Site','none'],['Sec-Fetch-Mode','navigate'],['Sec-Fetch-Mode','no-cors'],['Sec-Fetch-Dest','document'],['Sec-Fetch-Dest','iframe'],['Sec-Fetch-User','?1']]){
    assert.equal(setupRelease(new Request('https://domino.money/api/setup/v1/release',{headers:{[name]:value}}),env(d)).status,403,`${name}: ${value}`);
  }
  assert.equal(setupRelease(new Request('https://domino.money/api/setup/v1/release',{headers:{Origin:'https://evil.invalid'}}),env(d)).status,403,'the Origin check holds without Fetch Metadata');
  assert.equal(setupRelease(new Request('https://domino.money/api/setup/v1/release',{headers:{Origin:'https://domino.money'}}),env(d)).status,200);
  assert.equal(setupRelease(new Request('https://domino.money/api/setup/v1/release?x=1'),env(d)).status,404);
});
