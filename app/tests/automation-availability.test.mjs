import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as runtime from '../../api-contracts/execution-v1/runtime.mjs';
const require = createRequire(import.meta.url);
const { automationAvailable } = require('../.test-build/app/src/finance/automationAvailability.js');
const owner = '0x' + 'aa'.repeat(20), vault = '0x' + '56'.repeat(20);
const body = { contractVersion:'1.0.0-rc.1', chainId:4663, owner, vault,
  operational:true, checkedAtEpoch:100, expiresAtEpoch:110 };
function harness(reply = body, { status = 200, contract = '1.0.0-rc.1' } = {}) {
  let identity = { kind:'signed_in', owner, chainId:4663, epoch:1, connectorUid:'one' };
  const calls = [], denials = [];
  const port = { csrfAccess:true, getSnapshot:()=>identity, withCsrf:async (_epoch,fn)=>fn('private-csrf'),
    reportDenial:(code,epoch)=>denials.push({code,epoch}) };
  const fetcher = async (url,init) => { calls.push({url,init}); return new Response(JSON.stringify(reply),
    {status,headers:{'X-Domino-Execution-Contract':contract}}); };
  return { port, fetcher, calls, denials, identity:next=>{identity=next} };
}
test('fresh matching owner and vault heartbeat offers only a review', async()=>{
  const h=harness();
  assert.equal(await automationAvailable(owner,vault,h.port,h.fetcher,runtime,()=>100_000),true);
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].url,'/api/execution/v1/availability');
  assert.deepEqual(JSON.parse(h.calls[0].init.body),{vault});
  assert.equal(h.calls[0].init.headers['X-Domino-CSRF'],'private-csrf');
});
test('off, stale, foreign, missing session and changed session all fail closed',async()=>{
  for(const value of [{...body,operational:false},{...body,checkedAtEpoch:90,expiresAtEpoch:100},
    {...body,owner:'0x'+'bb'.repeat(20)},{...body,vault:'0x'+'77'.repeat(20)},
    {...body,expiresAtEpoch:111},{...body,privateKey:'redacted'}]) {
    const h=harness(value);
    assert.equal(await automationAvailable(owner,vault,h.port,h.fetcher,runtime,()=>100_000),false);
  }
  const h=harness();
  h.identity({kind:'signed_out'});
  assert.equal(await automationAvailable(owner,vault,h.port,h.fetcher,runtime,()=>100_000),false);
  assert.equal(h.calls.length,0);
  const changed=harness();
  const original=changed.fetcher;
  changed.fetcher=async (...args)=>{changed.identity({kind:'signed_out'});return original(...args)};
  assert.equal(await automationAvailable(owner,vault,changed.port,changed.fetcher,runtime,()=>100_000),false);
});
test('authenticated 401/403 denial rechecks or closes only the signed-in session epoch',async()=>{
  for(const [status,code] of [[401,'session_required'],[403,'csrf_invalid'],[403,'account_unsupported']]) {
    const h=harness({error:code},{status});
    assert.equal(await automationAvailable(owner,vault,h.port,h.fetcher,runtime,()=>100_000),false);
    assert.deepEqual(h.denials,[{code,epoch:1}]);
  }
  for(const h of [harness({error:'session_required'},{status:401,contract:'wrong'}),
    harness({error:'csrf_invalid'},{status:401}),harness({error:'origin_not_allowed'},{status:403}),
    harness({error:'session_required',extra:true},{status:401})]) {
    assert.equal(await automationAvailable(owner,vault,h.port,h.fetcher,runtime,()=>100_000),false);
    assert.deepEqual(h.denials,[]);
  }
});
