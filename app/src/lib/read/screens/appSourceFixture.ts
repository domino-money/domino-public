/**
 * The fixture build's one read source for the whole app: package fixtures
 * through the real pipeline, behind slice A's scheduler, with a request log a
 * browser test can inspect. Only the fixture build loads this module; its log
 * global never exists in the default or bridge-test build.
 */
import { READ_RUNTIME } from '../contract'
import { FIXTURE_CATALOG } from '../fixtureCatalog'
import { createFixtureSource } from '../fixtureSource'
import { createScheduledSource } from '../scheduler'
import type { ReadSource } from '../types'
import { APP_SCRIPT } from './appScript'
import { withDelays } from './delayedSource'

/** Shorter than the bridge's 1.1 s so the fixture pages load quickly, but still one read at a time. */
export const FIXTURE_SPACING_MS = 150

export function createAppFixtureSource(): ReadSource {
  const logged = withDelays(createFixtureSource({ catalog: FIXTURE_CATALOG, validators: READ_RUNTIME, script: APP_SCRIPT }), () => undefined)
  ;(globalThis as { __DOMINO_FIXTURE_READS__?: unknown }).__DOMINO_FIXTURE_READS__ = logged.log
  return createScheduledSource(logged, { minIntervalMs: FIXTURE_SPACING_MS })
}
