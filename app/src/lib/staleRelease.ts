/**
 * An open tab across a release (2026-10-01, platform workstream, D1).
 *
 * Every release renames most of the site's scripts (each is named by its content). A tab opened before a release still
 * runs the old entry, and the first time it needs a file the old entry names (a screen, the wallet),
 * the deployment no longer holds it: the import fails, and the screen said "This section couldn't load" until the
 * person reloaded, with nothing saying a new version was out.
 *
 * What the page does instead: when a file of its own fails to load, it asks the deployment, once, which entry its page
 * loads now (the same fetch of `/` a reload would make, and nothing else). When that entry is not the one this tab
 * runs, or the access gate asks for the password again, the tab reloads once, on the same route (the route is the
 * address, the page's own path since 2026-11-07, lib/route.ts, which a reload keeps). Any other failure (offline, a refused request) is left to the screen's own message: a reload
 * would not help, and a reload loop is never possible: at most one automatic reload per RELOAD_GAP_MS in a tab, kept in
 * that tab's sessionStorage.
 *
 * Safely: a failure while a money flow is open (New position, Setup, a sequence), or while a dialog is open (a
 * position's Collect fees or Close position, whose wallet prompt may be waiting), never reloads the page under it; the
 * reload waits for the person's next navigation instead (`whenSafe`). A route's own screen that fails to load is never
 * inside a flow (the person just asked for that screen), so it reloads at once.
 */

import { ROUTES } from '../routeTable'
import { currentRoute, onRoute } from './route'

/** The sessionStorage key of the last automatic reload's time. */
export const RELOAD_MARK = 'domino.release-reload.v1'
/** At most one automatic reload per tab in this time. */
export const RELOAD_GAP_MS = 10 * 60_000

/**
 * What browsers say when a script module, a stylesheet a chunk needs, or a worker's script could not be fetched or
 * run as what it should be: Chromium "Failed to fetch dynamically imported module", Firefox "error loading dynamically
 * imported module", Safari "Importing a module script failed", Vite's preload "Unable to preload CSS for", and a module
 * the server answered with the wrong type ("MIME type").
 */
const MISSING = /dynamically imported module|Importing a module script failed|Unable to preload CSS|MIME type|Failed to load module script/i

/** Whether `error` is a file of the page that could not be loaded, as opposed to an error in code that did load. */
export function isMissingChunk(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && MISSING.test(message)
}

/** The script a page of `html` loads as its entry: its module script's src, or null. */
export function entryOf(html: string): string | null {
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype=["']?module["']?/i.test(tag)) continue
    const src = /\bsrc=["']?([^"'\s>]+)/i.exec(tag)
    if (src) return src[1]
  }
  return null
}

/** What the deployment's page is now, for this tab: its own release, another one, the access gate, or no answer. */
export type Deployed = 'same' | 'newer' | 'gate' | 'unknown'

export interface ReleaseDeps {
  /** The entry this tab runs: its document's module script. */
  current: () => string | null
  fetch: (input: string, init: RequestInit) => Promise<Response>
  storage: () => Pick<Storage, 'getItem' | 'setItem'> | null
  now: () => number
  reload: () => void
}

/** Asks the deployment which page it serves now. Never throws. */
export async function deployedRelease(deps: Pick<ReleaseDeps, 'current' | 'fetch'>): Promise<Deployed> {
  try {
    const reply = await deps.fetch('/', { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'manual', headers: { Accept: 'text/html' } })
    // The access gate answers 401 to anything once the beta cookie has expired: a reload shows its page, and the
    // person's link is kept through it (functions/_lib/gate.ts).
    if (reply.status === 401) return 'gate'
    if (!reply.ok || !(reply.headers.get('Content-Type') ?? '').includes('text/html')) return 'unknown'
    const deployed = entryOf(await reply.text())
    const current = deps.current()
    if (!deployed || !current) return 'unknown'
    return deployed === current ? 'same' : 'newer'
  } catch {
    return 'unknown'
  }
}

/** Reloads unless this tab already did within RELOAD_GAP_MS; says whether it did. Storage that is blocked: never. */
export function reloadOnce(deps: Pick<ReleaseDeps, 'storage' | 'now' | 'reload'>): boolean {
  try {
    const storage = deps.storage()
    if (!storage) return false
    const last = Number(storage.getItem(RELOAD_MARK))
    const now = deps.now()
    if (Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < RELOAD_GAP_MS) return false
    storage.setItem(RELOAD_MARK, String(now))
  } catch {
    return false
  }
  deps.reload()
  return true
}

/**
 * After a file of this tab failed to load: reloads the tab once when the deployment serves a newer release, or the
 * access gate. Resolves true when the reload has started (the caller keeps what it shows until the page goes), false
 * otherwise (the caller shows its own message). One check at a time: callers that fail together share it.
 */
export function createReleaseRecovery(deps: ReleaseDeps) {
  let checking: Promise<boolean> | null = null
  let waiting = false
  const recover = (): Promise<boolean> =>
    (checking ??= deployedRelease(deps)
      .then((deployed) => (deployed === 'newer' || deployed === 'gate') && reloadOnce(deps))
      .finally(() => {
        checking = null
      }))
  return {
    recover,
    /**
     * The same, for a failure that may sit inside a money flow: when `safe` is false now, the check and the reload wait
     * for `later` (the next navigation), and nothing is reloaded under the flow.
     */
    whenSafe(safe: boolean, later: (run: () => void) => void): void {
      if (safe) {
        void recover()
        return
      }
      if (waiting) return
      waiting = true
      later(() => {
        waiting = false
        void recover()
      })
    },
  }
}

/** The browser's: this document's entry, the page's own fetch, sessionStorage, the wall clock and location.reload(). */
export const releaseRecovery = createReleaseRecovery({
  current: () => document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null,
  fetch: (input, init) => window.fetch(input, init),
  storage: () => {
    try {
      return window.sessionStorage
    } catch {
      return null
    }
  },
  now: () => Date.now(),
  reload: () => window.location.reload(),
})

/** The pages that hold a money flow open: New position, Setup and a sequence's page. */
const FLOWS: ReadonlySet<string> = new Set(['new', 'setup', 'sequence'])

/**
 * Whether the route in `hash` is one of them, or the second chain's own New position (`#/elysium/new…`, 2026-10-01, the
 * chain2 workstream, part B: its wallet prompt may be waiting the same way).
 */
export function moneyFlowOpen(hash: string): boolean {
  const [, first = '', second = ''] = hash.replace(/^#/, '').split('#')[0].split('/')
  if (first === 'elysium') return second === 'new'
  return Object.hasOwn(ROUTES, first) && FLOWS.has(ROUTES[first as keyof typeof ROUTES])
}

/**
 * Whether a modal dialog is open: a position's Collect fees or Close position (whose wallet prompt may be waiting), the
 * wallet's own, or any other. A reload would close what the person is reading or confirming, so it waits as in a flow.
 */
export function dialogOpen(doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document): boolean {
  try {
    return doc?.querySelector('[aria-modal="true"]') != null
  } catch {
    return false
  }
}

/**
 * For a file that failed to load anywhere on the page (Vite's vite:preloadError): the recovery now,
 * or, while a money flow or a dialog is open, at the person's next navigation.
 */
export function recoverWhenSafe(): void {
  releaseRecovery.whenSafe(!moneyFlowOpen(currentRoute()) && !dialogOpen(), (run) => onRoute(run, true))
}

/**
 * A lazily loaded module that, when its file is gone because a release replaced it, reloads the tab once into the new
 * release (keeping what is on screen until the page goes), and otherwise falls back to `standIn`. For a screen a route
 * opens: the person just asked for it, so no flow is open under it.
 */
export function recovering<T>(load: () => Promise<T>, standIn: (error: unknown) => T): () => Promise<T> {
  return () =>
    load().catch(async (error: unknown) => {
      if (isMissingChunk(error) && (await releaseRecovery.recover())) return new Promise<T>(() => undefined)
      return standIn(error)
    })
}
