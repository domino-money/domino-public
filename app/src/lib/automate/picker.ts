import type { WalletPosition, WalletPositionsState, WalletToken } from '../walletPositions'
import { priceInverted } from '../read/orientation'
import { DYNAMIC_FEE_PIPS } from '../read/screens/fee'
import { NATIVE_CURRENCY } from '../read/screens/identity'

/**
 * The automation page's position picker, as data (2026-09-24, the owner's
 * simpler page): which of the wallet's positions can be chosen, which one a
 * `#/sequence/<mode>/<id>` link preselects, and what each option shows. No NFT
 * id is ever typed or searched: the list is the connected wallet's own open
 * positions (lib/walletPositions.ts), and a link only preselects an id that is
 * already in it. Pure and Node-safe: no DOM, no chain, no clock.
 */

/** What the picker has to show for the wallet's positions read. */
export type PickerList =
  | { kind: 'loading' }
  | { kind: 'failed' }
  /** Read, and nothing open to automate (or nothing read, as `idle` answers). */
  | { kind: 'empty' }
  | { kind: 'ready'; positions: readonly WalletPosition[] }

/**
 * Whether a position can be automated: open (a closed one has no liquidity to reinvest into), in a pool with no
 * hooks and a fixed fee (a sequence refuses any other, finance/sequence.ts root()). Positions' rows offer Automate
 * on the same test (2026-09-24, the three features joined up), so no row leads to a position the picker leaves out.
 */
export function automatable(position: Pick<WalletPosition, 'status' | 'tokenId' | 'hooks' | 'fee'>): boolean {
  return position.status === 'open' && /^[1-9]\d{0,77}$/.test(position.tokenId) && position.hooks.toLowerCase() === NATIVE_CURRENCY && position.fee !== DYNAMIC_FEE_PIPS
}

/** The positions that can be automated (automatable), in the read's order. */
export function pickerList(state: WalletPositionsState): PickerList {
  if (state.phase === 'loading') return { kind: 'loading' }
  if (state.phase === 'failed') return { kind: 'failed' }
  if (state.phase === 'idle') return { kind: 'empty' }
  const open = state.positions.filter(automatable)
  return open.length ? { kind: 'ready', positions: open } : { kind: 'empty' }
}

/** The id a link asked for, when it is one of the listed positions; otherwise nothing is chosen for the person. */
export function preselected(positions: readonly WalletPosition[], wanted: string | null): string | null {
  return wanted !== null && positions.some((position) => position.tokenId === wanted) ? wanted : null
}

/** A token as the picker names it: its symbol, or the short form of its address when the chain gave none. */
export function tokenName(token: WalletToken): string {
  const symbol = token.symbol?.trim()
  if (symbol) return symbol
  const address = token.address.toLowerCase()
  return /^0x[0-9a-f]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Token'
}

/** The LP fee tier in pips as a percentage: 3000 → 0.30%, 500 → 0.05%, 100 → 0.01%, 80000 → 8.00%. */
export function feeText(pips: number): string {
  if (!Number.isSafeInteger(pips) || pips < 0) return 'Fee'
  const whole = Math.floor(pips / 10_000)
  const fraction = String(pips % 10_000).padStart(4, '0')
  return `${whole}.${fraction.slice(0, 2)}${fraction.slice(2).replace(/0+$/, '')}%`
}

/**
 * The mini range bar: the range with half its width of room on each side, and where the pool's tick sits (0 to 1), when
 * it was read. Drawn the app's one way round (lib/read/orientation.ts, 2026-09-28): the left end is the lowest price of
 * the priced token, so for a pool read the other way round from its own order the price's dot is mirrored.
 */
export function rangeView(position: Pick<WalletPosition, 'tickLower' | 'tickUpper' | 'tick'> & { currencies?: WalletPosition['currencies'] }): { lower: number; upper: number; current: number | null; inRange: boolean | null } {
  const width = Math.max(1, position.tickUpper - position.tickLower)
  const min = position.tickLower - width / 2
  const span = width * 2
  const at = (tick: number) => Math.min(1, Math.max(0, (tick - min) / span))
  const tick = position.tick
  const inverted = position.currencies ? priceInverted(position.currencies[0].address, position.currencies[1].address) : false
  const current = tick === null ? null : at(tick)
  return {
    lower: at(position.tickLower),
    upper: at(position.tickUpper),
    current: current === null || !inverted ? current : 1 - current,
    inRange: tick === null ? null : tick >= position.tickLower && tick < position.tickUpper,
  }
}
