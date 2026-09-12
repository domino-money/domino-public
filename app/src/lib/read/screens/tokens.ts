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
  balance: Fact | null
  page: number | null
  old: boolean
  block: number | null
}

export const selectable = (candidate: TokenCandidate) => candidate.why === null

export function candidateFromToken(data: TokenResponse, wire: string): TokenCandidate {
  const asset = data.asset
  const token = tokenDisplay(asset)
  const key = addressKey(asset.address)
  const base = { key, wire, token, source: 'pasted' as const, balance: null, page: null, old: false, block: data.snapshot.number }
  if (asset.kind === 'unknown') {
    return { ...base, kind: 'unknown', why: asset.readStatus === 'no_contract' ? 'no_contract' : 'unreadable', reasonCode: asset.reason, decimalsUnavailable: true }
  }
  return { ...base, kind: asset.kind, why: null, reasonCode: null, decimalsUnavailable: asset.decimals === null }
}

/** Wallet rows as candidates, plus the assets whose balance read failed, which stay visible but not selectable. */
export function candidatesFromWalletView(view: WalletView): TokenCandidate[] {
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
      balance: item.facts[0] ?? null,
      page: null,
      old: item.old ?? false,
      block: null,
    }
  })
  return [...rows, ...unavailable]
}

/** One row per address: a newer reading replaces an older one, keeping the list's order. */
export function mergeCandidates(existing: readonly TokenCandidate[], incoming: readonly TokenCandidate[]): TokenCandidate[] {
  const out = [...existing]
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
