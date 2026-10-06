import { useRef, useState } from 'react'
import { readDirectReceipt, type DirectPrepared, type DirectReceipt } from '../../finance/v2/direct'
import type { Hex } from '../../v2/types'
import { RECEIPT_POLL_MS } from './constants'
import { COPY } from './copy'
import { actionError, type ActionError } from './errors'
import type { ActionPosition } from './model'
import { connectPosition, type OpenGate, type PositionConnection } from './wallet'

/**
 * The direct exits of a position (spec F7 §2.6.4 recommendation; finance/v2/direct.ts): both tokens, all or part, and
 * the fees alone, straight at Uniswap's own position manager: no zap approval and no Domino fee. Copied from the S1
 * reference's dialog (the former src/v2ui/s1/PositionDialog.tsx useDirectExit), gate-aware:
 *   - `live`: prepared (the position read through the wallet, simulated, its fee known), sent once when the person
 *     confirms, followed to its receipt from Uniswap's own logs, "Included" then "Finalized";
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
  /** A failed send that certainly did not go out may be confirmed again; a failed review may not. */
  retry: boolean
  /** Rev2 §2.13: the pause warning ticked (asked only when the exit pauses an armed root's automation). */
  ticked: boolean
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
  const said = (error: unknown) => actionError(error, gate.chainId, label)
  const failed = (error: unknown, retry = false) => setState((now) => ({ ...now, stage: 'failed', error: said(error), retry }))

  async function prepareNow(connection: PositionConnection, kind: DirectKind, bps: number, part: bigint): Promise<DirectPrepared> {
    return kind === 'collect' ? connection.direct.prepareCollect(position.dex, position.tokenId) : connection.direct.prepareClose(position.dex, position.tokenId, bps, null, part)
  }

  async function quote(kind: DirectKind, bps: number, part: bigint) {
    const gen = ++generation.current
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
    setState((now) => ({ ...now, stage: 'sent' }))
    while (gen === generation.current) {
      const receipt = await connection.direct.receipt(hash).catch(() => ({ state: 'pending' as const }))
      if (receipt.state === 'reverted') {
        // Known not to have happened: a fresh exit may be reviewed.
        setState((now) => ({ ...now, stage: 'failed', prepared: null, error: said(new Error('batch_simulation_reverted')), retry: false }))
        return
      }
      if (receipt.state === 'included' || receipt.state === 'finalized') {
        try {
          const read = readDirectReceipt({ chainId: gate.chainId, kind: ask.kind, dex: position.dex, tokenId: position.tokenId, owner: connection.wallet.owner, pool: prepared.state.pool, receipt })
          setState((now) => ({ ...now, stage: 'done', receipt: read }))
        } catch (error) {
          // On chain, but its logs cannot be read exactly: said so, nothing guessed, and never offered again.
          setState((now) => ({ ...now, stage: 'done', error: { copy: COPY.receipt.unreadable, code: error instanceof Error ? error.message : 'receipt_invalid', recovery: 'none' } }))
        }
        if (receipt.state === 'finalized') return
      }
      await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS))
    }
  }

  return {
    ...state,
    quote,
    send,
    tick: () => setState((now) => ({ ...now, ticked: true })),
    reset: () => {
      generation.current++
      asked.current = null
      setState(IDLE)
    },
  }
}
