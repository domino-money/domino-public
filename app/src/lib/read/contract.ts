/**
 * The one place the app imports the read-v1 runtime.
 *
 * Every other module in src/lib/read takes the validators as a parameter, so
 * the node tests can compile them and inject the very same runtime. Only
 * fixture and bridge builds import this module; the default build never does.
 */
import * as runtime from 'api-contracts/read-v1/runtime.mjs'
import type { ReadContractVersion } from 'api-contracts/read-v1/types'
import type { ReadContractPin } from './pin'
import type { ReadValidators } from './types'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// Fails typecheck as soon as the pinned version and the imported runtime disagree.
void (true satisfies Same<ReadContractVersion, ReadContractPin>)

export const READ_RUNTIME: ReadValidators = runtime
