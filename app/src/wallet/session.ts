import { useSyncExternalStore } from 'react'
import { getAddress } from 'viem'
import { createSessionApi } from '../session/api'
import { sessionRuntime } from '../session/contract'
import { createSessionController, HIDDEN_STAGGER_MS, type Snapshot } from '../session/controller'
import { clearPrivate, privateQueryClient, storePrivate } from '../session/privateQuery'
import { probeReads } from '../session/testProbe'
import { signLoginMessage, startIdentityFeed } from './port'

/**
 * The page's one session controller.
 *
 * Created when the wallet chunk first loads and kept for the life of the page,
 * not per component: moving between routes neither drops the in-memory CSRF
 * nor misses a wallet event that fires while a screen is swapped.
 */

const CHANNEL = 'domino-session-v1'
/** How often a tab coming back into view may re-read me. */
const VISIBLE_RECHECK_MS = 30_000

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null

export const sessionController = createSessionController({
  api: createSessionApi({ fetch: (input, init) => window.fetch(input, init), runtime: sessionRuntime }),
  sign: signLoginMessage,
  clearPrivate,
  storePrivate,
  // Carries the fact of a change and nothing else. The other tab reads its own
  // state back from me with its own cookie.
  broadcast: () => channel?.postMessage({ t: 'changed' }),
  // Only the fact of a renewal. The other tab holds the same cookie, so its
  // idle deadline moved too, and it need not refresh or read anything.
  broadcastRenewal: () => channel?.postMessage({ t: 'renewed' }),
  isVisible: () => document.visibilityState === 'visible',
  // Each tab its own: tabs in the background spread their refreshes out, so one renews and the others hear of it.
  hiddenStaggerMs: Math.floor(Math.random() * HIDDEN_STAGGER_MS),
  now: () => Date.now(),
  setTimer: (callback, ms) => {
    const id = window.setTimeout(callback, ms)
    return () => window.clearTimeout(id)
  },
  origin: window.location.origin,
  checksum: (address) => getAddress(address),
})

if (channel) {
  channel.onmessage = (event: MessageEvent) => {
    const kind = (event.data as { t?: unknown } | null)?.t
    if (kind === 'changed') sessionController.dispatch({ type: 'recheck', cause: 'remote' })
    else if (kind === 'renewed') sessionController.renewedElsewhere()
  }
}

// Expiry and revocation happen on the server while a tab sits in the
// background; looking again when it returns finds them.
let lastVisibleCheck = Date.now()
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  const now = Date.now()
  if (now - lastVisibleCheck >= VISIBLE_RECHECK_MS) {
    lastVisibleCheck = now
    sessionController.dispatch({ type: 'recheck', cause: 'visible' })
  }
  // A renewal older than ten minutes is renewed now (after the check above,
  // if one started): the browser may have held back this tab's timers.
  sessionController.wake()
})
// Taking focus is a return too (owner, 2026-09-25): a window brought back
// from behind another one may never have been hidden.
window.addEventListener('focus', () => sessionController.wake())

// The contract runtime validates messages with String#isWellFormed (Chrome
// 111, Safari 16.4, Firefox 119). Older browsers get an explicit state rather
// than an exception in the middle of a sign-in.
if (!('isWellFormed' in String.prototype)) sessionController.dispatch({ type: 'unsupported_browser' })
else startIdentityFeed((identity) => sessionController.dispatch({ type: 'identity', identity }))

// Test builds only: lets the browser tests see which private data exists. Only
// queries that hold data or are fetching count; a disabled query with nothing
// in it is an empty slot, not private data. Keys hold public addresses and the
// epoch, never a credential.
if (__DOMINO_TEST_HOOKS__) {
  Object.defineProperty(window, '__dominoSessionProbe', {
    value: Object.freeze({
      privateKeys: () =>
        privateQueryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.state.data !== undefined || query.state.fetchStatus !== 'idle')
          .map((query) => query.queryKey),
      mutations: () => privateQueryClient.getMutationCache().getAll().length,
      // Every value the private cache holds, serialised, so a test can check
      // that a late answer never landed anywhere in it.
      privateValues: () =>
        privateQueryClient
          .getQueryCache()
          .getAll()
          .filter((query) => query.state.data !== undefined)
          .map((query) => JSON.stringify(query.state.data)),
      // The controllable private read (session/testProbe.ts).
      armPrivateRead: () => probeReads.arm(),
      resolvePrivateReads: (match: string, value: string) => probeReads.resolve(match, value),
      privateReads: () => probeReads.log(),
      view: () => sessionController.getSnapshot().view,
      // True from a dispatch until its response is applied: what a clock jump
      // must not land inside (tests/support/clock.mjs).
      busy: () => sessionController.getSnapshot().busy,
    }),
  })
}

export function useSession(): Snapshot {
  return useSyncExternalStore(sessionController.subscribe, sessionController.getSnapshot)
}
