import type { CSSProperties } from 'react'
import { CAPABILITIES, ROADMAP } from '../lib/capabilities'
import { REQUEST_READ_CONTRACT } from '../lib/read/pin'
import { PageHeader, PageShell, Stat } from '../components/ui'
import { RoadmapPill } from './Automate'

const rise = (step: number) => ({ '--delay': `${step * 40}ms` }) as CSSProperties

/**
 * A plain account of what this build can and cannot do. Nothing here is a switch for a capability: those are the
 * server's. The site has one look, the dark one, so there is nothing to choose here (owner, 2026-09-26: dark only).
 */
export function Settings() {
  return (
    <PageShell width="narrow">
      <PageHeader className="animate-rise" title="Settings" description="What this app can and cannot do." />

      <div className="dm-acct-settings">
        {/* The read contract version is for support and diagnostics, never shown as text. */}
        <section className="dm-card dm-acct-set-card animate-rise" style={rise(1)} aria-labelledby="settings-build" data-read-contract={REQUEST_READ_CONTRACT}>
          <h2 id="settings-build" className="dm-acct-set-title">
            This build
          </h2>
          <dl className="dm-acct-build">
            <Stat label="Chain">Robinhood</Stat>
            <Stat label="Chain id">{CAPABILITIES.chainId}</Stat>
            <Stat label="Automated signing">External; checked per sequence</Stat>
            <Stat label="Wallet transactions">
              {__DOMINO_WALLET_SESSION__ && CAPABILITIES.walletTransactionsBuilt ? 'Built in; each step reviewed in wallet' : 'Off'}
            </Stat>
          </dl>
        </section>

        <section className="dm-card dm-acct-caps animate-rise" style={rise(2)} aria-labelledby="settings-capabilities">
          <h2 id="settings-capabilities" className="dm-acct-set-title dm-acct-caps-title">
            Capabilities
          </h2>
          <div className="dm-rows">
            {ROADMAP.map((row) => (
              <div key={row.name} className="dm-acct-cap">
                <div className="min-w-0">
                  <p className="dm-acct-cap-name">{row.name}</p>
                  <p className="dm-acct-cap-note">{row.note}</p>
                </div>
                <RoadmapPill name={row.name} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </PageShell>
  )
}
