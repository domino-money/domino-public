import type { Snapshot, SessionController } from './controller'

export type SignInProgress = { phase: 'idle' | 'switching' | 'checking' | 'signing' | 'returning' | 'error'; message: string; returnChain?: number }
type Ports = Pick<SessionController, 'getSnapshot' | 'subscribe' | 'dispatch'> & {
  switchNetwork(chainId: number): Promise<string>
  networkName(chainId: number): string
  canReturn(chainId: number): boolean
  explain(snapshot: Snapshot): string
  switchError(result: string, chainId: number): string
}
const ready = (s: Snapshot) => s.view.status === 'signed_in' || s.away
const idle: SignInProgress = { phase: 'idle', message: '' }

/** One explicit sign-in intent, shared by header and inline controls. Never sends a transaction. */
export function createSignInFlow(ports: Ports) {
  let state = idle
  let active: { owner: string; connector: string; chainId: number; cancelled: boolean; stop: () => void } | null = null
  let pausedReturn: { owner: string; connector: string; chainId: number } | null = null
  let stopErrorWatch = () => {}
  const listeners = new Set<() => void>()
  const publish = (next: SignInProgress) => { state = next; for (const listener of listeners) listener() }
  const matches = (attempt: NonNullable<typeof active>) => {
    const id = ports.getSnapshot().identity
    return !attempt.cancelled && active === attempt && id.kind === 'connected' && id.address.toLowerCase() === attempt.owner && id.connectorUid === attempt.connector
  }
  const settled = (s: Snapshot) => ready(s) || (!s.busy && s.view.status !== 'checking' && s.view.status !== 'starting')
  function wait(attempt: NonNullable<typeof active>, timeoutMs: number): Promise<Snapshot> {
    return new Promise((resolve, reject) => {
      let stop = () => {}
      const finish = (error?: Error) => { clearTimeout(timer); stop(); if (error) reject(error); else resolve(ports.getSnapshot()) }
      const check = () => {
        if (!matches(attempt)) finish(new Error('Your wallet changed. Sign in again with the account you want to use.'))
        else if (settled(ports.getSnapshot())) finish()
      }
      const timer = setTimeout(() => finish(new Error('Sign-in is taking longer than expected. Check your wallet, then try again.')), timeoutMs)
      const stopSession = ports.subscribe(check)
      listeners.add(check)
      stop = () => { stopSession(); listeners.delete(check) }
      check()
    })
  }
  async function start() {
    if (active) return
    const before = ports.getSnapshot()
    const id = before.identity
    if (id.kind !== 'connected' || before.busy) return
    const resuming = ready(before) && pausedReturn?.owner === id.address.toLowerCase() && pausedReturn.connector === id.connectorUid
    if (!resuming && (ready(before) || !['signed_out', 'wrong_network'].includes(before.view.status))) return
    const attempt = { owner: id.address.toLowerCase(), connector: id.connectorUid, chainId: resuming ? pausedReturn!.chainId : id.chainId, cancelled: false, stop: () => {} }
    stopErrorWatch()
    pausedReturn = null
    active = attempt
    attempt.stop = ports.subscribe(() => {
      if (!matches(attempt)) {
        attempt.cancelled = true
        attempt.stop()
        if (active === attempt) active = null
        publish(idle)
      }
    })
    try {
      if (!resuming && id.chainId !== 4663) {
        publish({ phase: 'switching', message: 'Confirm the switch to Robinhood Chain in your wallet to sign in.' })
        const result = await ports.switchNetwork(4663)
        if (!matches(attempt)) return
        if (result !== 'switched') throw new Error(ports.switchError(result, 4663))
      }
      publish({ phase: 'checking', message: 'Checking your sign-in…' })
      let current = await wait(attempt, 30_000)
      if (!matches(attempt)) return
      if (!ready(current)) {
        if (current.view.status !== 'signed_out' || current.identity.kind !== 'connected' || current.identity.chainId !== 4663) throw new Error(ports.explain(current))
        publish({ phase: 'signing', message: 'Sign the message in your wallet. No transaction or network fee.' })
        ports.dispatch({ type: 'sign_in' })
        current = await wait(attempt, 180_000)
        if (!matches(attempt)) return
        if (!ready(current)) throw new Error(ports.explain(current))
      }
      if (!matches(attempt)) return
      if (attempt.chainId !== 4663 && ports.canReturn(attempt.chainId)) {
        publish({ phase: 'returning', message: `Signed in. Confirm the switch back to ${ports.networkName(attempt.chainId)} in your wallet.` })
        const result = await ports.switchNetwork(attempt.chainId)
        if (!matches(attempt)) return
        if (result !== 'switched') {
          pausedReturn = attempt
          publish({ phase: 'error', message: `You are signed in. ${ports.switchError(result, attempt.chainId)}`, returnChain: attempt.chainId })
          return
        }
      }
      publish(idle)
    } catch (error) {
      if (matches(attempt)) {
        if (ports.getSnapshot().view.status === 'signing_in') ports.dispatch({ type: 'cancel' })
        publish({ phase: 'error', message: error instanceof Error ? error.message : 'Sign-in could not finish. Try again.' })
      }
    } finally {
      attempt.stop()
      if (active === attempt) active = null
      if (!active && !attempt.cancelled && state.phase === 'error') {
        stopErrorWatch()
        const clearChangedContext = () => {
          const identity = ports.getSnapshot().identity
          if (identity.kind !== 'connected' || identity.address.toLowerCase() !== attempt.owner || identity.connectorUid !== attempt.connector || (pausedReturn && !ready(ports.getSnapshot()) && settled(ports.getSnapshot())) || (!pausedReturn && ready(ports.getSnapshot()))) {
            stopErrorWatch(); pausedReturn = null; publish(idle)
          }
        }
        stopErrorWatch = ports.subscribe(clearChangedContext)
      }
    }
  }
  function cancel() {
    stopErrorWatch()
    if (active) { active.cancelled = true; active.stop(); active = null }
    pausedReturn = null
    if (ports.getSnapshot().view.status === 'signing_in') ports.dispatch({ type: 'cancel' })
    publish(idle)
  }
  return { start, cancel, getSnapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
