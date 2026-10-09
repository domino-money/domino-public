import type { PortfolioResponse, Vault } from 'api-contracts/read-v6/types'
import { liveCustody, type VaultSnapshot } from '../../finance/v2/vault'
import { v2Chain } from '../../v2/chains'
import type { Address, Dex, V2ChainId, VaultLimits, VaultPolicy } from '../../v2/types'
import { AUTO_EXIT_WAITING_TEXT, DISARM_5_ADDED, DISARM_TEXT, DISARM_UNKNOWN } from './copy'
import { exitStandingOf, exitVaultOf, protectionStanding, type ProtectionStanding } from '../autoexit/standing'
import { agoWords, DISARM_REASON_NUMBER, listedMembers, listedPaused, listedReserves, vaultStatus, waitingWords, type VaultMemberView, type VaultStatus } from './portfolio'
import { rawFromText, tokenView, wholeFromText, type TokenView } from './tokens'

/**
 * One vault as the integrated screens show it (the Managed positions rows, a position's automation card), from either
 * source, never mixed (the integration brief's data rule):
 *   - `listing`: read-v6's `portfolio.vaults` item (the site's route, about the connected wallet, under `preview` and
 *     `live` alike). Its state is the index's last read, at its block.
 *   - `chain`: the vault client's `readVault`, every figure at one block through the wallet (`live` only), with what only
 *     read-v6 knows (why it waits, who paused it, why its root is disarmed) taken from its listing while that listing
 *     was read at the very same `stateNonce`; never guessed otherwise.
 * Rev3/rev4 (§2.13, §5.6): the reserves are there in every state of the vault and its root; whether the root is closed
 * (no liquidity left, or burned) decides whether "Return my reserves" is offered (`returnReserves()`: the root closed
 * and no successor active). Pure.
 */

export interface VaultReserve {
  token: Address
  /** "Fees collected, not yet reinvested": idle plus every member's lots. */
  total: bigint
  /** "Not used by automation". */
  idle: bigint
}

export type ReservesView = { known: true; list: readonly VaultReserve[]; held: boolean } | { known: false; reason: string }

export interface VaultView {
  source: 'listing' | 'chain'
  chainId: V2ChainId
  vault: Address
  dex: Dex
  owner: Address
  /** Whether the wallet the screen reads for is this vault's owner (only then is anything offered). */
  ownedByWallet: boolean
  rootTokenId: bigint
  /** The pool's two tokens, in pool order; null when the listing's state was not read. */
  pool: { currency0: Address; currency1: Address; fee: number } | null
  /** 1 Auto-compound, 2 Domino-compound; null when unknown. */
  mode: 1 | 2 | null
  policy: VaultPolicy | null
  limits: VaultLimits | null
  /** 'protection' (paused, auto-exit on: decision #25), 'off' (root not armed), 'paused', 'on'; null when unknown. */
  status: VaultStatus | null
  /** "Paused by you" / "Paused by Domino" when known. */
  pausedBy: 'you' | 'Domino' | null
  /** Live custody of the root (chain), or the listing's; null when unknown. */
  armed: boolean | null
  /** Why the root is not armed, in §5.4's words, and since when; null while armed or unknown. */
  disarm: { reason: number | 'unknown'; text: string; since: number | null } | null
  /** The root has no liquidity left or no longer exists; null when not known. */
  rootClosed: boolean | null
  /** The vault's active successors (Domino-compound's next positions, held by the vault). */
  successors: readonly bigint[]
  /**
   * §5.5's sequence: the root first, then its successors, each with its state, its range as ticks and its two lots
   * (./portfolio.ts VaultMemberView). Empty when neither the listing's history nor its ledger was read.
   */
  members: readonly VaultMemberView[]
  /** The vault's reference currency (`quoteCurrency()`), one of the pool's two tokens; null when its state was not read. */
  quoteCurrency: Address | null
  reserves: ReservesView
  /** "Waiting: … · since …" (decision #24; rev4's reserves reasons first). */
  waiting: { text: string; code: string } | null
  autoExitEnabled: boolean
  paused: boolean | null
  /**
   * Added 2026-10-06 (the review of point 5): for Auto-exit's own vault, where its Auto-exit stands from read-v6's orders
   * of its root (../autoexit/standing.ts: on, paused, off, closed); null for any other vault. Changed on purpose
   * 2026-10-06 (the integration review, rugged-literal #2): Auto-exit's own also after Leave automation turned its module
   * off (../autoexit/standing.ts exitVaultOf).
   */
  exit: ProtectionStanding | null
  /**
   * What still links the root to the vault after automation ended for it (§5.6 "Depois do exitAll numa v4"): the vault
   * as the v4 position's subscriber, the vault's individual approval, and whether the owner still holds the root. Null
   * when unknown. Only these make "Remove Domino from this position" and "Revoke approval" possible.
   */
  links: { subscribed: boolean | null; approved: boolean | null; ownerHolds: boolean | null }
}

/**
 * §5.4's sentence for a disarm reason, or the unknown one. Reason 5's second sentence ("Domino may turn it back on
 * automatically.") only when the data says the change was liquidity someone else merely added (`liquidityAdded` true):
 * read-v6 rc.1's custody says nothing of it, so the screens pass null and the sentence is never guessed.
 */
export function disarmText(reason: number | 'unknown', liquidityAdded: boolean | null = null): string {
  if (reason === 'unknown') return DISARM_UNKNOWN
  const text = DISARM_TEXT[reason] ?? DISARM_UNKNOWN
  return reason === 5 && liquidityAdded === true ? `${text} ${DISARM_5_ADDED}` : text
}

/** Whether a listed vault's root is closed, from what the listing says (its custody reason, its members, its root's live read). */
export function listedRootClosed(vault: Vault, body: PortfolioResponse): boolean | null {
  if (vault.custody.reason === 'burned' || vault.custody.reason === 'auto_exit') return true
  const root = vault.members.find((member) => member.role === 'root')
  if (root && (root.disarmReason === 'burned' || root.disarmReason === 'auto_exit')) return true
  const position = body.positions.find((p) => p.chainId === vault.chainId && p.dex === vault.dex && p.tokenId === vault.rootTokenId)
  if (position?.state.status === 'live') return position.state.liquidity === '0'
  return null
}

const policyOf = (vault: Vault): VaultPolicy | null => {
  if (vault.state.status !== 'read') return null
  const p = vault.state.policy
  return Object.freeze({ mode: p.mode === 'domino' ? 2 : 1, triggerDistanceBps: p.triggerDistanceBps, maxOverlapBps: p.maxOverlapBps, minimumIntervalSeconds: p.minimumIntervalSeconds, maxPositions: p.maxPositions })
}

/** A listed vault (read-v6) as the screens show it. `wallet`: who the answer is about (the connected wallet). */
export function vaultViewFromListing(vault: Vault, body: PortfolioResponse, wallet: Address, nowSeconds: number): VaultView {
  const status = vaultStatus(vault)
  const state = vault.state.status === 'read' ? vault.state : null
  const reserves = listedReserves(vault)
  const armed = vault.custody.armed
  const disarmReason = armed === false || vault.custody.reason !== null
    ? (vault.custody.reason ? DISARM_REASON_NUMBER[vault.custody.reason] : 'unknown')
    : null
  const policy = policyOf(vault)
  const exit = protectionStanding(vault, body.mandates ?? [])
  return Object.freeze({
    source: 'listing' as const,
    chainId: vault.chainId,
    vault: vault.address.toLowerCase() as Address,
    dex: vault.dex,
    owner: vault.owner.toLowerCase() as Address,
    ownedByWallet: vault.owner.toLowerCase() === wallet.toLowerCase(),
    rootTokenId: BigInt(vault.rootTokenId),
    pool: state ? Object.freeze({ currency0: state.pool.currency0.toLowerCase() as Address, currency1: state.pool.currency1.toLowerCase() as Address, fee: state.pool.fee }) : null,
    mode: policy ? policy.mode : null,
    policy,
    limits: state ? Object.freeze({ ...state.limits }) : null,
    status,
    pausedBy: listedPaused(vault) ? (vault.pausedBy === 'owner' ? 'you' as const : vault.pausedBy === 'operator' ? 'Domino' as const : null) : null,
    armed: armed === null ? (disarmReason !== null ? false : null) : armed,
    disarm: disarmReason === null ? null : Object.freeze({ reason: disarmReason, text: disarmText(disarmReason), since: vault.custody.since?.snapshot.timestamp ?? null }),
    rootClosed: listedRootClosed(vault, body),
    successors: Object.freeze(vault.members.filter((member) => member.role === 'successor' && member.status === 'active').map((member) => BigInt(member.tokenId))),
    members: listedMembers(vault),
    quoteCurrency: state ? (state.quoteCurrency.toLowerCase() as Address) : null,
    reserves: reserves.known ? Object.freeze({ known: true as const, list: reserves.reserves, held: reserves.held }) : Object.freeze({ known: false as const, reason: reserves.reason }),
    waiting: waitingWords(vault.waiting, vault.chainId, nowSeconds, { maxPositions: policy?.maxPositions ?? null }, exit !== null ? AUTO_EXIT_WAITING_TEXT : null),
    autoExitEnabled: vault.autoExitEnabled,
    paused: state ? state.paused : vault.pausedBy !== null ? true : null,
    exit,
    links: listedLinks(vault, body),
  })
}

/** The root's links to its vault as the listing read them live (its position's `custody` and owner), or unknown. */
function listedLinks(vault: Vault, body: PortfolioResponse): VaultView['links'] {
  const position = body.positions.find((p) => p.chainId === vault.chainId && p.dex === vault.dex && p.tokenId === vault.rootTokenId)
  if (position?.state.status !== 'live') return Object.freeze({ subscribed: null, approved: null, ownerHolds: null })
  const at = vault.address.toLowerCase()
  const { custody, owner } = position.state
  return Object.freeze({
    subscribed: vault.dex === 4 ? custody.subscriber?.toLowerCase() === at : false,
    approved: custody.approved?.toLowerCase() === at,
    ownerHolds: owner.toLowerCase() === vault.owner.toLowerCase(),
  })
}

/**
 * A vault read on chain (live) as the screens show it. `listed`: its read-v6 item, used for what the chain cannot say
 * only while it was read at the same stateNonce. `closed`: the root's liveness as the vault client's own check found it
 * (null when not read). `exit`: where its Auto-exit stands, from the listing's orders (Added 2026-10-06, the review of
 * point 5), for Auto-exit's own vault as the chain reads it now; null otherwise (the caller's word: shownVaultView).
 */
export function vaultViewFromChain(snapshot: VaultSnapshot, listed: Vault | null, closed: boolean | null, nowSeconds: number, exit: ProtectionStanding | null = null): VaultView {
  const custody = liveCustody(snapshot)
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #2): Auto-exit's own by the caller's word, its
  // module on or off (Leave automation turns it off), never by the module alone.
  const protection = snapshot.paused && exit !== null
  const current = listed !== null && listed.state.status === 'read' && listed.state.stateNonce === snapshot.stateNonce.toString()
  const status: VaultStatus = !custody.armed ? 'off' : snapshot.paused && snapshot.autoExitEnabled ? 'protection' : snapshot.paused ? 'paused' : 'on'
  let reason: number | 'unknown' | null = null
  let since: number | null = null
  if (!custody.armed) {
    if (custody.reason === 4) reason = 4
    else if (current && listed && listed.custody.armed === false && listed.custody.reason) {
      reason = DISARM_REASON_NUMBER[listed.custody.reason]
      since = listed.custody.since?.snapshot.timestamp ?? null
    } else reason = 'unknown'
  }
  // A burned root has no holder: closed whatever else is known.
  const rootClosed = snapshot.custody.holder === null ? true : closed
  // The sequence as the chain has it; what a member that is no longer active became (withdrawn, exited) only from the
  // listing's history, while it was read at this very state.
  const members: VaultMemberView[] = snapshot.members.map((member) => {
    const history = current && listed ? listed.members.find((m) => m.tokenId === member.tokenId.toString()) ?? null : null
    const state: VaultMemberView['state'] = member.role === 'root'
      ? (history?.status === 'exited' ? 'exited' : custody.armed ? 'armed' : 'disarmed')
      : member.active ? 'active' : history?.status === 'withdrawn' || history?.status === 'exited' ? history.status : 'inactive'
    return Object.freeze({
      tokenId: member.tokenId,
      role: member.role,
      state,
      parent: member.role === 'root' || member.parent === 0n ? null : member.parent,
      range: Object.freeze({ tickLower: member.tickLower, tickUpper: member.tickUpper }),
      lots: Object.freeze(member.lots.map((lot) => Object.freeze({ token: lot.token, uncharged: lot.uncharged, charged: lot.charged }))),
    })
  })
  return Object.freeze({
    source: 'chain' as const,
    chainId: snapshot.chainId,
    vault: snapshot.vault,
    dex: snapshot.dex,
    owner: snapshot.owner,
    ownedByWallet: snapshot.ownedByWallet,
    rootTokenId: snapshot.root.tokenId,
    pool: Object.freeze({ currency0: snapshot.pool.currency0, currency1: snapshot.pool.currency1, fee: snapshot.pool.fee }),
    mode: snapshot.policy.mode,
    policy: snapshot.policy,
    limits: snapshot.limits,
    status,
    pausedBy: snapshot.paused && current && listed ? (listed.pausedBy === 'owner' ? 'you' as const : listed.pausedBy === 'operator' ? 'Domino' as const : null) : null,
    armed: custody.armed,
    disarm: reason === null ? null : Object.freeze({ reason, text: disarmText(reason), since }),
    rootClosed,
    successors: Object.freeze(snapshot.members.filter((member) => member.role === 'successor' && member.active).map((member) => member.tokenId)),
    members: Object.freeze([...members].sort((a, b) => (a.role === 'root' ? -1 : b.role === 'root' ? 1 : 0))),
    quoteCurrency: snapshot.quoteCurrency,
    reserves: Object.freeze({ known: true as const, list: Object.freeze(snapshot.reserves.map((r) => Object.freeze({ token: r.token, total: r.total, idle: r.idle }))), held: snapshot.reserves.some((r) => r.total > 0n) }),
    waiting: listed ? waitingWords(listed.waiting, snapshot.chainId, nowSeconds, { maxPositions: snapshot.policy.maxPositions }, protection ? AUTO_EXIT_WAITING_TEXT : null) : null,
    autoExitEnabled: snapshot.autoExitEnabled,
    paused: snapshot.paused,
    exit: protection ? exit : null,
    links: Object.freeze({
      subscribed: snapshot.dex === 4 ? snapshot.custody.subscriber === snapshot.vault : false,
      approved: snapshot.custody.approved === snapshot.vault,
      ownerHolds: snapshot.custody.holder === null ? false : snapshot.custody.holder === snapshot.owner,
    }),
  })
}

/**
 * The vault a screen shows: its listing (read-v6), or, after an owner action on this page, the vault as read on chain
 * right after it (`fresh`, the dialog's own read), while the listing has not reached that state yet (its stateNonce is
 * older, or unread): so a withdrawal just made is not offered again from the index's last read. A root the listing
 * knows as closed stays closed.
 */
export function shownVaultView(listed: Vault, body: PortfolioResponse, wallet: Address, nowSeconds: number, fresh: VaultSnapshot | null): VaultView {
  if (fresh && fresh.chainId === listed.chainId && fresh.vault === listed.address.toLowerCase() && (listed.state.status !== 'read' || BigInt(listed.state.stateNonce) < fresh.stateNonce)) {
    // The listing's word on its Auto-exit, its root's orders: the chain read of the vault does not carry them.
    const exit = exitVaultOf(listed, body.mandates ?? [], fresh) ? exitStandingOf(listed, body.mandates ?? []) : null
    return vaultViewFromChain(fresh, listed, listedRootClosed(listed, body) === true ? true : null, nowSeconds, exit)
  }
  return vaultViewFromListing(listed, body, wallet, nowSeconds)
}

/**
 * What the reserves card offers (rev3/rev4 §2.13, §5.6): "Withdraw to wallet" whenever any reserve is above zero, in
 * every state; "Return my reserves" (`returnReserves()`, one transaction for both tokens, no fee) once the root is closed
 * and no successor is active, with the automation's own pass as the alternative. Nothing for a vault of another wallet.
 * Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §2 item 1): not "Return my reserves" once the automation could
 * not pay one of the tokens to the wallet (`reserves_unpayable`): a return pays only that wallet and would be refused the
 * same way, so "Withdraw to wallet" leads, where another address of the owner's can be named.
 */
export function reservesOffer(view: VaultView): { withdraw: boolean; returnable: boolean } {
  if (!view.ownedByWallet || !view.reserves.known || !view.reserves.held) return { withdraw: false, returnable: false }
  return { withdraw: true, returnable: view.rootClosed === true && view.successors.length === 0 && view.waiting?.code !== 'reserves_unpayable' }
}

/**
 * §5.6 "Reservas na tela": what the vault holds per pool token, as the two figures the spec names: `reserves(token)`,
 * "Fees collected, not yet reinvested" (idle plus every member's lots), and `idleReserves(token)`, "Not used by
 * automation". Both are the owner's; `owedFees` is never among them.
 */
export function splitReserves(list: readonly VaultReserve[]): { collected: readonly { token: Address; amount: bigint }[]; idle: readonly { token: Address; amount: bigint }[] } {
  return Object.freeze({
    collected: Object.freeze(list.map((r) => Object.freeze({ token: r.token, amount: r.total }))),
    idle: Object.freeze(list.map((r) => Object.freeze({ token: r.token, amount: r.idle }))),
  })
}

/**
 * An owner action a vault card offers (each opens its dialog, ./VaultDialog.tsx). §5.6's three owner functions beyond the
 * reserves: `withdraw-child` (an active successor to the wallet, one offer per successor), `recover-token` (anything the
 * vault holds outside its accounted reserves) and `recover-position` (an NFT it holds without managing).
 */
export type VaultActionKind = 'withdraw' | 'return' | 'leave' | 'rearm' | 'pause' | 'resume' | 'unsubscribe' | 'revoke' | 'withdraw-child' | 'recover-token' | 'recover-position'

/** The owner's rarely needed actions, under the page card's closed "Advanced" (beginner-first). */
export const VAULT_ADVANCED_ACTIONS: ReadonlySet<VaultActionKind> = new Set<VaultActionKind>(['recover-token', 'recover-position'])

/**
 * The actions the owner has on this vault now, in the order the card offers them. `withdraw-child` stands for one offer
 * per active successor (beside its id); the advanced two come last and are always the owner's (§5.3: the owner's actions
 * go on in every state, a halt included).
 *
 * Changed on purpose 2026-10-06 (the integration review, rugged-literal #1): Auto-exit's own vault (`exit`) closes its
 * position with the position's approval alone (DominoV2VaultExecutor.executeExit), whatever its root's armed flag. While
 * its Auto-exit is on, its rearm adds nothing to it; while it is on or paused, "Remove Domino from this position" and
 * "Revoke approval" are never offered (revoking would stop the exit); Pause and Resume never apply (resuming would
 * reinvest). Its rearm stays offered after Leave automation too (reason 7; §5.4: rearm to start again), where it gives the
 * approval back to a paused Auto-exit or is the first part of turning Auto-exit on again.
 */
export function vaultActions(view: VaultView): VaultActionKind[] {
  if (!view.ownedByWallet) return []
  const actions: VaultActionKind[] = []
  const offer = reservesOffer(view)
  const exit = view.exit
  const exitLive = exit === 'on' || exit === 'paused'
  if (offer.withdraw) actions.push('withdraw')
  if (offer.returnable) actions.push('return')
  // The rearm (decision #5): the root not armed for a reason the owner can undo (not burned, not withdrawn by auto-exit).
  const ended = (reason: number | 'unknown') => reason === 3 || reason === 6 || (reason === 7 && exit === null)
  if (exit !== 'on' && view.armed === false && view.rootClosed !== true && view.disarm && !ended(view.disarm.reason)) actions.push('rearm')
  if (exit === null && (view.rootClosed !== true || view.successors.length > 0) && view.armed !== false && view.status === 'on') actions.push('pause')
  if (exit === null && (view.rootClosed !== true || view.successors.length > 0) && view.status === 'paused') actions.push('resume')
  if (view.successors.length > 0) actions.push('withdraw-child')
  if (view.status !== 'off' || view.successors.length > 0 || offer.withdraw) actions.push('leave')
  // After automation ended for the root (§5.6): what still links it to the vault, on the owner's own position, once the
  // vault holds nothing more for the owner (its fees and next positions come first).
  if (!exitLive && view.armed === false && view.links.ownerHolds === true && !offer.withdraw && view.successors.length === 0) {
    if (view.dex === 4 && view.links.subscribed === true) actions.push('unsubscribe')
    if (view.links.approved === true) actions.push('revoke')
  }
  actions.push('recover-token', 'recover-position')
  return actions
}

/** What a member's state says on screen (§5.5 "o estado de cada um"). */
export function memberStateWords(state: VaultMemberView['state']): string {
  switch (state) {
    case 'armed': return 'Automation on'
    case 'disarmed': return 'Automation off'
    case 'exited': return 'Exited'
    case 'active': return 'Active'
    case 'withdrawn': return 'Withdrawn to your wallet'
    case 'inactive': return 'Inactive'
    default: return 'Unknown'
  }
}

/**
 * What the owner typed for "Recover a token" (§5.6 `recoverToken(token, amount)`): a token address, and an amount in that
 * token's units when its decimals are known (one of the pool's two tokens, or the chain profile's own: ETH, the charge
 * currencies, the wrapped native), else in raw units, never guessed. Nothing is built from an empty or malformed field.
 */
export function recoverTokenInput(chainId: V2ChainId, tokens: readonly [TokenView, TokenView] | null, tokenText: string, amountText: string):
  | { ok: true; token: TokenView; amount: bigint }
  | { ok: false; token: TokenView | null; problem: 'empty' | 'token' | 'amount' } {
  const typed = tokenText.trim().toLowerCase()
  // An empty field is not a wrong one: nothing is said until something is typed in it.
  if (typed === '') return { ok: false, token: null, problem: 'empty' }
  if (!/^0x[0-9a-f]{40}$/.test(typed)) return { ok: false, token: null, problem: 'token' }
  const address = typed as Address
  const token = tokens?.find((t) => t.address === address) ?? tokenView(v2Chain(chainId), address)
  if (amountText.trim() === '') return { ok: false, token, problem: 'empty' }
  const amount = token.decimals === null ? wholeFromText(amountText) : rawFromText(amountText, token.decimals)
  if (amount === null || amount <= 0n) return { ok: false, token, problem: 'amount' }
  return { ok: true, token, amount }
}

/** What the owner typed for "Recover a position" (§5.6 `recoverPosition(tokenId)`): a position number above zero, or null. */
export function recoverPositionInput(idText: string): bigint | null {
  if (idText.trim() === '') return null
  const id = wholeFromText(idText)
  return id !== null && id > 0n ? id : null
}

/**
 * The address the owner typed for "Send to another address you own" (rugged97's delta of 4 Oct §2 item 1), offered only
 * once a transfer of the reserves to the owner's wallet failed (TokenCallFailed): a wallet address, not the one that just
 * refused it (the owner's own), the vault or one of its tokens. The client refuses address(0) and Domino's contracts as
 * well (finance/v2/vault.ts recipientOf). Nothing is said while the field is empty.
 */
export function withdrawRecipientInput(text: string, refused: { owner: Address | null; vault: Address; tokens: readonly Address[] }):
  | { ok: true; address: Address }
  | { ok: false; problem: 'empty' | 'address' | 'same-wallet' | 'not-a-wallet' } {
  const typed = text.trim().toLowerCase()
  if (typed === '') return { ok: false, problem: 'empty' }
  if (!/^0x[0-9a-f]{40}$/.test(typed) || /^0x0{40}$/.test(typed)) return { ok: false, problem: 'address' }
  const address = typed as Address
  if (refused.owner !== null && address === refused.owner.toLowerCase()) return { ok: false, problem: 'same-wallet' }
  if (address === refused.vault.toLowerCase() || refused.tokens.some((token) => token.toLowerCase() === address)) return { ok: false, problem: 'not-a-wallet' }
  return { ok: true, address }
}

/** "Since {relative time}" for a disarm, or null. */
export const sinceWords = (since: number | null, nowSeconds: number): string | null => (since === null ? null : `since ${agoWords(since, nowSeconds)}`)

/**
 * Added 2026-10-06 (the owner's point 5): whether a vault is Auto-exit's own, the protection-only vault of decision #25:
 * paused, its auto-exit module on, whatever its root's state (after its exit the root is off, and the vault stays paused
 * with its module on). Its place on a position's page is the Auto-exit card's (../autoexit/Orders.tsx). Changed on
 * purpose 2026-10-06 (the integration review, rugged-literal #2): the view's own word (`exit`), so a vault Leave automation
 * paused with its module off stays Auto-exit's while Auto-exit is listed on its root (../autoexit/standing.ts exitVaultOf).
 */
export const protectionVault = (view: Pick<VaultView, 'exit'>): boolean => view.exit !== null

/** NFT identity, independent of the number of vaults created for it. */
export function automationPositionKey(view: Pick<VaultView, 'chainId' | 'dex' | 'rootTokenId'>): string {
  const chain = v2Chain(view.chainId)
  const manager = view.dex === 3 ? chain.uniswap.v3.positionManager : chain.uniswap.v4.positionManager
  return `${view.chainId}|${manager.toLowerCase()}|${view.rootTokenId}`
}

/**
 * The NFT's present approval/subscription wins over an older vault's recorded state. Otherwise prefer an active
 * automation, then the latest creation. Index order is historical and must never choose the current control.
 */
export function currentVaultFirst(views: readonly VaultView[], body: PortfolioResponse): VaultView[] {
  const rank = (view: VaultView): number => {
    if (view.links.approved === true && view.links.ownerHolds !== false) return 6
    if (view.links.subscribed === true && view.links.ownerHolds !== false) return 5
    if (view.exit === 'on' || view.exit === 'paused') return 4
    if (view.armed === true && view.rootClosed !== true) return 3
    if (view.successors.length > 0) return 2
    return 1
  }
  const nonce = (view: VaultView): bigint => {
    const listed = body.vaults.find((vault) => vault.chainId === view.chainId && vault.address.toLowerCase() === view.vault)
    return BigInt(listed?.ownerNonce ?? '0')
  }
  return [...views].sort((a, b) => {
    const difference = rank(b) - rank(a)
    if (difference) return difference
    const left = nonce(a), right = nonce(b)
    return left === right ? a.vault.localeCompare(b.vault) : left > right ? -1 : 1
  })
}

export const automationMode = (view: VaultView): string => view.exit !== null ? 'Auto-exit' : view.mode === 2 ? 'Domino-compound' : view.mode === 1 ? 'Auto-compound' : 'Automation'

export function automationStanding(view: VaultView): string {
  if (view.exit === 'closed') return 'Completed'
  if (view.rootClosed === true) return 'Closed'
  if (view.status === 'unknown' || view.status === null) return 'State unavailable'
  if (view.exit !== null) return view.exit === 'on' ? 'On' : view.exit === 'paused' ? 'Paused' : 'Off'
  if (view.status === 'on') return 'On'
  if (view.status === 'paused') return 'Paused'
  if (view.status === 'off') return 'Off'
  return 'State unavailable'
}

export interface AutomatedPosition {
  key: string
  current: VaultView
  vaults: readonly VaultView[]
  /** Keep unknown balances visible: an unread balance is not zero. */
  recovery: boolean
  active: boolean
}

export function automatedPositions(views: readonly VaultView[], body: PortfolioResponse): AutomatedPosition[] {
  const groups = new Map<string, VaultView[]>()
  for (const view of views) {
    const key = automationPositionKey(view)
    const group = groups.get(key) ?? []
    group.push(view)
    groups.set(key, group)
  }
  return [...groups].map(([key, group]) => {
    const vaults = currentVaultFirst(group, body)
    const current = vaults[0]
    const recovery = vaults.some((view) => !view.reserves.known || view.reserves.held || view.successors.length > 0)
    const active = current.rootClosed !== true && (current.exit === 'on' || current.exit === 'paused' || (current.exit === null && (current.status === 'on' || current.status === 'paused')))
    const pending = current.status === null || current.status === 'unknown' || vaultActions(current).includes('rearm')
    return { key, current, vaults, recovery, active: active || recovery || pending }
  }).sort((a, b) => Number(b.active) - Number(a.active) || a.key.localeCompare(b.key))
}
