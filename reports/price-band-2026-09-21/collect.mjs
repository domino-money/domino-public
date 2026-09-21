// Read-only sampling of pool spot movement; no independent price oracle or live publisher.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {toolsFor,DEPENDENCIES} from '../../scripts/prepare-financial-release.mjs';
import {observedBlocks,differsFromCanonical} from './canonicality.mjs';
const repo=resolve(import.meta.dirname,'../..'),v=toolsFor(repo);
const seconds=Number(process.env.DOMINO_BAND_SAMPLE_SECONDS??600),intervalMs=500;
assert(Number.isSafeInteger(seconds)&&seconds>=30&&seconds<=1800);
const out=resolve(import.meta.dirname,'LIVE_SAMPLES.json');
const selected=[...readFileSync(resolve(repo,'backend/selected_pools.py'),'utf8').matchAll(/'0x[0-9a-f]{64}'/g)].map(m=>m[0].slice(1,-1));
const labels=['WETH/USDG','USDG/MARLIN','cbBTC/USDG (catalogue label)','U/USDG (catalogue label)','ETH/USDG (catalogue label)','PONS/USDG (catalogue label)'];
const pools=selected.map((poolId,i)=>({poolId,label:labels[i],selection:'public selected-pool catalogue'}));
pools.push({poolId:'0xbf0fe39ec46400f36455eae199696e1009af2182f62bfb256b559b1f3e11afec',label:'ETH/MARLIN',selection:'historical public discovery candidate'});
const keyAbi=v.parseAbi(['function poolKeys(bytes25) view returns(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)']);
const slotAbi=v.parseAbi(['function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)','function getLiquidity(bytes32) view returns(uint128 liquidity)']);
const keyTypes=v.parseAbiParameters('address,address,uint24,int24,address');
let tunnel,id=0,rpc;
const report={schemaVersion:1,kind:'domino-price-band-readonly-sampling',chainId:4663,startedAtUTC:new Date().toISOString(),requestedSeconds:seconds,intervalMs,source:'project Nitro node, authenticated SSH local tunnel; not production VM/HTTPS route',independentOracle:false,mainnetTransactionsSent:false,collectorSha256:null,pools,samples:[],warnings:['Pool spot-to-spot drift only; not proof of economic safety or independent-price quality.','Observed RPC round trips include this machine and SSH tunnel, not the production publisher environment.','No publisher transaction or live inclusion latency is measured.']};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function save(){const temp=out+'.tmp';writeFileSync(temp,JSON.stringify(report,null,2)+'\n');renameSync(temp,out);}
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
try{
 const port=await freePort();tunnel=spawn('ssh',['-N','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${port}:127.0.0.1:8547`,'domino-host'],{stdio:'ignore'});
 const endpoint=`http://127.0.0.1:${port}`;
 rpc=async(method,params)=>{assert(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call'].includes(method));const n=++id,start=performance.now();const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:n,method,params}),signal:AbortSignal.timeout(5000)});assert(r.ok);const j=await r.json();assert.equal(j.id,n);if(j.error)throw Error(method+':rpc_'+j.error.code);return{value:j.result,latencyMs:performance.now()-start};};
 for(let n=0;;n++){try{assert.equal((await rpc('eth_chainId',[])).value,'0x1237');break;}catch(e){if(n>=80)throw e;await delay(100);}}
 const block=(await rpc('eth_getBlockByNumber',['latest',false])).value,tag={blockHash:block.hash,requireCanonical:true};
 report.identityBlock={number:Number(BigInt(block.number)),hash:block.hash,timestamp:Number(BigInt(block.timestamp))};
 const expected=JSON.parse(readFileSync(resolve(repo,'reports/v4-remediation-2026-09-21/public-deployment.template.json'))).dependencyCodeHashes;
 report.dependencies={};
 for(const [name,address]of Object.entries(DEPENDENCIES)){const code=(await rpc('eth_getCode',[address,tag])).value;const hash=v.keccak256(code);assert.equal(hash,expected[name]);report.dependencies[name]={address,codeHash:hash};await delay(70);}
 for(const pool of pools){
  try{
   const raw=(await rpc('eth_call',[{to:DEPENDENCIES.positionManager,data:v.encodeFunctionData({abi:keyAbi,functionName:'poolKeys',args:[pool.poolId.slice(0,52)]})},tag])).value;
   const key=v.decodeFunctionResult({abi:keyAbi,functionName:'poolKeys',data:raw});assert.equal(v.keccak256(v.encodeAbiParameters(keyTypes,key)),pool.poolId);
   pool.poolKey={currency0:key[0].toLowerCase(),currency1:key[1].toLowerCase(),fee:key[2],tickSpacing:key[3],hooks:key[4].toLowerCase()};pool.poolKeyHashVerified=true;
   const liq=(await rpc('eth_call',[{to:DEPENDENCIES.stateView,data:v.encodeFunctionData({abi:slotAbi,functionName:'getLiquidity',args:[pool.poolId]})},tag])).value;pool.initialLiquidity=v.decodeFunctionResult({abi:slotAbi,functionName:'getLiquidity',data:liq}).toString();
  }catch(e){pool.identityError=String(e.message).slice(0,200);pool.poolKeyHashVerified=false;}
  await delay(130);
 }
 assert(pools.some(p=>p.poolKeyHashVerified));
 const start=performance.now(),end=start+seconds*1000;let next=start,lastProgress=0;
 while(performance.now()<end){
  const sample={observedAtUnixMs:Date.now(),pools:[]},t=performance.now();
  try{
   const header=await rpc('eth_getBlockByNumber',['latest',false]);const b=header.value;sample.observedAtUnixMs=Date.now();sample.blockNumber=Number(BigInt(b.number));sample.blockHash=b.hash;sample.blockTimestamp=Number(BigInt(b.timestamp));sample.headerRpcLatencyMs=header.latencyMs;
   const tag={blockHash:b.hash,requireCanonical:true};
   sample.pools=await Promise.all(pools.map(async p=>{
    if(!p.poolKeyHashVerified)return{poolId:p.poolId,error:'pool_identity_unqualified'};
    try{const call=await rpc('eth_call',[{to:DEPENDENCIES.stateView,data:v.encodeFunctionData({abi:slotAbi,functionName:'getSlot0',args:[p.poolId]})},tag]);const [sqrt,tick,protocolFee,lpFee]=v.decodeFunctionResult({abi:slotAbi,functionName:'getSlot0',data:call.value});assert(sqrt>0n);return{poolId:p.poolId,sqrtPriceX96:sqrt.toString(),tick,protocolFee,lpFee,rpcLatencyMs:call.latencyMs};}catch(e){return{poolId:p.poolId,error:String(e.message).slice(0,180)};}
   }));
  }catch(e){sample.error=String(e.message).slice(0,180);}
  sample.rpcLatencyMs=performance.now()-t;sample.completedAtUnixMs=Date.now();report.samples.push(sample);
  if(report.samples.length%20===0)save();
  const elapsed=performance.now()-start;if(elapsed-lastProgress>=30000){console.log(JSON.stringify({elapsedSeconds:Math.round(elapsed/1000),samples:report.samples.length,latestBlock:sample.blockNumber,failedPools:sample.pools.filter(p=>p.error).length}));lastProgress=elapsed;}
  next+=intervalMs;if(next<performance.now())next=performance.now();await delay(Math.max(0,next-performance.now()));
 }
 report.status='completed';report.endedAtUTC=new Date().toISOString();report.rpcCalls=id;report.observedDurationMs=report.samples.at(-1).observedAtUnixMs-report.samples[0].observedAtUnixMs;
 const observed=observedBlocks(report.samples);report.canonicalityCheckedBlocks=0;report.noncanonicalBlocks=[];
 report.conflictingObservedHeights=observed.filter(b=>b.hashes.length>1).map(b=>b.number);
 for(const block of observed){const b=(await rpc('eth_getBlockByNumber',['0x'+block.number.toString(16),false])).value;if(differsFromCanonical(block,b))report.noncanonicalBlocks.push(block.number);report.canonicalityCheckedBlocks++;await delay(60);}
 report.rpcCalls=id;report.canonicalityCompletedAtUTC=new Date().toISOString();
 if(report.noncanonicalBlocks.length)report.status='noncanonical_samples_detected';
}catch(e){report.status='failed';report.error=String(e.stack);throw e;}finally{const{createHash}=await import('node:crypto');report.collectorSha256=createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex');save();tunnel?.kill('SIGTERM');}
console.log(JSON.stringify({status:report.status,samples:report.samples.length,pools:report.pools.length,verifiedPools:report.pools.filter(p=>p.poolKeyHashVerified).length,canonicalityCheckedBlocks:report.canonicalityCheckedBlocks,noncanonicalBlocks:report.noncanonicalBlocks,out}));
