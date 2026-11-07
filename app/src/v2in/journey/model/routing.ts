import type { V2ChainId } from '../../../v2/types'
import { JOURNEY_STAYS_ON_ROBINHOOD, SETUP_STAYS_WHILE_PREVIEW } from '../constants'

/**
 * Which New position a network gets (the integrated journey, 2026-10-02):
 *   - `setup`: today's journey exactly, Create position through Domino V1's setup (Robinhood Chain whenever its S1 gate
 *     is `off`, and, with SETUP_STAYS_WHILE_PREVIEW, while it is only `preview`: V1 stays fully testable there);
 *   - `zap`: the same four steps on Domino's new contracts (the zap): to the review then the locked sentence under
 *     `preview`, for real under `live`;
 *   - `closed`: not offered (Base or Arbitrum One with its gate `off`).
 * No network choice exists (the owner, 2026-10-02 night): New position is Robinhood Chain's journey, whose search also finds
 * Base's and Arbitrum One's tokens since 2026-10-05 (../otherChains.ts). Pure.
 */
export type GateMode = 'off' | 'preview' | 'live'
export type JourneyRoute = 'setup' | 'zap' | 'closed'

export const ROBINHOOD: V2ChainId = 4663

export function routeFor(chainId: V2ChainId, mode: GateMode, setupFirstWhilePreview: boolean = SETUP_STAYS_WHILE_PREVIEW, journeyStays: boolean = JOURNEY_STAYS_ON_ROBINHOOD): JourneyRoute {
  if (chainId === ROBINHOOD) {
    // The owner, 2026-10-05: his journey on Robinhood Chain, whatever the gate says (../constants.ts).
    if (journeyStays) return 'setup'
    if (mode === 'live') return 'zap'
    if (mode === 'preview' && !setupFirstWhilePreview) return 'zap'
    return 'setup'
  }
  return mode === 'off' ? 'closed' : 'zap'
}

/**
 * Whether Robinhood Chain's pools that today's journey cannot open (a v3 pool, a pool with no price yet) may be found and
 * created on the zap path: wherever its gate is open (`preview` or `live`), even while its listed pools keep Setup.
 */
export const robinhoodFinderOpen = (mode: GateMode): boolean => mode !== 'off'

/**
 * Added 2026-11-06 (the replica rule, O-15: Base and Arbitrum One are Robinhood Chain's screens, only the network
 * changes): whether "Create a new pool (advanced)" at the foot of today's pool step opens the zap path's pool finder on
 * `chainId`, the network of the token chosen there (Robinhood Chain before one is chosen). On Robinhood Chain, as before:
 * while its listed pools keep today's steps (`route` 'setup') and its gate is open. On Base and Arbitrum One: wherever
 * their gate is open (`preview` runs to the review, then says the gate's sentence; `live` creates), exactly as Robinhood
 * Chain's finder is offered under either. It opened Robinhood Chain's finder whatever token was chosen. Pure.
 */
export function finderOpen(chainId: V2ChainId, mode: GateMode, route: JourneyRoute = routeFor(chainId, mode)): boolean {
  if (chainId === ROBINHOOD) return route === 'setup' && robinhoodFinderOpen(mode)
  return mode !== 'off'
}
