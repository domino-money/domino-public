/**
 * Issue #3: token candidates, from a pasted address or from a public
 * address's wallet listing. Identity is the lowercase address; the symbol is
 * untrusted decoration. Native ETH (the zero address) and wrapped ETH (an
 * ERC-20 at its own address) are two candidates, never one.
 *
 * Selectable: available and partial metadata (partial shows "decimals
 * unavailable"; decimals 0 is a real value). Never selectable: no contract,
 * unreadable, a wallet row whose balance could not be read, or the token the
 * pair already holds.
 */
import type { TokenResponse } from 'api-contracts/read-v1/types'
import type { WalletView } from '../pagers'
import { tokenDisplay } from '../project'
import type { Fact } from '../project'
import type { TokenDisplay } from '../types'
import { NATIVE_CURRENCY, addressKey, type AddressKey } from './identity'

export type CandidateKind = 'native' | 'erc20_candidate' | 'unknown'
export type NotSelectable = 'no_contract' | 'unreadable' | 'wallet_unavailable' | 'excluded'

export interface TokenCandidate {
  key: AddressKey
  /** What goes back on the wire: the typed string for a pasted address, the payload's lowercase address otherwise. */
  wire: string
  token: TokenDisplay
  kind: CandidateKind
  why: NotSelectable | null
  /** The contract's reason code behind `why`, as a closed enum value. */
  reasonCode: string | null
  decimalsUnavailable: boolean
  source: 'pasted' | 'wallet'
  /**
   * The address whose listing produced this row, for a wallet row; null for a
   * pasted one. Rows are keyed by TOKEN address everywhere — the picker, the
   * search, the exclusion — so the subject cannot live in the key. It lives
   * here, and mergeCandidates uses it to refuse to carry one address's
   * balances into another's listing.
   */
  wallet: AddressKey | null
  balance: Fact | null
  page: number | null
  old: boolean
  block: number | null
}

export const selectable = (candidate: TokenCandidate) => candidate.why === null

/**
 * The candidate a token read produced for exactly `wire`, or null: what a
 * search hands the view it opens, so the view need not read the same address
 * again. Only a selectable answer is handed over. An unreadable one can carry
 * a reason that passes (an RPC error, a deadline), and the view's own read is
 * the one that can get past it; nothing else asks again. A wallet row (no
 * block) or another spelling of the address is not that answer either.
 */
export const handoffFor = (candidate: TokenCandidate | null | undefined, wire: string): TokenCandidate | null =>
  candidate != null && candidate.source === 'pasted' && candidate.block !== null && candidate.wire === wire && selectable(candidate) ? candidate : null

export function candidateFromToken(data: TokenResponse, wire: string): TokenCandidate {
  const asset = data.asset
  const token = tokenDisplay(asset)
  const key = addressKey(asset.address)
  const base = { key, wire, token, source: 'pasted' as const, wallet: null, balance: null, page: null, old: false, block: data.snapshot.number }
  if (asset.kind === 'unknown') {
    return { ...base, kind: 'unknown', why: asset.readStatus === 'no_contract' ? 'no_contract' : 'unreadable', reasonCode: asset.reason, decimalsUnavailable: true }
  }
  return { ...base, kind: asset.kind, why: null, reasonCode: null, decimalsUnavailable: asset.decimals === null }
}

/**
 * One of a verified pool's two currencies, as a candidate.
 *
 * Arriving at the flow with a pool already chosen — the link a pool page's
 * "New position" carries — gave a pool and no deposit token, and the step
 * refused to continue for want of one with nowhere to pick it. The pool's own
 * currencies are the only sensible answer, and the pool read already verified
 * them on chain at `block`, so nothing is read again to offer them.
 *
 * A currency whose own token read did not complete keeps its reason and is
 * offered unselectable, the same as anywhere else.
 */
export function candidateFromPoolCurrency(token: TokenDisplay, block: number): TokenCandidate {
  const address = token.origin === 'read' ? token.address : ''
  const key = addressKey(address)
  const unreadable = token.origin === 'read' && (token.readStatus === 'no_contract' || token.readStatus === 'unavailable')
  return {
    key,
    wire: key,
    token,
    kind: key === NATIVE_CURRENCY ? 'native' : 'erc20_candidate',
    why: unreadable ? (token.origin === 'read' && token.readStatus === 'no_contract' ? 'no_contract' : 'unreadable') : null,
    reasonCode: null,
    decimalsUnavailable: token.origin === 'read' && token.decimals === null,
    source: 'pasted',
    wallet: null,
    balance: null,
    page: null,
    old: false,
    block,
  }
}

/** Wallet rows as candidates, plus the assets whose balance read failed, which stay visible but not selectable. */
export function candidatesFromWalletView(view: WalletView, wallet: AddressKey | null): TokenCandidate[] {
  const rows = view.rows.map((row): TokenCandidate => {
    const token = row.token
    const address = token.origin === 'read' ? token.address : ''
    const key = addressKey(address)
    return {
      key,
      wire: key,
      token,
      kind: key === NATIVE_CURRENCY ? 'native' : 'erc20_candidate',
      why: null,
      reasonCode: null,
      decimalsUnavailable: token.origin === 'read' && token.decimals === null,
      source: 'wallet',
      wallet,
      balance: row.amount,
      page: row.page,
      old: row.old,
      block: null,
    }
  })
  const unavailable = view.unavailable.map((item): TokenCandidate => {
    const token = item.title.tokens?.[0] as TokenDisplay
    const key = addressKey(token.origin === 'read' ? token.address : '')
    return {
      key,
      wire: key,
      token,
      kind: key === NATIVE_CURRENCY ? 'native' : 'erc20_candidate',
      why: 'wallet_unavailable',
      reasonCode: null,
      decimalsUnavailable: true,
      source: 'wallet',
      wallet,
      balance: item.facts[0] ?? null,
      page: null,
      old: item.old ?? false,
      block: null,
    }
  })
  return [...rows, ...unavailable]
}

/**
 * One row per address: a newer reading replaces an older one, keeping the
 * list's order.
 *
 * With one exception, which is the whole reason `wallet` exists. A listing for
 * a NEW address does not mention the tokens the previous address held, so
 * merging alone left those rows on screen — with their balances, their page
 * number and `old: false` — under the new address's listing. Nothing on the row
 * says which address it came from, so one wallet's holdings read as another's,
 * and the picker would carry that choice forward. Paging the SAME address is
 * untouched: a later page keeps the rows of the earlier ones.
 */
export function mergeCandidates(existing: readonly TokenCandidate[], incoming: readonly TokenCandidate[]): TokenCandidate[] {
  const subject = incoming.find((candidate) => candidate.source === 'wallet')?.wallet ?? null
  const kept = subject === null ? existing : existing.filter((candidate) => candidate.source !== 'wallet' || candidate.wallet === subject)
  const out = [...kept]
  for (const candidate of incoming) {
    const at = out.findIndex((c) => c.key === candidate.key)
    if (at === -1) out.push(candidate)
    else out[at] = candidate
  }
  return out
}

/** The first token of a pair cannot be its second. */
export const excluding = (candidate: TokenCandidate, exclude: AddressKey | null): TokenCandidate =>
  exclude !== null && candidate.key === exclude && candidate.why === null ? { ...candidate, why: 'excluded' } : candidate
