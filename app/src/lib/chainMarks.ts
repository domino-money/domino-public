import type { CSSProperties } from 'react'
import { ELYSIUM_LIVE, ELYSIUM_MARK, ELYSIUM_V2_ID } from './elysiumIdentity'

/**
 * A network's mark served as a file, for the places that draw a network's mark beside its name (added 2026-11-06,
 * Elysium readiness): the token search's network tags and group headings, a network token page's tags, the Positions
 * collection's network, the Wallet card's network rows and Activity's network (each place that draws a network's mark; a
 * network pool page's chips, a network token page's pool rows and New position's pool rows' network chip are words only:
 * that chip takes the slot, but no rule draws a mark there; changed on purpose 2026-11-06, review UI-5). Robinhood Chain,
 * Base and Arbitrum One keep their marks as the stylesheets draw them (styles/v4-markets.css, styles/v4-positions.css:
 * one rule per chain id, with Robinhood Chain's or Base's mark as some places' default); a chain listed here is drawn
 * from its file instead, through `--dm-chain-mark` on the element, so a new network never shows another network's mark.
 *
 * Empty today: no chain the app serves is drawn from a file. Elysium's is lib/elysiumIdentity.ts ELYSIUM_MARK (the official
 * file the owner supplies, in public/chains), listed here by its chain id on the day it is one
 * (docs/ELYSIUM_DAY9.md; tests/v2/chain-identity.test.mjs fails until every V2 chain past the first three has its file).
 * Changed on purpose 2026-11-06 (the Elysium surface): its row, by its mainnet id (99901), is here exactly when the
 * build's switch says Elysium is live (lib/elysiumIdentity.ts ELYSIUM_LIVE), and such a build fails without the file
 * (scripts/elysium-switch.mjs). Today the table is empty, as before.
 *
 * Pure data and two functions; its one import is lib/elysiumIdentity.ts's literals (no import of their own), so every
 * chunk that draws a network may take it.
 */
const ELYSIUM_FILE: Record<number, string> = ELYSIUM_LIVE ? { [ELYSIUM_V2_ID]: ELYSIUM_MARK } : {}
export const CHAIN_MARK_FILES: Readonly<Record<number, string>> = Object.freeze({ ...ELYSIUM_FILE })

export type ChainMarkProps = { 'data-chain-mark'?: ''; style?: CSSProperties }
const NONE: ChainMarkProps = Object.freeze({})

/** What an element that draws `chainId`'s mark takes from a table of files: its file as `--dm-chain-mark`, or nothing. */
export function markPropsFrom(files: Readonly<Record<number, string>>, chainId: number | string | null | undefined): ChainMarkProps {
  const id = typeof chainId === 'string' && /^\d{1,12}$/.test(chainId) ? Number(chainId) : chainId
  const file = typeof id === 'number' && Object.hasOwn(files, id) ? files[id] : null
  return file && /^\/[a-z0-9/_-]+\.(?:svg|png|webp)$/.test(file) ? { 'data-chain-mark': '', style: { '--dm-chain-mark': `url("${file}")` } as CSSProperties } : NONE
}

/** What an element that draws a network's mark takes for `chainId`: nothing for a network without a file (today, all). */
export const chainMarkProps = (chainId: number | string | null | undefined): ChainMarkProps => markPropsFrom(CHAIN_MARK_FILES, chainId)
