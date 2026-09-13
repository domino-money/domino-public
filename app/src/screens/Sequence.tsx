import { useEffect, useRef, useState } from 'react'
import { watchConnection } from 'wagmi/actions'
import { type Address, type Hex } from 'viem'
import { walletConfig } from '../wallet/config'
import { setupWallet } from '../finance/wallet'
import { financialFetch } from '../finance/http'
import { createSequenceClient, sequenceDeploymentFrom, sequenceRaw, type PreparedSequence, type SequenceDeployment, type SequenceState } from '../finance/sequence'
import { Button, Card, Display } from '../components/ui'

const empty = { root: '', trigger: '', overlap: '', interval: '', positions: '', upside: '', slippage: '', impact: '', executionGas: '', age: '', horizon: '',
  maxGas: '', maxFee: '', priority: '', reserve: '', vault: '', member: '', original: '', charged: '' }
const labels: Record<keyof typeof empty,string> = {
  root:'Root NFT ID',trigger:'Distance to range ceiling (basis points)',overlap:'Maximum successor overlap (basis points)',interval:'Minimum execution interval (seconds)',
  positions:'Maximum positions, including root',upside:'Successor upside (basis points)',slippage:'Maximum swap slippage (basis points)',impact:'Maximum price impact (basis points)',
  executionGas:'Maximum execution gas cost (wei)',age:'Maximum observation age (seconds)',horizon:'Forecast horizon (seconds)',
  maxGas:'Maximum wallet gas units',maxFee:'Maximum fee per gas (wei)',priority:'Maximum priority fee per gas (wei)',reserve:'Keep native gas reserve (wei)',
  vault:'Sequence address',member:'Root or child NFT ID',original:'Original fee amount (smallest units)',charged:'Already charged fee amount (smallest units)',
}
type Client = ReturnType<typeof createSequenceClient>
type Root = Awaited<ReturnType<Client['inspectRoot']>>
type Reserves = Awaited<ReturnType<Client['reserves']>>
const cacheKey = 'domino.sequence.public-recovery.v1'

async function currentSequenceDeployment():Promise<SequenceDeployment|null> {
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),10_000)
  try {
    const response=await financialFetch('/api/setup/v1/sequence-release',{signal:controller.signal,cache:'no-store',redirect:'error',headers:{'X-Domino-Setup-Contract':'1.0.0-rc.1'}})
    if(!response.ok||response.headers.get('X-Domino-Setup-Contract')!=='1.0.0-rc.1'||!response.body)throw new Error('sequence_release_unavailable')
    const reader=response.body.getReader(), chunks:Uint8Array[]=[];let size=0
    while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>8192){await reader.cancel();throw new Error('invalid_sequence_release')}chunks.push(chunk.value)}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
    return sequenceDeploymentFrom(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))
  } finally {clearTimeout(timer)}
}

/** Owner controls use the wallet directly. A wallet connection is deliberately
 * separate from a private Domino session and from executor availability. */
export default function Sequence() {
  const [form,setForm] = useState(empty), [client,setClient] = useState<Client|null>(null), [recovery,setRecovery] = useState(false)
  const [recent,setRecent] = useState<Awaited<ReturnType<Client['recent']>>>([]), [state,setState] = useState<SequenceState|null>(null)
  const [root,setRoot] = useState<Root|null>(null), [reserves,setReserves] = useState<Reserves|null>(null), [balanceIndex,setBalanceIndex] = useState(0)
  const [base0,setBase0] = useState(true), [consent,setConsent] = useState(false), [prepared,setPrepared] = useState<PreparedSequence|null>(null)
  const [ack,setAck] = useState(false), [hash,setHash] = useState<Hex|null>(null), [busy,setBusy] = useState(false), [notice,setNotice] = useState<string|null>(null)
  const generation = useRef(0), connection = useRef(0), running = useRef(false)
  useEffect(() => watchConnection(walletConfig,{onChange:()=>{
    generation.current++; connection.current++; running.current=false; setBusy(false); setClient(null); setRecent([]); setState(null); setRoot(null); setReserves(null)
    setPrepared(null); setHash(null); setAck(false); setConsent(false); setForm(empty); setNotice(null)
  }}),[])
  useEffect(()=>()=>{generation.current++;connection.current++},[])
  function edit(name:keyof typeof empty,value:string) {
    generation.current++; setForm(old=>({...old,[name]:value})); setPrepared(null); setAck(false)
    if(name==='root') {setRoot(null);setConsent(false)}
    if(name==='vault') {setState(null);setReserves(null)}
    if(name==='member') setReserves(null)
  }
  async function action(work:()=>Promise<void>) {
    if(running.current)return
    running.current=true;setBusy(true);setNotice(null);setPrepared(null);setAck(false)
    const gen=generation.current
    try {await work()} catch(error) {if(generation.current===gen)setNotice(error instanceof Error && /^[a-z_]+$/.test(error.message)?error.message.replaceAll('_',' '):'The wallet read or simulation could not be completed. No new transaction was sent.')}
    finally {if(generation.current===gen){running.current=false;setBusy(false)}}
  }
  async function connect() {
    const gen=generation.current
    let d:SequenceDeployment|null=null, saved=false
    try {d=await currentSequenceDeployment()} catch { /* Previously verified public identities can recover existing assets. */ }
    if(!d)try {const raw=localStorage.getItem(cacheKey);if(raw&&raw.length<=8192){const old=sequenceDeploymentFrom(JSON.parse(raw),0);if(old){d={...old,expiresAt:0};saved=true}}}catch{ /* Cache is optional; it never contains owner data or a key. */ }
    if(generation.current!==gen)return
    if(!d){setNotice('Sequence creation is not available on this deployment yet. No approval or transaction was requested.');return}
    const wallet=await setupWallet(), epoch=++connection.current
    const next=createSequenceClient({...wallet,current:()=>wallet.current()&&connection.current===epoch},d,()=>Date.now()/1000,currentSequenceDeployment)
    const rows=await next.recent()
    if(generation.current!==gen||!wallet.current())return
    if(!saved)try{localStorage.setItem(cacheKey,JSON.stringify({contractVersion:'1.0.0-rc.1',chainId:4663,available:true,deployment:d}))}catch{ /* Recovery still works while this verified profile is loaded. */ }
    setClient(next);setRecent(rows);setRecovery(saved);setState(null);setReserves(null);setRoot(null);setHash(null)
    setNotice(saved?'Recovery mode. Previously saved deployment identities were checked on chain. New approvals and sequence creation are disabled.':'Deployment verified through your wallet. Create a paused sequence or manage one you own.')
  }
  const gas=()=>({maxGas:sequenceRaw(form.maxGas,64),maxFeePerGas:sequenceRaw(form.maxFee),maxPriorityFeePerGas:sequenceRaw(form.priority),reserveWei:sequenceRaw(form.reserve,256)})
  const integer=(value:string)=>{const n=sequenceRaw(value,32);return Number(n)}
  const vault=()=>form.vault.toLowerCase() as Address
  async function inspect(address=vault()) {
    if(!client)return;const gen=generation.current, value=await client.inspect(address)
    if(generation.current===gen){setState(value);setForm(old=>({...old,vault:address,member:value.rootTokenId.toString()}));setReserves(null)}
  }
  async function create() {
    if(!client||!root||recovery)return;const gen=generation.current
    const value=await client.create({rootTokenId:sequenceRaw(form.root,256),baseIsCurrency0:base0,consentToUncollectedFees:consent,
      triggerDistanceBps:integer(form.trigger),maxOverlapBps:integer(form.overlap),minimumIntervalSeconds:integer(form.interval),maxPositions:integer(form.positions),
      upsideBps:integer(form.upside),maxSlippageBps:integer(form.slippage),maxPriceImpactBps:integer(form.impact),maxGasCostWei:sequenceRaw(form.executionGas),
      maxObservationAgeSeconds:integer(form.age),forecastHorizonSeconds:integer(form.horizon)},gas())
    if(generation.current===gen)setPrepared(value)
  }
  async function recover(kind:'pause'|'revoke-operator'|'revoke-root'|'withdraw-child'|'withdraw-fees') {
    if(!client||!state)return;const gen=generation.current,balance=reserves?.balances[balanceIndex]
    const values=kind==='withdraw-child'?{tokenId:sequenceRaw(form.member,256)}:kind==='withdraw-fees'?{sourceId:balance?.sourceId,currency:balance?.currency,original:sequenceRaw(form.original),charged:sequenceRaw(form.charged)}:{}
    const value=await client.recover(state.vault,kind,gas(),values)
    if(generation.current===gen)setPrepared(value)
  }
  async function send() {
    if(!client||!prepared||!ack||running.current)return
    const step=prepared,gen=generation.current
    running.current=true;setBusy(true);setPrepared(null);setAck(false);setHash(null)
    try {const result=await client.send(step,true);if(generation.current===gen){setHash(result);setForm(old=>({...old,vault:step.vault}));setNotice('Offered to your wallet once. Check the canonical receipt, then read the position or sequence again before the next step.')}}
    catch(error){if(generation.current===gen){
      const beforeWallet=error instanceof Error&&['review_required','sequence_admission_unavailable','sequence_release_expired','sequence_preparation_changed','sequence_activation_unavailable','sequence_tariff_changed','deployment_code_changed','deployment_identity_changed','root_approval_changed'].includes(error.message)
      setNotice(beforeWallet?'The preparation is no longer valid. No wallet transaction was requested. Reload the deployment or sequence, then prepare and review again.':error&&typeof error==='object'&&(error as {code?:unknown}).code===4001?'Wallet request rejected. Prepare and review again if you want to continue.':'The wallet outcome may be unknown. Check wallet activity and chain state. This nonce remains protected against another offer, including after reload.')
    }}
    finally {if(generation.current===gen){running.current=false;setBusy(false)}}
  }
  const fields=(names:(keyof typeof empty)[]) => <div className="dm-acct-fields dm-acct-fields--3">{names.map(name=><label className="dm-label dm-acct-lf" key={name}>{labels[name]}<input disabled={busy} className="dm-field dm-acct-mono-field" value={form[name]} onChange={e=>edit(name,e.target.value)} autoComplete="off" /></label>)}</div>
  return <main className="dm-page dm-page--narrow">
    <Display as="h1" className="dm-display-title">Your sequences</Display>
    <p className="dm-acct-lede">Keep your root NFT in your wallet while a dedicated sequence manages earned fees and child positions. Creating a sequence starts it paused. Each wallet transaction has its own review.</p>
    <Card className="dm-acct-block dm-acct-panel"><h2 className="dm-acct-panel-title">Wallet and deployment</h2><p className="dm-acct-panel-note">Use a connected Robinhood Chain wallet. Owner recovery works without a Domino sign-in or a running executor.</p>
      <Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(connect)}}>Load deployment and my sequences</Button>
      {notice&&<p role="status" className="dm-inset dm-acct-notice dm-acct-wrap">{notice}</p>}
      {client&&<p className="dm-acct-hash">Factory {client.deployment.factory} · {recovery?'Recovery only':'Verified deployment'} · 2% on earned fees consumed for reinvestment, once. No fee on principal.</p>}
    </Card>
    {client&&<>
      <Card className="dm-acct-block dm-acct-panel"><h2 className="dm-acct-panel-title">Network budget</h2><p className="dm-acct-panel-note">Set explicit limits for each approval, creation or owner action. These are wallet transaction limits; the sequence execution cap is configured separately.</p>{fields(['maxGas','maxFee','priority','reserve'])}</Card>
      {!recovery&&<Card className="dm-acct-block dm-acct-panel"><h2 className="dm-acct-panel-title">Create a paused sequence</h2>{fields(['root'])}
        <Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(async()=>{const gen=generation.current,result=await client.inspectRoot(sequenceRaw(form.root,256));if(generation.current===gen){setRoot(result);setConsent(false)}})}}>Read my root NFT</Button>
        {root&&<><p className="dm-acct-line dm-acct-wrap">Pool {root.poolId} · ticks {root.lower} to {root.upper}. Currency 0: {root.key.currency0}. Currency 1: {root.key.currency1}. The zero address denotes native currency.</p>
          <label className="dm-label dm-acct-lf">Price orientation<select disabled={busy} className="dm-field" value={base0?'0':'1'} onChange={e=>{generation.current++;setBase0(e.target.value==='0');setPrepared(null);setAck(false)}}><option value="0">Currency 0 is base; currency 1 is quote</option><option value="1">Currency 1 is base; currency 0 is quote</option></select></label>
          <details className="dm-details dm-acct-disclosure" open><summary>Choose sequence limits</summary><div className="dm-acct-disclosure-body"><p className="dm-acct-panel-note">One basis point is 0.01%. Trigger distance and overlap each allow 0–2,000 bps. These choices define bounded automation authority; creation does not activate it.</p>{fields(['trigger','overlap','interval','positions','upside','slippage','impact','executionGas','age','horizon'])}</div></details>
          <label className="dm-acct-check"><input type="checkbox" disabled={busy} checked={consent} onChange={e=>{generation.current++;setConsent(e.target.checked);setPrepared(null);setAck(false)}}/><span>I consent to using already uncollected fees from this NFT, plus future earned fees, for reinvestment under these limits. The service fee is 2% of earned fees actually consumed, once, never principal.</span></label>
          <Button className="justify-self-start" disabled={busy||!consent} onClick={()=>{void action(create)}}>Prepare approval or paused creation</Button>
          <p className="dm-acct-panel-note">First approve this NFT to its predicted sequence address. After its receipt is confirmed, prepare again to create the sequence. No approval for all NFTs is requested.</p>
        </>}
      </Card>}
      <Card className="dm-acct-block dm-acct-panel"><h2 className="dm-acct-panel-title">Owner controls</h2><p className="dm-acct-panel-note">Pause, revoke permissions or recover assets directly through your wallet. These controls remain available when Domino services are off. Withdrawals have no Domino service fee.</p>
        <div className="dm-acct-choices">{recent.map(row=><Button key={row.vault} variant="outline" size="sm" disabled={busy} onClick={()=>{void action(()=>inspect(row.vault))}}>Sequence {row.ownerNonce.toString()} · {row.vault.slice(0,10)}</Button>)}</div>
        {fields(['vault'])}<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(()=>inspect())}}>Read owned sequence</Button>
        {state&&<><p className="dm-acct-line dm-acct-wrap">Root NFT #{state.rootTokenId.toString()} · {state.paused?'Paused':'Active'} · {state.operator==='0x0000000000000000000000000000000000000000'?'Operator revoked':`Operator ${state.operator}`} · root permission {state.rootPermissionValid?'valid':'unavailable'}.</p>
          <div className="dm-acct-choices">{!recovery&&state.paused&&<Button disabled={busy||!state.rootPermissionValid||state.operator!==client.deployment.operator} onClick={()=>{void action(async()=>{const gen=generation.current,result=await client.resume(state.vault,gas());if(generation.current===gen)setPrepared(result)})}}>Review activation</Button>}<Button variant="outline" disabled={busy||state.paused} onClick={()=>{void action(()=>recover('pause'))}}>Review pause</Button><Button variant="outline" disabled={busy||state.operator==='0x0000000000000000000000000000000000000000'} onClick={()=>{void action(()=>recover('revoke-operator'))}}>Review operator revocation</Button><Button variant="outline" disabled={busy} onClick={()=>{void action(()=>recover('revoke-root'))}}>Review root NFT approval revocation</Button></div>
          <details className="dm-details dm-acct-disclosure"><summary>Child positions and fee reserves</summary><div className="dm-acct-disclosure-body">{fields(['member'])}<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(async()=>{const gen=generation.current,result=await client.reserves(state.vault,sequenceRaw(form.member,256));if(generation.current===gen){setReserves(result);setBalanceIndex(0)}})}}>Read position and earned-fee reserves</Button>
            {reserves&&<><p className="dm-acct-line">NFT #{reserves.tokenId.toString()} · {reserves.isRoot?'Root':'Child'} · {reserves.active?'registered':'withdrawn'}. {reserves.successor>0n?`Successor NFT #${reserves.successor}.`:'No successor registered.'}</p>
              {reserves.successor>0n&&<Button className="justify-self-start" variant="outline" size="sm" disabled={busy} onClick={()=>edit('member',reserves.successor.toString())}>Select successor</Button>}
              {!reserves.isRoot&&reserves.active&&<Button className="justify-self-start" variant="outline" size="sm" disabled={busy} onClick={()=>{void action(()=>recover('withdraw-child'))}}>Review child NFT withdrawal</Button>}
              <label className="dm-label dm-acct-lf">Fee source and currency<select disabled={busy} className="dm-field" value={balanceIndex} onChange={e=>{generation.current++;setBalanceIndex(Number(e.target.value));setPrepared(null);setAck(false)}}>{reserves.balances.map((b,i)=><option key={`${b.sourceId}:${b.currency}`} value={i}>{b.currency} · source {b.sourceId.slice(0,12)}</option>)}</select></label>
              <p className="dm-acct-line dm-acct-wrap">Source {reserves.balances[balanceIndex].sourceId}. Available: {reserves.balances[balanceIndex].original.toString()} original + {reserves.balances[balanceIndex].charged.toString()} already charged smallest units. These are earned-fee reserves, not NFT principal.</p>
              {fields(['original','charged'])}<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(()=>recover('withdraw-fees'))}}>Review fee reserve withdrawal</Button>
            </>}
          </div></details>
        </>}
      </Card>
      {prepared&&<Card className="dm-acct-block dm-acct-panel" role="region" aria-label="Sequence wallet review"><h2 className="dm-acct-panel-title">Review {prepared.kind.replaceAll('-',' ')}</h2>{prepared.summary.map(line=><p key={line} className="dm-acct-line dm-acct-wrap">{line}</p>)}<label className="dm-acct-check"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/><span>I reviewed the NFT, owner, sequence address, currencies, fees and limits for this single step.</span></label><Button className="justify-self-start" variant="accent" disabled={busy||!ack} onClick={()=>{void send()}}>Send this step in wallet</Button></Card>}
      {hash&&<Card className="dm-acct-block dm-acct-panel"><h2 className="dm-acct-panel-title">Transaction receipt</h2><p className="dm-acct-hash">{hash}</p><Button variant="outline" className="justify-self-start" disabled={busy} onClick={()=>{void action(async()=>{const gen=generation.current,result=await client.receipt(hash);if(generation.current===gen)setNotice(`Receipt: ${result.state}. ${result.state==='finalized'?'Read the root or owned sequence again before continuing.':'Check again explicitly when the chain has progressed. No transaction is retried.'}`)})}}>Check canonical receipt</Button></Card>}
    </>}
  </main>
}
