import { createContext, useContext } from 'react'
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
}

export const JourneyNetworkContext = createContext<JourneyNetwork | null>(null)

export const useJourneyNetwork = (): JourneyNetwork | null => useContext(JourneyNetworkContext)
