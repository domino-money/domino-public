import { useEffect, useRef, useState } from 'react'
import { watchConnection } from 'wagmi/actions'
import { zeroAddress, type Address, type Hex } from 'viem'
import { walletConfig } from '../wallet/config'
import { setupWallet } from '../finance/wallet'
import { financialFetch } from '../finance/http'
import { createSetupClient, deploymentFrom, raw, type PreparedSetup, type SetupOperation, type SetupDeployment } from '../finance/setup'
import { Button, Card } from '../components/ui'

const defaults = { currency0: '', currency1: '', fee: '3000', tickSpacing: '60', amount0: '', amount1: '', grossSwap: '', slippage: '50', sqrtLimit: '',
  tickLower: '', tickUpper: '', liquidity: '', maxAmount0: '', maxAmount1: '', minPrice: '', maxPrice: '', initialPrice: '0',
  maxGas: '', maxFee: '', priorityFee: '', reserve: '', operationId: '', transactionHash: '' }
const labels: Record<keyof typeof defaults, string> = { currency0: 'Token 0 address (lower address; zero address for native)', currency1: 'Token 1 address', fee: 'Pool fee (pips)', tickSpacing: 'Tick spacing',
  amount0: 'Fund token 0 (smallest units)', amount1: 'Fund token 1 (smallest units)', grossSwap: 'Swap gross input (smallest units, includes Domino fee)', slippage: 'Maximum swap slippage (basis points)', sqrtLimit: 'Swap sqrtPriceX96 limit',
  tickLower: 'Lower tick', tickUpper: 'Upper tick', liquidity: 'Liquidity (raw)', maxAmount0: 'Mint token 0 cap (smallest units)', maxAmount1: 'Mint token 1 cap (smallest units)',
  minPrice: 'Minimum sqrtPriceX96', maxPrice: 'Maximum sqrtPriceX96', initialPrice: 'Initial sqrtPriceX96 (0 for an existing pool)', maxGas: 'Maximum gas units', maxFee: 'Maximum fee per gas (wei)', priorityFee: 'Maximum priority fee (wei)', reserve: 'Keep native gas reserve (wei)', operationId: 'Operation ID', transactionHash: 'Wallet transaction hash' }
type Client = ReturnType<typeof createSetupClient>
async function currentSetupDeployment(): Promise<SetupDeployment | null> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await financialFetch('/api/setup/v1/release', { signal: controller.signal, cache: 'no-store', redirect: 'error', headers: { 'X-Domino-Setup-Contract': '1.0.0-rc.1' } })
    if (!response.ok || response.headers.get('X-Domino-Setup-Contract') !== '1.0.0-rc.1' || !response.body) throw new Error('setup_release_unavailable')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 8192) { await reader.cancel(); throw new Error('invalid_setup_release') } chunks.push(chunk.value) }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return deploymentFrom(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } finally { clearTimeout(timer) }
}
/** Advanced owner actions remain usable without a private session. The release
 * holds public identities only; it grants no spending or automation authority. */
export default function AdvancedSetup() {
  const [form, setForm] = useState(defaults), [client, setClient] = useState<Client | null>(null)
  const [operation, setOperation] = useState<SetupOperation | null>(null), [recent, setRecent] = useState<{ id: Hex; operation: SetupOperation }[]>([])
  const [prepared, setPrepared] = useState<PreparedSetup | null>(null), [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null), [direction, setDirection] = useState(true)
  const generation = useRef(0), running = useRef(false)
  useEffect(() => watchConnection(walletConfig, { onChange: () => { generation.current++; running.current = false; setClient(null); setOperation(null); setRecent([]); setPrepared(null); setAck(false); setBusy(false); setForm(defaults); setNotice(null) } }), [])
  useEffect(() => () => { generation.current++ }, [])
  const edit = (name: keyof typeof defaults, value: string) => { generation.current++; setForm(old => ({ ...old, [name]: value })); setPrepared(null); setAck(false) }
  async function action(work: () => Promise<void>) {
    if (running.current) return
    running.current = true; setBusy(true); setNotice(null); setPrepared(null); setAck(false)
    const gen = generation.current
    try { await work() } catch (error) { if (generation.current === gen) setNotice(error instanceof Error ? error.message.replaceAll('_', ' ') : 'Wallet operation unavailable.') }
    finally { if (generation.current === gen) { running.current = false; setBusy(false) } }
  }
  async function connect() {
    const gen = generation.current
    let deployment: SetupDeployment | null = null, recovery = false
    try { deployment = await currentSetupDeployment() } catch { /* A previously verified public profile can still recover funds. */ }
    if (!deployment) {
      try {
        const saved = localStorage.getItem('domino.setup.public-recovery.v1')
        if (saved && saved.length <= 8192) { const old = deploymentFrom(JSON.parse(saved), 0); if (old) { deployment = { ...old, expiresAt: 0 }; recovery = true } }
      } catch { /* Storage is optional and holds no wallet or operation data. */ }
    }
    if (!deployment) { if (generation.current === gen) setNotice('Setup deployment is not connected yet. No transaction was prepared.'); return }
    const wallet = await setupWallet(), next = createSetupClient(wallet, deployment, () => Date.now() / 1000, currentSetupDeployment)
    const rows = await next.recent()
    if (generation.current !== gen || !wallet.current()) return
    if (!recovery) {
      try { localStorage.setItem('domino.setup.public-recovery.v1', JSON.stringify({ contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment })) } catch { /* Recovery can also use the published deployment profile. */ }
    }
    setClient(next); setRecent(rows); setNotice(recovery ? 'Recovery mode: the saved deployment was verified on chain. You can read and refund existing operations; new funding, swaps and mint are disabled.' : 'Deployment verified through your wallet. Choose an existing operation or review new funding.')
  }
  const gas = () => ({ maxGas: raw(form.maxGas, 64), maxFeePerGas: raw(form.maxFee), maxPriorityFeePerGas: raw(form.priorityFee), reserveWei: raw(form.reserve, 256) })
  const id = () => form.operationId.toLowerCase() as Hex
  const integer = (value: string) => { if (!/^-?(0|[1-9][0-9]{0,6})$/.test(value)) throw new Error('invalid_integer'); return Number(value) }
  async function prepare(kind: 'fund' | 'swap' | 'mint' | 'cancel') {
    if (!client) return
    const gen = generation.current
    const result = kind === 'fund' ? await client.fund({ currency0: form.currency0.toLowerCase() as Address, currency1: form.currency1.toLowerCase() as Address, hooks: zeroAddress, fee: integer(form.fee), tickSpacing: integer(form.tickSpacing) }, raw(form.amount0), raw(form.amount1), gas())
      : kind === 'swap' ? await client.swap(id(), direction, raw(form.grossSwap), integer(form.slippage), raw(form.sqrtLimit, 160), gas())
      : kind === 'mint' ? await client.mint(id(), { tickLower: integer(form.tickLower), tickUpper: integer(form.tickUpper), liquidity: raw(form.liquidity, 127), maxAmount0: raw(form.maxAmount0), maxAmount1: raw(form.maxAmount1), minSqrtPriceX96: raw(form.minPrice, 160), maxSqrtPriceX96: raw(form.maxPrice, 160), initialSqrtPriceX96: raw(form.initialPrice, 160) }, gas())
      : await client.cancel(id(), gas())
    if (generation.current === gen) setPrepared(result)
  }
  async function send() {
    if (!client || !prepared || !ack || running.current) return
    const step = prepared, gen = generation.current
    running.current = true; setBusy(true); setPrepared(null); setAck(false)
    try {
      const hash = await client.send(step, true)
      if (generation.current === gen) { setForm(old => ({ ...old, transactionHash: hash, operationId: step.operationId ?? old.operationId })); setNotice('Transaction offered once. Check its receipt and the operation before the next stage.') }
    } catch (error) { if (generation.current === gen) setNotice(error instanceof Error && ['setup_admission_unavailable','setup_release_unavailable','invalid_setup_release','setup_release_expired','deployment_code_changed','deployment_identity_changed'].includes(error.message)
      ? 'The setup release is no longer available or its identities changed. No wallet transaction was requested. Reload the deployment, then prepare and review again. Existing operations can still be read and refunded.'
      : error && typeof error === 'object' && (error as { code?: unknown }).code === 4001
        ? 'Wallet request rejected. Prepare and review again if you want to continue.'
        : 'The wallet outcome may be unknown. Check wallet activity and reload the operation before proceeding. This nonce remains protected against another offer, including after reload.') }
    finally { if (generation.current === gen) { running.current = false; setBusy(false) } }
  }
  const inputs = (names: (keyof typeof defaults)[]) => <div className="mt-4 grid gap-3 sm:grid-cols-2">{names.map(name => <label className="text-sm" key={name}>{labels[name]}<input disabled={busy} className="mt-1 block w-full rounded border bg-surface-1 p-2" value={form[name]} onChange={event => edit(name, event.target.value)} /></label>)}</div>
  return <Card className="mt-8 p-5">
    <h2 className="font-medium">Advanced setup and owner recovery</h2>
    <p className="mt-2 text-sm text-fg-muted">Fund a setup operation, optionally swap once, then mint. New pools require an explicit initial price and liquidity range. Each stage is reviewed separately in your wallet. Refunds remain available without a Domino sign-in.</p>
    <Button className="mt-4" disabled={busy} variant="outline" onClick={() => { void action(connect) }}>Load deployment and my operations</Button>
    {notice && <p role="status" className="mt-4 break-all">{notice}</p>}
    {client && <>
      <p className="mt-4 break-all text-xs">Setup {client.deployment.setup} · assisted swap fee {client.deployment.feeBps} bps · tariff {client.deployment.tariffVersion}. Mint and refunds: 0% Domino fee. Network and pool fees still apply.</p>
      <fieldset disabled={busy}><legend className="mt-5 font-medium">Network budget for each wallet step</legend>{inputs(['maxGas','maxFee','priorityFee','reserve'])}</fieldset>
      <details className="mt-5"><summary>Fund a new operation</summary>{inputs(['currency0','currency1','fee','tickSpacing','amount0','amount1'])}<Button className="mt-4" disabled={busy} onClick={() => { void action(() => prepare('fund')) }}>Prepare exact allowance or funding</Button></details>
      <h3 className="mt-6 font-medium">Recover or continue an operation</h3>
      {recent.map(row => <Button className="mr-2 mt-2" variant="outline" key={row.id} disabled={busy} onClick={() => { edit('operationId', row.id); setOperation(row.operation) }}>{row.operation.closed ? 'Closed' : row.operation.swapped ? 'Swapped' : 'Funded'} · {row.id.slice(0, 12)}</Button>)}
      {inputs(['operationId'])}<Button className="mt-3" disabled={busy} variant="outline" onClick={() => { void action(async () => { const gen = generation.current, op = await client.inspect(id()); if (generation.current === gen) setOperation(op) }) }}>Read operation from chain</Button>
      {operation && <p className="mt-3 break-all text-sm">Token 0 {operation.key.currency0}: {operation.balance0.toString()} · token 1 {operation.key.currency1}: {operation.balance1.toString()} · {operation.closed ? `closed, NFT ${operation.tokenId}` : operation.swapped ? 'swap completed; ready to mint or refund' : 'funded'}</p>}
      <details className="mt-5"><summary>Optional assisted swap</summary><label className="mt-3 block text-sm"><input type="checkbox" disabled={busy} checked={direction} onChange={e => { generation.current++; setDirection(e.target.checked); setPrepared(null); setAck(false) }} /> Token 0 to token 1 (uncheck for token 1 to token 0)</label>{inputs(['grossSwap','slippage','sqrtLimit'])}<Button className="mt-4" disabled={busy} onClick={() => { void action(() => prepare('swap')) }}>Simulate and review swap</Button></details>
      <details className="mt-5"><summary>Mint or create a new pool</summary>{inputs(['tickLower','tickUpper','liquidity','maxAmount0','maxAmount1','minPrice','maxPrice','initialPrice'])}<Button className="mt-4" disabled={busy} onClick={() => { void action(() => prepare('mint')) }}>Simulate and review mint</Button></details>
      <Button className="mt-5" variant="outline" disabled={busy} onClick={() => { void action(() => prepare('cancel')) }}>Review refund of remaining funds</Button>
      {prepared && <section className="mt-6 rounded border p-4" aria-label="Wallet transaction review"><h3 className="font-medium">Review {prepared.kind}</h3>{prepared.summary.map(line => <p className="mt-2 break-all text-sm" key={line}>{line}</p>)}<label className="mt-4 block text-sm"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> I reviewed the tokens, destination, amounts, fee and limits.</label><Button className="mt-4" disabled={!ack || busy} onClick={() => { void send() }}>Send this step in wallet</Button></section>}
      {inputs(['transactionHash'])}<Button className="mt-3" variant="outline" disabled={busy} onClick={() => { void action(async () => { const gen = generation.current, receipt = await client.receipt(form.transactionHash.toLowerCase() as Hex, form.operationId ? id() : undefined); if (generation.current === gen) setNotice(`Receipt: ${receipt.state}. ${receipt.state === 'finalized' ? 'Read the operation before continuing.' : 'Wait for canonical finality before considering the step complete.'}`) }) }}>Check canonical receipt</Button>
    </>}
  </Card>
}
