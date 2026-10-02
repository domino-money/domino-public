/**
 * The reads the Robinhood v4 adapter wraps (2026-10-01, the chain2 workstream, part B, audit item G7): the very functions
 * Robinhood Chain's own screens call, handed over as they are, so the adapter reads exactly what those screens read
 * (adapter.ts says which, and what it does not wrap). tests/chain-adapters.test.mjs holds each one to the page's own.
 */
import { principalAt } from '../../../functions/_lib/walletPositions'
import { chainState } from '../../lib/fees/client'
import { readWalletPositions } from '../../lib/walletPositions'
import type { RobinhoodReads } from './adapter'

export const ROBINHOOD_READS: RobinhoodReads = Object.freeze({
  walletPositions: readWalletPositions,
  positionState: chainState,
  principal: principalAt,
})
