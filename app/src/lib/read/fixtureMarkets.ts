/**
 * Market rows from the package fixtures, for the fixture build and the read
 * lab. Every read goes through the real pipeline and the real runtime.
 */
import { READ_RUNTIME } from './contract'
import { FIXTURE_CATALOG } from './fixtureCatalog'
import { createFixtureSource } from './fixtureSource'
import { createReadMarketsProvider, type MarketsProvider } from './marketsProvider'
import { FIXTURE_POOL, MARKET_CASES, type MarketCase } from './scenarios'

export function fixtureMarketsFor(scenario: MarketCase): MarketsProvider {
  const source = createFixtureSource({ catalog: FIXTURE_CATALOG, validators: READ_RUNTIME, script: scenario.script, policy: scenario.policy })
  return createReadMarketsProvider({ source, poolIds: [FIXTURE_POOL], kind: 'fixture' })
}

export const fixtureMarkets = (id: string) => fixtureMarketsFor(MARKET_CASES.find((scenario) => scenario.id === id) ?? MARKET_CASES[0])
