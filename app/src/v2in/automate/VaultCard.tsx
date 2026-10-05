import type { ReactNode } from 'react'
import { Button, KeyValue, KeyValueList, Pill } from '../../components/ui'
import { automationFeeText } from '../../finance/v2/vault'
import { v2Chain } from '../../v2/chains'
import type { PriceOrientation } from '../../v2/trigger'
import { ChainBadge } from '../lists/parts'
import { DISARM_UNKNOWN, RESERVES_TEXT } from './copy'
import { nextPositionWords, type VaultMemberView } from './portfolio'
import type { VaultDialogKind, VaultDialogSubject } from './VaultDialog'
import { amountWords, rangeWords, referenceOrientation, shortAddress, type TokenView } from './tokens'
import { Details } from './ui'
import { memberStateWords, reservesOffer, sinceWords, splitReserves, VAULT_ADVANCED_ACTIONS, vaultActions, type VaultView } from './vaultView'

/**
 * One vault, in the look of the screen it sits on (spec F7 rev3/rev4 §2.13, §5.3–§5.6, §8.2), beginner-first (the
 * review of 2026-10-03, #8): what a person who knows nothing about liquidity pools needs, and nothing else above the fold.
 *   - `page`: a card of the position's own page (components' `dm-pos-card`), titled Automation: its chain (§8.2 "every
 *     object shows its chain"), its state as a pill, ONE sentence (why it waits, rev4's reserves reasons first; else its
 *     state in §5.4's words, or the spec's own sentence for a running vault), ONE figure (§5.6's `reserves(token)`: "Fees
 *     collected, not yet reinvested", in every state of the vault and its root, never `owedFees`) and at most TWO buttons:
 *     the primary way out for the state ("Return my reserves" once the root is closed and no successor is active, "Turn
 *     back on" after a manual action, else "Withdraw to wallet" whenever a reserve is above zero) and "Leave automation"
 *     (exitAll, the main way out). Everything else is under a closed Details: the mode and its fee, the idle part ("Not
 *     used by automation"), the two hints, §5.5's sequence (root → successors, each with its state, its range in the
 *     reference currency's orientation and the other way round, and its two lots), the other actions (Pause, Resume, the
 *     other way with the fees, "Withdraw #id from the vault" beside an active successor) and §5.6's two recoveries.
 *   - `row`: a row of Managed positions (screens/Performance.tsx's `dm-mp-row`), named by its position: the name, the
 *     chain chip, the pill, the figure line and the one primary button. Its page has the rest.
 * Each button opens its dialog (./VaultDialog.tsx).
 */

const PILL_TONE = { on: 'in', paused: 'wait', protection: 'neutral', off: 'out' } as const
const MEMBER_TONE: Readonly<Record<VaultMemberView['state'], 'in' | 'out' | 'neutral'>> = { armed: 'in', active: 'in', disarmed: 'out', exited: 'neutral', withdrawn: 'neutral', inactive: 'neutral', unknown: 'neutral' }
/** The spec's own sentence for a running vault (F7 rev4 §2.13), as written. */
const ON_TEXT = "Your automation reinvests this position's fees. If you change it, move it or approve another app, it stops for this position until you turn it back on."
const PAUSED_TEXT = 'Nothing is reinvested while automation is paused.'
const PROTECTION_TEXT = "Domino doesn't reinvest this position. It only watches your stop-loss and take-profit."
const RETURN_HINT = 'Your position is closed. Return these fees now, or leave it: Domino returns them on its next pass. No fee either way.'
const COLLECTED_LABEL = 'Fees collected, not yet reinvested'
/** rugged97's F7 delta of 5 Oct, §5.5 ("Na tela"): a Domino-compound vault's next position, on its own line. */
const NEXT_LABEL = 'Next position'
const IDLE_LABEL = 'Not used by automation'
const ADVANCED_TEXT = 'Rarely needed: take back something your automation holds outside its fees (another token, ETH, what a route left behind), or a position it holds without managing.'
/** The primary way out, by state; the first offered wins (return and rearm never are at once). */
const PRIMARY_ORDER: readonly VaultDialogKind[] = ['return', 'rearm', 'withdraw', 'unsubscribe', 'revoke']

export function statusWords(view: VaultView): string {
  switch (view.status) {
    case 'protection': return 'Protection only'
    case 'off': return 'Automation off'
    case 'on': return 'Automation on'
    case 'paused': return view.pausedBy === 'you' ? 'Paused by you' : view.pausedBy === 'Domino' ? 'Paused by Domino' : 'Paused'
    default: return 'Automation'
  }
}

function modeWords(view: VaultView): string | null {
  if (view.status === 'protection' || view.mode === null) return null
  return view.mode === 2 ? `Domino-compound: ${automationFeeText(2)} of reinvested fees` : `Auto-compound: ${automationFeeText(1)} of reinvested fees`
}

/** One amount per pool token as "1.5 USDG + 990 raw units of MANY", only those above zero; "0" when none; a dash with its reason when unread. */
function AmountsWords({ list, tokens, name }: { list: readonly { token: string; amount: bigint }[]; tokens: readonly [TokenView, TokenView] | null; name: string }) {
  const held = list.filter((r) => r.amount > 0n)
  if (held.length === 0) return <span data-reserves="none">0</span>
  return (
    <span className="tnum" data-reserves="held">
      {held.map((r, i) => {
        const token = tokens?.find((t) => t.address === r.token)
        const words = token ? amountWords(r.amount, token) : { text: `${r.amount} raw units of ${shortAddress(r.token)}`, exact: `${r.amount} raw units of ${r.token}` }
        return (
          <span key={r.token} title={words.exact} data-reserve={r.token} data-reserve-part={name}>
            {i > 0 && ' + '}
            {words.text}
          </span>
        )
      })}
    </span>
  )
}

/** The vault's reserves in one of §5.6's two figures (`part`), or a dash with its reason when unread. */
export function ReservesWords({ view, tokens, part = 'collected' }: { view: VaultView; tokens: readonly [TokenView, TokenView] | null; part?: 'collected' | 'idle' }) {
  if (!view.reserves.known) return <span title={`Not read: ${view.reserves.reason.replaceAll('_', ' ')}`} data-reserves="unread">—</span>
  return <AmountsWords list={splitReserves(view.reserves.list)[part]} tokens={tokens} name={part} />
}

const LABEL: Readonly<Record<VaultDialogKind, string>> = {
  withdraw: 'Withdraw to wallet',
  return: 'Return my reserves',
  rearm: 'Turn back on',
  pause: 'Pause',
  resume: 'Resume',
  leave: 'Leave automation',
  unsubscribe: 'Remove Domino from this position',
  revoke: 'Revoke approval',
  'withdraw-child': 'Withdraw from your automation',
  'recover-token': 'Recover a token',
  'recover-position': 'Recover a position',
}

/** A tick as text, a typographic minus for the negative ones. */
const tickText = (tick: number): string => (tick < 0 ? `−${-tick}` : String(tick))

/**
 * A member's range (§5.5): in the reference currency's orientation first, then the other way round; the ticks when a
 * price cannot be written (a token's decimals not read, or the reference not one of the pool's tokens), never guessed.
 */
function RangeWords({ range, tokens, reference }: { range: VaultMemberView['range']; tokens: readonly [TokenView, TokenView] | null; reference: PriceOrientation | null }) {
  if (!range) return <span title="Your automation's ledger was not read" data-member-range="unread">—</span>
  const other: PriceOrientation | null = reference === 'token1PerToken0' ? 'token0PerToken1' : reference === 'token0PerToken1' ? 'token1PerToken0' : null
  const first = tokens ? rangeWords(range.tickLower, range.tickUpper, tokens, reference) : null
  const second = tokens ? rangeWords(range.tickLower, range.tickUpper, tokens, other) : null
  if (!first) {
    return (
      <span className="tnum" title="A token's decimals were not read: the range is shown as ticks" data-member-range="ticks">
        ticks {tickText(range.tickLower)} to {tickText(range.tickUpper)}
      </span>
    )
  }
  return (
    <span data-member-range="prices">
      <span className="tnum">{first}</span>
      {second && <span className="text-fg-subtle"> · the other way round, {second}</span>}
    </span>
  )
}

/** A member's two lots per pool token: "Fees collected: … · fee already taken: …" (raw units when a token's decimals are unknown). */
function LotsWords({ lots, tokens }: { lots: VaultMemberView['lots']; tokens: readonly [TokenView, TokenView] | null }) {
  if (lots.length === 0) return <span title="Your automation's ledger was not read" data-member-lots="unread">Fees collected: —</span>
  const words = (amount: bigint, address: string) => {
    const token = tokens?.find((t) => t.address === address)
    return token ? amountWords(amount, token).text : `${amount} raw units of ${shortAddress(address)}`
  }
  return (
    <span className="tnum" data-member-lots="">
      Fees collected: {lots.map((lot) => words(lot.uncharged, lot.token)).join(' + ')} · fee already taken: {lots.map((lot) => words(lot.charged, lot.token)).join(' + ')}
    </span>
  )
}

/** §5.5 "Na tela": the sequence, root first, each member's state, range and lots, and the owner's offer on an active successor. */
function Sequence({ view, tokens, offerChild, onAction }: { view: VaultView; tokens: readonly [TokenView, TokenView] | null; offerChild: boolean; onAction: (kind: VaultDialogKind, subject?: VaultDialogSubject) => void }) {
  const reference = view.pool && view.quoteCurrency ? referenceOrientation(view.pool, view.quoteCurrency) : null
  return (
    <ol className="dm-v2in-sequence" aria-label="Positions in this automation" data-vault-sequence={view.members.length}>
      {view.members.map((member) => (
        <li key={member.tokenId.toString()} data-vault-member={member.tokenId.toString()} data-member-role={member.role} data-member-state={member.state}>
          <span className="dm-v2in-member-head">
            <span className="font-medium">#{member.tokenId.toString()}</span>
            <span className="text-fg-muted">{member.role === 'root' ? 'Your position' : 'Next position'}</span>
            <span className={`dm-pill dm-pill--${MEMBER_TONE[member.state]} dm-acct-status`}>{memberStateWords(member.state)}</span>
          </span>
          <p className="dm-acct-note">
            Range: <RangeWords range={member.range} tokens={tokens} reference={reference} />
          </p>
          <p className="dm-acct-note">
            <LotsWords lots={member.lots} tokens={tokens} />
          </p>
          {offerChild && member.role === 'successor' && member.state === 'active' && (
            <Button type="button" size="sm" variant="outline" onClick={() => onAction('withdraw-child', { tokenId: member.tokenId })} data-vault-child={member.tokenId.toString()}>
              Withdraw #{member.tokenId.toString()} from your automation
            </Button>
          )}
        </li>
      ))}
    </ol>
  )
}

export function VaultCard({ view, tokens, variant, nowSeconds, positionHref, onAction, children }: {
  view: VaultView
  tokens: readonly [TokenView, TokenView] | null
  variant: 'page' | 'row'
  nowSeconds: number
  /** The root position's own page (rows link to it). */
  positionHref?: string | null
  onAction: (kind: VaultDialogKind, subject?: VaultDialogSubject) => void
  children?: ReactNode
}) {
  const offer = reservesOffer(view)
  const actions = vaultActions(view)
  const primary = PRIMARY_ORDER.find((kind) => actions.includes(kind)) ?? null
  const leave = actions.includes('leave')
  // The rest, under Details: the other way with the fees, Pause or Resume; a successor's offer sits beside its id, the two recoveries come last.
  const more = actions.filter((kind) => kind !== primary && kind !== 'leave' && kind !== 'withdraw-child' && !VAULT_ADVANCED_ACTIONS.has(kind))
  const advanced = actions.filter((kind) => VAULT_ADVANCED_ACTIONS.has(kind))
  const chainName = v2Chain(view.chainId).name
  const since = view.disarm ? sinceWords(view.disarm.since, nowSeconds) : null
  const off = view.armed === false || view.status === 'off'
  const state = off
    ? `${view.disarm?.text ?? DISARM_UNKNOWN}${since ? ` · ${since}` : ''}`
    : view.status === 'protection' ? PROTECTION_TEXT : view.status === 'paused' ? PAUSED_TEXT : ON_TEXT
  // The one sentence: why it waits (rev4's reserves reasons first), else its state; the other goes under Details.
  const line = view.waiting ? view.waiting.text : state
  // Added 2026-10-05 (rugged97's F7 delta of 5 Oct, §5.5: the automation mints Domino-compound's successors): when the next
  // position opens, for a Domino-compound vault still running (a vault that is off or whose root closed opens none).
  const next = off || view.rootClosed === true ? null : nextPositionWords(view)
  // §5.4's reason travels with its sentence, wherever that stands.
  const disarmReason = off ? String(view.disarm?.reason ?? 'unknown') : undefined
  const data = { 'data-vault-card': view.vault, 'data-vault-chain': view.chainId, 'data-vault-status': view.status ?? 'unknown', 'data-vault-armed': view.armed === null ? 'unknown' : view.armed ? 'yes' : 'no', 'data-vault-reserves': view.reserves.known ? (view.reserves.held ? 'held' : 'none') : 'unread', 'data-vault-source': view.source }

  if (variant === 'row') {
    return (
      <li className="dm-mp-row" {...data}>
        <div className="dm-mp-head">
          {positionHref ? <a className="dm-mp-name" href={positionHref}>Position #{view.rootTokenId.toString()}</a> : <span className="dm-mp-name">Position #{view.rootTokenId.toString()}</span>}
          <span className="flex flex-wrap items-center gap-1.5">
            <ChainBadge name={chainName} chainId={view.chainId} compact />
            <span className={`dm-pill dm-pill--${PILL_TONE[view.status ?? 'off']} dm-acct-status`}>{statusWords(view)}</span>
          </span>
        </div>
        <p className="dm-acct-note" data-vault-held="">
          {COLLECTED_LABEL}: <ReservesWords view={view} tokens={tokens} />
        </p>
        {primary && (
          <div data-vault-actions="">
            <Button type="button" size="sm" variant="primary" onClick={() => onAction(primary)} data-vault-open={primary}>
              {LABEL[primary]}
            </Button>
          </div>
        )}
      </li>
    )
  }

  return (
    <section className="dm-card dm-pos-card" aria-label="Automation" {...data}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="dm-title">Automation</h2>
        <ChainBadge name={chainName} chainId={view.chainId} />
        <Pill tone={PILL_TONE[view.status ?? 'off']} dot data-vault-pill="">
          {statusWords(view)}
        </Pill>
      </div>
      <p className="text-body" data-vault-state="" data-vault-waiting={view.waiting?.code} data-disarm-reason={view.waiting ? undefined : disarmReason}>
        {line}
      </p>
      <KeyValueList>
        <KeyValue label={COLLECTED_LABEL} data-vault-held="">
          <ReservesWords view={view} tokens={tokens} />
        </KeyValue>
        {next && (
          <KeyValue label={NEXT_LABEL} data-vault-next="">
            {next}
          </KeyValue>
        )}
      </KeyValueList>
      {(primary || leave) && (
        <div className="flex flex-wrap items-center gap-2" data-vault-actions="">
          {primary && (
            <Button type="button" size="sm" variant="primary" onClick={() => onAction(primary)} data-vault-open={primary}>
              {LABEL[primary]}
            </Button>
          )}
          {leave && (
            <Button type="button" size="sm" variant="danger" onClick={() => onAction('leave')} data-vault-open="leave">
              {LABEL.leave}
            </Button>
          )}
        </div>
      )}
      <Details data-vault-details="">
        <div className="grid gap-3">
          {view.waiting && <p className="dm-acct-note" data-vault-detail="state" data-disarm-reason={disarmReason}>{state}</p>}
          {offer.withdraw && <p className="dm-acct-note" data-reserves-text="">{RESERVES_TEXT}</p>}
          {offer.returnable && <p className="dm-acct-note" data-return-hint="">{RETURN_HINT}</p>}
          <KeyValueList>
            {modeWords(view) && <KeyValue label="Automation">{modeWords(view)}</KeyValue>}
            <KeyValue label={IDLE_LABEL} data-vault-idle="">
              <ReservesWords view={view} tokens={tokens} part="idle" />
            </KeyValue>
          </KeyValueList>
          {view.members.length > 0 && <Sequence view={view} tokens={tokens} offerChild={actions.includes('withdraw-child')} onAction={onAction} />}
          {more.length > 0 && (
            <div className="dm-v2in-advanced" data-vault-more-actions="">
              {more.map((kind) => (
                <Button key={kind} type="button" size="sm" variant="outline" onClick={() => onAction(kind)} data-vault-more={kind}>
                  {LABEL[kind]}
                </Button>
              ))}
            </div>
          )}
          {advanced.length > 0 && (
            <>
              <p className="dm-acct-note" data-vault-advanced="">{ADVANCED_TEXT}</p>
              <div className="dm-v2in-advanced">
                {advanced.map((kind) => (
                  <Button key={kind} type="button" size="sm" variant="outline" onClick={() => onAction(kind)} data-vault-advanced-open={kind}>
                    {LABEL[kind]}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      </Details>
      {children}
    </section>
  )
}
