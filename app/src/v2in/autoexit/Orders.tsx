import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Mandate } from 'api-contracts/read-v6/types'
import { Button, KeyValue, KeyValueList, Pill } from '../../components/ui'
import { createAutoExitClient, type MandateStatusView } from '../../finance/v2/autoExit'
import { browserSignatureJournal } from '../../finance/v2/signatureJournal'
import { v2Wallet } from '../../finance/v2/wallet'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import type { PriceOrientation } from '../../v2/trigger'
import { ZERO_ADDRESS, type Address, type Hex } from '../../v2/types'
import { errorLabels } from '../automate/copy'
import { bpsText } from '../automate/form'
import { OneStepDialog } from '../automate/OneStepDialog'
import { BLOCKED_TEXT_KEY, rawAmounts, waitingWords } from '../automate/portfolio'
import { automationState, sessionMandates, subscribeAutomation } from '../automate/store'
import { amountWords, dateWords, shortAddress, type TokenView } from '../automate/tokens'
import { Fact } from '../automate/ui'
import { conditionWords, receiveWords, triggerWords } from './words'
import type { ExitTarget } from './MandateDialog'

/**
 * A position's exit orders on its page (spec F7 §4.5, §4.8; decision #24): every order of this position in the wallet's
 * vault, as read-v6 lists them (`portfolio.mandates`: Active, Expired, Cancelled or Executed; what keeps an active one
 * from firing, in §4.5's words; "Waiting: … · since …"), and the ones registered from this page that the index does not
 * list yet. "Cancel order" revokes an active order (its status read on chain first); a signed order that was never
 * registered can be cancelled so it can never be used (`cancelNonce`); what an exit could not deliver is claimed to an
 * address the owner chooses (§4.8). Under the gate's `preview` each of those dialogs stops at its review with the locked
 * sentence.
 */

const WORD = { active: 'Active', expired: 'Expired', revoked: 'Cancelled', executed: 'Executed' } as const

/**
 * §4.8's claim without the index: `unclaimed(owner, token)` for the pool's two tokens, read on chain through the connected
 * wallet's own provider (finance/v2/autoExit.ts readUnclaimed: reads only, at one block, nothing verified or sent), under
 * a live gate alone and only while the wallet is already on the chain (a read never asks it to switch; the client's own
 * port refuses before any wallet call otherwise). Null until read, under preview, and when the read could not be made:
 * then read-v6's credits stand as they are, and nothing is shown in the read's place. Read again whenever `round` moves.
 */
export function useUnclaimed(gate: V2Gate | null, pool: { currency0: Address; currency1: Address } | null, owner: Address | null, round: number): readonly { token: Address; amount: bigint }[] | null {
  const identity = useWalletIdentity()
  const live = gate && gate.mode === 'live' ? gate : null
  const onChain = live !== null && identity.kind === 'connected' && identity.chainId === live.chainId && owner !== null && identity.address.toLowerCase() === owner
  const currency0 = pool?.currency0 ?? null
  const currency1 = pool?.currency1 ?? null
  const key = `${live?.chainId ?? ''}|${owner ?? ''}|${currency0 ?? ''}|${currency1 ?? ''}|${round}`
  const [read, setRead] = useState<{ key: string; amounts: readonly { token: Address; amount: bigint }[] } | null>(null)
  useEffect(() => {
    if (!live || !onChain || currency0 === null || currency1 === null) return
    let alive = true
    const asked = key
    void (async () => {
      const wallet = await v2Wallet()
      const client = createAutoExitClient(wallet, v2Chain(live.chainId), live.contracts)
      return client.readUnclaimed([currency0, currency1])
    })().then(
      (answer) => { if (alive) setRead({ key: asked, amounts: answer.amounts }) },
      () => { if (alive) setRead(null) },
    )
    return () => {
      alive = false
    }
  }, [live, onChain, currency0, currency1, key])
  return read && read.key === key ? read.amounts : null
}

type Dialog =
  | { kind: 'cancel'; id: Hex }
  | { kind: 'cancel-signed'; nonce: bigint }
  | { kind: 'claim'; token: TokenView; amount: bigint }
  /** Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 3): auto-exit turned off (Leave automation does it) back on. */
  | { kind: 'module-on'; vault: Address }

export function ExitOrders({ target, orders, credits, gate, owner, orientation, nowSeconds, onChanged }: {
  target: ExitTarget
  /** read-v6's orders of this position in its vault. */
  orders: readonly Mandate[]
  /** What exits could not deliver on this chain's module, above zero. */
  credits: readonly { token: Address; amount: bigint }[]
  gate: Exclude<V2Gate, { mode: 'off' }>
  /** The wallet the screen reads for. */
  owner: Address | null
  orientation: PriceOrientation
  nowSeconds: number
  onChanged: () => void
}) {
  const chain = v2Chain(target.chainId)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [recipient, setRecipient] = useState<string>(owner ?? '')
  const store = useSyncExternalStore(subscribeAutomation, automationState, automationState)
  const locked = gate.mode === 'preview'
  const lockedCopy = gate.mode === 'preview' ? gate.lockedCopy : ''
  const labels = useMemo(() => errorLabels(target.chainId, (address) => target.tokens.find((t) => t.address === address.toLowerCase())?.label ?? shortAddress(address)), [target.chainId, target.tokens])
  const vault = target.vault?.address ?? null
  // Registered from this page and not listed yet by the index.
  const listedIds = new Set(orders.map((order) => order.mandateHash.toLowerCase()))
  const mine = owner && vault ? sessionMandates(store, target.chainId, owner).filter((m) => m.registered && m.vault === vault && m.tokenId === target.tokenId && !listedIds.has(m.id)) : []
  // Signed here and never registered (the page's own journal), live only: their nonce can be cancelled.
  const held = !locked && owner ? browserSignatureJournal().list(target.chainId, owner).filter((entry) => entry.space === 'autoExit' && entry.verifier === gate.contracts.addresses.autoExit && !sessionMandates(store, target.chainId, owner).some((m) => m.registered && m.nonce === entry.nonce)) : []
  const validRecipient = /^0x[0-9a-fA-F]{40}$/.test(recipient.trim()) && recipient.trim().toLowerCase() !== ZERO_ADDRESS
  // An active order held only because auto-exit is off for the automation (Leave automation turns it off, #319): the
  // orders pause, not revoked, and turning it back on (`setExitModule(autoExit)`) lets them fire again as signed.
  const moduleOff = vault !== null && orders.some((order) => order.status === 'active' && !order.expired && order.blockedBy.includes('module_disabled'))

  return (
    <div className="grid gap-3" data-exit-orders={orders.length + mine.length}>
      {orders.length + mine.length === 0 && <p className="dm-acct-note">No exit orders on this position yet.</p>}
      {orders.length + mine.length > 0 && (
        <ul className="dm-mp-list">
          {orders.map((order) => {
            const status = order.status === 'active' ? (order.expired ? 'expired' : 'active') : order.status
            const blocked = order.status === 'active' ? order.blockedBy.map((code) => BLOCKED_TEXT_KEY[code]).filter((key) => key !== undefined) : []
            const waiting = order.status === 'active' && !order.expired ? waitingWords(order.waiting, target.chainId, nowSeconds) : null
            const terms = order.terms
            const [below, above] = terms ? rawAmounts([terms.triggerBelowSqrtPriceX96 ?? '0', terms.triggerAboveSqrtPriceX96 ?? '0']) : [0n, 0n]
            const delivered = order.status === 'executed' && order.executed ? rawAmounts(order.executed.delivered) : null
            return (
              <li key={order.mandateHash} className="dm-mp-row" data-order={order.mandateHash.toLowerCase()} data-order-status={status}>
                <div className="dm-mp-head">
                  <span className="dm-mp-name">Exit order</span>
                  <Pill tone={status === 'active' ? (blocked.length ? 'wait' : 'in') : 'neutral'} dot data-order-pill="">
                    {WORD[status]}
                  </Pill>
                </div>
                {blocked.map((key) => (
                  <p key={key} className="dm-acct-note" data-order-condition={key}>{conditionWords(key, chain.name)}</p>
                ))}
                {waiting && <p className="dm-acct-note" data-order-waiting={waiting.code}>{waiting.text}</p>}
                {terms && (
                  <KeyValueList>
                    {below !== 0n && <KeyValue label="Lower exit">{triggerWords('triggerBelowSqrtPriceX96', below, target.tokens, orientation)}</KeyValue>}
                    {above !== 0n && <KeyValue label="Upper exit">{triggerWords('triggerAboveSqrtPriceX96', above, target.tokens, orientation)}</KeyValue>}
                    <KeyValue label="Receive">{receiveWords(terms.receive === 'both' ? 0 : 1, terms.convertTo ?? ZERO_ADDRESS, target.tokens)}</KeyValue>
                    <KeyValue label="Max slippage, on top of the pool fee">{bpsText(terms.maxSlippageBps)}%</KeyValue>
                    <KeyValue label="Valid until">{dateWords(order.validUntil)}</KeyValue>
                  </KeyValueList>
                )}
                {delivered && delivered.length === 2 && (
                  <p className="dm-acct-note" data-order-result="">
                    Received, after the 0.2% fee: {amountWords(delivered[0], target.tokens[0]).text} + {amountWords(delivered[1], target.tokens[1]).text}
                  </p>
                )}
                {status === 'active' && (
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: 'cancel', id: order.mandateHash.toLowerCase() as Hex })} data-order-cancel="">
                      Cancel order
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
          {mine.map((entry) => (
            <li key={entry.id} className="dm-mp-row" data-order={entry.id} data-order-status="registered">
              <div className="dm-mp-head">
                <span className="dm-mp-name">Exit order</span>
                <Pill tone="in" dot>Registered</Pill>
              </div>
              <p className="dm-acct-note">Registered. It appears in the list shortly.</p>
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: 'cancel', id: entry.id })} data-order-cancel="">
                  Cancel order
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {moduleOff && vault && (
        <div className="flex flex-wrap items-center gap-2" data-orders-module-off="">
          <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: 'module-on', vault })} data-order-module-on="">
            Turn auto-exit back on
          </Button>
        </div>
      )}
      {held.length > 0 && (
        <div className="dm-inset dm-acct-perf-form" data-held-orders="">
          <h3 className="dm-acct-subtitle">Signed but never registered</h3>
          <p className="dm-hint">You signed these orders here and they were never registered. Cancel them so they can never be used.</p>
          {held.map((entry) => (
            <div key={entry.nonce.toString()} className="flex flex-wrap items-center gap-2" data-held-order={entry.nonce.toString()}>
              <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: 'cancel-signed', nonce: entry.nonce })} data-held-cancel="">
                Cancel signed order
              </Button>
            </div>
          ))}
        </div>
      )}
      {credits.length > 0 && (
        <div className="dm-inset dm-acct-perf-form" data-claim="">
          <h3 className="dm-acct-subtitle">Waiting for you to claim</h3>
          <p className="dm-hint">An exit could not deliver these to your wallet. They are kept for you until you claim them.</p>
          <KeyValueList>
            {credits.map((credit) => {
              const token = target.tokens.find((t) => t.address === credit.token) ?? null
              return (
                <KeyValue key={credit.token} label={token?.label ?? shortAddress(credit.token)} data-claim-amount={credit.token}>
                  {token ? amountWords(credit.amount, token).text : `${credit.amount} raw units`}
                </KeyValue>
              )
            })}
          </KeyValueList>
          <label className="dm-label dm-acct-lf">
            Send to
            <input className="dm-field dm-acct-mono-field" value={recipient} spellCheck={false} autoComplete="off" onChange={(event) => setRecipient(event.target.value)} data-claim-recipient="" aria-invalid={validRecipient ? undefined : true} />
          </label>
          {!validRecipient && <p className="dm-error">Choose a valid address to receive the funds.</p>}
          <div className="flex flex-wrap gap-2">
            {credits.map((credit) => {
              const token = target.tokens.find((t) => t.address === credit.token)
              return token ? (
                <Button key={credit.token} type="button" size="sm" disabled={!validRecipient} onClick={() => setDialog({ kind: 'claim', token, amount: credit.amount })} data-claim-open={credit.token}>
                  Claim {token.label}
                </Button>
              ) : null
            })}
          </div>
        </div>
      )}
      {dialog?.kind === 'module-on' && (
        <OneStepDialog
          name="module-on"
          title="Turn auto-exit back on"
          primary="Confirm in wallet"
          chainId={target.chainId}
          contracts={gate.contracts}
          locked={locked}
          lockedCopy={lockedCopy}
          context="vault"
          labels={labels}
          prepare={async (session) => {
            // The vault client reads the module live: only address(0) or the manifest's auto-exit, never twice (§4.1).
            const review = await session.serial(() => session.vault.reviewAction(dialog.vault, { kind: 'set-exit-module', module: session.contracts.addresses.autoExit }))
            return { key: 'set-exit-module', title: 'Turn auto-exit back on', tx: { client: session.vault, prepare: () => session.vault.prepareStep(review, 0, null) } }
          }}
          onDone={onChanged}
          onClose={() => setDialog(null)}
        >
          <p className="dm-receipt-lede">Your paused exit orders work again, exactly as you signed them. Nothing else changes.</p>
        </OneStepDialog>
      )}
      {dialog?.kind === 'cancel' && (
        <OneStepDialog
          name="cancel-order"
          title="Cancel order"
          primary="Cancel order in wallet"
          chainId={target.chainId}
          contracts={gate.contracts}
          locked={locked}
          lockedCopy={lockedCopy}
          context="autoExit"
          labels={labels}
          prepare={async (session) => {
            // The order's status read on chain first (§4.5): only an active order of this wallet is cancelled.
            const status: MandateStatusView = await session.serial(() => session.autoExit.status(dialog.id))
            if (status.status !== 'active') throw new Error('mandate_not_active')
            if (!status.ownedByWallet) throw new Error('mandate_not_owner')
            return { key: 'revoke-mandate', title: 'Cancel this order', tx: { client: session.autoExit, prepare: () => session.autoExit.prepareRevoke(dialog.id, null) } }
          }}
          onDone={onChanged}
          onClose={() => setDialog(null)}
        >
          <p className="dm-receipt-lede">The order stops for good: it can never fire. Your position stays where it is.</p>
          <Fact label="Order id">{dialog.id}</Fact>
        </OneStepDialog>
      )}
      {dialog?.kind === 'cancel-signed' && (
        <OneStepDialog
          name="cancel-signed"
          title="Cancel signed order"
          primary="Cancel in wallet"
          chainId={target.chainId}
          contracts={gate.contracts}
          locked={locked}
          lockedCopy={lockedCopy}
          context="autoExit"
          labels={labels}
          prepare={(session) => ({ key: 'cancel-nonce', title: 'Cancel this signed order', tx: { client: session.autoExit, prepare: () => session.autoExit.prepareCancelNonce(dialog.nonce, null) } })}
          onDone={onChanged}
          onClose={() => setDialog(null)}
        >
          <p className="dm-receipt-lede">A signed order that was never registered is voided, so it can never be used.</p>
          <Fact label="Order number">{dialog.nonce.toString()}</Fact>
        </OneStepDialog>
      )}
      {dialog?.kind === 'claim' && (
        <OneStepDialog
          name="claim"
          title={`Claim ${dialog.token.label}`}
          primary="Claim in wallet"
          chainId={target.chainId}
          contracts={gate.contracts}
          locked={locked}
          lockedCopy={lockedCopy}
          context="autoExit"
          labels={{ ...labels, subjectToken: dialog.token.address }}
          prepare={(session) => ({ key: 'claim', title: `Claim ${dialog.token.label}`, tx: { client: session.autoExit, prepare: () => session.autoExit.prepareClaim(dialog.token.address, recipient.trim().toLowerCase() as Address, null) } })}
          onDone={onChanged}
          onClose={() => setDialog(null)}
        >
          <KeyValueList className="dm-receipt">
            <KeyValue label="You receive">{amountWords(dialog.amount, dialog.token).text}</KeyValue>
            <KeyValue label="Sent to">
              <span className="dm-mono" translate="no">{recipient.trim()}</span>
            </KeyValue>
          </KeyValueList>
        </OneStepDialog>
      )}
    </div>
  )
}
