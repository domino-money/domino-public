import type { GasBudget, WalletRpc } from './setup'

/**
 * A network budget for the wallet steps, from the network's own price now:
 * what the guided deposit fills in so nobody types wei. Twice the current gas
 * price as the ceiling, no priority fee, and enough gas units for a mint; each prepared step still estimates its own gas, keeps
 * to a fifth above that, and shows the resulting maximum cost before the
 * wallet opens (finance/setup.ts prepare). The wallet may lower any of it.
 *
 * Reads only. Nothing here sends anything.
 */

/** Below this the ceiling is not a price a block takes. */
const FLOOR_FEE_PER_GAS = 10_000_000n
/** Gas units the widest step (a mint) stays under; the estimate decides what is offered. */
const MAX_GAS = 8_000_000n

const wei = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('invalid_wallet_quantity')
  return BigInt(value)
}

export async function suggestGasBudget(wallet: WalletRpc): Promise<GasBudget> {
  const price = wei(await wallet.request('eth_gasPrice', []))
  const maxFeePerGas = price * 2n > FLOOR_FEE_PER_GAS ? price * 2n : FLOOR_FEE_PER_GAS
  // Robinhood Chain sequences by arrival, so no priority fee is offered; the wallet may set one under the ceiling.
  return { maxGas: MAX_GAS, maxFeePerGas, maxPriorityFeePerGas: 0n, reserveWei: 0n }
}
