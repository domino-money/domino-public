import type { Hex } from 'viem'
import { setupWallet } from './wallet'
import { suggestGasBudget } from './gas'
import { readRelease } from './release'
import { createSequenceClient, sequenceDeploymentFrom, sequenceProviderReadError, type SequenceDeployment } from './sequence'
import { readSequenceSnapshot } from './sequenceSnapshot'
import type { GasBudget } from './setup'

/**
 * The sequence client as the pages use it, live: the published release, the connected wallet, the network budget from
 * the wallet's own price (./gas.ts), and a sent step read back until it settles. Shared by the automation page
 * (screens/Sequence.tsx, SequenceCreate.tsx) and a sequence's Turn on and Pause (components/positions/SequenceSwitch.tsx,
 * 2026-09-25), so both prepare, send and read back exactly alike. Moved here from screens/Sequence.tsx and
 * SequenceCreate.tsx unchanged.
 */

export type SequenceClient = ReturnType<typeof createSequenceClient>

/** What a press needs, fresh at each press: the verified client, a network budget from the wallet's own price, and a way to keep the verified profile. */
export interface Connected {
  client: SequenceClient
  gas: GasBudget
  verified: () => void
}

/** Kept after a verified creation, for Start tracking's reads when no release is published (screens/Performance.tsx). It never holds owner data or a key. */
const cacheKey = 'domino.sequence.public-recovery.v1'

export const readSequenceRelease = () => readRelease('/api/setup/v1/sequence-release', (value) => sequenceDeploymentFrom(value))

/** For a loaded client: the published profile now, or null when it is no longer published. */
export const currentSequenceDeployment = async (): Promise<SequenceDeployment | null> => {
  const release = await readSequenceRelease()
  return release.kind === 'available' ? release.deployment : null
}

/** A batch simulated on the chain's own RPC, for a wallet without eth_simulateV1: the page's chain code, loaded as its reads load it. */
const simulateOnChain = async (params: unknown[]) => (await import('../lib/chain/chainCode')).simulateOnChain(params)

/**
 * What a press needs, asked again at each press: the published release (a release switched off since the page opened
 * never prepares a step), the connected wallet, the sequence client over it, and a network budget from the wallet's
 * own price, so nobody types gas.
 */
export async function connectSequence(): Promise<Connected> {
  const live = await readSequenceRelease()
  if (live.kind !== 'available') throw new Error('sequence_admission_unavailable')
  const wallet = await setupWallet().catch((error) => {
    throw sequenceProviderReadError(error)
  })
  const client = createSequenceClient(wallet, live.deployment, () => Date.now() / 1000, currentSequenceDeployment, readSequenceSnapshot, { simulate: simulateOnChain })
  const gas = await suggestGasBudget(wallet)
  const verified = () => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment: live.deployment }))
    } catch {
      /* Optional: tracking still reads the published release. */
    }
  }
  return { client, gas, verified }
}

type Receipt = Awaited<ReturnType<SequenceClient['receipt']>>['state']
/** How long a sent step's receipt is read, and how often. */
export const RECEIPT_WAIT_MS = 240_000
export const RECEIPT_EVERY_MS = 3_000
/** In a block and settled: succeeded (within its budget or past it), reverted, or its block gone. */
const SETTLED: readonly Receipt[] = ['confirming', 'finalized', 'reverted', 'reorged', 'over_budget', 'over_budget_finalized']

/**
 * Reads a sent step's receipt every few seconds until it settles. 'landed': it is in a block and succeeded. 'left':
 * `here()` said the page moved on, and nothing reads it any more. Throws sequence_receipt_waiting when it is still
 * not in a block after RECEIPT_WAIT_MS, sequence_step_reverted or sequence_step_reorged; a read that fails throws its
 * own error. Nothing is ever sent again from here.
 */
export async function settleStep(client: SequenceClient, hash: Hex, here: () => boolean): Promise<'landed' | 'left'> {
  let state: Receipt = 'pending'
  const until = Date.now() + RECEIPT_WAIT_MS
  while (Date.now() < until && !SETTLED.includes(state)) {
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_EVERY_MS))
    if (!here()) return 'left'
    state = (await client.receipt(hash)).state
  }
  if (!SETTLED.includes(state)) throw new Error('sequence_receipt_waiting')
  if (state === 'reverted') throw new Error('sequence_step_reverted')
  if (state === 'reorged') throw new Error('sequence_step_reorged')
  return 'landed'
}
