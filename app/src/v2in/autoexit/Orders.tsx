import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Mandate } from 'api-contracts/read-v6/types'
import { Button, KeyValue, KeyValueList, Pill } from '../../components/ui'
import { createAutoExitClient, type MandateStatusView } from '../../finance/v2/autoExit'
import { browserSignatureJournal } from '../../finance/v2/signatureJournal'
import { v2Wallet } from '../../finance/v2/wallet'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { positionManagerOrNull, v2Chain } from '../../v2/chains'
import type { ErrorLabels } from '../../v2/errors'
import type { V2Gate } from '../../v2/gate'
import type { PriceOrientation } from '../../v2/trigger'
import { ZERO_ADDRESS, type Address, type Hex } from '../../v2/types'
import { AUTO_EXIT_WAITING_TEXT, errorLabels } from '../automate/copy'
import { OneStepDialog } from '../automate/OneStepDialog'
import { waitingWords } from '../automate/portfolio'
import { automationState, recordVaultEvents, rememberRevoked, sessionMandates, sessionRevoked, subscribeAutomation, type SessionMandate } from '../automate/store'
import { amountWords, dateWords, shortAddress, type TokenView } from '../automate/tokens'
import { Details, Fact } from '../automate/ui'
import { VAULT_ACTION_LABEL } from '../automate/VaultCard'
import { vaultActions, type VaultActionKind, type VaultView } from '../automate/vaultView'
import { exitCardState, type ExitTriggers } from './card'
import type { ExitTarget } from './MandateDialog'
import { PastEdge } from './PastEdge'
import { EDGE_PASSED, edgePassed } from './turnBackOn'
import { closedLine, conditionWords, edgesOf, onLine, receiveWords, triggerWords } from './words'

/**
 * A position's Auto-exit on its page (spec F7 §4.5, §4.8; decision #24), ONE card.
 *
 * Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "it is AUTO-EXIT, separate from the rest"): one Auto-exit
 * per position, so no list of orders and no "New order". The card says where it stands in one line, under its title and
 * its "On" pill: "Closes at 2,000 – 3,000 USDG per ETH" (or the one far edge), with ONE control in its head: "Turn off"
 * (revokeMandate, its status read on chain first), or "Turn on" where it can be set up again. A paused one says why, and
 * offers its fix beside that line: "Turn back on" when auto-exit was turned off for its automation (Leave automation does
 * it), "Turn Auto-exit back on" when its position lost the approval (the protection-only automation's rearm). Its terms,
 * the earlier ones and the protection-only automation's own rarely needed actions are under Details. What an exit could
 * not deliver stays in view, to claim to an address the owner chooses (§4.8); a signature made here and never used can be
 * voided. Under the gate's `preview` each dialog stops at its review with the locked sentence.
 *
 * Changed on purpose 2026-10-06 (the review of point 5): the line no longer repeats "Auto-exit on"; the card's head has
 * one control, the fix of a paused one standing beside its line; a closed position says the tokens were sent only when
 * nothing waits to be claimed; the waiting lines are in Auto-exit's words.
 *
 * Changed on purpose 2026-10-06 (the integration review, rugged-literal #1, money #4): while it is on or paused, nothing
 * here cuts the position from its automation ("Remove Domino from this position", "Revoke approval": an exit needs the
 * approval). The automation's rearm is offered only where it is the fix, by what it does: "Approve again" beside a pause
 * for a lost approval, and "Turn on" while none is on (the first part of turning Auto-exit on; its dialog follows). Both
 * ways back on of a paused one (its module here, its approval in the automation's dialog) read the pool's price first: an
 * end the price already passed is said before the wallet opens, with a tick to go on anyway and "Turn off instead".
 *
 * 7 Oct: the owner keeps completed operations in Receipts/Activity. The current control says Completed without
 * claiming a withdrawal or fee: an executed mandate can deliver zero. It still never offers that mandate again.
 */

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
  /**
   * Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 3): auto-exit turned off (Leave automation does it) back on.
   * Changed on purpose 2026-10-06 (the integration review, money #4): with the order it puts back in force.
   */
  | { kind: 'module-on'; vault: Address; id: Hex; triggers: ExitTriggers | null }

/** The protection-only automation's actions this card offers (Pause and Resume never apply to it): one in view, the rest under Details. */
const CARD_ACTIONS: ReadonlySet<VaultActionKind> = new Set<VaultActionKind>(['withdraw', 'return', 'rearm', 'leave', 'unsubscribe', 'revoke', 'recover-token', 'recover-position'])
/** The one in view, by state (as the automation card's primary way out, ../automate/VaultCard.tsx). */
const PRIMARY: readonly VaultActionKind[] = ['return', 'rearm', 'withdraw']
/** Turning a paused Auto-exit back on after Leave automation: its module, as it was signed (never "works again"). */
const MODULE_ON_LEDE = 'Auto-exit is turned back on as you signed it: Domino closes this position when the price reaches the end of your range.'

/**
 * "Turn back on" for an Auto-exit Leave automation paused (its module off): `setExitModule(autoExit)`, one step, the order
 * as it was signed. Changed on purpose 2026-10-06 (the integration review, money #4): the pool's price is read first (and
 * again right before the wallet), and an end of the range it already passed is said before anything is sent: going on
 * closes the position at today's price, with the 0.2% fee, so it takes a tick; "Turn off instead" opens Auto-exit's own
 * Turn off, after which "Turn on" arms only the ends still ahead.
 */
function ModuleOnDialog({ target, vault, order, gate, labels, onTurnOff, onDone, onClose }: {
  target: ExitTarget
  vault: Address
  order: { id: Hex; triggers: ExitTriggers | null }
  gate: Exclude<V2Gate, { mode: 'off' }>
  labels: ErrorLabels
  onTurnOff: () => void
  onDone: () => void
  onClose: () => void
}) {
  const locked = gate.mode === 'preview'
  const [past, setPast] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const acknowledgedNow = useRef(false)
  return (
    <OneStepDialog
      name="module-on"
      title="Turn Auto-exit back on"
      primary="Confirm in wallet"
      chainId={target.chainId}
      contracts={gate.contracts}
      locked={locked}
      lockedCopy={gate.mode === 'preview' ? gate.lockedCopy : ''}
      context="vault"
      labels={labels}
      affected={{ positionManager: positionManagerOrNull(v2Chain(target.chainId), target.dex) ?? undefined, tokenIds: [target.tokenId.toString()], vault }}
      held={past && !acknowledged}
      prepare={async (session) => {
        // Unread here: nothing is said yet; the step reads it again right before the wallet, and says a failure there.
        setPast(await session.serial(() => edgePassed(session, order, target.dex, target.tokenId)).catch(() => false))
        // The vault client reads the module live: only address(0) or the manifest's auto-exit, never twice (§4.1).
        const review = await session.serial(() => session.vault.reviewAction(vault, { kind: 'set-exit-module', module: session.contracts.addresses.autoExit }))
        return {
          key: 'set-exit-module',
          title: 'Turn Auto-exit back on',
          tx: {
            client: session.vault,
            prepare: async () => {
              // Again right before the wallet (in the session's queue already), unless the person ticked to go on anyway.
              if (!acknowledgedNow.current && (await edgePassed(session, order, target.dex, target.tokenId))) throw new Error(EDGE_PASSED)
              return session.vault.prepareStep(review, 0, null)
            },
          },
        }
      }}
      onError={(error) => {
        if (error.code !== EDGE_PASSED) return false
        setPast(true)
        return true
      }}
      // The module on, from the receipt (the final check, F2): the card says it at once, whatever the index still lists.
      onStepDone={(outcome) => {
        if (outcome.receipt) recordVaultEvents(target.chainId, vault, outcome.receipt.events)
      }}
      onDone={onDone}
      onClose={onClose}
    >
      <p className="dm-receipt-lede" data-module-on-lede="">{MODULE_ON_LEDE}</p>
      {past && (
        <PastEdge
          acknowledged={acknowledged}
          onAcknowledge={(next) => {
            acknowledgedNow.current = next
            setAcknowledged(next)
          }}
          onTurnOff={onTurnOff}
        />
      )}
    </OneStepDialog>
  )
}

/** This page's registered Auto-exits of a position the index does not list yet (one per position). */
export function sessionExits(mandates: readonly SessionMandate[], orders: readonly Mandate[], tokenId: bigint): readonly SessionMandate[] {
  const listed = new Set(orders.map((order) => order.mandateHash.toLowerCase()))
  return mandates.filter((m) => m.registered && m.tokenId === tokenId && !listed.has(m.id))
}

export function AutoExitCard({ target, orders, mine, credits, gate, owner, orientation, nowSeconds, offer, protection, stateAvailable, turnOff = 0, renderContent, onDialogOpened, onTurnOn, onVaultAction, onChanged }: {
  /** The position as the card names it: its chain, pool, tokens, and the vault its orders are in (or null). */
  target: ExitTarget
  /** read-v6's orders of this position, in whichever of its vaults holds them. */
  orders: readonly Mandate[]
  /** Registered from this page and not listed yet by the index (sessionExits). */
  mine: readonly SessionMandate[]
  /** What exits could not deliver on this chain's module, above zero. */
  credits: readonly { token: Address; amount: bigint }[]
  gate: Exclude<V2Gate, { mode: 'off' }>
  /** The wallet the screen reads for. */
  owner: Address | null
  orientation: PriceOrientation
  nowSeconds: number
  /** Auto-exit can be turned on here now (none is on): for a plain position, or in its protection-only automation. */
  offer: 'plain' | 'member' | null
  /** The protection-only automation this position is the root of, for its own actions. */
  protection: VaultView | null
  /** No failed or incomplete position/custody read is presented as proof that Auto-exit is off. */
  stateAvailable: boolean
  /**
   * Added 2026-10-06 (the integration review, money #4): moves when the automation's own dialog asks for "Turn off
   * instead" (the price already past an end); this card's Turn off opens then.
   */
  turnOff?: number
  /** Keeps the controller mounted while its management content moves into a Sheet; wallet dialogs stay outside it. */
  renderContent: (content: ReactNode, actionOpen: boolean) => ReactNode
  onDialogOpened?: () => void
  onTurnOn: () => void
  onVaultAction: (kind: VaultActionKind) => void
  onChanged: () => void
}) {
  const chain = v2Chain(target.chainId)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const dialogOpen = dialog !== null
  useEffect(() => { if (dialogOpen) onDialogOpened?.() }, [dialogOpen, onDialogOpened])
  const [recipient, setRecipient] = useState<string>(owner ?? '')
  const store = useSyncExternalStore(subscribeAutomation, automationState, automationState)
  const locked = gate.mode === 'preview'
  const lockedCopy = gate.mode === 'preview' ? gate.lockedCopy : ''
  const labels = useMemo(() => errorLabels(target.chainId, (address) => target.tokens.find((t) => t.address === address.toLowerCase())?.label ?? shortAddress(address)), [target.chainId, target.tokens])
  const vault = target.vault?.address ?? null
  // Signed here and never registered (the page's own journal), live only: their nonce can be cancelled.
  const held = !locked && owner ? browserSignatureJournal().list(target.chainId, owner).filter((entry) => entry.space === 'autoExit' && entry.verifier === gate.contracts.addresses.autoExit && !sessionMandates(store, target.chainId, owner).some((m) => m.registered && m.nonce === entry.nonce)) : []
  const validRecipient = /^0x[0-9a-fA-F]{40}$/.test(recipient.trim()) && recipient.trim().toLowerCase() !== ZERO_ADDRESS
  const state = exitCardState(orders, mine, sessionRevoked(store, target.chainId))
  const active = state.kind === 'on' || state.kind === 'paused' ? orders.find((order) => order.mandateHash.toLowerCase() === state.id) ?? null : null
  const edges = (state.kind === 'on' || state.kind === 'paused') && state.triggers ? edgesOf({ triggerBelowSqrtPriceX96: state.triggers.below, triggerAboveSqrtPriceX96: state.triggers.above }, target.tokens, orientation) : []
  // Waiting for the price to reach an edge is what an Auto-exit that is on does: its line already says where it closes.
  // Changed on purpose 2026-10-06 (the owner's point 5: no "trigger" on screen); anything else it waits for is said.
  const normal = active?.waiting ? active.waiting.reason === 'trigger_not_reached' || active.waiting.error === 'TriggerNotReached' : false
  const waiting = active && state.kind !== 'paused' && !normal ? waitingWords(active.waiting, target.chainId, nowSeconds, null, AUTO_EXIT_WAITING_TEXT) : null
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #1): on or paused, never a way to cut the
  // position from its automation (an exit needs the approval); the rearm only where it is the fix, for a lost approval or
  // as the first part of turning Auto-exit on while none is on.
  const live = state.kind === 'on' || state.kind === 'paused'
  const approvalLost = state.kind === 'paused' && state.reasons.includes('mandate_root_custody_lost')
  const actions = protection
    ? vaultActions(protection).filter((kind) => CARD_ACTIONS.has(kind) && !(live && (kind === 'unsubscribe' || kind === 'revoke')) && (kind !== 'rearm' || approvalLost || state.kind === 'off'))
    : []
  const primary = PRIMARY.find((kind) => actions.includes(kind)) ?? null
  const more = actions.filter((kind) => kind !== primary && kind !== 'leave')
  /**
   * The protection-only automation's own action as this card names it, by what it does here: its rearm is the approval
   * back for a paused Auto-exit, or the first part of turning one on (never "Turn Auto-exit back on"); this card is the
   * only place that offers it (../automate/VaultCard.tsx never does).
   */
  const actionLabel = (kind: VaultActionKind): string => (kind === 'rearm' ? (approvalLost ? 'Approve again' : 'Turn on') : VAULT_ACTION_LABEL[kind])
  // The head has ONE control. Paused, it is "Turn off": the automation's own fix (its rearm, its reserves) stands beside
  // the line that says why. Off or closed with nothing to turn on here, that fix takes the head.
  const fixBeside = state.kind === 'paused' && !offer ? primary : null
  const fixInHead = state.kind !== 'on' && state.kind !== 'paused' && !offer ? primary : null
  // Off, with Auto-exit to turn on here: offered at once, or after its automation takes the position back (the rearm).
  const canTurnOn = offer !== null || fixInHead === 'rearm'
  // Nothing to say on a plain position with none on: the page's actions row has the button (no empty card).
  const quiet = state.kind === 'off' && orders.length === 0 && credits.length === 0 && held.length === 0 && protection === null
  // "Turn off instead" from the automation's own dialog (money #4): this card's Turn off opens.
  const [askedOff, setAskedOff] = useState(turnOff)
  if (askedOff !== turnOff) {
    setAskedOff(turnOff)
    if (live) setDialog({ kind: 'cancel', id: state.id })
  }

  const pill = state.kind === 'on' ? <Pill tone="in" dot data-exit-pill="on">On</Pill>
    : state.kind === 'paused' ? <Pill tone="wait" dot data-exit-pill="paused">Paused</Pill>
      : state.kind === 'closed' ? <Pill tone="neutral" data-exit-pill="closed">Completed</Pill>
        // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no pill while the state is not read ("State unavailable").
        : !stateAvailable ? <span hidden data-exit-pill="unknown" /> : <Pill tone="neutral" data-exit-pill="off">Off</Pill>
  const line = state.kind === 'on' ? onLine(edges, target.tokens, orientation)
    : state.kind === 'paused' ? conditionWords(state.reasons[0], chain.name)
      : state.kind === 'closed' ? closedLine(credits.length > 0)
        // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): no line ("Auto-exit data is unavailable. Your recoverable funds remain below.").
        : !stateAvailable ? null
          : canTurnOn ? 'Auto-exit is off. Turn it on to close this position at the end of its range.' : 'Auto-exit is off for this position.'

  const content = (
    // One title, one pill, one line, one button (the owner, 2026-10-03: few words; the rest under Details).
    <section hidden={quiet} className="dm-automation-summary dm-exit-card" aria-label="Auto-exit" data-v2in-exit={offer ?? 'orders'} data-exit-orders={orders.length + mine.length} data-exit-state={state.kind}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {pill}
        </div>
        {(state.kind === 'on' || state.kind === 'paused') && (
          <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: 'cancel', id: state.id })} data-order-cancel="" data-exit-off="">
            Turn off
          </Button>
        )}
        {/* Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §4 item 7): while none is on, never after an exit. */}
        {state.kind === 'off' && offer && (
          <Button type="button" variant="primary" size="sm" onClick={onTurnOn} data-v2in-open="mandate">
            Turn on
          </Button>
        )}
        {fixInHead && (
          <Button type="button" variant="primary" size="sm" onClick={() => onVaultAction(fixInHead)} data-vault-open={fixInHead}>
            {actionLabel(fixInHead)}
          </Button>
        )}
      </div>
      {/* (2026-10-15, pack 7 review): only when there is a line; the state not read has none, so no empty paragraph. */}
      {line && (
        <p className="text-body text-fg-muted dm-exit-card-line" data-v2in-exit-line={state.kind === 'off' ? (!stateAvailable ? 'unknown' : canTurnOn ? 'open' : 'off') : state.kind}>
          {line}
        </p>
      )}
      {waiting && <p className="dm-acct-note" data-order-waiting={waiting.code}>{waiting.text}</p>}
      {state.kind === 'paused' && state.moduleOff && vault && (
        <div className="dm-exit-card-actions" data-orders-module-off="">
          <Button type="button" variant="primary" size="sm" onClick={() => setDialog({ kind: 'module-on', vault, id: state.id, triggers: state.triggers })} data-order-module-on="">
            Turn back on
          </Button>
        </div>
      )}
      {fixBeside && !(state.kind === 'paused' && state.moduleOff) && (
        <div className="dm-exit-card-actions" data-exit-fix={fixBeside}>
          <Button type="button" variant="primary" size="sm" onClick={() => onVaultAction(fixBeside)} data-vault-open={fixBeside}>
            {actionLabel(fixBeside)}
          </Button>
        </div>
      )}
      {actions.includes('leave') && <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => onVaultAction('leave')} data-vault-more="leave">{VAULT_ACTION_LABEL.leave}</Button>}
      {credits.length > 0 && (
        <div className="dm-inset dm-acct-perf-form" data-claim="">
          <h3 className="dm-acct-subtitle">Funds available to your wallet</h3>
          <p className="dm-hint">Auto-exit could not deliver these funds. This balance may include other positions on this network.</p>
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
          <Details label="Send to another address">
            <label className="dm-label dm-acct-lf">
              Send to
              <input className="dm-field dm-acct-mono-field" value={recipient} spellCheck={false} autoComplete="off" onChange={(event) => setRecipient(event.target.value)} data-claim-recipient="" aria-invalid={validRecipient ? undefined : true} />
            </label>
            {!validRecipient && <p className="dm-error">Choose a valid address to receive the funds.</p>}
          </Details>
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
      {held.length > 0 && (
        <div className="dm-inset dm-acct-perf-form" data-held-orders="">
          <h3 className="dm-acct-subtitle">Signed, never turned on</h3>
          <p className="dm-hint">You signed an Auto-exit here that was never turned on. Cancel the signature so it can never be used.</p>
          {held.map((entry) => (
            <div key={entry.nonce.toString()} className="flex flex-wrap items-center gap-2" data-held-order={entry.nonce.toString()}>
              <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: 'cancel-signed', nonce: entry.nonce })} data-held-cancel="">
                Cancel signature
              </Button>
            </div>
          ))}
        </div>
      )}
      {(active || more.length > 0) && (
        <Details data-exit-details="">
          <div className="grid gap-3">
            {active?.terms && (
              <KeyValueList data-order={active.mandateHash.toLowerCase()} data-order-status="active">
                {/* Changed on purpose 2026-10-06 (the final check, F7): each end by the way the price moves to reach it, the
                    falling one first, as the card's line and the dialog say them; never by the pool's field, which on a pool
                    written the other way round (ETH per TOKEN) makes the lower trigger the highest price shown. */}
                {edges.map((edge) => (
                  <KeyValue key={edge.field} label={edge.move === 'falls' ? 'Lower end' : 'Upper end'} data-exit-end={edge.move}>
                    {triggerWords(edge.field, edge.sqrtPriceX96, target.tokens, orientation)}
                  </KeyValue>
                ))}
                <KeyValue label="You receive">{receiveWords(active.terms.receive === 'both' ? 0 : 1, active.terms.convertTo ?? ZERO_ADDRESS, target.tokens)}</KeyValue>
                <KeyValue label="Slippage limit">{`${active.terms.maxSlippageBps / 100}% on top of the pool fee`}</KeyValue>
                <KeyValue label="Valid until">{dateWords(active.validUntil)}</KeyValue>
              </KeyValueList>
            )}
            {active && state.kind === 'paused' && state.reasons.slice(1).map((key) => (
              <p key={key} className="dm-acct-note" data-order-condition={key}>{conditionWords(key, chain.name)}</p>
            ))}
            {more.length > 0 && (
              <div className="dm-v2in-advanced" data-exit-vault-actions="">
                {more.map((kind) => (
                  <Button key={kind} type="button" size="sm" variant="outline" onClick={() => onVaultAction(kind)} data-vault-more={kind}>
                    {actionLabel(kind)}
                  </Button>
                ))}
              </div>
            )}
            {active && <Fact label="Auto-exit id">{active.mandateHash.toLowerCase()}</Fact>}
          </div>
        </Details>
      )}
    </section>
  )
  return (
    <>
      {renderContent(content, dialogOpen)}
      {dialog?.kind === 'module-on' && (
        <ModuleOnDialog
          target={target}
          vault={dialog.vault}
          order={{ id: dialog.id, triggers: dialog.triggers }}
          gate={gate}
          labels={labels}
          onTurnOff={() => setDialog({ kind: 'cancel', id: dialog.id })}
          onDone={onChanged}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'cancel' && (
        <OneStepDialog
          name="cancel-order"
          title="Turn off Auto-exit"
          primary="Turn off in wallet"
          chainId={target.chainId}
          contracts={gate.contracts}
          locked={locked}
          lockedCopy={lockedCopy}
          context="autoExit"
          labels={labels}
          affected={{ positionManager: positionManagerOrNull(chain, target.dex) ?? undefined, tokenIds: [target.tokenId.toString()], ...(vault ? { vault } : {}) }}
          prepare={async (session) => {
            // The order's status read on chain first (§4.5): only an active order of this wallet is cancelled.
            const status: MandateStatusView = await session.serial(() => session.autoExit.status(dialog.id))
            if (status.status !== 'active') throw new Error('mandate_not_active')
            if (!status.ownedByWallet) throw new Error('mandate_not_owner')
            return { key: 'revoke-mandate', title: 'Turn off Auto-exit', tx: { client: session.autoExit, prepare: () => session.autoExit.prepareRevoke(dialog.id, null) } }
          }}
          onDone={() => {
            // Turned off: said at once, whatever the index still lists (2026-10-06, the owner's point 5).
            rememberRevoked(target.chainId, dialog.id)
            onChanged()
          }}
          onClose={() => setDialog(null)}
        >
          <p className="dm-receipt-lede">Domino will no longer close this position by itself. Your position stays as it is.</p>
        </OneStepDialog>
      )}
      {dialog?.kind === 'cancel-signed' && (
        <OneStepDialog
          name="cancel-signed"
          title="Cancel signature"
          primary="Cancel in wallet"
          chainId={target.chainId}
          contracts={gate.contracts}
          locked={locked}
          lockedCopy={lockedCopy}
          context="autoExit"
          labels={labels}
          affected={{ tokenIds: [], ...(vault ? { vault } : {}) }}
          prepare={(session) => ({ key: 'cancel-nonce', title: 'Cancel this signature', tx: { client: session.autoExit, prepare: () => session.autoExit.prepareCancelNonce(dialog.nonce, null) } })}
          onDone={onChanged}
          onClose={() => setDialog(null)}
        >
          <p className="dm-receipt-lede">An Auto-exit you signed and never turned on is voided, so it can never be used.</p>
          <Fact label="Signature number">{dialog.nonce.toString()}</Fact>
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
          affected={{ tokenIds: [], ...(vault ? { vault } : {}) }}
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
    </>
  )
}
