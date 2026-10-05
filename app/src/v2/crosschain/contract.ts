/**
 * The one place the app will import the crosschain-v1 runtime (deposit/contract.ts's pattern). NOTHING IMPORTS THIS
 * MODULE in this phase: the pure modules take the runtime injected, the node tests import
 * api-contracts/crosschain-v1/runtime.mjs themselves, and no route or deployable build reaches S2 yet. PHASE B's
 * screen imports it lazily, behind its flag, next to the http transport.
 */
import * as runtime from 'api-contracts/crosschain-v1/runtime.mjs'
import type { CrosschainValidators } from './types'

export const CROSSCHAIN_RUNTIME: CrosschainValidators = runtime
