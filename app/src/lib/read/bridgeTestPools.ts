/**
 * The pool the bridge-test build asks for: the read-v1 package's fixture
 * pool, which the local bridge stub in tests/read-bridge.browser.test.mjs
 * serves. Only the bridge-test branch of bridgeMarkets.ts refers to this
 * module. Deployable builds fold that branch away, so this id never reaches
 * dist, and their bundle check refuses a build in which it does.
 */
export const BRIDGE_TEST_POOLS: readonly string[] = ['0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941']
