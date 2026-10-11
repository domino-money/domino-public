/**
 * The one place the app imports the position-plan-v1 runtime (spec F7 rev2 §2.4), as src/v2/crosschain/contract.ts and
 * src/v2ui/read6.ts do for theirs. Only src/v2ui reaches this module (the S1 screens' source); the pure modules take
 * the runtime handed in, and the node tests load api-contracts/position-plan-v1/runtime.mjs themselves.
 */
import { CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError } from 'api-contracts/position-plan-v1/runtime.mjs'
import type { S1PlanValidators } from './types'

// Pass only the validation interface: a namespace object also retains the package's public encoding/test helpers.
export const POSITION_PLAN_RUNTIME: S1PlanValidators = Object.freeze({ CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError })
