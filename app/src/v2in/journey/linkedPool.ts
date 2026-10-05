import { useEffect, useRef, useState } from 'react'
import type { PreselectStatus } from '../../components/create/StageToken'
import { preselectFrom, verificationToken, type Preselect } from '../../lib/create/journey'
import { featuredStore, useFeatured } from '../../lib/read/featuredSource'
import { verifyCandidate } from '../../lib/read/screens/catalogueSession'
import { failureText } from '../../lib/read/screens/copy'
import { DYNAMIC_FEE_PIPS } from '../../lib/read/screens/fee'
import { NATIVE_CURRENCY, addressKey, type AddressKey } from '../../lib/read/screens/identity'
import { poolWarning } from '../../lib/read/screens/lookalike'
import { optionUsableForDomino, type PoolOption } from '../../lib/read/screens/poolsList'
import type { ReadSource } from '../../lib/read/types'

/** How many times a failed verification of the linked pool is asked again on its own, and the first wait: today's journey's. */
const VERIFY_ATTEMPTS = 3
const VERIFY_WAIT_MS = 4000

type Verified = Extract<PreselectStatus, { kind: 'verified' | 'not_found' | 'unsupported' | 'failed' | 'withdrawn' }>

/**
 * New position opened from a pool's link (#/new/<id>, or #/new/<id>/<token> from a pool's page: Markets, a featured row,
 * a pool page) on Domino V2's journey. Changed on purpose 2026-10-04 (the owner: every function runs on Domino V2): the zap
 * journey took no link, so every "New position" beside a pool opened on an empty search. The pool is verified exactly as
 * today's journey verifies it (components/create/Journey.tsx, the same reads and rules, no new ones):
 *   - the featured list's word first: a pool it withdrew by a safety rule is refused, never verified or preselected;
 *   - one pools read for that id, against the token its list entry or its link names, else USDG;
 *   - Domino's own rules: no hooks, a fixed fee, no token that passes for one of the site's main tokens.
 * A pool that passes goes to `onVerified`, once per answer; the caller keeps any pool the person already chose. A failure
 * that asking again could fix is asked again on its own, a few times, only while the page is visible. The status is
 * what step 1 says about the link meanwhile (components/create/StageToken.tsx).
 */
export function useLinkedPool(source: ReadSource | null, poolId: string, linkToken: string | null, onVerified: (option: PoolOption) => void): PreselectStatus {
  const featured = useFeatured()
  const [verified, setVerified] = useState<{ poolId: string; attempt: number; outcome: Verified } | null>(null)
  const [attempt, setAttempt] = useState(0)
  // The caller's latest callback, for an answer that lands after a later render.
  const deliver = useRef(onVerified)
  useEffect(() => {
    deliver.current = onVerified
  })

  useEffect(() => {
    const listed = featuredStore()
    const link = preselectFrom(poolId)
    if (!source || !link.ok) return
    const controller = new AbortController()
    const tokenFor = (linked: Extract<Preselect, { ok: true }>): AddressKey => (!linked.catalogue && linkToken ? addressKey(linkToken) : verificationToken(linked))
    void listed.ensure().then(async () => {
      const list = listed.getSnapshot()
      const linked = preselectFrom(poolId, list.entries)
      if (controller.signal.aborted || !linked.ok) return
      if (list.withdrawn.has(linked.key)) {
        setVerified({ poolId, attempt, outcome: { kind: 'withdrawn' } })
        return
      }
      const against = tokenFor(linked)
      const result = await verifyCandidate(source, against, null, linked.key, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (result.failure) {
        if (result.failure.state !== 'aborted') setVerified({ poolId, attempt, outcome: { kind: 'failed', line: failureText(result.failure, 'pools') } })
        return
      }
      const option = result.option
      if (!option) {
        setVerified({ poolId, attempt, outcome: { kind: 'not_found' } })
        return
      }
      if (!optionUsableForDomino(option)) {
        setVerified({ poolId, attempt, outcome: { kind: 'unsupported', reason: option.hooks === NATIVE_CURRENCY && option.feePips === DYNAMIC_FEE_PIPS ? 'dynamic' : 'hooks' } })
        return
      }
      if (poolWarning(option.currencies)) {
        setVerified({ poolId, attempt, outcome: { kind: 'withdrawn' } })
        return
      }
      deliver.current(option)
      setVerified({ poolId, attempt, outcome: { kind: 'verified', block: option.block } })
    })
    return () => controller.abort()
  }, [source, poolId, linkToken, attempt])

  useEffect(() => {
    if (!verified || verified.poolId !== poolId || verified.attempt !== attempt) return
    const outcome = verified.outcome
    if (outcome.kind !== 'failed' || !outcome.line.retry || attempt >= VERIFY_ATTEMPTS) return
    let cancelled = false
    const again = () => {
      if (!cancelled) setAttempt((count) => count + 1)
    }
    const whenVisible = () => {
      if (document.hidden) return
      document.removeEventListener('visibilitychange', whenVisible)
      again()
    }
    const timer = setTimeout(() => {
      if (document.hidden) document.addEventListener('visibilitychange', whenVisible)
      else again()
    }, VERIFY_WAIT_MS * 2 ** attempt)
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', whenVisible)
    }
  }, [verified, poolId, attempt])

  const linked = preselectFrom(poolId, featured.entries)
  if (!linked.ok) return { kind: linked.reason === 'malformed' ? 'malformed' : 'none' }
  return verified?.poolId === poolId && verified.attempt === attempt ? verified.outcome : { kind: 'checking', again: attempt > 0 }
}
