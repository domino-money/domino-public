/**
 * The session-v1 runtime validators, imported in place from the producer's
 * package through the `api-contracts` alias. This is the only value import of the
 * package in the app; api.ts receives the runtime as a parameter so node tests
 * can drive it with the same validators.
 */
import * as runtime from 'api-contracts/session-v1/runtime.mjs'
import type { SessionRuntime } from './api'

export const sessionRuntime: SessionRuntime = runtime
