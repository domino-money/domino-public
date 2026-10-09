import type { ChainStatus } from 'api-contracts/read-v6/types'
import { Badge, FigureDash } from '../../components/ui'
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
const STALE_TEXT = 'Your automation may be a few minutes behind.'
const FAILED_TEXT = "Domino can't read your automation right now."

export function IndexStatus({ chains, failed, chainId, what }: { chains?: readonly ChainStatus[]; failed?: Exclude<ListsReply<unknown>, { kind: 'ok' }>; chainId: V2ChainId; what: string }) {
  const name = v2Chain(chainId).name
  if (failed) {
    return (
      <p className="dm-acct-note" data-read6-failed={failed.kind === 'invalid' ? failed.detail : failed.reason}>
        <FigureDash /> {FAILED_TEXT}
      </p>
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
      {view?.state === 'stale' && (
        <p className="dm-acct-note flex flex-wrap items-center gap-2" data-read6-stale={String(view.lagSeconds ?? '')}>
          <Badge kind="stale" />
          <span>{STALE_TEXT}</span>
        </p>
      )}
      {(view === null || view.state === 'unavailable') && (
        <p className="dm-acct-note" data-read6-unavailable={view?.reason ?? 'missing'}>
          <FigureDash /> {what} on {name} isn't available right now.
        </p>
      )}
    </div>
  )
}
