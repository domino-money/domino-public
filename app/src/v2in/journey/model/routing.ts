import type { V2ChainId } from '../../../v2/types'
import { SETUP_STAYS_WHILE_PREVIEW } from '../constants'

/**
 * Which New position a network gets (the integrated journey, 2026-10-02):
 *   - `setup`: today's journey exactly, Create position through Domino V1's setup (Robinhood Chain whenever its S1 gate
 *     is `off`, and, with SETUP_STAYS_WHILE_PREVIEW, while it is only `preview`: V1 stays fully testable there);
 *   - `zap`: the same four steps on Domino's new contracts (the zap): to the review then the locked sentence under
 *     `preview`, for real under `live`;
 *   - `closed`: not offered (Base or Arbitrum One with its gate `off`).
 * No network choice exists (the owner, 2026-10-02 night): New position is Robinhood Chain's. Pure.
 */
export type GateMode = 'off' | 'preview' | 'live'
export type JourneyRoute = 'setup' | 'zap' | 'closed'

export const ROBINHOOD: V2ChainId = 4663

export function routeFor(chainId: V2ChainId, mode: GateMode, setupFirstWhilePreview: boolean = SETUP_STAYS_WHILE_PREVIEW): JourneyRoute {
  if (chainId === ROBINHOOD) {
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
