import type { AutoExit } from 'api-contracts/read-v6/types'

/** An executed mandate alone does not prove that it withdrew value. Use the receipt's raw amounts. */
export function exitReceiptOutcome(item: AutoExit): { empty: boolean; title: string } {
  const withdrawn = item.withdrawn.some((amount) => BigInt(amount) > 0n)
  const moved = [
    ...item.delivered,
    ...item.deferred.map((part) => part.amount),
    ...item.reservesReturned.map((part) => part.amount),
    ...item.legs.flatMap((leg) => [leg.amountIn, leg.amountOut]),
    ...item.tariffs.flatMap((fee) => [fee.amount, fee.deferred]),
  ].some((amount) => BigInt(amount) > 0n)
  const empty = !withdrawn && !moved
  return {
    empty,
    title: empty ? `Auto-exit: nothing to withdraw from #${item.tokenId}`
      : withdrawn ? `Auto-exit: position #${item.tokenId} withdrawn`
        : `Auto-exit executed for position #${item.tokenId}`,
  }
}
