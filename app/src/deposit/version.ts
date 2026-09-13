import { PRODUCER_PIN } from '../lib/read/pin'

/** The deposit-v1 version this build is pinned to, from the one pin table. */
export type DepositContractPin = (typeof PRODUCER_PIN)['packages']['deposit-v1']['version']

/**
 * The only value accepted in `X-Domino-Deposit-Contract`, and the value sent.
 * Exact: a prerelease never satisfies a range, so rc.2, rc.3 and a later rc.5
 * are all refused until the pin moves.
 */
export const DEPOSIT_CONTRACT: DepositContractPin = PRODUCER_PIN.packages['deposit-v1'].version
