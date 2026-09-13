import { useEffect, useState } from 'react'
import { readNow } from '../markets'

/** Presentation clock only; never schedules a network refresh. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(readNow)
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(readNow())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [active])
  return now
}
