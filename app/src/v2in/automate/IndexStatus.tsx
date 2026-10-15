import type { ChainStatus } from 'api-contracts/read-v6/types'
import { v2Chain } from '../../v2/chains'
import type { ListsReply } from '../lists/read'
import type { V2ChainId } from '../../v2/types'
import { chainView, haltWords } from './portfolio'

/**
 * What is known of a chain's automation before any figure of it (spec F7 §8.2, §6.3, §5.3), in a beginner's words: the
 * registry's halt in the spec's sentence (the owner's actions go on, so the cards stay); behind, the stale badge and one
 * sentence; unavailable, a dash and one sentence (never zeros, and another chain's answer is never emptied); or the read
 * as a whole failed (an error, a body the validator refused), one sentence. Up to date and not halted says nothing. The
 * codes (the reason, the lag, the validator's detail) stay in data attributes, never in the text.
 */
// Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the halt banner is all it says. A chain behind
// ("Your automation may be a few minutes behind." with the stale badge), one unavailable ("… isn't available right now.")
// and a read that failed ("Domino can't read your automation right now.") are the markers' data only.

export function IndexStatus({ chains, failed, chainId, what }: { chains?: readonly ChainStatus[]; failed?: Exclude<ListsReply<unknown>, { kind: 'ok' }>; chainId: V2ChainId; what: string }) {
  const name = v2Chain(chainId).name
  if (failed) {
    return (
      <span hidden data-read6-failed={failed.kind === 'invalid' ? failed.detail : failed.reason} />
    )
  }
  if (!chains) return null
  const view = chainView(chains, chainId)
  // §5.3's banner: the chain's registry halted automation (`automationHalted` true; null is not known, and says nothing).
  const halt = view?.halted === true ? (
    <p role="status" className="dm-acct-note" data-automation-halted={chainId}>
      {haltWords(chainId)}
    </p>
  ) : null
  if (view?.state === 'current') return halt
  return (
    <div className="grid gap-1" data-read6-chain={view?.state ?? 'missing'}>
      {halt}
      {view?.state === 'stale' && <span hidden data-read6-stale={String(view.lagSeconds ?? '')} />}
      {(view === null || view.state === 'unavailable') && <span hidden data-read6-unavailable={view?.reason ?? 'missing'} data-read6-what={`${what} on ${name}`} />}
    </div>
  )
}
