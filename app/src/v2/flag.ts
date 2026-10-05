/**
 * Whether this build carries Domino V2 (spec F7 §1.1: V2 enters as new flows, switched on per service and per chain only
 * with that chain's pinned manifest and the backend's capability).
 *
 * `__DOMINO_V2__` is a Vite define written from the build mode's row (vite.config.ts MODES `v2`). Changed on purpose
 * 2026-10-04 (the owner: the site runs on Domino V2): true in production and development, the two deployable modes, as
 * in v2-test, preview-v2 and the test builds that compile V2 in; false in the test builds without V2. A deployable
 * build carries V2's pinned production manifests only, never its fixture sets (`__DOMINO_V2_FIXTURE_SETS__` below).
 * Declared here, module-scoped, as finance/pin.ts declares its own flag, so a compile outside Vite (.test-build) answers
 * "off" unless a test says otherwise (globalThis.__DOMINO_V2__ before a fresh module load).
 *
 * Screens open V2 with the bare define (`__DOMINO_V2__ ? lazy(...) : null`) so a build without it emits none of V2's
 * code; modules the node tests compile read V2_ON.
 */
declare const __DOMINO_V2__: boolean | undefined
export const V2_ON: boolean = typeof __DOMINO_V2__ === 'boolean' && __DOMINO_V2__

/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): whether this build takes V2's
 * FIXTURE contract sets (src/v2/manifestFixtures.ts) at all: the builds that carry V2 and are not deployable
 * (vite.config.ts, the `__DOMINO_V2_FIXTURE_SETS__` define), preview-v2 included, where the gate's `preview` mode
 * (./gate.ts) runs an option up to its review on them.
 *
 * Where it is true, the money clients do not refuse a fixture set the way a deployable build does, even where
 * `__DOMINO_DEPLOYABLE__` is true (preview-v2 is the real site for V1): src/finance/v2/liveLock.ts refuses every send,
 * signature, batch offer and approval with one instead, outside the test builds. False in production and development
 * and in every build without V2; a compile outside Vite (.test-build) sees no define and answers false, as before.
 */
declare const __DOMINO_V2_FIXTURE_SETS__: boolean | undefined
export const V2_FIXTURE_SETS_TAKEN: boolean = typeof __DOMINO_V2_FIXTURE_SETS__ === 'boolean' && __DOMINO_V2_FIXTURE_SETS__
