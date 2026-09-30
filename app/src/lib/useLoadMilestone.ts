import { useEffect } from 'react'
import { loadTimings, type LoadMetric, type LoadQuality, type LoadScreen } from './loadTiming'

/** Record only committed, usable UI values, never a skeleton or the mere completion of a request. */
export function useLoadMilestone(screen: LoadScreen | readonly LoadScreen[], metric: LoadMetric, quality: LoadQuality | null): void {
  const active = loadTimings.current()
  const visit = active && (typeof screen === 'string' ? screen === active.screen : screen.includes(active.screen)) ? active.visit : null
  useEffect(() => {
    if (visit !== null && quality !== null) loadTimings.ready(visit, metric, quality)
  }, [visit, metric, quality])
}
