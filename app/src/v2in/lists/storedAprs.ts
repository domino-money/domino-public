/**
 * Your APR on the rows of a chain whose fee history is read-v6's (`position-fees`, docs/v2/V2_FEES.md; the owner,
 * 2026-11-04: every chain the same as Robinhood Chain). The same arithmetic and the same cell as Robinhood Chain's rows
 * (components/positions/listApr.ts), asked eight a request, as those rows' ledgers are. Nothing is sent while the route's
 * capabilities do not name it, and the rows keep their dash.
 */
import { useEffect, useMemo, useState } from 'react'
import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { rowAprs, type RowApr } from '../../components/positions/listApr'
import { positionFeesView } from '../../lib/fees/positionFees'
import type { FeeHistoryView } from '../../lib/fees/types'
import type { V2ChainId } from '../../v2/types'
import { tokensOf } from '../position/model'
import { feeTokenOf } from '../position/positionFees'
import { tokenBook } from '../position/tokens'
import type { PositionRowView } from './model'
import { POSITION_FEES, positionFeesKey, routeOpensPositionFees } from './source'

const PER_REQUEST = 8
const NONE: ReadonlyMap<string, RowApr> = new Map()

/** A row whose APR comes from this read: not Robinhood Chain's (its ledger, ./positionCollection.ts hasPositionApr), and no hooked pool's. */
export const hasStoredApr = (row: PositionRowView): boolean => row.chainId !== 4663 && !row.hooked

/** A row's place in the map `useStoredAprs` answers: a numeric id alone could name another chain's NFT. */
export const storedAprId = (row: Pick<PositionRowView, 'chainId' | 'dex' | 'tokenId'>): string => `${row.chainId}:${row.dex}:${row.tokenId}`

/** The rows (by `storedAprId`), grouped by chain, as `position-fees` reads of at most eight. */
export function storedAprReads(ids: readonly string[]): { chainId: V2ChainId; key: string }[] {
  const byChain = new Map<V2ChainId, { dex: 3 | 4; tokenId: string }[]>()
  for (const id of new Set(ids)) {
    const [chainId, dex, tokenId] = id.split(':')
    const list = byChain.get(Number(chainId) as V2ChainId) ?? []
    list.push({ dex: Number(dex) as 3 | 4, tokenId })
    byChain.set(Number(chainId) as V2ChainId, list)
  }
  const reads: { chainId: V2ChainId; key: string }[] = []
  for (const [chainId, list] of byChain) {
    for (let at = 0; at < list.length; at += PER_REQUEST) reads.push({ chainId, key: positionFeesKey(chainId, list.slice(at, at + PER_REQUEST)) })
  }
  return reads
}

type Replies = ReadonlyMap<string, ReturnType<typeof POSITION_FEES.get>>

/** Each row's APR cell, by `storedAprId`, while `active` (the Open tab). `answer`: the portfolio read, for the tokens' decimals. */
export function useStoredAprs(rows: readonly PositionRowView[], answer: PortfolioResponse | null, active: boolean): ReadonlyMap<string, RowApr> {
  const ids = rows.filter(hasStoredApr).map(storedAprId).join(',')
  const reads = useMemo(() => (ids === '' ? [] : storedAprReads(ids.split(','))), [ids])
  const [replies, setReplies] = useState<Replies>(() => new Map())
  useEffect(() => {
    if (!active || reads.length === 0) return undefined
    const heard = () => setReplies(new Map(reads.map((read) => [read.key, POSITION_FEES.get(read.key)])))
    const stops = reads.map((read) => POSITION_FEES.subscribe(read.key, heard))
    // A read kept from an earlier visit is drawn at once, not at its next answer.
    heard()
    return () => { for (const stop of stops) stop() }
  }, [reads, active])
  return useMemo(() => {
    if (reads.length === 0) return NONE
    const views = new Map<string, FeeHistoryView>()
    for (const { chainId, key } of reads) {
      const reply = replies.get(key) ?? null
      if (reply === null) {
        if (routeOpensPositionFees()) for (const item of key.split('|')[1].split(',')) views.set(`${chainId}:${item}`, { phase: 'loading', state: null })
      } else if (reply.kind === 'ok') {
        const tokenOf = feeTokenOf(tokenBook(chainId, answer ? tokensOf(answer, chainId) : []))
        for (const position of reply.body.positions) views.set(`${chainId}:${position.dex}:${position.tokenId}`, positionFeesView(position, tokenOf))
      }
    }
    return rowAprs([...views.keys()], views)
  }, [reads, replies, answer])
}
