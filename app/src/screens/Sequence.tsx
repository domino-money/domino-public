import { useEffect, useRef, useState } from 'react'
import { getConnection, watchConnection } from 'wagmi/actions'
import { type Address, type Hex } from 'viem'
import { walletConfig } from '../wallet/config'
import { setupWallet } from '../finance/wallet'
import { suggestGasBudget } from '../finance/gas'
import type { GasBudget } from '../finance/setup'
import { readRelease, type ReleaseRead } from '../finance/release'
import { AUTOMATION_FEE_BPS, createSequenceClient, sequenceDeploymentFrom, sequenceRaw, type AutomationMode, type PreparedSequence, type SequenceDeployment, type SequenceState } from '../finance/sequence'
import { RECEIPT_TEXT, SEQUENCE_STEP_TEXT, errorCode, financeErrorText } from '../finance/words'
import { AUTOMATION_SERVICE } from '../lib/capabilities'
import { Button, Card, Display } from '../components/ui'
import { hashParts } from '../components/explore/routes'
import { sequenceIntent } from '../lib/create/sequenceDefaults'
import SequenceCreate from './SequenceCreate'

const empty = { root: '', trigger: '', overlap: '', interval: '', positions: '', upside: '', slippage: '', impact: '', executionGas: '', age: '', horizon: '',
  maxGas: '', maxFee: '', priority: '', reserve: '', vault: '', member: '', original: '', charged: '', recoverAmount: '' }
const labels: Record<keyof typeof empty,string> = {
  root:'Root NFT ID',trigger:'Distance to range ceiling (basis points)',overlap:'Maximum successor overlap (basis points)',interval:'Minimum execution interval (seconds)',
  positions:'Maximum positions, including root',upside:'Successor upside (basis points)',slippage:'Maximum swap slippage (basis points)',impact:'Maximum price impact (basis points)',
  executionGas:'Maximum execution gas cost (wei)',age:'Maximum observation age (seconds)',horizon:'Forecast horizon (seconds)',
  maxGas:'Maximum wallet gas units',maxFee:'Maximum fee per gas (wei)',priority:'Maximum priority fee per gas (wei)',reserve:'Keep native gas reserve (wei)',
  vault:'Sequence address',member:'Root or child NFT ID',original:'Original fee amount (smallest units)',charged:'Already charged fee amount (smallest units)',recoverAmount:'Amount to return (smallest units)',
}
type Client = ReturnType<typeof createSequenceClient>
type Root = Awaited<ReturnType<Client['inspectRoot']>>
type Reserves = Awaited<ReturnType<Client['reserves']>>
type Release = { kind: 'loading' } | ReleaseRead<SequenceDeployment>
type Notice = { text: string; code: string | null }
const cacheKey = 'domino.sequence.public-recovery.v1'
const readSequenceRelease = () => readRelease('/api/setup/v1/sequence-release', value => sequenceDeploymentFrom(value))
/** For a loaded client: the published profile now, or null when it is no longer published. */
const currentSequenceDeployment = async (): Promise<SequenceDeployment | null> => { const release = await readSequenceRelease(); return release.kind === 'available' ? release.deployment : null }
/** Identities this browser saved after verifying them, for recovery when none are published. */
function savedProfile(): SequenceDeployment | null {
  try { const raw = localStorage.getItem(cacheKey); if (raw && raw.length <= 8192) { const old = sequenceDeploymentFrom(JSON.parse(raw), 0); if (old) return { ...old, expiresAt: 0 } } } catch { /* Cache is optional; it never contains owner data or a key. */ }
  return null
}

/** Owner controls use the wallet directly. A wallet connection is deliberately
 * separate from a private Domino session and from executor availability. The
 * public release profile is read once on mount; without one, creation stays
 * hidden and only the owner controls of a saved profile remain. With neither,
 * there are no controls to offer, and the page says so in one plain line. */
export default function Sequence() {
  const [release,setRelease] = useState<Release>({kind:'loading'}), [saved] = useState(savedProfile)
  const [form,setForm] = useState(empty), [client,setClient] = useState<Client|null>(null), [recovery,setRecovery] = useState(false)
  const [recent,setRecent] = useState<Awaited<ReturnType<Client['recent']>>>([]), [state,setState] = useState<SequenceState|null>(null)
  const [root,setRoot] = useState<Root|null>(null), [reserves,setReserves] = useState<Reserves|null>(null), [balanceIndex,setBalanceIndex] = useState(0)
  // Which currency the untracked-balance recovery is about: the sequence's own two, or native.
  const [recoverCurrency,setRecoverCurrency] = useState<`0x${string}`>('0x0000000000000000000000000000000000000000')
  const [base0,setBase0] = useState(true), [consent,setConsent] = useState(false), [prepared,setPrepared] = useState<PreparedSequence|null>(null)
  const [createMode,setCreateMode] = useState<AutomationMode>('compound'), [policyMode,setPolicyMode] = useState<AutomationMode|null>(null)
  const [ack,setAck] = useState(false), [hash,setHash] = useState<Hex|null>(null), [busy,setBusy] = useState(false), [notice,setNotice] = useState<Notice|null>(null)
  const generation = useRef(0), connection = useRef(0), running = useRef(false)
  const say = (text:string, code:string|null = null) => setNotice({text,code})
  // What the link asked for (#/sequence/<mode>/<nft>): with either, a connected wallet is read without a press, so the guided creation opens filled in.
  const [intent] = useState(() => sequenceIntent(hashParts(window.location.hash).segments))
  // The wallet's own network price, asked only when the guided creation prepares a step; the owner's raw fields below stay theirs.
  const [gasFor,setGasFor] = useState<(()=>Promise<GasBudget>)|null>(null)
  const [intentRoot,setIntentRoot] = useState<Root|null>(null)
  // The latest connect, reachable from the one-time release read below without being its dependency: a link naming a mode or a
  // position, with the release in and a wallet already connected, reads the sequences without a press. Reads only; the one GET stays one.
  const onArrival = useRef<()=>void>(()=>{})
  useEffect(() => { let live = true; void readSequenceRelease().then(result => { if(!live) return; setRelease(result); const asked = sequenceIntent(hashParts(window.location.hash).segments); if(result.kind==='available'&&(asked.mode!==null||asked.tokenId!==null)) onArrival.current() }); return () => { live = false } },[])
  useEffect(() => watchConnection(walletConfig,{onChange:()=>{
    generation.current++; connection.current++; running.current=false; setBusy(false); setClient(null); setRecovery(false); setRecent([]); setState(null); setRoot(null); setReserves(null)
    setPrepared(null); setHash(null); setAck(false); setConsent(false); setCreateMode('compound'); setPolicyMode(null); setForm(empty); setNotice(null); setGasFor(null); setIntentRoot(null)
  }}),[])
  useEffect(()=>()=>{generation.current++;connection.current++},[])
  const available = release.kind === 'available'
  const profile = available ? release.deployment : release.kind === 'unavailable' ? saved : null
  function edit(name:keyof typeof empty,value:string) {
    generation.current++; setForm(old=>({...old,[name]:value})); setPrepared(null); setAck(false)
    if(name==='root') {setRoot(null);setConsent(false)}
    if(name==='vault') {setState(null);setReserves(null)}
    if(name==='member') setReserves(null)
  }
  function chooseMode(target:'create'|'policy',mode:AutomationMode) {
    generation.current++; setPrepared(null); setAck(false); setConsent(false)
    if(target==='create')setCreateMode(mode);else setPolicyMode(mode)
    if(mode==='compound')setForm(old=>({...old,positions:'1'}))
  }
  const modeChoice=(target:'create'|'policy',mode:AutomationMode|null) => <label className="dm-label dm-acct-lf">{target==='create'?'Automation mode':'Automation mode for rule change'}<select className="dm-field" disabled={busy} value={mode??''} onChange={e=>chooseMode(target,e.target.value as AutomationMode)}>{mode===null&&<option value="" disabled>Choose an automation mode</option>}<option value="compound">Auto-compound · 2% · root position only</option><option value="domino">Domino-compound · 4% · successor positions</option></select><span className="dm-hint">{mode==='compound'?'Reinvest in the root only. Maximum positions is one.':mode==='domino'?'Reinvest or fund successor positions within your limits. The 4% rate applies to every automated recipe.':'Choose a mode and review its fee before changing the policy.'} Charged once on consumed earned fees, never principal. No additional automation swap fee.</span></label>
  async function action(work:()=>Promise<void>) {
    if(running.current)return
    running.current=true;setBusy(true);setNotice(null);setPrepared(null);setAck(false)
    const gen=generation.current
    try {await work()} catch(error) {if(generation.current===gen)say(financeErrorText(errorCode(error),'The wallet read or simulation could not be completed. No new transaction was sent.','Read my sequences'),errorCode(error))}
    finally {if(generation.current===gen){running.current=false;setBusy(false)}}
  }
  async function connect() {
    const gen=generation.current
    // Asked again at the owner's press, so a release switched off since the page opened never prepares an approval or creation.
    const live=await readSequenceRelease()
    if(generation.current!==gen)return
    setRelease(live)
    const d=live.kind==='available'?live.deployment:savedProfile(), isRecovery=live.kind!=='available'
    if(!d){say('The deployment could not be read. No approval or transaction was requested.',live.kind==='unavailable'?live.reason:null);return}
    const wallet=await setupWallet(), epoch=++connection.current
    const next=createSequenceClient({...wallet,current:()=>wallet.current()&&connection.current===epoch},d,()=>Date.now()/1000,currentSequenceDeployment)
    const rows=await next.recent()
    // A link that named a position: it is read now, so the guided creation opens on it. A position that cannot be read is left for the owner to read again there.
    let wanted:Root|null=null
    if(intent.tokenId){try{wanted=await next.inspectRoot(BigInt(intent.tokenId))}catch{wanted=null}}
    if(generation.current!==gen||!wallet.current())return
    setGasFor(()=>()=>suggestGasBudget(wallet)); setIntentRoot(wanted)
    if(!isRecovery)try{localStorage.setItem(cacheKey,JSON.stringify({contractVersion:'1.0.0-rc.1',chainId:4663,available:true,deployment:d}))}catch{ /* Recovery still works while this verified profile is loaded. */ }
    setClient(next);setRecent(rows);setRecovery(isRecovery);setState(null);setReserves(null);setRoot(null);setHash(null)
    say(isRecovery?'Previously saved deployment identities were checked on chain. Manage a sequence you own below.':'Deployment verified through your wallet. Create a paused sequence or manage one you own.')
  }
  // A link naming a mode or a position: with the release in and a wallet already connected, the sequences are read without a press. Reads only; a wallet connected later presses Read my sequences.
  useEffect(()=>{ onArrival.current = () => { if(getConnection(walletConfig).status==='connected') void action(connect) } })
  const gas=()=>({maxGas:sequenceRaw(form.maxGas,64),maxFeePerGas:sequenceRaw(form.maxFee),maxPriorityFeePerGas:sequenceRaw(form.priority),reserveWei:sequenceRaw(form.reserve,256)})
  const integer=(value:string)=>{const n=sequenceRaw(value,32);return Number(n)}
  const vault=()=>form.vault.toLowerCase() as Address
  async function inspect(address=vault()) {
    if(!client)return;const gen=generation.current, value=await client.inspect(address)
    if(generation.current===gen){setState(value);setPolicyMode(value.automationMode);setConsent(false);setForm(old=>({...old,vault:address,member:value.rootTokenId.toString(),...(value.automationMode==='compound'?{positions:'1'}:{})}));setReserves(null)}
  }
  async function create() {
    if(!client||!root||recovery)return;const gen=generation.current
    const value=await client.create({automationMode:createMode,rootTokenId:sequenceRaw(form.root,256),baseIsCurrency0:base0,consentToUncollectedFees:consent,
      triggerDistanceBps:integer(form.trigger),maxOverlapBps:integer(form.overlap),minimumIntervalSeconds:integer(form.interval),maxPositions:createMode==='compound'?1:integer(form.positions),
      upsideBps:integer(form.upside),maxSlippageBps:integer(form.slippage),maxPriceImpactBps:integer(form.impact),maxGasCostWei:sequenceRaw(form.executionGas),
      maxObservationAgeSeconds:integer(form.age),forecastHorizonSeconds:integer(form.horizon)},gas())
    if(generation.current===gen)setPrepared(value)
  }
  async function changePolicy() {
    if(!client||!state||!policyMode)return;const gen=generation.current
    const value=await client.setPolicy(state.vault,{automationMode:policyMode,triggerDistanceBps:integer(form.trigger),maxOverlapBps:integer(form.overlap),
      minimumIntervalSeconds:integer(form.interval),maxPositions:policyMode==='compound'?1:integer(form.positions)},gas())
    if(generation.current===gen)setPrepared(value)
  }
  async function changeLimits() {
    if(!client||!state)return;const gen=generation.current
    const value=await client.setExecutionLimits(state.vault,{upsideBps:integer(form.upside),maxSlippageBps:integer(form.slippage),
      maxPriceImpactBps:integer(form.impact),maxGasCostWei:sequenceRaw(form.executionGas),
      maxObservationAgeSeconds:integer(form.age),forecastHorizonSeconds:integer(form.horizon)},gas())
    if(generation.current===gen)setPrepared(value)
  }
  async function recover(kind:'pause'|'revoke-operator'|'revoke-root'|'withdraw-child'|'withdraw-fees'|'rearm-root'|'recover-position'|'recover-currency') {
    if(!client||!state)return;const gen=generation.current,balance=reserves?.balances[balanceIndex]
    const values=kind==='withdraw-child'||kind==='recover-position'?{tokenId:sequenceRaw(form.member,256)}
      :kind==='withdraw-fees'?{sourceId:balance?.sourceId,currency:balance?.currency,original:sequenceRaw(form.original),charged:sequenceRaw(form.charged)}
      :kind==='recover-currency'?{currency:recoverCurrency,amount:sequenceRaw(form.recoverAmount,256)}:{}
    const value=await client.recover(state.vault,kind,gas(),values)
    if(generation.current===gen)setPrepared(value)
  }
  async function send() {
    if(!client||!prepared||!ack||running.current)return
    const step=prepared,gen=generation.current
    running.current=true;setBusy(true);setPrepared(null);setAck(false);setHash(null)
    try {const result=await client.send(step,true);if(generation.current===gen){setHash(result);setForm(old=>({...old,vault:step.vault}));say('Offered to your wallet once. Check the canonical receipt, then read the position or sequence again before the next step.')}}
    catch(error){if(generation.current===gen){
      const beforeWallet=error instanceof Error&&['review_required','sequence_admission_unavailable','sequence_release_expired','sequence_preparation_changed','sequence_activation_unavailable','sequence_tariff_changed','deployment_code_changed','deployment_identity_changed','root_approval_changed'].includes(error.message)
      say(beforeWallet?'The preparation is no longer valid. No wallet transaction was requested. Read your sequences again, then prepare and review again.':error&&typeof error==='object'&&(error as {code?:unknown}).code===4001?'Wallet request rejected. Prepare and review again if you want to continue.':'The wallet outcome may be unknown. Check wallet activity and chain state. This nonce remains protected against another offer, including after reload.',errorCode(error))
    }}
    finally {if(generation.current===gen){running.current=false;setBusy(false)}}
  }
  const fields=(names:(keyof typeof empty)[],mode?:AutomationMode|null) => <div className="dm-acct-fields dm-acct-fields--3">{names.map(name=><label className="dm-label dm-acct-lf" key={name}>{labels[name]}<input disabled={busy||(name==='positions'&&mode==='compound')} className="dm-field dm-acct-mono-field" value={name==='positions'&&mode==='compound'?'1':form[name]} onChange={e=>edit(name,e.target.value)} autoComplete="off" /></label>)}</div>
  // No published release, no saved profile, and nothing read, running or said on this visit: the owner controls would promise actions
  // with no way into them. Once the release has answered, one plain line says so instead; why is its data and title. While it is read, nothing shows.
  const noControls=!available&&!saved&&!client&&!notice&&!busy
  return <main className="dm-page dm-page--narrow">
    <Display as="h1" className="dm-display-title">Your sequences</Display>
    <p className="dm-acct-lede">Keep your root NFT in your wallet while a dedicated sequence manages earned fees and child positions. Each wallet transaction has its own review.</p>
    {noControls?(release.kind==='unavailable'
      ?<p className="dm-acct-block text-body text-fg-muted" data-sequence-release="unavailable" data-sequence-release-reason={release.reason} data-recovery-profile="none" title={`Sequence deployment unavailable: ${release.reason.replaceAll('_',' ')}.`}>No sequence to manage here.</p>
      :<div hidden data-sequence-release={release.kind} data-recovery-profile="none" />)
    :<Card className="dm-acct-block dm-acct-panel" data-sequence-release={release.kind} data-sequence-release-reason={release.kind==='unavailable'?release.reason:undefined} data-recovery-profile={saved?'saved':'none'}>
      <h2 className="dm-acct-panel-title">Owner controls</h2>
      <p className="dm-acct-panel-note">{available?'Create a paused sequence from a position NFT you hold, or manage one you own, directly through your wallet. Owner controls need no Domino sign-in.':'Pause, revoke permissions or recover assets of a sequence you own, directly through your wallet. Withdrawals have no Domino service fee.'}</p>
      {profile&&<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(connect)}}>Read my sequences</Button>}
      {notice&&<p role="status" className="dm-acct-line dm-acct-wrap" data-notice-code={notice.code??undefined}>{notice.text}</p>}
      {client&&<p className="dm-acct-hash">Factory {client.deployment.factory} · {recovery?'Saved deployment':'Verified deployment'} · Auto-compound 2%; Domino-compound 4% of earned fees consumed, once. No fee on principal.</p>}
    </Card>}
    {client&&<>
      {available&&!recovery&&<SequenceCreate client={client} gasFor={gasFor} intent={intent} initialRoot={intentRoot} onCreated={vault=>{void action(()=>inspect(vault))}} />}
      <Card className="dm-acct-block dm-acct-panel"><h2 className="dm-acct-panel-title">Network budget</h2><p className="dm-acct-panel-note">Set explicit limits for each approval, creation or owner action. These are wallet transaction limits; the sequence execution cap is configured separately.</p>{fields(['maxGas','maxFee','priority','reserve'])}</Card>
      {available&&!recovery&&<Card className="dm-acct-block dm-acct-panel"><h2 className="dm-acct-panel-title">Create a paused sequence</h2><p className="dm-acct-panel-note">Every field by hand, in basis points, seconds and wei. The guided creation above takes the same choices in plain units. Creating a sequence starts it paused; activating it is a separate owner transaction.</p>{fields(['root'])}
        <Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(async()=>{const gen=generation.current,result=await client.inspectRoot(sequenceRaw(form.root,256));if(generation.current===gen){setRoot(result);setConsent(false)}})}}>Read my root NFT</Button>
        {root&&<><p className="dm-acct-line dm-acct-wrap">Pool {root.poolId} · ticks {root.lower} to {root.upper}. Currency 0: {root.key.currency0}. Currency 1: {root.key.currency1}. The zero address denotes native currency.</p>
          {modeChoice('create',createMode)}
          <label className="dm-label dm-acct-lf">Price orientation<select disabled={busy} className="dm-field" value={base0?'0':'1'} onChange={e=>{generation.current++;setBase0(e.target.value==='0');setPrepared(null);setAck(false)}}><option value="0">Currency 0 is base; currency 1 is quote</option><option value="1">Currency 1 is base; currency 0 is quote</option></select></label>
          <details className="dm-details dm-acct-disclosure" open><summary>Choose sequence limits</summary><div className="dm-acct-disclosure-body"><p className="dm-acct-panel-note">One basis point is 0.01%. Trigger distance and overlap each allow 0–2,000 bps; successor limits apply only in Domino mode. These choices define bounded automation authority; creation does not activate it.</p>{fields(['trigger','overlap','interval','positions','upside','slippage','impact','executionGas','age','horizon'],createMode)}</div></details>
          <label className="dm-acct-check"><input type="checkbox" disabled={busy} checked={consent} onChange={e=>{generation.current++;setConsent(e.target.checked);setPrepared(null);setAck(false)}}/><span>I consent to using already uncollected fees from this NFT, plus future earned fees, for {createMode==='domino'?'Domino-compound':'Auto-compound'} under these limits. The service fee is {AUTOMATION_FEE_BPS[createMode]/100}% of earned fees actually consumed, once, never principal. No additional automation swap fee.</span></label>
          <Button className="justify-self-start" disabled={busy||!consent} onClick={()=>{void action(create)}}>Prepare approval or paused creation</Button>
          <p className="dm-acct-panel-note">First approve this NFT to its predicted sequence address. After its receipt is confirmed, prepare again to create the sequence. No approval for all NFTs is requested.</p>
        </>}
      </Card>}
      <Card className="dm-acct-block dm-acct-panel"><h2 className="dm-acct-panel-title">Manage a sequence</h2><p className="dm-acct-panel-note">Read a sequence you own, then pause it, revoke permissions or withdraw, one reviewed step each. Withdrawals have no Domino service fee.</p>
        <div className="dm-acct-choices">{recent.map(row=><Button key={row.vault} variant="outline" size="sm" disabled={busy} onClick={()=>{void action(()=>inspect(row.vault))}}>Sequence {row.ownerNonce.toString()} · {row.vault.slice(0,10)}</Button>)}</div>
        {fields(['vault'])}<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(()=>inspect())}}>Read owned sequence</Button>
        {state&&<><p className="dm-acct-line dm-acct-wrap">Root NFT #{state.rootTokenId.toString()} · {state.paused?'Paused':'Active'} · {state.operator==='0x0000000000000000000000000000000000000000'?'Operator revoked':`Operator ${state.operator}`} · root permission {state.rootPermissionValid?'valid':'not valid'}.</p>
          <p className="dm-acct-line" data-sequence-current-mode={state.automationMode??'unknown'}>Current policy: {state.automationMode==='domino'?'Domino-compound':state.automationMode==='compound'?'Auto-compound':'Unrecognized automation mode'} · {state.serviceFeeBps/100}% of consumed earned fees, once. No principal charge or additional automation swap fee.</p>
          {/* Activation is offered only while the service that runs automation is in operation: an owner may authorise the operator, but that
              alone runs nothing, and a resumed sequence with no service behind it would be announced as active for no reason. Every other
              control stays: pause, revocation, repair, withdrawal and recovery need no service. Paused/Active above is the chain's own word. */}
          {!recovery&&state.paused&&!AUTOMATION_SERVICE.operational&&<p className="dm-acct-line dm-acct-wrap" data-automation-service="not-operational">{AUTOMATION_SERVICE.reason}</p>}
          <div className="dm-acct-choices">{!recovery&&state.paused&&AUTOMATION_SERVICE.operational&&<Button disabled={busy||!state.rootPermissionValid||state.operator!==client.deployment.operator} onClick={()=>{void action(async()=>{const gen=generation.current,result=await client.resume(state.vault,gas());if(generation.current===gen)setPrepared(result)})}}>Review activation</Button>}<Button variant="outline" disabled={busy||state.paused} onClick={()=>{void action(()=>recover('pause'))}}>Review pause</Button><Button variant="outline" disabled={busy||state.operator==='0x0000000000000000000000000000000000000000'} onClick={()=>{void action(()=>recover('revoke-operator'))}}>Review operator revocation</Button>{state.operator==='0x0000000000000000000000000000000000000000'&&<Button variant="outline" disabled={busy} onClick={()=>{void action(async()=>{const gen=generation.current,result=await client.restoreOperator(state.vault,gas());if(generation.current===gen)setPrepared(result)})}}>Review operator authorisation</Button>}{!state.rootPermissionValid&&<Button variant="outline" disabled={busy} onClick={()=>{void action(()=>recover('rearm-root'))}}>Review root permission repair</Button>}<Button variant="outline" disabled={busy} onClick={()=>{void action(()=>recover('revoke-root'))}}>Review root NFT approval revocation</Button></div>
          <details className="dm-details dm-acct-disclosure"><summary>Adjust automation rules</summary><div className="dm-acct-disclosure-body">
            <p className="dm-acct-line dm-acct-wrap">Choose the mode and its fee, then review the change before signing. The paused state stays unchanged. Simple Auto-compound requires a sequence with only its root registered.</p>
            {modeChoice('policy',policyMode)}
            {fields(['trigger','overlap','interval','positions'],policyMode)}<Button className="justify-self-start" variant="outline" disabled={busy||!policyMode} onClick={()=>{void action(changePolicy)}}>Review automation rule change</Button>
          </div></details>
          <details className="dm-details dm-acct-disclosure"><summary>Adjust safety limits</summary><div className="dm-acct-disclosure-body">
            <p className="dm-acct-line dm-acct-wrap">These bound every automated run: the upside a successor must show, the slippage and price impact a swap may take, what the executor may spend on gas, and how stale a price reading may be.</p>
            {fields(['upside','slippage','impact','executionGas','age','horizon'])}<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(changeLimits)}}>Review safety limit change</Button>
          </div></details>
          <details className="dm-details dm-acct-disclosure"><summary>Child positions and fee reserves</summary><div className="dm-acct-disclosure-body">{fields(['member'])}<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(async()=>{const gen=generation.current,result=await client.reserves(state.vault,sequenceRaw(form.member,256));if(generation.current===gen){setReserves(result);setBalanceIndex(0)}})}}>Read position and earned-fee reserves</Button>
            {reserves&&<><p className="dm-acct-line">NFT #{reserves.tokenId.toString()} · {reserves.isRoot?'Root':'Child'} · {reserves.active?'registered':'withdrawn'}. {reserves.successor>0n?`Successor NFT #${reserves.successor}.`:'No successor registered.'}</p>
              {reserves.successor>0n&&<Button className="justify-self-start" variant="outline" size="sm" disabled={busy} onClick={()=>edit('member',reserves.successor.toString())}>Select successor</Button>}
              {!reserves.isRoot&&reserves.active&&<Button className="justify-self-start" variant="outline" size="sm" disabled={busy} onClick={()=>{void action(()=>recover('withdraw-child'))}}>Review child NFT withdrawal</Button>}
              <label className="dm-label dm-acct-lf">Fee source and currency<select disabled={busy} className="dm-field" value={balanceIndex} onChange={e=>{generation.current++;setBalanceIndex(Number(e.target.value));setPrepared(null);setAck(false)}}>{reserves.balances.map((b,i)=><option key={`${b.sourceId}:${b.currency}`} value={i}>{b.currency} · source {b.sourceId.slice(0,12)}</option>)}</select></label>
              <p className="dm-acct-line dm-acct-wrap">Source {reserves.balances[balanceIndex].sourceId}. Available: {reserves.balances[balanceIndex].original.toString()} original + {reserves.balances[balanceIndex].charged.toString()} already charged smallest units. These are earned-fee reserves, not NFT principal.</p>
              {fields(['original','charged'])}<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(()=>recover('withdraw-fees'))}}>Review fee reserve withdrawal</Button>
              {/* A stray NFT the sequence holds but does not manage, and loose balances above what its books account for. Neither is principal and neither is a fee reserve. */}
              {!reserves.active&&<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(()=>recover('recover-position'))}}>Review unmanaged NFT recovery</Button>}
              <label className="dm-label dm-acct-lf">Currency to return<select disabled={busy} className="dm-field" value={recoverCurrency} onChange={e=>{generation.current++;setRecoverCurrency(e.target.value as `0x${string}`);setPrepared(null);setAck(false)}}><option value="0x0000000000000000000000000000000000000000">Native ETH</option><option value={state.baseCurrency}>{state.baseCurrency}</option><option value={state.quoteCurrency}>{state.quoteCurrency}</option></select></label>
              {fields(['recoverAmount'])}<Button className="justify-self-start" variant="outline" disabled={busy} onClick={()=>{void action(()=>recover('recover-currency'))}}>Review untracked balance recovery</Button>
            </>}
          </div></details>
        </>}
      </Card>
      {prepared&&<Card className="dm-acct-block dm-acct-panel" role="region" aria-label="Sequence wallet review"><h2 className="dm-acct-panel-title">Review {SEQUENCE_STEP_TEXT[prepared.kind]}</h2>{prepared.summary.map(line=><p key={line} className="dm-acct-line dm-acct-wrap">{line}</p>)}<label className="dm-acct-check"><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/><span>I reviewed the NFT, owner, sequence address, currencies, fees and limits for this single step.</span></label><Button className="justify-self-start" variant="accent" disabled={busy||!ack} onClick={()=>{void send()}}>Send this step in wallet</Button></Card>}
      {/* The hash links to the explorer, so a checked receipt that disagrees with the review can be looked at where it stands. There is no
          button that sends again: a mismatch, a revert and an over-budget inclusion each end here, with the state read again by the owner. */}
      {hash&&<Card className="dm-acct-block dm-acct-panel"><h2 className="dm-acct-panel-title">Transaction receipt</h2><p className="dm-acct-hash">{hash}</p><Button variant="outline" className="justify-self-start" disabled={busy} onClick={()=>{void action(async()=>{const gen=generation.current,result=await client.receipt(hash);if(generation.current===gen)say(`Receipt: ${RECEIPT_TEXT[result.state]}. ${result.state==='finalized'?'Read the root or owned sequence again before continuing.':(result.state==='over_budget'||result.state==='over_budget_finalized')?'Nothing was sent again. Read the root or owned sequence again to see where it stands.':'Check again when the chain has progressed. No transaction is retried.'}`)})}}>Check canonical receipt</Button></Card>}
    </>}
  </main>
}
