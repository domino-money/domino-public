import type {
  ActivityResponse, AutoExit, AutoExitEvent, ChainStatus, Credit, IndexedToken, Mandate, PortfolioResponse, ReservesReturned, Tariff, Vault, VaultCreated, VaultEvent, VaultExecution, Waiting,
} from 'api-contracts/read-v6/types'
import { automationFeeText, VAULT_TEXT, type VaultMember, type VaultSnapshot } from '../../finance/v2/vault'
import { v2Chain, type V2Chain } from '../../v2/chains'
import { AUTO_EXIT_WAITING, decodeRevertData } from '../../v2/errors'
import { chainState, coverageNote } from '../../v2/read/v6'
import { ZERO_ADDRESS, type Address, type V2ChainId } from '../../v2/types'
import { DISARM_TEXT } from './copy'
import { amountWords, tokenView, type TokenMeta, type TokenView } from './tokens'

/**
 * What the automation screens take from read-v6 (spec F7 rev2 §6.2, §6.3, §4.9; decisions #9, #24), as words. Pure: the
 * screens read through ./read6.ts (every answer through the package's validator) and hand the body here.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/vault/portfolio.ts, copied for the integrated screens, with
 * what the position page and Managed positions add: a position's vaults (`vaultsOfPosition`: its root or one of its
 * successors, from the listed members, never from the NFT) and a listed vault's reserves (`listedReserves`).
 *
 * - The chain's status comes before any value of it (§8.2): `current` as is; `stale` with the stale badge and its age;
 *   `unavailable` is a dash with its reason, never zeros, and never empties the other chains (§6.3's partial sentence).
 * - A vault's state: "Protection only" for a paused vault whose auto-exit is on (decision #25: never "Paused"); who
 *   paused it (`pausedBy`); why its root is disarmed (`custody.reason`, with `source` and `since`).
 * - Why a vault or an order waits (decision #24): "Waiting: {copy} · since {relative time}", the copy from
 *   `waiting.error` (§4.9's table) or, for the automation's own codes, `waiting.reason` (§6.2's suggested texts).
 * - The receipts history (`activity`): runs with their 2%/4% tariff, auto-exits with their 0.2%, the vault's creation,
 *   the owner's and the operator's vault events, and the orders' events. Raw amounts in the token's units, never USD.
 */

// ---------------------------------------------------------------------------
// Chains (§6.2 `chains`, §6.3)
// ---------------------------------------------------------------------------

export interface ChainView {
  chainId: number
  state: 'current' | 'stale' | 'unavailable'
  reason: string | null
  lagSeconds: number | null
  /** The registry's global halt as the index saw it (null when it could not tell). */
  halted: boolean | null
}

/** The chain's status in an answer (always the three chains), or null when the answer does not list it. */
export function chainView(chains: readonly ChainStatus[], chainId: V2ChainId): ChainView | null {
  const chain = chains.find((c) => c.chainId === chainId)
  if (!chain) return null
  const state = chainState(chain)
  return { ...state, halted: chain.automationHalted }
}

/** §6.3's partial sentence for an answer ("Showing Base and Arbitrum. Robinhood Chain is unavailable right now."), or null. */
export const partialNote = (chains: readonly ChainStatus[]): string | null => coverageNote(chains)

/**
 * §5.3's banner for a chain whose registry halted automation (`chains[].automationHalted`), in the spec's exact words,
 * the chain named: "Domino has stopped automation on {chain} for safety. You can still withdraw and manage your
 * positions." Drawn before any figure of that chain (./IndexStatus.tsx); the owner's actions stay offered.
 */
export const haltWords = (chainId: V2ChainId): string => VAULT_TEXT.vault_halted.replace('{chain}', v2Chain(chainId).name)

/** How long ago a Unix time was: "40 s ago", "3 min ago", "2 h ago", "4 days ago" (never negative). */
export function agoWords(seconds: number, nowSeconds: number): string {
  const ago = Math.max(0, Math.floor(nowSeconds - seconds))
  if (ago < 120) return `${ago} s ago`
  if (ago < 7_200) return `${Math.floor(ago / 60)} min ago`
  if (ago < 172_800) return `${Math.floor(ago / 3_600)} h ago`
  return `${Math.floor(ago / 86_400)} days ago`
}

/** A stale chain's age in words ("4 min behind"), from its lag; null when the index did not say. */
export function staleWords(view: ChainView): string | null {
  if (view.state !== 'stale' || view.lagSeconds === null) return null
  const lag = Math.max(0, Math.floor(view.lagSeconds))
  if (lag < 120) return `${lag} s behind`
  if (lag < 7_200) return `${Math.floor(lag / 60)} min behind`
  if (lag < 172_800) return `${Math.floor(lag / 3_600)} h behind`
  return `${Math.floor(lag / 86_400)} days behind`
}

/** A token's metadata from an answer's `tokens` (symbol untrusted, decimals null when unread), for tokens.ts tokenView. */
export function tokenMetaOf(tokens: readonly IndexedToken[], chainId: V2ChainId): (address: Address) => TokenMeta | null {
  return (address) => {
    const token = tokens.find((t) => t.chainId === chainId && t.address === address.toLowerCase())
    return token ? { address: token.address.toLowerCase() as Address, symbol: token.symbol, decimals: token.decimals } : null
  }
}

// ---------------------------------------------------------------------------
// Vaults (§6.2 `portfolio.vaults`)
// ---------------------------------------------------------------------------

/** The wallet's vaults on one chain, as listed (the answer is about the wallet asked: runtime.mjs validateExchange). */
export const vaultsOn = (body: PortfolioResponse, chainId: V2ChainId): readonly Vault[] => body.vaults.filter((v) => v.chainId === chainId)

export const vaultOn = (body: PortfolioResponse, chainId: V2ChainId, vault: Address): Vault | null =>
  body.vaults.find((v) => v.chainId === chainId && v.address === vault.toLowerCase()) ?? null

/** A listed vault, and what one position is to it. */
export interface PositionVault {
  vault: Vault
  role: 'root' | 'successor'
}

/**
 * The listed vaults one position belongs to on one chain (spec F7 rev3 §2.13, §5.6: from read-v6's `portfolio.vaults`,
 * by owner, never from the NFT): the vault whose root it is, in every state of that root (armed, disarmed, exited,
 * closed, burned or transferred: the vault stays listed with its reserves), and a vault that lists it as an ACTIVE
 * successor. A successor withdrawn to the wallet is a plain position again, and its vault is not its own any more. Pure.
 */
export function vaultsOfPosition(body: PortfolioResponse, chainId: V2ChainId, tokenId: string, dex?: 3 | 4): readonly PositionVault[] {
  const out: PositionVault[] = []
  for (const vault of body.vaults) {
    if (vault.chainId !== chainId || (dex !== undefined && vault.dex !== dex)) continue
    if (vault.rootTokenId === tokenId) out.push({ vault, role: 'root' })
    else if (vault.members.some((member) => member.role === 'successor' && member.tokenId === tokenId && member.status === 'active')) out.push({ vault, role: 'successor' })
  }
  return out
}

/**
 * A listed vault's reserves (read-v6 `state.reserves`: per pool token, the total, "Fees collected, not yet reinvested",
 * and the idle part), as raw amounts, or `known: false` when its state was not read or could not be: then they are a
 * dash with the reason, never zeros. `held` is whether any of them is above zero (rev3: then "Withdraw to wallet").
 */
export function listedReserves(vault: Vault): { known: true; reserves: readonly { token: Address; total: bigint; idle: bigint }[]; held: boolean } | { known: false; reason: string } {
  if (vault.state.status !== 'read') return { known: false, reason: vault.state.status === 'unavailable' ? vault.state.reason : 'not_read' }
  const reserves = vault.state.reserves.map((reserve) => Object.freeze({ token: reserve.token.toLowerCase() as Address, total: BigInt(reserve.total), idle: BigInt(reserve.idle) }))
  return { known: true, reserves: Object.freeze(reserves), held: reserves.some((reserve) => reserve.total > 0n) }
}

/**
 * One member of a vault's sequence (§5.5): the root, then the successors the vault minted and holds. `state` is the
 * history's word for it (the root armed, disarmed or exited; a successor active, withdrawn to the wallet or exited by the
 * auto-exit), or 'inactive' when only the ledger says it is no longer active, or 'unknown'. `range` and `lots` come from
 * the vault's ledger (`member`, `lot`); null and empty when that state was not read.
 */
export interface VaultMemberView {
  tokenId: bigint
  role: 'root' | 'successor'
  state: 'armed' | 'disarmed' | 'exited' | 'active' | 'withdrawn' | 'inactive' | 'unknown'
  /** The parent it was opened under; null for the root. */
  parent: bigint | null
  range: { tickLower: number; tickUpper: number } | null
  /** Per pool token: earned fees not yet charged, and units already charged. */
  lots: readonly { token: Address; uncharged: bigint; charged: bigint }[]
}

/**
 * A listed vault's sequence (read-v6 `members`, the history by events, and `state.members`, the ledger read at the
 * state's block), root first, then the successors as listed. A member the ledger knows and the history does not is
 * named by the ledger alone (its state from `active`); one the history knows and the ledger does not has no range.
 */
export function listedMembers(vault: Vault): readonly VaultMemberView[] {
  const ledger = vault.state.status === 'read' ? vault.state.members : []
  const low = (address: string) => address.toLowerCase() as Address
  const lotsOf = (tokenId: string) => {
    const entry = ledger.find((m) => m.tokenId === tokenId)
    return entry ? Object.freeze(entry.lots.map((lot) => Object.freeze({ token: low(lot.token), uncharged: BigInt(lot.uncharged), charged: BigInt(lot.charged) }))) : Object.freeze([])
  }
  const rangeOf = (tokenId: string) => {
    const entry = ledger.find((m) => m.tokenId === tokenId)
    return entry ? Object.freeze({ tickLower: entry.tickLower, tickUpper: entry.tickUpper }) : null
  }
  const out: VaultMemberView[] = vault.members.map((member) => Object.freeze({
    tokenId: BigInt(member.tokenId),
    role: member.role,
    state: member.status,
    parent: member.parentTokenId === null ? null : BigInt(member.parentTokenId),
    range: rangeOf(member.tokenId),
    lots: lotsOf(member.tokenId),
  }))
  for (const entry of ledger) {
    if (out.some((member) => member.tokenId.toString() === entry.tokenId)) continue
    const role = entry.tokenId === vault.rootTokenId ? 'root' : 'successor'
    const state: VaultMemberView['state'] = role === 'root'
      ? (vault.custody.armed === true ? 'armed' : vault.custody.armed === false ? 'disarmed' : 'unknown')
      : entry.active ? 'active' : 'inactive'
    out.push(Object.freeze({ tokenId: BigInt(entry.tokenId), role, state, parent: entry.parentTokenId === null ? null : BigInt(entry.parentTokenId), range: rangeOf(entry.tokenId), lots: lotsOf(entry.tokenId) }))
  }
  return Object.freeze(out.sort((a, b) => (a.role === 'root' ? -1 : b.role === 'root' ? 1 : 0)))
}

export type VaultStatus = 'protection' | 'on' | 'paused' | 'off'

/** Whether the listed vault is paused: its state's `paused` when read, else `pausedBy` (null only while it runs). */
export const listedPaused = (vault: Vault): boolean => (vault.state.status === 'read' ? vault.state.paused : vault.pausedBy !== null)

/**
 * A listed vault's status (§5.1, §5.3, §5.4): a paused vault whose auto-exit is on is the protection-only vault (decision
 * #25: "Protection only", never "Paused"); a root that is not armed is "Automation off"; then paused or on.
 */
export function vaultStatus(vault: Vault): VaultStatus {
  // Off first: the root disarmed (read live, or the index's reason while live custody is unread). A protection-only
  // vault whose root was withdrawn protects nothing any more.
  if (vault.custody.armed === false || (vault.custody.armed === null && vault.custody.reason !== null)) return 'off'
  if (listedPaused(vault) && vault.autoExitEnabled) return 'protection'
  return listedPaused(vault) ? 'paused' : 'on'
}

/** What a status says on screen; a paused vault says who paused it when the index knows (§5.3). */
export function statusWords(status: VaultStatus, pausedBy: Vault['pausedBy'] = null): string {
  if (status === 'protection') return 'Protection only'
  if (status === 'off') return 'Automation off'
  if (status === 'on') return 'Automation on'
  return pausedBy === 'owner' ? 'Paused by you' : pausedBy === 'operator' ? 'Paused by Domino' : 'Paused'
}

/** read-v6's disarm reasons as RootDisarmed's numbers (§5.4). */
export const DISARM_REASON_NUMBER: Readonly<Record<NonNullable<Vault['custody']['reason']>, number>> = Object.freeze({
  unsubscribed_or_transferred: 1,
  changed_outside_domino: 2,
  burned: 3,
  custody_lost: 4,
  v3_checkpoint_mismatch: 5,
  auto_exit: 6,
  exit_all: 7,
})

/** Raw integer strings (read-v6's amounts) as bigints; the validator already checked their form. */
export const rawAmounts = (amounts: readonly string[]): bigint[] => amounts.map((raw) => BigInt(raw))

/**
 * A listed vault's last read state (read-v6 `state`, status `read`) as the panels' snapshot, for the v2-preview build,
 * where no wallet may be asked anything (finance/v2/previewLock.ts): the same figures the panel shows from a chain read,
 * at the index's block, never a money client. The root's custody comes from its listed position when the index read it
 * live (owner, approval, subscriber); otherwise it is drawn consistent with the vault's own `rootArmed`, so the panel
 * says read-v6's custody reason (same stateNonce) and never one made up. Null when the state was not read.
 */
export function snapshotFromRead6(listed: Vault, body: PortfolioResponse, chainId: V2ChainId, wallet: Address): VaultSnapshot | null {
  if (listed.state.status !== 'read' || listed.chainId !== chainId) return null
  const s = listed.state
  const low = (address: string) => address.toLowerCase() as Address
  const vault = low(listed.address)
  const owner = low(listed.owner)
  const dex = listed.dex
  const profile = v2Chain(chainId)
  const rootPosition = body.positions.find((p) => p.chainId === chainId && p.dex === dex && p.tokenId === listed.rootTokenId && p.vault?.address === vault) ?? null
  const live = rootPosition && rootPosition.state.status === 'live' ? rootPosition.state : null
  const custody = live
    ? { holder: low(live.owner), approved: live.custody.approved ? low(live.custody.approved) : null, subscriber: live.custody.subscriber ? low(live.custody.subscriber) : null }
    : { holder: owner, approved: vault, subscriber: dex === 4 ? vault : null }
  const members: VaultMember[] = s.members.map((m) => ({
    tokenId: BigInt(m.tokenId),
    role: m.tokenId === listed.rootTokenId ? 'root' : 'successor',
    active: m.active,
    parent: BigInt(m.parentTokenId ?? '0'),
    successor: BigInt(m.successorTokenId ?? '0'),
    tickLower: m.tickLower,
    tickUpper: m.tickUpper,
    lots: m.lots.map((lot) => ({ token: low(lot.token), uncharged: BigInt(lot.uncharged), charged: BigInt(lot.charged) })),
  }))
  return Object.freeze({
    chainId,
    blockNumber: BigInt(s.snapshot.number),
    blockTimestamp: BigInt(s.snapshot.timestamp),
    vault,
    dex,
    factory: low(listed.factory),
    owner,
    ownedByWallet: owner === wallet.toLowerCase(),
    pool: { dex: s.pool.dex, currency0: low(s.pool.currency0), currency1: low(s.pool.currency1), fee: s.pool.fee, tickSpacing: s.pool.tickSpacing, hooks: low(s.pool.hooks) },
    root: { dex, positionManager: rootPosition ? low(rootPosition.positionManager) : dex === 4 ? profile.uniswap.v4.positionManager : profile.uniswap.v3.positionManager, tokenId: BigInt(listed.rootTokenId) },
    positions: members.filter((m) => m.active).sort((a, b) => (a.role === 'root' ? -1 : b.role === 'root' ? 1 : 0)).map((m) => m.tokenId),
    members,
    policy: { mode: s.policy.mode === 'domino' ? 2 : 1, triggerDistanceBps: s.policy.triggerDistanceBps, maxOverlapBps: s.policy.maxOverlapBps, minimumIntervalSeconds: s.policy.minimumIntervalSeconds, maxPositions: s.policy.maxPositions },
    limits: { ...s.limits },
    paused: s.paused,
    rootArmed: s.rootArmed,
    stateNonce: BigInt(s.stateNonce),
    exitModule: s.exitModule ? low(s.exitModule) : ZERO_ADDRESS,
    autoExitEnabled: listed.autoExitEnabled,
    quoteCurrency: low(s.quoteCurrency),
    lastExecutionAt: BigInt(s.lastExecutionAt),
    reserves: s.reserves.map((r) => ({ token: low(r.token), total: BigInt(r.total), idle: BigInt(r.idle) })),
    custody,
    halted: chainView(body.chains, chainId)?.halted === true,
  } satisfies VaultSnapshot)
}

/** read-v6's `blockedBy` (§6.2) in §4.5's words, the AUTO_EXIT_TEXT key of each; `expired` is the status word, `custody_unread` unknown. */
export const BLOCKED_TEXT_KEY: Readonly<Record<string, 'mandate_module_off' | 'mandate_halted' | 'mandate_root_custody_lost' | 'mandate_successor_inactive' | 'mandate_vault_unknown'>> = Object.freeze({
  module_disabled: 'mandate_module_off',
  automation_halted: 'mandate_halted',
  custody_lost: 'mandate_root_custody_lost',
  not_in_vault: 'mandate_successor_inactive',
  vault_not_domino: 'mandate_vault_unknown',
})

/** The auto-exit orders of one vault on one chain, as listed. */
export const mandatesOf = (body: PortfolioResponse, chainId: V2ChainId, vault: Address): readonly Mandate[] =>
  body.mandates.filter((m) => m.chainId === chainId && m.vault === vault.toLowerCase())

/** What an exit could not deliver on one chain's module (§4.8), above zero, as raw amounts. */
export function creditsOn(body: PortfolioResponse, chainId: V2ChainId, module: Address | null): readonly { token: Address; amount: bigint }[] {
  // `module` null: every module's (the v2-preview build lists its fixtures' credits as they are).
  const mine = body.credits.filter((c: Credit) => c.chainId === chainId && (module === null || c.module === module.toLowerCase()))
  return mine.map((c) => ({ token: c.token.toLowerCase() as Address, amount: BigInt(c.unclaimed) })).filter((c) => c.amount > 0n)
}

/**
 * §4.8's claim screen without the index: the credits read-v6 lists (`credits`), joined with `unclaimed(owner, token)` as
 * read on chain for the pool's two tokens (finance/v2/autoExit.ts readUnclaimed, live only). For a token read on chain,
 * the chain's figure wins (the index may be behind, or off); a token not read keeps the index's. Above zero only. `live`
 * null (not read: the gate not live, the wallet elsewhere, the read refused) leaves the index's as they are.
 */
export function mergeCredits(indexed: readonly { token: Address; amount: bigint }[], live: readonly { token: Address; amount: bigint }[] | null): readonly { token: Address; amount: bigint }[] {
  if (live === null) return indexed.filter((c) => c.amount > 0n)
  const read = new Set(live.map((c) => c.token.toLowerCase()))
  const out = live.map((c) => ({ token: c.token.toLowerCase() as Address, amount: c.amount })).filter((c) => c.amount > 0n)
  for (const c of indexed) if (!read.has(c.token.toLowerCase()) && c.amount > 0n) out.push({ token: c.token.toLowerCase() as Address, amount: c.amount })
  return Object.freeze(out)
}

// ---------------------------------------------------------------------------
// Waiting (§4.9, §6.2; decision #24)
// ---------------------------------------------------------------------------

/** §6.2's suggested texts for the automation's own codes (decision #29: valid as written). */
export const WAITING_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  too_soon: 'Waiting for the minimum interval',
  gas_not_covered: 'Waiting until fees cover the network cost',
  // Changed on purpose 2026-10-05 (rugged97's F7 delta of 5 Oct, §6.2): one text for a compound and for the next position's
  // mint, which wait with the same code (it was "Waiting: compounding now wouldn't pay off yet").
  owner_benefit_insufficient: "Waiting: running now wouldn't pay off yet",
  earnings_evidence_missing: 'Waiting for enough fee history',
  trigger_not_reached: 'Waiting for your trigger price',
  eligible: 'Running soon',
  triggered: 'Running soon',
  // Added 2026-10-05 (rugged97's F7 delta of 5 Oct, §5.5 and §6.2: the automation mints Domino-compound's successors).
  // max_positions_reached names the vault's own limit: maxPositionsWaiting below.
  awaiting_successor: 'Waiting to open the next position',
  successor_range_unavailable: "Waiting: the next position can't start at the current price within your overlap limit",
  successor_anchor_unstable: 'Waiting for the reference price to settle before opening the next position',
  // waiting.error InvalidTick: a range out of the tick bounds, which the backend never builds.
  reverted_invalid_tick: "Waiting: the next position's range isn't valid at this price",
  // Added 2026-10-05 (rugged97's #358): a v3 pool with too little price history for the reference price (its oracle
  // slots); Domino's automation adds the slots, paid once per pool.
  twap_history_short: "Waiting for this pool to record enough price history",
})

/** A share in basis points as a percent: 500 → "5", 250 → "2.5", 5000 → "50". */
const percentOfBps = (bps: number): string => Number((bps / 100).toFixed(2)).toString()

/**
 * rugged97's F7 delta of 5 Oct, §5.5, "Na tela": a Domino-compound vault's next position in one sentence, "Opens when the
 * price is within {trigger}% of #{tokenId}'s ceiling, starting at the current price, with a ceiling at least {upside}%
 * higher." Only the sequence's newest member, the one with no successor yet, opens it (the root while it has none).
 * Null for a vault that is not Domino-compound, or whose policy or limits were not read.
 */
export function nextPositionWords(view: {
  mode: 1 | 2 | null
  policy: { triggerDistanceBps: number } | null
  limits: { upsideBps: number } | null
  members: readonly Pick<VaultMemberView, 'tokenId' | 'role' | 'state' | 'parent'>[]
  rootTokenId: bigint
}): string | null {
  if (view.mode !== 2 || !view.policy || !view.limits) return null
  const live = view.members.filter((member) => member.state === 'armed' || member.state === 'active')
  const parents = new Set(live.flatMap((member) => (member.role === 'successor' && member.parent !== null ? [member.parent.toString()] : [])))
  const newest = live.find((member) => !parents.has(member.tokenId.toString()))?.tokenId ?? view.rootTokenId
  return `Opens when the price is within ${percentOfBps(view.policy.triggerDistanceBps)}% of #${newest.toString()}'s ceiling, starting at the current price, with a ceiling at least ${percentOfBps(view.limits.upsideBps)}% higher.`
}

/**
 * rugged97's F7 delta of 5 Oct, §6.2: `max_positions_reached`, with the sequence's own `maxPositions` (its policy). Without
 * the policy read, the same sentence without the number.
 */
export function maxPositionsWaiting(maxPositions: number | null): string {
  return maxPositions === null
    ? 'Waiting: your sequence has reached its position limit. Raise the limit or withdraw a position to continue'
    : `Waiting: your sequence has reached ${maxPositions} positions. Raise the limit or withdraw a position to continue`
}

/**
 * Spec rev4 §6.2 (#311): a vault whose root is closed, with reserves left. The automation returns them on its own pass
 * (`returnReserves()`), or cannot pay one of the tokens to the owner (it stays in the vault for the owner to withdraw).
 * Said first: this reason's words win over anything else its record says.
 */
export const RESERVES_WAITING_TEXT: Readonly<Record<string, string>> = Object.freeze({
  reserves_returnable: 'Your position is closed. Its waiting fees are being returned to your wallet',
  reserves_unpayable: "Your position is closed, but your wallet can't receive one of the tokens. Withdraw it from your automation",
})

/** Codes the screen already says another way (the paused state, the disarmed root): no waiting line for them. */
const SAID_ELSEWHERE = new Set(['vault_paused', 'root_disarmed'])

/**
 * "Waiting: {copy} · since {relative time}" (§6.2 recommendation) for a vault's or an order's `waiting`, or null when
 * there is nothing to say: no record (`null`), a code the screen already shows (paused, disarmed), or the planner's own
 * `InvalidExecution` (§4.9: never shown). A closed root's reserves (RESERVES_WAITING_TEXT) are said first; then the copy
 * is §4.9's for `waiting.error` (its own words: "Waiting …", "Paused: …", "Not valid: …", "Blocked: …"), else §6.2's for
 * `waiting.reason`, else plainly "Waiting". `code` is for a data attribute.
 */
export function waitingWords(waiting: Waiting | null, chainId: V2ChainId, nowSeconds: number, vault: { maxPositions: number | null } | null = null): { text: string; code: string } | null {
  if (!waiting) return null
  // Changed on purpose 2026-10-04 (rugged97's delta of 4 Oct §2 item 5, #311): RootOpen and SuccessorActive are the
  // automatic reserves return waiting its turn (it runs only with the root closed and no active successor): the normal
  // state, so no line at all.
  if (waiting.error === 'RootOpen' || waiting.error === 'SuccessorActive') return null
  const reserves = Object.hasOwn(RESERVES_WAITING_TEXT, waiting.reason) ? RESERVES_WAITING_TEXT[waiting.reason] : null
  if (reserves !== null) return { text: `${reserves} · since ${agoWords(waiting.since, nowSeconds)}`, code: waiting.reason }
  let copy: string | null = null
  if (waiting.error) {
    const row = AUTO_EXIT_WAITING.find((r) => r.signature.startsWith(`${waiting.error}(`))
    if (row) {
      const decoded = decodeRevertData(row.selector, 'autoExitWaiting', { chainId })
      if (decoded.recovery === 'hidden') return null
      copy = decoded.copy
    }
  }
  if (copy === null) {
    if (SAID_ELSEWHERE.has(waiting.reason)) return null
    copy = waiting.reason === 'max_positions_reached' ? maxPositionsWaiting(vault?.maxPositions ?? null) : (WAITING_REASON_TEXT[waiting.reason] ?? 'Waiting')
  }
  return { text: `${copy.replace(/\.$/, '')} · since ${agoWords(waiting.since, nowSeconds)}`, code: waiting.error ?? waiting.reason }
}

// ---------------------------------------------------------------------------
// The receipts history (§6.2 `activity`)
// ---------------------------------------------------------------------------

export type HistoryItem = ActivityResponse['items'][number]

/** The history items of one vault on one chain: its runs, auto-exits, creation, vault events and orders' events. */
export function historyOf(items: readonly HistoryItem[], chainId: V2ChainId, vault: Address): readonly (VaultExecution | AutoExit | VaultCreated | VaultEvent | ReservesReturned | AutoExitEvent)[] {
  const at = vault.toLowerCase()
  const out: (VaultExecution | AutoExit | VaultCreated | VaultEvent | ReservesReturned | AutoExitEvent)[] = []
  for (const item of items) {
    if (item.chainId !== chainId) continue
    if ((item.kind === 'vault_execution' || item.kind === 'auto_exit' || item.kind === 'vault_created' || item.kind === 'vault_event' || item.kind === 'reserves_returned' || item.kind === 'auto_exit_event') && item.vault === at) out.push(item)
  }
  return out
}

export interface HistoryLine {
  label: string
  value: string
}

export interface HistoryWords {
  id: string
  kind: HistoryItem['kind']
  title: string
  lines: readonly HistoryLine[]
  /** The block's time (Unix seconds). */
  at: number
  hash: string
  finalized: boolean
}

interface HistoryContext {
  chain: V2Chain
  /** The wallet: who "you" is in an event's actor. */
  owner: Address
  /** The vault's pool tokens in pool order, when known: amounts given as [amount0, amount1] need them. */
  pool: readonly [TokenView, TokenView] | null
  meta: (address: Address) => TokenMeta | null
}

const amountOf = (ctx: HistoryContext, token: string, raw: string): string => amountWords(BigInt(raw), tokenView(ctx.chain, token.toLowerCase() as Address, ctx.meta(token.toLowerCase() as Address))).text
/** [amount0, amount1] in the pool's tokens; the raw integers when the pool's tokens are not known. */
const pairOf = (ctx: HistoryContext, amounts: readonly string[]): string =>
  amounts.map((raw, i) => (ctx.pool ? amountWords(BigInt(raw), ctx.pool[i as 0 | 1]).text : `${raw} raw units`)).join(' + ')
const tariffsOf = (ctx: HistoryContext, tariffs: readonly Tariff[]): string => tariffs.map((t) => amountOf(ctx, t.token, t.amount)).join(' + ')

/** "Service fee (2%)" / "(4%)" from a run's tariffs (200 or 400 bps by the vault's mode), or plainly "Service fee". */
function serviceFeeLabel(tariffs: readonly Tariff[]): string {
  const rates = new Set(tariffs.filter((t) => t.kind === 'automation').map((t) => t.rateBps))
  if (rates.size !== 1) return 'Service fee'
  const rate = [...rates][0]
  return rate === 200 ? `Service fee (${automationFeeText(1)})` : rate === 400 ? `Service fee (${automationFeeText(2)})` : 'Service fee'
}

/** One vault event in words (§5.3–§5.6), or null for one the person need not read (the v3 checkpoint). */
function vaultEventWords(event: VaultEvent['events'][number], ctx: HistoryContext, sender: string | null): string | null {
  switch (event.event) {
    case 'PolicyChanged': return `Automation settings saved: ${event.policy.mode === 'domino' ? 'Domino-compound' : 'Auto-compound'}`
    case 'LimitsChanged': return 'Limits saved'
    case 'AutomationPaused': return event.actor === ctx.owner.toLowerCase() ? 'Paused by you' : 'Paused by Domino'
    case 'AutomationResumed': return 'Automation resumed'
    case 'RootDisarmed': return DISARM_TEXT[DISARM_REASON_NUMBER[event.reason]] ?? 'Automation stopped for this position.'
    case 'RootRearmed': return sender !== null && sender !== ctx.owner.toLowerCase() ? 'Turned back on by Domino after someone added liquidity to your position.' : 'Turned back on'
    case 'RootCheckpointed': return null
    // rev3 §2.13: a vault's reserves returned by someone else (the backend's pass, once the contract PR lets anyone return
    // a closed vault's reserves to its owner only) are "Returned to your wallet"; read-v6 rc.1 says it as a
    // ReservesWithdrawn the owner did not send. Unknown sender: the owner's own withdrawal.
    case 'ReservesWithdrawn': return sender !== null && sender !== ctx.owner.toLowerCase()
      ? `Returned to your wallet: ${amountOf(ctx, event.token, event.amount)}`
      : `Withdrawn to your wallet: ${amountOf(ctx, event.token, event.amount)}`
    case 'ChildWithdrawn': return `Position #${event.tokenId} withdrawn to your wallet`
    case 'TokenRecovered': return `Recovered: ${amountOf(ctx, event.token, event.amount)}`
    case 'PositionRecovered': return `Position #${event.tokenId} recovered to your wallet`
    case 'ExitModuleSet': return event.module === null || event.module === ZERO_ADDRESS ? 'Auto-exit turned off' : 'Auto-exit turned on'
  }
  return null
}

/** A history item in words, or null for one the vault screens do not show (S1's own, the zap's). */
export function historyWords(item: HistoryItem, ctx: HistoryContext): HistoryWords | null {
  const base = { id: item.id, kind: item.kind, at: item.tx.snapshot.timestamp, hash: item.tx.hash, finalized: item.tx.finality === 'finalized' }
  switch (item.kind) {
    case 'vault_execution': {
      const lines: HistoryLine[] = [
        { label: 'Fees used', value: pairOf(ctx, [item.compounded.fees0, item.compounded.fees1]) },
        { label: serviceFeeLabel(item.tariffs), value: tariffsOf(ctx, item.tariffs.filter((t) => t.kind === 'automation')) || pairOf(ctx, [item.compounded.serviceFee0, item.compounded.serviceFee1]) },
        { label: 'Added to your position', value: `${item.compounded.liquidityAdded} liquidity units` },
      ]
      const title = item.successor ? `Automated run: position #${item.successor.tokenId} opened` : `Automated run on position #${item.compounded.tokenId}`
      return { ...base, title, lines }
    }
    case 'auto_exit': {
      const lines: HistoryLine[] = [{ label: 'Sent to your wallet', value: pairOf(ctx, item.delivered) }]
      const fee = item.tariffs.filter((t) => t.kind === 'auto_exit')
      if (fee.length) lines.push({ label: 'Auto-exit fee (0.2%)', value: tariffsOf(ctx, fee) })
      if (item.deferred.length) lines.push({ label: 'Waiting for you to claim', value: item.deferred.map((d) => amountOf(ctx, d.token, d.amount)).join(' + ') })
      if (item.reservesReturned.length) lines.push({ label: 'Returned from your automation, no fee', value: item.reservesReturned.map((d) => amountOf(ctx, d.token, d.amount)).join(' + ') })
      return { ...base, title: `Auto-exit: position #${item.tokenId} withdrawn`, lines }
    }
    case 'vault_created':
      return { ...base, title: `Automation set up for position #${item.rootTokenId}`, lines: [] }
    case 'vault_event': {
      const sender = item.tx.gas?.sender?.toLowerCase() ?? null
      const said = item.events.map((event) => vaultEventWords(event, ctx, sender)).filter((line): line is string => line !== null)
      if (said.length === 0) return null
      return { ...base, title: said[0], lines: said.slice(1).map((value) => ({ label: '', value })) }
    }
    // read-v6's own kind for a returnReserves() the owner did not send (0xdecimal's item 8): the words a vault_event
    // with such a ReservesWithdrawn had before.
    case 'reserves_returned': {
      const said = item.reservesReturned.map((line) => `Returned to your wallet: ${amountOf(ctx, line.token, line.amount)}`)
      return { ...base, title: said[0], lines: said.slice(1).map((value) => ({ label: '', value })) }
    }
    case 'auto_exit_event': {
      if (item.event === 'MandateRegistered') return { ...base, title: `Exit order registered${item.tokenId ? ` for position #${item.tokenId}` : ''}`, lines: [] }
      if (item.event === 'MandateRevoked') return { ...base, title: 'Exit order cancelled', lines: [] }
      if (item.event === 'NonceCancelled') return { ...base, title: 'Signed order cancelled', lines: [] }
      return { ...base, title: item.token && item.amount ? `Claimed: ${amountOf(ctx, item.token, item.amount)}` : 'Claimed', lines: [] }
    }
  }
  return null
}
