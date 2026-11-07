import type { ChainStatus } from 'api-contracts/read-v6/types'
import { setupHref } from '../../automate/intent'
import { exitOrderKey } from '../../autoexit/entry'
import { v2PositionHref } from '../../route'
import type { Dex, V2ChainId } from '../../../v2/types'

/**
 * Added 2026-11-06 (the replica rule, O-18: Base and Arbitrum One are Robinhood Chain's screens, only the network
 * changes): what New position's success offers for a position made through the owner's journey on another network than
 * Robinhood Chain. It is Robinhood Chain's own success (components/create/CreatedNext.tsx: "What should Domino do with
 * it?", the position kept plain, Auto-compound, Domino-compound, Auto-exit), its links by that network's routes, and only
 * the automations that network takes now. Pure: the gates and read-v6's answer are handed in.
 */

/** The choices CreatedNext links: the position's own page, or a setup with this position and that mode chosen. */
export type CreatedChoice = 'plain' | 'compound' | 'domino'

/** Where a choice leads for a position on any network: its page (the qualified route), or its setup. */
export function createdHref(chainId: V2ChainId, dex: Dex, tokenId: bigint, choice: CreatedChoice): string {
  const ref = { chainId, dex, tokenId }
  return choice === 'plain' ? v2PositionHref(ref) : setupHref(ref, choice)
}

/** The automation panel's own key for the position (../../autoexit/entry.ts), for Auto-exit's ask and the page's wait. */
export const createdKey = (chainId: V2ChainId, dex: Dex, tokenId: bigint): string => exitOrderKey(tokenId.toString(), chainId, dex)

/** read-v6's word on a network's automation (`chains[]` of the wallet's portfolio): the fields the setup refuses on. */
export type AutomationWord = Pick<ChainStatus, 'automationHalted' | 'operatorsAdmitted'>

/**
 * Whether read-v6 says the network's automation refuses a new position now: a halted registry (`automationHalted` true)
 * or no operator admitted (`operatorsAdmitted` 0), the setup's own two refusals, in its own words there
 * (../../automate/SetupFlow.tsx). Not reported (null), or no word at all, is no refusal, as the setup reads it.
 */
export const automationRefused = (status: AutomationWord | null | undefined): boolean =>
  status != null && (status.automationHalted === true || status.operatorsAdmitted === 0)

/**
 * Which automations the success offers on the network, exactly as they open there: the compounding pair (Auto-compound
 * and Domino-compound) when the vault's gate is open; Auto-exit when, besides, Auto-exit's own gate is open (it runs in a
 * vault: the position's page asks both, ../../automate/PositionAutomation.tsx); neither while read-v6 says the network
 * refuses a new automation (automationRefused), nor while a connected wallet's portfolio, which says it, is still read
 * (`word` 'pending'), so a choice is never drawn and then taken back. With no wallet, or a read that answered nothing, the
 * gates decide, as the setup does. Whether the range lets Auto-exit close it at all (a full range never ends) is
 * CreatedNext's own rule, as on Robinhood Chain. A choice not offered is not drawn: no notice, no disabled row.
 */
export function createdOffers({ vault, autoExit, word }: { vault: boolean; autoExit: boolean; word: { status: AutomationWord | null | undefined } | 'pending' }): { compound: boolean; exit: boolean } {
  const runs = vault && word !== 'pending' && !automationRefused(word.status)
  return { compound: runs, exit: runs && autoExit }
}
