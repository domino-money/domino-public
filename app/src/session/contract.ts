/**
 * The session-v1 runtime validators, imported in place from the producer's
 * package through the `api-contracts` alias. This is the only value import of the
 * package in the app; api.ts receives the runtime as a parameter so node tests
 * can drive it with the same validators.
 */
import { CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError } from 'api-contracts/session-v1/runtime.mjs'
import type { SessionRuntime } from './api'

// The cookie-envelope validator belongs to the server, not the browser client.
export const sessionRuntime: SessionRuntime = { CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError }
