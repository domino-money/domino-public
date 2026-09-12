/**
 * Claims about the read screens' types that `npm run typecheck` proves.
 * Nothing imports this module; it only has to compile, and each
 * `@ts-expect-error` has to find the error it expects.
 */
import type { ChainPositionsSection } from '../../../components/read/screens/ChainPositionsSection'
import type { OpaqueCursor } from '../types'
import type { AddressKey, PoolIdKey } from './identity'
import type { ChainPositionCard } from './positions'

export function aStringIsNotAnAddressKey(value: string): AddressKey {
  // @ts-expect-error a plain string is not an address key: only identity.ts mints one
  return value
}

export function aStringIsNotAPoolId(value: string): PoolIdKey {
  // @ts-expect-error a plain string is not a pool id key
  return value
}

export function aStringIsNotACursor(value: string): OpaqueCursor {
  // @ts-expect-error a continuation handle only comes from a validated page, inside a pager
  return value
}

type UsdKeys<T> = Extract<keyof T, `${string}Usd` | `${string}usd`>
/** A chain card has no USD field at all: its valuation is only ever "unavailable". */
export const cardsCarryNoUsdField: [UsdKeys<Extract<ChainPositionCard, { kind: 'live' }>>] extends [never] ? true : false = true

/** The Dashboard slot takes no props, so no chain data can flow out of it into the rest of the app. */
export const positionsSlotTakesNoProps: Parameters<typeof ChainPositionsSection> extends [] ? true : false = true
