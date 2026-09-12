import { useState } from 'react'
import { MarketsTable } from '../components/MarketsTable'
import { Ticker } from '../components/Ticker'
import { BuildBanner } from '../components/read/BuildBanner'
import { FamilyCaseView } from '../components/read/FamilyPanels'
import { Display, Eyebrow } from '../components/ui'
import { READ_RUNTIME } from '../lib/read/contract'
import { FIXTURE_CATALOG } from '../lib/read/fixtureCatalog'
import { fixtureMarketsFor } from '../lib/read/fixtureMarkets'
import { createFixtureSource } from '../lib/read/fixtureSource'
import { PRODUCER_PIN } from '../lib/read/pin'
import { MARKET_CASES, familyCases, type FamilyCase, type MarketCase } from '../lib/read/scenarios'
import { MarketsContext } from '../lib/read/useMarkets'

/**
 * Every fixture case on one page, each with its own source, rendered by the
 * app's real components: the Selected pools table and the ticker for market rows,
 * the family panels for everything else. Nothing here is a mock of a
 * component; only the reads are scripted.
 */
const FAMILY = familyCases(FIXTURE_CATALOG)
const ROUTES = [...new Set(FAMILY.map((c) => c.route))]

function MarketCaseView({ scenario }: { scenario: MarketCase }) {
  const [provider] = useState(() => fixtureMarketsFor(scenario))
  return (
    <section data-case={`market-${scenario.id}`} className="rounded-[20px] border border-dashed p-4">
      <Eyebrow>market · {scenario.id}</Eyebrow>
      <h3 className="mb-3 mt-1 text-[15px] font-medium">{scenario.title}</h3>
      <MarketsContext.Provider value={provider}>
        <Ticker />
        <div className="mt-4">
          <MarketsTable />
        </div>
      </MarketsContext.Provider>
    </section>
  )
}

function FamilyCaseSection({ scenario }: { scenario: FamilyCase }) {
  const [source] = useState(() => createFixtureSource({ catalog: FIXTURE_CATALOG, validators: READ_RUNTIME, script: scenario.script }))
  return (
    <section data-case={`family-${scenario.id}`}>
      <h4 className="mb-1.5 font-mono text-[12px] text-fg-muted">{scenario.id}</h4>
      <FamilyCaseView source={source} route={scenario.route} request={scenario.request} pager={scenario.pager} />
    </section>
  )
}

export function ReadLab() {
  const pin = PRODUCER_PIN.packages['read-v1']
  return (
    <>
      <BuildBanner mode="fixture" />
      <main className="mx-auto max-w-[1220px] px-5 py-10">
        <Display as="h1" className="text-[38px]">
          Read lab
        </Display>
        <p className="mt-2 max-w-[70ch] text-[14px] text-fg-muted">
          Every read-v1 {pin.version} fixture case, read through the real pipeline and rendered by the app’s own components. Producer {PRODUCER_PIN.producerCommit.slice(0, 7)},
          manifest {pin.manifestSha256.slice(0, 12)}.
        </p>

        <Display className="mt-10 text-[28px]">Selected pools and ticker</Display>
        <div className="mt-4 grid gap-6">
          {MARKET_CASES.map((scenario) => (
            <MarketCaseView key={scenario.id} scenario={scenario} />
          ))}
        </div>

        {ROUTES.map((route) => (
          <section key={route} className="mt-12" aria-labelledby={`route-${route}`}>
            <Display id={`route-${route}`} className="text-[28px]">
              {route}
            </Display>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {FAMILY.filter((c) => c.route === route).map((scenario) => (
                <FamilyCaseSection key={scenario.id} scenario={scenario} />
              ))}
            </div>
          </section>
        ))}
      </main>
    </>
  )
}
