// Bounded transfer qualification of live runtime/state in an isolated Anvil fork.
// No signature, private key, live transaction, exemption or authorization override.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {toolsFor,DEPENDENCIES} from '../../scripts/prepare-financial-release.mjs';
const dir=import.meta.dirname,repo=resolve(dir,'../..'),v=toolsFor(repo);
const sourceText=readFileSync(resolve(dir,'TOKEN_READS.json'),'utf8'),evidence=JSON.parse(sourceText);
assert.equal(evidence.status,'completed');assert(evidence.canonicalityRechecked);
const sha=x=>createHash('sha256').update(x).digest('hex');
const render=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function client(endpoint,readonly){let id=0;return async(method,params)=>{
 if(readonly)assert(['eth_chainId','eth_getBlockByNumber','eth_getCode'].includes(method),'upstream write refused');
 const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:render({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(15000)});
 assert(r.ok);const j=await r.json();if(j.error)throw Object.assign(Error(j.error.message),{rpcData:j.error.data});return j.result;
};}
async function ready(rpc){for(let i=0;;i++){try{assert.equal(await rpc('eth_chainId',[]),'0x1237');return;}catch(e){if(i===60)throw e;await delay(150);}}}
const actors={holder:'0x00000000000000000000000000000000000a11ce',vault:'0x000000000000000000000000000000000000b0b1',recipient:'0x000000000000000000000000000000000000cafe',poolManager:DEPENDENCIES.poolManager};
const erc20=v.parseAbi(['function transfer(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)']);
const report={schemaVersion:1,kind:'isolated-live-token-transfer-replay',startedAtUTC:new Date().toISOString(),chainId:4663,sourceBlock:evidence.block,sourceEvidenceSha256:sha(sourceText),mainnetTransactionsSent:false,privateKeysUsed:false,actors,overrides:[],cases:[],limitations:['Synthetic holders and balances isolate transfer semantics; no actual Domino vault or full trading path is executed.','Amounts below one QUOTRON unit avoid ERC404 NFT synchronization boundaries; these tests do not qualify those boundaries.','A successful exact ordinary transfer does not admit a token, pool, hook or router into Domino.']};
let tunnel,anvil,local;
async function balance(token,who){return v.decodeFunctionResult({abi:erc20,functionName:'balanceOf',data:await local('eth_call',[{to:token,data:v.encodeFunctionData({abi:erc20,functionName:'balanceOf',args:[who]})},'latest'])});}
async function case_(token,label,from,to,amount,expectedError){
 const snapshot=await local('evm_snapshot',[]),beforeFrom=await balance(token.address,from),beforeTo=await balance(token.address,to);
 const tx={from,to:token.address,data:v.encodeFunctionData({abi:erc20,functionName:'transfer',args:[to,amount]}),gas:'0x1e8480'};
 const row={token:token.address,label,from,to,amount,beforeFrom,beforeTo};
 try{
  if(expectedError){
   let caught;try{await local('eth_call',[tx,'latest']);}catch(e){caught=e;}
   assert(caught,'expected route rejection');assert.equal(typeof caught.rpcData,'string');
   const error=v.decodeErrorResult({abi:token.abi,data:caught.rpcData});assert.equal(error.errorName,expectedError);
   Object.assign(row,{expectedError,error: error.errorName,revertData:caught.rpcData});
   assert.equal(await balance(token.address,from),beforeFrom);assert.equal(await balance(token.address,to),beforeTo);
  }else{
   await local('anvil_impersonateAccount',[from]);await local('anvil_setBalance',[from,'0x8ac7230489e80000']);
   const hash=await local('eth_sendTransaction',[tx]);let receipt;
   for(let i=0;i<80;i++){receipt=await local('eth_getTransactionReceipt',[hash]);if(receipt)break;await delay(25);}
   assert.equal(receipt?.status,'0x1');
   const afterFrom=await balance(token.address,from),afterTo=await balance(token.address,to);
   assert.equal(beforeFrom-afterFrom,amount);assert.equal(afterTo-beforeTo,amount);
   Object.assign(row,{afterFrom,afterTo,senderDebit:beforeFrom-afterFrom,recipientCredit:afterTo-beforeTo,localReceiptHash:hash,localGasUsed:BigInt(receipt.gasUsed)});
  }
  row.status='passed';report.cases.push(row);
 }finally{assert(await local('evm_revert',[snapshot]));}
}
try{
 const sourcePort=await port(),forkPort=await port();
 tunnel=spawn('ssh',['-N','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${sourcePort}:127.0.0.1:8547`,'domino-host'],{stdio:'ignore'});
 const sourceURL=`http://127.0.0.1:${sourcePort}`,source=client(sourceURL,true);await ready(source);
 const blockTag=v.toHex(evidence.block.number),header=await source('eth_getBlockByNumber',[blockTag,false]);assert.equal(header.hash,evidence.block.hash);
 anvil=spawn(resolve(repo,'node_modules/@foundry-rs/anvil-darwin-arm64/bin/anvil'),['--host','127.0.0.1','--port',String(forkPort),'--chain-id','4663','--hardfork','cancun','--fork-url',sourceURL,'--fork-block-number',String(evidence.block.number),'--silent'],{stdio:'ignore'});
 local=client(`http://127.0.0.1:${forkPort}`,false);await ready(local);
 const quotron=evidence.contracts.find(x=>x.address==='0x5a86828efd322bfb16d93cfed16ee9bc14940d7f');
 const hash=evidence.contracts.find(x=>x.address==='0xca75082b85bb7bec8325d513f615b16bda260020');
 for(const token of [quotron,hash]){
  assert.equal(v.keccak256(await local('eth_getCode',[token.address,'latest'])),token.runtimeCodeHash);
  for(const who of [actors.holder,actors.vault,actors.recipient]){
   assert.equal(await balance(token.address,who),0n);
   const slot=token===quotron?v.keccak256(v.encodeAbiParameters(v.parseAbiParameters('address,uint256'),[who,1n])):v.keccak256(v.concatHex([who,'0x0000000000000000','0x87a211a2']));
   const amount=100_000_000_000_000_000n;
   await local('anvil_setStorageAt',[token.address,slot,v.toHex(amount,{size:32})]);assert.equal(await balance(token.address,who),amount);
   report.overrides.push({scope:'local fork only',token:token.address,account:who,storageSlot:slot,oldBalance:'0',syntheticBalance:amount});
  }
 }
 const amount=10_000_000_000_000_000n;
 await case_(hash,'ordinary holder to simulated vault',actors.holder,actors.vault,amount);
 await case_(hash,'simulated vault to fee recipient',actors.vault,actors.recipient,amount);
 await case_(hash,'simulated vault to PoolManager',actors.vault,actors.poolManager,amount);
 await case_(hash,'PoolManager to simulated vault',actors.poolManager,actors.vault,amount);
 await case_(quotron,'ordinary holder to simulated vault',actors.holder,actors.vault,amount);
 await case_(quotron,'simulated vault to fee recipient',actors.vault,actors.recipient,amount);
 await case_(quotron,'simulated vault to PoolManager without canonical router',actors.vault,actors.poolManager,amount,'NotRouter');
 await case_(quotron,'PoolManager to simulated vault without transient authorization',actors.poolManager,actors.vault,amount,'UnauthorizedPoolSettlement');
 assert.equal((await source('eth_getBlockByNumber',[blockTag,false])).hash,evidence.block.hash);
 report.canonicalityRechecked=true;report.status='passed';
}catch(e){report.status='failed';report.error=String(e.stack);throw e;}
finally{report.finishedAtUTC=new Date().toISOString();report.scriptSha256=sha(readFileSync(import.meta.filename));writeFileSync(resolve(dir,'TOKEN_TRANSFER_REPLAY.json'),render(report));anvil?.kill('SIGTERM');tunnel?.kill('SIGTERM');}
console.log(render({status:report.status,cases:report.cases.map(x=>({token:x.token,label:x.label,status:x.status,error:x.error}))}));
