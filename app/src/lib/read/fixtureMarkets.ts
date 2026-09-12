/**
 * Market rows from the package fixtures, for the fixture build and the read
 * lab. Every read goes through the real pipeline and the real runtime, and
 * the rows say they are fixtures.
 */
import { READ_RUNTIME } from './contract'
import { FIXTURE_CATALOG } from './fixtureCatalog'
import { createFixtureSource } from './fixtureSource'
import { createReadMarketsProvider, type MarketsProvider } from './marketsProvider'
import { PRODUCER_PIN } from './pin'
import { FIXTURE_POOL, MARKET_CASES, type MarketCase } from './scenarios'

const NOTICE = `Contract fixtures from read-v1 ${PRODUCER_PIN.packages['read-v1'].version}, served through the real read pipeline. Not observations.`

export function fixtureMarketsFor(scenario: MarketCase): MarketsProvider {
  const source = createFixtureSource({ catalog: FIXTURE_CATALOG, validators: READ_RUNTIME, script: scenario.script, policy: scenario.policy })
  return createReadMarketsProvider({ source, poolIds: scenario.poolIds ?? [FIXTURE_POOL], kind: 'fixture', notice: NOTICE })
}

export const fixtureMarkets = (id: string) => fixtureMarketsFor(MARKET_CASES.find((scenario) => scenario.id === id) ?? MARKET_CASES[0])
