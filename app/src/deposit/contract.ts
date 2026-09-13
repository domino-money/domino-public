/**
 * The one place the app imports the deposit-v1 runtime. Only the
 * consumer-test build reaches this module (through the lazy #/deposits fixture
 * lab); the default build never does.
 */
import * as runtime from 'api-contracts/deposit-v1/runtime.mjs'
import type { DepositContractVersion } from 'api-contracts/deposit-v1/types'
import type { DepositValidators } from './types'
import type { DepositContractPin } from './version'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// Fails typecheck as soon as the pinned version and the imported runtime disagree.
void (true satisfies Same<DepositContractVersion, DepositContractPin>)

export const DEPOSIT_RUNTIME: DepositValidators = runtime
