import { createContext, useContext } from 'react'
import type { V2Gate } from '../../v2/gate'
import type { V2ChainId } from '../../v2/types'

/**
 * What New position's wrapper (./NewPositionV2.tsx) tells the journeys it draws: the network (Robinhood Chain; no network
 * choice exists, the owner's decision of 2026-10-02 night), and the way to the zap path's pool finder and back ("Create a
 * new pool (advanced)", ./PoolAdvanced.tsx). Absent (null) outside the wrapper.
 */
export interface JourneyNetwork {
  chainId: V2ChainId
  /**
   * On Robinhood Chain while its listed pools keep today's steps: open the zap path's pool finder for a pool today's
   * journey cannot open (a v3 pool, a pool with no price yet). Null where it is not offered.
   */
  findOther: (() => void) | null
  /** Back from that finder to today's list (null elsewhere). */
  backToList: (() => void) | null
  /**
   * Robinhood Chain's S1 gate, for today's journey's own Review and Create position (./JourneyCreateV2.tsx: the plan and
   * the zap behind the owner's screens once it is `live`, 2026-10-05); undefined while the wrapper still reads it.
   */
  s1?: V2Gate
}

export const JourneyNetworkContext = createContext<JourneyNetwork | null>(null)

export const useJourneyNetwork = (): JourneyNetwork | null => useContext(JourneyNetworkContext)
