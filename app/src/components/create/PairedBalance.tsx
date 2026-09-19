import { CREATE } from '../../lib/create/copy'
import { otherCurrency } from '../../lib/create/journey'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { SymbolText } from '../read/screens/SymbolText'
import type { PairBalancesState } from './usePairBalances'

/**
 * What the connected wallet holds of the pool's *other* token, under the
 * budget on the amount step.
 *
 * A position holds both of a pool's tokens. The budget above is in the token
 * the person chose; the service derives the other from the range and the
 * price, and it is usually that second balance that decides whether the
 * deposit can go through at all. Until this line existed the second token was
 * never named before Review, which read as a one-sided deposit.
 *
 * Nothing here computes a split: the amounts are the position preview's, in
 * Review. This is only the balance, read at a block through the shared read
 * source, and it says plainly when it could not be read. Nothing signs,
 * approves or moves anything.
 */
export function PairedBalance({ pair, pool, token }: { pair: PairBalancesState; pool: PoolOption; token: TokenCandidate }) {
  const other = otherCurrency(pool, token.key)
  if (!other) return null
  const index = pool.currencies[0].address === other.address ? 0 : 1
  const balance = pair.balances?.[index] ?? null
  const fact = balance?.fact ?? null

  const line = (state: string, children: React.ReactNode, role?: 'status') => (
    <div className="dm-flow-balance" data-paired-balance={state} data-paired-token={other.address}>
      <p className="dm-flow-balance-line" role={role} title={CREATE.amount.balanceNote}>
        <span className="text-fg-subtle">{CREATE.amount.pairLabel}</span>{' '}
        <span className="text-fg-muted">
          <SymbolText token={other} />
        </span>{' '}
        {children}
      </p>
    </div>
  )

  if (pair.status === 'disconnected') return line('disconnected', <span className="text-fg-subtle">{CREATE.amount.pairConnect}</span>)
  if (pair.status !== 'ready' || !fact) return line('loading', <span className="text-fg-subtle">{CREATE.amount.pairReading}</span>, 'status')
  if (fact.state !== 'value' && fact.state !== 'zero') return line('unreadable', <span className="text-fg-subtle">{CREATE.amount.pairNone}</span>)
  return line(
    fact.state,
    <>
      <span className="text-fg-subtle">{CREATE.amount.pairBalanceAt(null)}</span> <bdi className="tnum text-fg">{fact.text}</bdi>
    </>,
  )
}
