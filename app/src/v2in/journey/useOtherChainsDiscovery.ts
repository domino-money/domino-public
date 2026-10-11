import { useEffect, useMemo, useState } from 'react'
import { whenVisibleAfter } from '../../lib/read/screens/quietRead'
import { quietDelayMs } from '../../lib/read/screens/transient'
import { mergeGates } from './model/networks'
import { otherChainsFor } from './otherChains'
import { PASSING } from './served'
import { journeyGatesRead, type JourneyGates } from './source'

const FOCUS_EVERY_MS = 15_000

/** Markets and New position share discovery; a public read never opens the financial gate. */
export function useOtherChainsDiscovery({ walletFallback = true }: { walletFallback?: boolean } = {}) {
  const [gates, setGates] = useState<JourneyGates | null>(null)
  useEffect(() => {
    let alive = true
    let reading = false
    let wanted = false
    let attempt = 0
    let lastRead = 0
    let cancelWait: (() => void) | null = null
    const later = () => {
      const wait = quietDelayMs(PASSING, attempt)
      if (wait === null) return
      attempt += 1
      cancelWait = whenVisibleAfter(wait, read)
    }
    function read() {
      if (!alive || reading) return
      reading = true
      lastRead = Date.now()
      cancelWait?.()
      cancelWait = null
      void journeyGatesRead().then(
        ({ gates: next, again }) => {
          reading = false
          if (!alive) return
          setGates((held) => mergeGates(held, next))
          wanted = again
          if (again) later()
        },
        () => {
          reading = false
          if (!alive) return
          wanted = true
          later()
        },
      )
    }
    const onFocus = () => {
      if (wanted && document.visibilityState === 'visible' && Date.now() - lastRead >= FOCUS_EVERY_MS) read()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    read()
    return () => {
      alive = false
      cancelWait?.()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [])
  const others = useMemo(() => otherChainsFor(gates, { walletFallback }), [gates, walletFallback])
  return { gates, others }
}
