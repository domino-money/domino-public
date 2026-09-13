// Actual wallet SDK requests against a fresh, local Anvil fixture. No real keys.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const fixture=JSON.parse(readFileSync(0,'utf8'));
const {createSetupClient,deploymentFrom}=await import(pathToFileURL(process.env.DOMINO_SETUP_SDK_MODULE).href);
let now=fixture.now, current=true, rejectOnce=false;
const calls=[];
const rpc=async(method,params=[])=>{
  const response=await fetch(fixture.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const data=await response.json();if(data.error)throw Object.assign(new Error(data.error.message),data.error);return data.result;
};
const claims=new Map();
const wallet={nonceOffered:n=>claims.has(String(n)),claimNonce:async n=>{if(claims.has(String(n)))throw new Error('already_offered');const token=String(n);claims.set(String(n),token);return token},releaseRejectedNonce:async(n,token)=>{if(claims.get(String(n))===token)claims.delete(String(n))},owner:fixture.owner,current:()=>current,request:async(method,params)=>{
  calls.push(method);
  if(rejectOnce&&method==='eth_sendTransaction'){rejectOnce=false;throw Object.assign(new Error('User rejected'),{code:4001});}
  return rpc(method,params);
}};
const deployment=deploymentFrom(fixture.release,now);
let client=createSetupClient(wallet,deployment,()=>now);
const key=fixture.key;
const gas={maxGas:15_000_000n,maxFeePerGas:10_000_000_000n,maxPriorityFeePerGas:1_000_000_000n,reserveWei:100_000_000_000_000n};
async function settle(prepared){
  const hash=await client.send(prepared,true);
  await rpc('anvil_mine',['0x40']);
  now=Number(BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp));
  const receipt=await client.receipt(hash);
  assert.equal(receipt.state,'finalized');
  await assert.rejects(client.send(prepared,true));
  return hash;
}
async function fund(amount0,amount1){
  for(let step=0;step<5;step++){
    const prepared=await client.fund(key,amount0,amount1,gas);
    if(prepared.kind==='approve'){
      assert(prepared.summary.some(s=>s.includes('Exact allowance')||s.includes('Reset')));
      await settle(prepared);continue;
    }
    assert.equal(prepared.kind,'fund');await settle(prepared);return prepared.operationId;
  }
  assert.fail('bounded funding did not finish');
}
const first=await client.fund(key,100_000_000_000_000_000_000n,100_000_000_000_000_000_000n,gas);
await assert.rejects(client.send(first,false),/wallet_review_required/);
await assert.rejects(client.send({...first},true),/wallet_review_required/);
rejectOnce=true;await assert.rejects(client.send(first,true),/User rejected/);
// A definite owner rejection must allow a fresh review with that unchanged nonce.
const id=await fund(100_000_000_000_000_000_000n,100_000_000_000_000_000_000n);
let op=await client.inspect(id);assert.equal(op.closed,false);
const price=2n**96n;
const mint=await client.mint(id,{tickLower:-600,tickUpper:600,liquidity:1_000_000_000_000_000_000n,
  maxAmount0:op.balance0,maxAmount1:op.balance1,minSqrtPriceX96:price/2n,maxSqrtPriceX96:price*2n,initialSqrtPriceX96:price},gas);
assert(mint.summary.some(s=>s.includes('initial relative token price')));
const mintHash=await settle(mint);op=await client.inspect(id);assert.equal(op.closed,true);assert(op.tokenId>0n);
const second=await fund(1_000_000_000_000_000n,0n);
const swap=await client.swap(second,true,100_000_000_000_000n,100,4_295_128_740n,gas);
assert(swap.summary.some(s=>s.includes('650000000000')));await settle(swap);
op=await client.inspect(second);assert.equal(op.swapped,true);assert(op.balance1>0n);assert.equal(op.balance0,900_000_000_000_000n);
const afterSwap={balance0:op.balance0.toString(),balance1:op.balance1.toString()};
// Reload discovers an existing owner operation without replaying the swap.
client=createSetupClient(wallet,deployment,()=>now);
assert((await client.recent()).some(x=>x.id===second&&x.operation.swapped));
const cancel=await client.cancel(second,gas);const cancelHash=await settle(cancel);
op=await client.inspect(second);assert.equal(op.closed,true);assert.equal(op.balance0,0n);assert.equal(op.balance1,0n);
await assert.rejects(client.swap(second,true,1n,0,4_295_128_740n,gas));
// The SDK must not label an unrelated successful transaction a setup receipt.
const unrelated=await rpc('eth_sendTransaction',[{from:fixture.owner,to:fixture.owner,value:'0x0'}]);
await rpc('anvil_mine',['0x40']);now=Number(BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp));
await assert.rejects(client.receipt(unrelated));
current=false;await assert.rejects(client.recent(),/wallet_action_expired|wallet_identity_changed/);
process.stdout.write(JSON.stringify({passed:true,operationId:id,tokenId:op.tokenId.toString(),mintHash,cancelHash,afterSwap,calls:calls.length}));
