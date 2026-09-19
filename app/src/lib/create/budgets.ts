/**
 * What the connected wallet holds of a pool's two currencies, as the optional
 * budget fields onboarding-v1's position preview accepts.
 *
 * A Uniswap position is funded with both of a pool's currencies: the person
 * chooses one and an amount, and the service derives the other. Without a
 * budget for each, `previewChecks` cannot say whether the wallet covers the
 * maximum the mint may debit, and every `estimatedUnspentBudgetRaw` comes
 * back null. This module is what turns a read balance into that budget.
 *
 * No React and no reads: the caller passes the wallet snapshot it already
 * has. Nothing is guessed. A balance is used only when it was read at a block
 * and its display units convert back exactly, through the same
 * `validateBudget` the typed budget goes through — the round trip the "Use
 * max" button already relies on. A balance that is raw, zero, unreadable or
 * whose decimals were not read contributes no field at all, and a field that
 * is absent is exactly today's behaviour.
 */
import { identityKey, type Fact } from '../read/project'
import { NATIVE_CURRENCY } from '../read/screens/identity'
import type { PoolOption } from '../read/screens/poolsList'
import type { WalletSnapshot } from '../read/screens/walletSession'
import type { TokenDisplay } from '../read/types'
import { validateBudget } from './journey'

/** One pool currency's balance, in pool order. */
export interface CurrencyBalance {
  token: TokenDisplay
  /** The wallet page's row for this currency, its unavailable entry, or null when the page named neither. */
  fact: Fact | null
  /** The exact raw integer behind `fact`, when it converts back; null otherwise. */
  raw: string | null
}

/** The optional position-preview fields a pair of balances supports. Every one may be absent. */
export interface BudgetFields {
  budget0Raw?: string
  budget1Raw?: string
  nativeBalanceRaw?: string
}

/**
 * The exact raw integer a read balance stands for, or null.
 *
 * A read balance in display units is `formatUnits` text: the exact digits,
 * trailing fraction zeros dropped, thousands grouped with commas. Removing
 * the commas gives back the exact decimal, which `validateBudget` turns into
 * the same raw integer the chain returned. Anything else — raw units with
 * decimals unknown, an unreadable balance, digits the decimals cannot hold —
 * is not a budget. A zero balance is a real budget of zero: the service must
 * be told the wallet holds none, or it cannot report the shortfall.
 */
export function rawFromFact(fact: Fact | null, decimals: number | null): string | null {
  if (!fact || decimals === null) return null
  if (fact.state === 'zero') return '0'
  if (fact.state !== 'value') return null
  const check = validateBudget(fact.text.replace(/,/g, ''), decimals)
  return check.ok ? check.raw : null
}

/** The wallet page's balance for one currency: its row, else its unavailable entry, else nothing. */
function factFor(snapshot: WalletSnapshot, address: string): Fact | null {
  if (snapshot.failure) return null
  const wanted = identityKey(address)
  const view = snapshot.view
  const row = view.rows.find((item) => item.key.toLowerCase() === wanted || item.token.address === address)
  if (row) return row.amount
  return view.unavailable.find((item) => item.key.toLowerCase() === wanted)?.facts[0] ?? null
}

/**
 * Both of a pool's currencies, in pool order, as the wallet snapshot answered
 * for them. A snapshot that failed, or that never named a currency, gives that
 * currency a null fact rather than a zero.
 */
export function pairBalances(snapshot: WalletSnapshot, pool: PoolOption): readonly [CurrencyBalance, CurrencyBalance] {
  const of = (token: TokenDisplay): CurrencyBalance => {
    const fact = factFor(snapshot, token.address)
    return { token, fact, raw: rawFromFact(fact, token.decimals) }
  }
  return [of(pool.currencies[0]), of(pool.currencies[1])]
}

/**
 * The optional fields to add to a position-preview request for these
 * balances. A currency whose balance did not convert contributes nothing, so
 * the request stays exactly as it is today when nothing could be read.
 *
 * `nativeBalanceRaw` is the same figure as the native currency's budget when
 * the pool holds native ETH: the service uses it for the value the mint
 * settles in native units. No gas reserve is sent — that is a number the
 * person chooses, and Setup asks for it.
 */
export function budgetFields(balances: readonly [CurrencyBalance, CurrencyBalance]): BudgetFields {
  const fields: BudgetFields = {}
  if (balances[0].raw !== null) fields.budget0Raw = balances[0].raw
  if (balances[1].raw !== null) fields.budget1Raw = balances[1].raw
  const native = balances.find((balance) => balance.token.address === NATIVE_CURRENCY)
  if (native?.raw != null) fields.nativeBalanceRaw = native.raw
  return fields
}

/** The addresses to ask a wallet read for: the pool's two currencies, in pool order. */
export const pairTokens = (pool: PoolOption): string[] => pool.currencies.map((currency) => currency.address)
