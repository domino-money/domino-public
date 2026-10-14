import { useEffect, useRef, useState } from 'react'
import { readDirectReceipt, type DirectPrepared, type DirectReceipt } from '../../finance/v2/direct'
import type { Hex } from '../../v2/types'
import { COPY } from './copy'
import { actionError, type ActionError } from './errors'
import type { ActionPosition } from './model'
import { connectPosition, type OpenGate, type PositionConnection } from './wallet'
import { positionChanged } from '../lists/positionSync'
import { v2Chain } from '../../v2/chains'
import { RECEIPT_STILL_WAITING_MS, receiptPause, receiptWalletAway } from '../receiptWait'
import { RECEIPT_FOLLOW } from '../journey/receiptFollow'

/**
 * The direct exits of a position (spec F7 §2.6.4 recommendation; finance/v2/direct.ts): both tokens, all or part, and
 * the fees alone, straight at Uniswap's own position manager: no zap approval and no Domino fee. Copied from the S1
 * reference's dialog (the former src/v2ui/s1/PositionDialog.tsx useDirectExit), gate-aware:
 *   - `live`: prepared (the position read through the wallet, simulated, its fee known), sent once when the person
 *     confirms, followed to its receipt from Uniswap's own logs, "Included" then "Finalized" (Changed on purpose 2026-10-14,
 *     incident C3: followed until it is in a block, "Confirmed", and no longer; nor after the dialog is gone);
 *   - `preview`: prepared the same way (its figures are the chain's), never sent: the dialog shows the gate's locked
 *     sentence instead of the button. The dialog asks for this read only while the wallet is already on the position's
 *     chain, and ./wallet.ts never asks a wallet to switch for the preview: nothing is sent, so nothing moves the wallet.
 */
export type DirectKind = 'collect' | 'close'

export interface DirectState {
  /**
   * `failed`: definitely not sent (a refusal, or the wallet never asked), so it may be confirmed again. `sent`: the wallet
   * gave a hash, followed to its receipt. `unknown`: the wallet may have it: never offered again from here. `done`: on chain.
   */
  stage: 'idle' | 'reading' | 'ready' | 'wallet' | 'sent' | 'unknown' | 'done' | 'failed'
  prepared: DirectPrepared | null
  error: ActionError | null
  receipt: DirectReceipt | null
  includedBlock?: bigint
  /** A failed send that certainly did not go out may be confirmed again; a failed review may not. */
  retry: boolean
  /** Rev2 §2.13: the pause warning ticked (asked only when the exit pauses an armed root's automation). */
  ticked: boolean
  /** The hash the wallet gave, and whether its block is still not seen 20 s later (C3: the sheet says so, with its link). */
  hash?: Hex
  slow?: boolean
  /** Its last read failed on the wallet's network (`chain`) or account (`account`): the sheet says to switch back (C3 review). */
  away?: 'chain' | 'account'
}

const IDLE: DirectState = { stage: 'idle', prepared: null, error: null, receipt: null, retry: false, ticked: false }

export function useDirectExit(gate: OpenGate, position: ActionPosition, label: (token: `0x${string}`) => string) {
  const [state, setState] = useState<DirectState>(IDLE)
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #1): on the root of Auto-exit's own automation,
  // its Auto-exit on or paused, a direct action keeps the position's approval, all its exit needs: the armed root's pause
  // is acknowledged without a tick (that automation never reinvests), and nothing is offered after (./PositionDialog.tsx).
  const quiet = position.vault?.exitLive === true
  const asked = useRef<{ kind: DirectKind; bps: number; part: bigint } | null>(null)
  // Every prepared exit handed to the client's send: never handed again (a new press reviews afresh).
  const handed = useRef(new WeakSet<DirectPrepared>())
  const generation = useRef(0)
  /** A sent exit whose block is not seen yet: what hands it on when the dialog goes (C3, below). */
  const waiting = useRef<(() => void) | null>(null)
  // Changed on purpose 2026-10-14 (incident C3: L5 of the incident): the dialog gone, its loop stops; it read the receipt
  // every 1.5 s until final, about 16 minutes after the screen was left. An exit still not seen in a block is handed to
  // the journey's shared follow (../journey/receiptFollow.ts: 5 s, then 15 s and 30 s, an hour at most, only while the
  // tab is in view), which reads it until it is in a block and no longer: the direct client lets the position go at that
  // read (finance/v2/direct.ts receipt) and the lists hear of it, as when the dialog stays open.
  const handOn = () => { waiting.current?.(); waiting.current = null }
  useEffect(() => () => { generation.current++; waiting.current?.(); waiting.current = null }, [])
  const said = (error: unknown) => actionError(error, gate.chainId, label)
  const failed = (error: unknown, retry = false) => setState((now) => ({ ...now, stage: 'failed', error: said(error), retry }))

  async function prepareNow(connection: PositionConnection, kind: DirectKind, bps: number, part: bigint): Promise<DirectPrepared> {
    return kind === 'collect' ? connection.direct.prepareCollect(position.dex, position.tokenId) : connection.direct.prepareClose(position.dex, position.tokenId, bps, null, part)
  }

  async function quote(kind: DirectKind, bps: number, part: bigint) {
    const gen = ++generation.current
    handOn()
    asked.current = { kind, bps, part }
    setState({ ...IDLE, stage: 'reading' })
    try {
      const prepared = await prepareNow(await connectPosition(gate), kind, bps, part)
      if (gen === generation.current) setState({ ...IDLE, stage: 'ready', prepared })
    } catch (error) {
      if (gen === generation.current) failed(error)
    }
  }

  async function send() {
    const gen = generation.current
    const ask = asked.current
    // The preview never sends: its dialog offers no button, and nothing here asks the wallet.
    if (gate.mode !== 'live' || !ask || (state.stage !== 'ready' && !(state.stage === 'failed' && state.retry))) return
    if (state.prepared?.pausesAutomation && !state.ticked && !quiet) return
    setState((now) => ({ ...now, stage: 'wallet', error: null }))
    let connection: PositionConnection
    let prepared: DirectPrepared
    try {
      connection = await connectPosition(gate)
      const kept = state.prepared
      prepared = kept && !handed.current.has(kept) && kept.step.expiresAt > Date.now() / 1000 + 2 ? kept : await prepareNow(connection, ask.kind, ask.bps, ask.part)
      // The warning was ticked on this review: a fresh preparation of the same exit carries it (rev2 §2.13).
      if (prepared.pausesAutomation !== null) {
        if (!state.ticked && !quiet) throw new Error('automation_pause_unacknowledged')
        connection.direct.acknowledgePause(prepared)
      }
    } catch (error) {
      if (gen === generation.current) failed(error)
      return
    }
    handed.current.add(prepared)
    setState((now) => ({ ...now, prepared }))
    let hash: Hex
    try {
      hash = await connection.direct.send(prepared, true)
    } catch (error) {
      if (gen !== generation.current) return
      // Handed to the wallet with no answer (review F2): it may run. Never offered again from here; the chain will say.
      if (connection.direct.wasOffered(prepared)) setState((now) => ({ ...now, stage: 'unknown', error: null }))
      else failed(error, true)
      return
    }
    setState((now) => ({ ...now, stage: 'sent', hash }))
    const chain = v2Chain(gate.chainId)
    /** The lists hear of the exit once, at its block. */
    const announce = (block: bigint) => positionChanged({ chainId: gate.chainId, positionManager: position.dex === 4 ? chain.uniswap.v4.positionManager : chain.uniswap.v3.positionManager, tokenIds: [position.tokenId.toString()], wallet: connection.wallet.owner, block })
    const wallet = connection.wallet
    waiting.current = () => RECEIPT_FOLLOW.follow(`direct:${gate.chainId}:${wallet.owner}:${hash}`, {
      read: () => connection.direct.receipt(hash),
      // Robinhood's receipts come from the site's own reader: the wallet's state does not matter to them (automate/session.tsx).
      // Changed on purpose 2026-10-14 (review of C3 on main): the wallet on another account, or gone a moment, is a pause, as
      // another network is. It was "gone", and the follow dropped the exit before any read: nothing else reads this hash, so
      // the direct client's latch on the position stayed, and when the same account came back the page reused that client
      // (./wallet.ts), and every Withdraw or Collect fees of the position said "already sent" until a reload. The follow
      // still ends at its hour.
      available: () => gate.chainId === 4663 ? 'ready' : wallet.current() && wallet.chainId() === gate.chainId ? 'ready' : 'paused',
      accept(next) {
        if (next.state === 'included' || next.state === 'finalized') announce(next.blockNumber)
        return next.state === 'included' || next.state === 'finalized' || next.state === 'reverted'
      },
    })
    // Changed on purpose 2026-10-14 (C3 review): the dialog closed (or went back) while the wallet still had the exit: its
    // cleanup found nothing to hand on then, so the hash is handed to the shared follow now. It was never read, and the
    // position stayed held from every later exit ("This was already sent to your wallet") until a reload.
    if (gen !== generation.current) { handOn(); return }
    // Changed on purpose 2026-10-14 (incident C3: waiting never locks; screens finish at inclusion): the pause grows and
    // slows after a failed read (../receiptWait.ts); a failed read is still "ask again", as it always was here. The sheet
    // is done at inclusion: the direct client lets the position go then (finance/v2/direct.ts receipt), and nothing waits
    // for finality on this path. It was read again every 1.5 s until its block was final.
    // Said at 20 s whatever the pause under way, while this dialog still follows it.
    const late = setTimeout(() => { if (gen === generation.current) setState((now) => (now.stage === 'sent' && !now.slow ? { ...now, slow: true } : now)) }, RECEIPT_STILL_WAITING_MS)
    let failures = 0
    try {
      for (let attempt = 0; gen === generation.current; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, receiptPause(attempt, failures)))
        if (gen !== generation.current) return
        const [receipt, away] = await connection.direct.receipt(hash).then(
          (answer) => { failures = 0; return [answer, undefined] as const },
          (error: unknown) => { failures++; return [{ state: 'pending' as const }, receiptWalletAway(error) ?? undefined] as const })
        // Gone while this read was out (C3 review): the follow it was handed reads and announces it, once.
        if (gen !== generation.current) return
        // Changed on purpose 2026-10-14 (C3 review): the wallet on another network or account is still "ask again", and
        // the sheet says to switch back.
        setState((now) => (now.stage === 'sent' && now.away !== away ? { ...now, away } : now))
        if (receipt.state === 'reverted') {
          waiting.current = null
          // Known not to have happened: a fresh exit may be reviewed.
          setState((now) => ({ ...now, stage: 'failed', prepared: null, error: said(new Error('batch_simulation_reverted')), retry: false }))
          return
        }
        if (receipt.state === 'included' || receipt.state === 'finalized') {
          waiting.current = null
          announce(receipt.blockNumber)
          try {
            const read = readDirectReceipt({ chainId: gate.chainId, kind: ask.kind, dex: position.dex, tokenId: position.tokenId, owner: connection.wallet.owner, pool: prepared.state.pool, receipt })
            setState((now) => ({ ...now, stage: 'done', receipt: read, includedBlock: receipt.blockNumber }))
          } catch (error) {
            // On chain, but its logs cannot be read exactly: said so, nothing guessed, and never offered again.
            setState((now) => ({ ...now, stage: 'done', includedBlock: receipt.blockNumber, error: { copy: COPY.receipt.unreadable, code: error instanceof Error ? error.message : 'receipt_invalid', recovery: 'none' } }))
          }
          return
        }
      }
    } finally {
      clearTimeout(late)
    }
  }

  return {
    ...state,
    quote,
    send,
    tick: () => setState((now) => ({ ...now, ticked: true })),
    reset: () => {
      generation.current++
      handOn()
      asked.current = null
      setState(IDLE)
    },
  }
}
