// Read-only, own-node qualification. No signer, private configuration or writes to chain.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { toolsFor, DEPENDENCIES } from '../../scripts/prepare-financial-release.mjs';
const folder=import.meta.dirname, v=toolsFor(resolve(folder,'../..'));
const tokens=['0x5a86828efd322bfb16d93cfed16ee9bc14940d7f','0xca75082b85bb7bec8325d513f615b16bda260020'];
const sha=x=>createHash('sha256').update(x).digest('hex');
const render=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const tunnel=spawn('ssh',['-N','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${port}:127.0.0.1:8547`,'domino-host'],{stdio:'ignore'});
let seq=0,tag;
async function rpc(method,params){
 assert(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_call'].includes(method));
 const response=await fetch(`http://127.0.0.1:${port}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method,params}),signal:AbortSignal.timeout(10000)});
 assert(response.ok);const x=await response.json();if(x.error)throw Object.assign(Error('rpc_'+x.error.code),{data:x.error.data});await wait(150);return x.result;
}
async function source(address){
 const url=`https://sourcify.dev/server/v2/contract/4663/${address}?fields=all`;
 const response=await fetch(url,{signal:AbortSignal.timeout(30000)});assert(response.ok,'source unavailable '+response.status);
 const raw=await response.text(),x=JSON.parse(raw);assert(x.runtimeMatch,'source runtime not matched');
 const code=await rpc('eth_getCode',[address,tag]);assert.equal(code.toLowerCase(),x.runtimeBytecode.onchainBytecode.toLowerCase(),'runtime/source package mismatch');
 return {address,sourceURL:url,sourcePackageSha256:sha(raw),runtimeMatch:x.runtimeMatch,creationMatch:x.creationMatch,verifiedAt:x.verifiedAt,compilation:x.compilation,proxyResolution:x.proxyResolution,runtimeCodeHash:v.keccak256(code),runtimeCodeBytes:(code.length-2)/2,abi:x.abi,sources:x.sources,storageLayout:x.storageLayout,reads:{}};
}
async function read(contract,name,args=[]){
 const method=contract.abi.find(x=>x.type==='function'&&x.name===name&&x.inputs.length===args.length);assert(method&&['pure','view'].includes(method.stateMutability));
 const data=v.encodeFunctionData({abi:[method],functionName:name,args});
 try{const raw=await rpc('eth_call',[{to:contract.address,data},tag]);const value=v.decodeFunctionResult({abi:[method],functionName:name,data:raw});contract.reads[name+(args.length?'('+args.join(',')+')':'')]={value,raw};return value;}
 catch(e){contract.reads[name+(args.length?'('+args.join(',')+')':'')]={error:String(e.message),revertData:e.data??null};return null;}
}
const report={schemaVersion:1,chainId:4663,startedAtUTC:new Date().toISOString(),readOnly:true,mainnetTransactionsSent:false,source:'project node through authenticated SSH and host loopback',contracts:[],limitations:['Source matches and bounded state reads do not constitute a full token/hook audit or approve automation.','The price-band parameter is separate from transfer and trading fees.']};
try{
 for(let i=0;;i++){try{assert.equal(await rpc('eth_chainId',[]),'0x1237');break;}catch(e){if(i>=60)throw e;await wait(100);}}
 const header=await rpc('eth_getBlockByNumber',['finalized',false]);tag={blockHash:header.hash,requireCanonical:true};report.block={number:Number(BigInt(header.number)),hash:header.hash,timestamp:Number(BigInt(header.timestamp)),selection:'finalized'};
 for(const address of tokens){
  const contract=await source(address);report.contracts.push(contract);
  for(const name of ['name','symbol','decimals','poolManager','floorHook','canonicalRouter','paused','transfersLocked','owner','ROYALTY_BPS','royaltyReceiver','launchedAt','totalSupply','minterCount'])if(contract.abi.some(x=>x.type==='function'&&x.name===name&&x.inputs.length===0))await read(contract,name);
  if(contract.reads.floorHook?.value){
   const hook=await source(contract.reads.floorHook.value.toLowerCase());report.contracts.push(hook);
   for(const method of hook.abi.filter(x=>x.type==='function'&&['pure','view'].includes(x.stateMutability)&&x.inputs.length===0))await read(hook,method.name);
   const account='0x00000000000000000000000000000000000a11ce';
   for(const name of ['currentFeeBps','isTransferRestricted','markedUntil'])await read(hook,name,[account]);
   for(const name of ['setupAllowed','erc721TransferExempt','blacklisted'])if(contract.abi.some(x=>x.type==='function'&&x.name===name))await read(contract,name,[account]);
   const poolId=hook.reads.registeredPool.value;
   const keys=v.parseAbi(['function poolKeys(bytes25) view returns(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)']);
   const raw=await rpc('eth_call',[{to:DEPENDENCIES.positionManager,data:v.encodeFunctionData({abi:keys,functionName:'poolKeys',args:[poolId.slice(0,52)]})},tag]);
   const key=v.decodeFunctionResult({abi:keys,functionName:'poolKeys',data:raw});
   assert.equal(v.keccak256(v.encodeAbiParameters(v.parseAbiParameters('address,address,uint24,int24,address'),key)),poolId);
   const slots=v.parseAbi(['function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)']);
   const slotRaw=await rpc('eth_call',[{to:DEPENDENCIES.stateView,data:v.encodeFunctionData({abi:slots,functionName:'getSlot0',args:[poolId]})},tag]);
   const slot=v.decodeFunctionResult({abi:slots,functionName:'getSlot0',data:slotRaw});
   report.quotronPool={poolId,poolKey:{currency0:key[0],currency1:key[1],fee:key[2],tickSpacing:key[3],hooks:key[4]},poolKeyHashVerified:true,slot0:{sqrtPriceX96:slot[0],tick:slot[1],protocolFee:slot[2],lpFee:slot[3]}};
  }
 }
 assert.equal((await rpc('eth_getBlockByNumber',[header.number,false])).hash,header.hash);report.canonicalityRechecked=true;report.status='completed';
}catch(e){report.status='failed';report.error=String(e.message);throw e;}
finally{report.finishedAtUTC=new Date().toISOString();report.scriptSha256=sha(readFileSync(import.meta.filename));writeFileSync(resolve(folder,'TOKEN_READS.json'),render(report));tunnel.kill('SIGTERM');}
console.log(render({status:report.status,block:report.block,contracts:report.contracts.map(c=>({address:c.address,name:c.compilation.name,codeHash:c.runtimeCodeHash,reads:c.reads}))}));
