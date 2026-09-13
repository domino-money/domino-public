/**
 * How often this page lets the user ask for a preview.
 *
 * Best effort, by design (R-9, T-34). The server's quota (10 per account per
 * 60 s, shared by every tab and device of the account) is the real guard, and
 * its 429 is honoured here: every tab open on this origin hears about the
 * cooldown over BroadcastChannel and waits it out, with no automatic retry.
 * Locally a tab allows 8 sends per rolling 60 s, counting sends other open
 * tabs announce. A tab opened later starts with a full 8; that is accepted.
 *
 * Messages carry durations, never timestamps: each tab applies them to its
 * own monotonic clock.
 */
import type { Clock } from '../lib/clock'

export const BUDGET_LIMIT = 8
export const BUDGET_WINDOW_MS = 60_000
export const BUDGET_CHANNEL = 'domino-preview-budget-v1'

export type BudgetMessage = { t: 'spent' } | { t: 'cooldown'; ms: number }

export interface BudgetChannel {
  post(message: BudgetMessage): void
  listen(listener: (message: unknown) => void): () => void
}

export type BudgetCheck = { ok: true } | { ok: false; reason: 'budget' | 'cooldown'; retryAtMono: number }

export interface PreviewBudget {
  check(): BudgetCheck
  spend(): void
  /** The server said to wait `seconds`. Shared with other open tabs. */
  cooldown(seconds: number): void
  subscribe(listener: () => void): () => void
  /** Starts hearing other tabs, and telling them; returns what stops it. */
  connect(): () => void
  dispose(): void
}

function isMessage(value: unknown): value is BudgetMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { t?: unknown; ms?: unknown }
  if (message.t === 'spent') return Object.keys(value).length === 1
  return (
    message.t === 'cooldown' &&
    Object.keys(value).length === 2 &&
    typeof message.ms === 'number' &&
    Number.isSafeInteger(message.ms) &&
    message.ms > 0 &&
    message.ms <= BUDGET_WINDOW_MS
  )
}

export function createPreviewBudget({
  clock,
  channel = null,
  limit = BUDGET_LIMIT,
  windowMs = BUDGET_WINDOW_MS,
}: {
  clock: Clock
  channel?: BudgetChannel | null
  limit?: number
  windowMs?: number
}): PreviewBudget {
  let sends: number[] = []
  let cooldownUntil = Number.NEGATIVE_INFINITY
  const listeners = new Set<() => void>()
  let cancelWake: (() => void) | null = null

  const notify = () => {
    for (const listener of listeners) listener()
  }

  function prune(now: number) {
    sends = sends.filter((at) => at > now - windowMs)
  }

  function check(): BudgetCheck {
    const now = clock.monoMs()
    prune(now)
    if (now < cooldownUntil) return { ok: false, reason: 'cooldown', retryAtMono: cooldownUntil }
    if (sends.length >= limit) return { ok: false, reason: 'budget', retryAtMono: sends[0] + windowMs }
    return { ok: true }
  }

  /** Tells subscribers again when the current block lifts, so the button comes back on its own. */
  function planWake() {
    cancelWake?.()
    cancelWake = null
    const state = check()
    if (state.ok) return
    cancelWake = clock.setTimer(() => {
      cancelWake = null
      notify()
      planWake()
    }, Math.max(0, state.retryAtMono - clock.monoMs()) + 1)
  }

  function record(kind: 'spent' | 'cooldown', ms = 0) {
    const now = clock.monoMs()
    if (kind === 'spent') sends.push(now)
    else cooldownUntil = Math.max(cooldownUntil, now + ms)
    planWake()
    notify()
  }

  let unlisten: (() => void) | null = null

  return {
    check,
    spend() {
      record('spent')
      if (unlisten) channel?.post({ t: 'spent' })
    },
    cooldown(seconds) {
      const ms = Math.min(Math.max(1, Math.trunc(seconds)), 60) * 1000
      record('cooldown', ms)
      if (unlisten) channel?.post({ t: 'cooldown', ms })
    },
    connect() {
      if (!channel || unlisten) return () => {}
      unlisten = channel.listen((message) => {
        if (!isMessage(message)) return
        record(message.t, message.t === 'cooldown' ? message.ms : 0)
      })
      return () => {
        unlisten?.()
        unlisten = null
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      cancelWake?.()
      unlisten?.()
      listeners.clear()
    },
  }
}

/** The page's channel, where BroadcastChannel exists. */
export function broadcastBudgetChannel(): BudgetChannel | null {
  if (typeof BroadcastChannel !== 'function') return null
  let open: BroadcastChannel | null = null
  return {
    post: (message) => open?.postMessage(message),
    listen(listener) {
      const channel = new BroadcastChannel(BUDGET_CHANNEL)
      open = channel
      channel.onmessage = (event: MessageEvent) => listener(event.data)
      return () => {
        channel.close()
        if (open === channel) open = null
      }
    },
  }
}
