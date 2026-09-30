/** Local UI readiness timings. No requests, wallet identifiers, URLs, storage or analytics service. */
export type LoadScreen = 'overview' | 'markets' | 'pool' | 'positions' | 'position' | 'other'
export type LoadMetric = 'value' | 'tvl' | 'volume' | 'apr' | 'chart'
export type LoadQuality = 'current' | 'estimated' | 'cached' | 'partial'
export interface LoadSample { metric: LoadMetric; quality: LoadQuality; ms: number; backgrounded: boolean }
export interface LoadVisit { visit: number; screen: LoadScreen; started: number; backgrounded: boolean; readings: readonly LoadSample[] }
interface Runtime {
  now(): number
  visible(): boolean
  publish?(name: string, start: number, end: number, sample: LoadSample, visit: number): void
  remove?(name: string): void
}
export const MAX_LOAD_VISITS = 16
const SCREENS = new Set<LoadScreen>(['overview', 'markets', 'pool', 'positions', 'position', 'other'])
const METRICS = new Set<LoadMetric>(['value', 'tvl', 'volume', 'apr', 'chart'])
const QUALITIES = new Set<LoadQuality>(['current', 'estimated', 'cached', 'partial'])
const measureName = (visit: LoadVisit, metric: LoadMetric, quality: LoadQuality) => `domino:load:${visit.visit}:${visit.screen}:${metric}:${quality}`

/** Injectable clock and sink let before/after tests use exactly the same conditions. */
export function createLoadTimings(runtime: Runtime) {
  const visits: Array<LoadVisit & { readings: LoadSample[] }> = []
  let sequence = 0
  return {
    begin(screen: LoadScreen, start = runtime.now()): number {
      // A timing must never interrupt the application, even with unsupported runtime input.
      if (!SCREENS.has(screen) || !Number.isFinite(start)) return 0
      const visit = ++sequence
      visits.push({ visit, screen, started: Math.max(0, start), backgrounded: !runtime.visible(), readings: [] })
      while (visits.length > MAX_LOAD_VISITS) {
        const old = visits.shift()!
        for (const sample of old.readings) {
          try { runtime.remove?.(measureName(old, sample.metric, sample.quality)) } catch { /* Optional diagnostics. */ }
        }
      }
      return visit
    },
    current(): Readonly<{ visit: number; screen: LoadScreen }> | null {
      const active = visits.at(-1)
      return active ? { visit: active.visit, screen: active.screen } : null
    },
    visibility(): void {
      const active = visits.at(-1)
      if (active && !runtime.visible()) active.backgrounded = true
    },
    ready(visit: number, metric: LoadMetric, quality: LoadQuality): void {
      const active = visits.at(-1)
      if (!active || visit !== active.visit || !METRICS.has(metric) || !QUALITIES.has(quality)) return
      if (active.readings.some((sample) => sample.metric === metric && sample.quality === quality)) return
      const end = runtime.now()
      if (!Number.isFinite(end) || end < active.started) return
      active.backgrounded ||= !runtime.visible()
      const sample = { metric, quality, ms: end - active.started, backgrounded: active.backgrounded }
      active.readings.push(sample)
      try { runtime.publish?.(measureName(active, metric, quality), active.started, end, { ...sample }, visit) } catch { /* No User Timing support is harmless. */ }
    },
    snapshot(): readonly LoadVisit[] {
      return visits.map((visit) => ({ ...visit, readings: visit.readings.map((sample) => ({ ...sample })) }))
    },
  }
}

/** Route contents are classified then discarded: no pool, token, wallet or position identifier is recorded. */
export function loadScreen(hash: string): LoadScreen {
  const [page = '', param = ''] = hash.replace(/^#\/?/, '').split('#', 1)[0].split('/')
  if (page === '') return 'overview'
  if (page === 'markets' || page === 'explore' || page === 'pools') return 'markets'
  if (page === 'pool') return 'pool'
  if (page === 'positions' || page === 'app' || page === 'portfolio') return param ? 'position' : 'positions'
  return 'other'
}

export const loadTimings = createLoadTimings({
  now: () => typeof performance === 'undefined' ? 0 : performance.now(),
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  publish: (name, start, end, sample, visit) => performance.measure(name, { start, end, detail: { ...sample, visit } }),
  remove: (name) => performance.clearMeasures(name),
})

/** Install before React mounts, so lazy chunks and data reads count. Timings never leave this browser. */
export function startLoadTimings(browser: Window): () => void {
  let route = browser.location.hash.split('#', 2).join('#')
  loadTimings.begin(loadScreen(route), 0)
  const navigate = () => {
    const next = browser.location.hash.split('#', 2).join('#')
    if (next === route) return
    route = next
    loadTimings.begin(loadScreen(route))
  }
  const visibility = () => loadTimings.visibility()
  browser.addEventListener('hashchange', navigate)
  browser.document.addEventListener('visibilitychange', visibility)
  return () => {
    browser.removeEventListener('hashchange', navigate)
    browser.document.removeEventListener('visibilitychange', visibility)
  }
}
