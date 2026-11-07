/**
 * Elysium's day-9 files, as the build hands them in (added 2026-11-07, Elysium as a fourth V2 chain, switched on by
 * itself): rugged97's enabled profile of chain 99901 and its deployment record, with the pin we wrote for it.
 *
 * Why not imported like the other three chains' (./chains.ts, ./manifest.ts): those files do not exist until rugged97's
 * day-9 pull request, and an import of a missing file breaks every build. So scripts/elysium-switch.mjs reads them by
 * directory and, only where every day-9 piece is there (Elysium is live: lib/elysiumIdentity.ts ELYSIUM_LIVE), vite.config.ts
 * writes their texts into the build as string literals (`__DOMINO_ELYSIUM_PROFILE__`, `__DOMINO_ELYSIUM_DEPLOYMENT__`) and
 * the record's pin as an object (`__DOMINO_ELYSIUM_DEPLOYMENT_PIN__`). Each is parsed once, here. A build where Elysium
 * is off writes `null` for all three, and carries nothing of them; a compile outside Vite (.test-build) sees no define
 * and answers null, unless a test sets them on globalThis before a fresh module load (tests/v2/elysium-chain.test.mjs).
 *
 * The record a live build carries is the file the pin names, byte for byte (the switch hashed it against the pin, which
 * a person wrote: never a hash computed and trusted by the build), and ./manifest.ts still parses it under the production
 * admission, as it does the other three. A forced test build carries the fixture profile and no record: its contracts
 * are the fork-rehearsal fixture of ./manifestFixtures.ts, under the test admission.
 *
 * Literals, the build's defines and Elysium's switch only: no viem, no wallet.
 */
import { ELYSIUM_LIVE } from '../lib/elysiumIdentity'
import type { ManifestPin } from './manifest'

declare const __DOMINO_ELYSIUM_PROFILE__: string | null | undefined
declare const __DOMINO_ELYSIUM_DEPLOYMENT__: string | null | undefined
declare const __DOMINO_ELYSIUM_DEPLOYMENT_PIN__: ManifestPin | null | undefined

/** Elysium's enabled profile (api-contracts/v2/chains, rugged97's elysium-99901.json), parsed; null while Elysium is off. */
export const ELYSIUM_PROFILE: unknown = ELYSIUM_LIVE && typeof __DOMINO_ELYSIUM_PROFILE__ === 'string' ? JSON.parse(__DOMINO_ELYSIUM_PROFILE__) : null

/**
 * Elysium's pinned deployment record (docs/deployments/v2-<slug>-99901-<date>/deployment.json), parsed, and its pin; both
 * null while Elysium is off, and in a forced test build. Never one without the other.
 */
const PIN: ManifestPin | null = ELYSIUM_LIVE && typeof __DOMINO_ELYSIUM_DEPLOYMENT_PIN__ === 'object' ? __DOMINO_ELYSIUM_DEPLOYMENT_PIN__ : null
const RECORD: unknown = PIN !== null && typeof __DOMINO_ELYSIUM_DEPLOYMENT__ === 'string' ? JSON.parse(__DOMINO_ELYSIUM_DEPLOYMENT__) : null
export const ELYSIUM_DEPLOYMENT: unknown = RECORD
export const ELYSIUM_DEPLOYMENT_PIN: ManifestPin | null = RECORD === null || PIN === null ? null : Object.freeze({ path: PIN.path, sha256: PIN.sha256 })
