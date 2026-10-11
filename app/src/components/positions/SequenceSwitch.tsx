import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Hex } from 'viem'
import { CONTRACT_VERSION, validateResponse, validateError } from 'api-contracts/execution-v1/runtime.mjs'
import { automationReadyUntil } from '../../finance/automationAvailability'
import { financialFetch } from '../../finance/http'
import { connectSequence, watchSequenceRelease, settleStep } from '../../finance/sequenceLive'
import { errorCode, financeErrorText } from '../../finance/words'
import { personRefused } from '../../finance/nonce'
import { livePort } from '../../session/livePort'
import { readyUntil, renewIn, switchOffer, type Readiness } from '../../lib/automate/switchGate'
import { noteAutomation, useAutomation } from '../../lib/automationState'
import { useWalletIdentity, walletKey } from '../../lib/walletIdentity'
import { Button } from '../ui'
import { outcomeUnknown, readAfterReplaced } from './walletSteps'

const executionRuntime = { CONTRACT_VERSION, validateResponse, validateError }

/*
 * Turn on and Pause (the owner, 2026-09-25: "vamos ligar tudo"): the one owner transaction a sequence's vault takes to
 * start or stop, on the page of its root position and on the automation page's success. A sequence is created paused
 * (finance/sequence.ts create), and nothing switched it on since Manage a sequence left (2026-09-24).
 *
 * Turn on is shown only on the automation service's own word, until that word expires (at most 9 seconds, asked again
 * about every 8 while it holds), for this owner and this vault in the signed-in session (lib/automate/switchGate.ts), and
 * the service is asked again right before anything is sent: a service that is not ready, or an answer that cannot be
 * read, shows nothing new, and the page keeps its link to the docs (`fallback`). Connected and not signed in, the way to
 * sign in is offered instead. Pause needs no service and no session.
 *
 * A press prepares the step through the sequence client (the vault read and checked on chain, simulated, its network
 * budget from the wallet's own price), offers it to the wallet once, and reads it back by hash until it settles, as Set
 * up automation does (finance/sequenceLive.ts). The position's state is then told at once (noteAutomation), so its pill
 * says Active or Paused without waiting for the next read. There is no review wall: the wallet shows the transaction.
 */

type Action = 'turn-on' | 'pause'
type Stage = 'reading' | 'wallet' | 'chain' | 'done' | 'failed'
interface Run {
  action: Action
  stage: Stage
  notice: { text: string; code: string | null } | null
}

const LABEL = { 'turn-on': 'Turn on', pause: 'Pause' } as const satisfies Readonly<Record<Action, string>>
const DONE: Readonly<Record<Action, string>> = { 'turn-on': 'Turned on.', pause: 'Paused.' }
const PROGRESS: Partial<Record<Stage, string>> = { wallet: 'Confirm in your wallet.', chain: 'Waiting for the network.' }

/** This control's sentences for the codes a press meets; any other code goes through finance/words.ts. */
const OWN: Readonly<Record<string, string>> = {
  automation_not_ready: 'The automation service is not ready for this sequence. Nothing was sent.',
  sequence_activation_unavailable: 'This sequence can’t be turned on now: it is already on, or its permission over the position or its operator changed. Nothing was sent.',
  sequence_preparation_changed: 'The sequence changed while this was prepared. Nothing was sent. Try again.',
  sequence_already_paused: 'This sequence is already paused. Nothing was sent.',
  native_gas_reserve_insufficient: 'Your ETH does not cover the network fee for this step. Nothing was sent.',
  gas_budget_exceeded: 'This step needs more gas than expected. Nothing was sent. Try again in a moment.',
  sequence_receipt_waiting: 'The transaction is still waiting to be included. Check your wallet activity before trying again.',
  sequence_step_reverted: 'The transaction reverted: nothing changed, only network gas was spent.',
  sequence_step_reorged: 'The block that held the transaction left the chain. Check your wallet activity before trying again.',
}
/** The checks a send makes before the wallet opens: failing one, the wallet was never asked. */
const BEFORE_WALLET = ['review_required', 'sequence_admission_unavailable', 'sequence_release_expired', 'sequence_activation_unavailable', 'sequence_tariff_changed', 'deployment_code_changed', 'deployment_identity_changed', 'sequence_preparation_changed', 'pending_wallet_transaction', 'wallet_request_open']
/** Once a transaction was sent, no sentence may claim that nothing was sent (the review of 754014c). */
const NOTHING = / ?(No (wallet )?transaction|Nothing) was \w+\./g

/** A failure while the step was offered to the wallet, kept apart from the reads and the preparation before it. */
class Offered extends Error {
  constructor(readonly inner: unknown) {
    super('offered')
  }
}

// The person's own refusal, as the nonce latch reads it (finance/nonce.ts: 4001, WalletConnect's 5000, a hardware wallet's words).
const declined = (error: unknown) => personRefused(error)

/** A press's failure in words. `sent`: the wallet gave a hash, so the sentence says what is known of it and never that nothing was sent. */
function noticeFor(error: unknown, sent: boolean, action: Action): { text: string; code: string | null } {
  const offered = error instanceof Offered
  const inner = offered ? error.inner : error
  const code = errorCode(inner)
  let text: string
  if (code !== null && Object.hasOwn(OWN, code)) text = OWN[code]
  // 2026-10-01 (audit C14): "Cancel" in the wallet, read back from the chain: the vault did not change. Changed on purpose
  // 2026-10-01 (integration pass 3, the copy review): "automation", not "sequence" (audit E3), and Create position's pattern.
  else if (code === 'sequence_step_replaced') text = `Your wallet replaced this step with another transaction, and automation was not ${action === 'turn-on' ? 'turned on' : 'paused'}. Press ${LABEL[action]} again.`
  else if (sent) text = outcomeUnknown('transaction')
  else if (offered && declined(inner)) text = 'You declined in your wallet. Nothing was sent.'
  else if (offered && code !== null && BEFORE_WALLET.includes(code)) text = financeErrorText(code, 'The sequence changed. Nothing was sent. Try again.', LABEL[action])
  else if (offered) text = 'The wallet outcome may be unknown. Check your wallet activity before trying again.'
  else text = financeErrorText(code, 'Your wallet could not complete this step. Nothing was sent.', LABEL[action])
  return { text: sent ? text.replace(NOTHING, '').trim() || outcomeUnknown('transaction') : text, code: declined(inner) ? 'declined' : code }
}

/** The service's word for this owner and vault, asked through the session: when its "ready" expires, or null (finance/automationAvailability.ts: a refusal is null). */
const askReady = (owner: `0x${string}`, vault: `0x${string}`) => automationReadyUntil(owner, vault, livePort, financialFetch, executionRuntime)

/** Opens the header's wallet dialog, where Sign in is. */
const openSignIn = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()

export interface SequenceSwitchProps {
  /** The root position's NFT id. */
  tokenId: string
  /** The NFT's owner as the page read it, lowercase; nothing is offered unless it is the connected wallet. Unset: the connected wallet's own. */
  holder?: string
  /** Whether the position holds liquidity: an empty one is never turned on. */
  liquid: boolean
  /** What the page shows when the switch offers nothing: its link to the docs, or nothing. */
  fallback?: ReactNode
  /** Whether a connected wallet that is not signed in is offered the way to sign in (a position's page); if not, `fallback`. */
  signIn?: boolean
  size?: 'md' | 'lg'
}

export function SequenceSwitch({ tokenId, holder, liquid, fallback = null, signIn = true, size = 'md' }: SequenceSwitchProps) {
  const view = useAutomation(tokenId)
  const sequence = view.phase === 'ready' && 'paused' in view.state ? view.state : null
  const identity = useWalletIdentity()
  const connected = walletKey(identity) !== null && identity.kind === 'connected' ? (identity.address.toLowerCase() as `0x${string}`) : null
  const owner = connected !== null && (holder === undefined || holder.toLowerCase() === connected) ? connected : null
  const session = useSyncExternalStore(livePort.subscribe, livePort.getSnapshot)
  const [release, setRelease] = useState(false)
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  // The time the switch was last looked at: when an answer arrived, or when it went stale.
  const [now, setNow] = useState(0)
  const [run, setRun] = useState<Run | null>(null)
  const generation = useRef(0)
  const running = useRef(false)
  useEffect(() => () => void generation.current++, [])

  // Another wallet or position: nothing a press said for the previous one applies.
  const key = `${owner ?? ''}|${tokenId}`
  const [seen, setSeen] = useState(key)
  if (seen !== key) {
    setSeen(key)
    setRun(null)
    setReadiness(null)
  }
  useEffect(() => {
    generation.current++
    running.current = false
  }, [key])

  const wanted = sequence !== null && owner !== null
  useEffect(() => {
    if (!wanted) return
    return watchSequenceRelease((value) => setRelease(value.kind === 'available'))
  }, [wanted])

  // The service is asked for a paused sequence of this owner's, in its session, while the page is in view, and again
  // just before its "ready" expires (lib/automate/switchGate.ts renewIn). Nothing is asked for a running sequence,
  // another owner's, or with no session; a hidden page asks again when it is shown.
  const vault = sequence ? (sequence.vault as `0x${string}`) : null
  const epoch = session.kind === 'signed_in' && owner !== null && session.owner === owner ? session.epoch : null
  const ask = release && liquid && sequence?.paused === true && owner !== null && vault !== null && epoch !== null
  useEffect(() => {
    if (!ask || owner === null || vault === null || epoch === null) return
    const [who, where, signedEpoch] = [owner, vault, epoch]
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const shown = () => {
      if (document.hidden) return
      document.removeEventListener('visibilitychange', shown)
      check()
    }
    function check() {
      if (document.hidden) {
        document.addEventListener('visibilitychange', shown)
        return
      }
      void askReady(who, where).then((until) => {
        if (!live) return
        const answer = { owner: who, vault: where, epoch: signedEpoch, at: Date.now(), until }
        setReadiness(answer)
        setNow(answer.at)
        timer = setTimeout(check, renewIn(answer))
      })
    }
    check()
    return () => {
      live = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [ask, owner, vault, epoch])
  // A "ready" nobody renewed expires: looked at again when it does, and Turn on goes.
  useEffect(() => {
    if (!readiness?.until) return
    const timer = setTimeout(() => setNow(Date.now()), readyUntil(readiness) - Date.now() + 50)
    return () => clearTimeout(timer)
  }, [readiness])

  const offer = release ? switchOffer({ sequence, owner, session, readiness, now, liquid }) : null
  // While a press runs, or after it, its own button stays: the state it changed is what the page shows next.
  const pressing = run !== null && (run.stage === 'reading' || run.stage === 'wallet' || run.stage === 'chain')
  const action: Action | null = pressing ? run.action : offer === 'turn-on' || offer === 'pause' ? offer : null

  async function press(chosen: Action) {
    if (running.current || !sequence || owner === null || vault === null) return
    running.current = true
    const gen = ++generation.current
    const alive = () => generation.current === gen
    let sent = false
    setRun({ action: chosen, stage: 'reading', notice: null })
    try {
      // Asked again right before anything: a service that stopped since the page asked closes Turn on, fail closed.
      const ready = async () => {
        if (chosen !== 'turn-on' || (await askReady(owner, vault)) !== null) return
        if (alive()) setReadiness(null)
        throw new Error('automation_not_ready')
      }
      await ready()
      const { client, gas } = await connectSequence()
      const step = chosen === 'turn-on' ? await client.resume(vault, gas) : await client.recover(vault, 'pause', gas)
      if (!alive()) return
      await ready()
      if (!alive()) return
      setRun({ action: chosen, stage: 'wallet', notice: null })
      let hash: Hex
      try {
        hash = await client.send(step, true)
      } catch (error) {
        throw new Offered(error)
      }
      sent = true
      if (!alive()) return
      setRun({ action: chosen, stage: 'chain', notice: null })
      const settled = await settleStep(client, hash, alive)
      if (settled === 'left' || !alive()) return
      if (settled === 'replaced') {
        // 2026-10-01 (audit C14): replaced in the wallet ("Speed up" or "Cancel"). The vault read again says whether it is
        // now on or paused: a sped-up step switched it, a cancelled one did not. Nothing is sent again.
        const switched = await readAfterReplaced(() => client.inspect(vault), (state) => state.paused === (chosen === 'pause'), alive)
        if (switched === null || !alive()) return
        if (!switched) throw new Error('sequence_step_replaced')
      }
      // Its receipt is in and matches what was prepared: the vault is running or paused now. Positions and this page
      // show it at once, and the chain is asked again a few seconds later.
      noteAutomation({ tokenId, automation: sequence.automation, paused: chosen === 'pause', active: chosen === 'turn-on', vault })
      setRun({ action: chosen, stage: 'done', notice: null })
    } catch (error) {
      if (!alive()) return
      setRun({ action: chosen, stage: 'failed', notice: noticeFor(error, sent, chosen) })
    } finally {
      if (alive()) running.current = false
    }
  }

  const note = run?.notice?.text ?? (run && run.stage === 'done' ? DONE[run.action] : run ? (PROGRESS[run.stage] ?? null) : null)
  const noteLine = note && (
    <span role="status" className="dm-seq-switch-note" data-sequence-switch-note={run?.notice?.code ?? run?.stage}>
      {note}
    </span>
  )

  if (action === null) {
    if (offer === 'sign-in' && signIn)
      return (
        <>
          <Button type="button" variant="ghost" size={size} className="dm-auto-go dm-seq-switch" data-sequence-switch="sign-in" onClick={openSignIn}>
            Sign in to turn on
          </Button>
          {noteLine}
        </>
      )
    return (
      <>
        {fallback}
        {noteLine}
      </>
    )
  }
  return (
    <>
      {/* Turn on is the primary button on a position's page (2026-09-27: the one that offers sign-in), outlined elsewhere. */}
      <Button
        type="button"
        variant={signIn && action === 'turn-on' ? 'primary' : 'outline'}
        size={size}
        className="dm-auto-go dm-seq-switch"
        disabled={pressing}
        aria-busy={pressing || undefined}
        data-sequence-switch={action}
        data-sequence-switch-stage={run?.action === action ? run.stage : undefined}
        onClick={() => void press(action)}
      >
        {LABEL[action]}
      </Button>
      {noteLine}
    </>
  )
}
