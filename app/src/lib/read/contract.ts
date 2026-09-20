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
import { READ_V2_PIN, READ_V3_PIN } from './pin'
import type { ReadV2ContractVersion } from 'api-contracts/read-v2/types'
import type { ReadV3ContractVersion } from 'api-contracts/read-v3/types'
import type { ReadValidators } from './types'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// Fails typecheck as soon as the pinned version and the imported runtime disagree.
void (true satisfies Same<ReadContractVersion, ReadContractPin>)
void (true satisfies Same<ReadV2ContractVersion, typeof READ_V2_PIN.version>)
void (true satisfies Same<ReadV3ContractVersion, typeof READ_V3_PIN.version>)

// Each namespace rejects routes outside its own closed contract. The common
// source interface also names V3; its dispatcher chooses the matching runtime.
export const READ_RUNTIME = runtime as unknown as ReadValidators
