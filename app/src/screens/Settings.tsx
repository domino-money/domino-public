import type { CSSProperties } from 'react'
import { useAppearance } from '../lib/appearance'
import { CAPABILITIES, ROADMAP } from '../lib/capabilities'
import { REQUEST_READ_CONTRACT } from '../lib/read/pin'
import { Button, PageHeader, PageShell, Stat } from '../components/ui'
import { RoadmapPill } from './Automate'

const rise = (step: number) => ({ '--delay': `${step * 60}ms` }) as CSSProperties

/** Appearance, and a plain account of what this build can and cannot do. Nothing here is a switch for a capability: those are the server's. */
export function Settings() {
  const { dark, setDark } = useAppearance()

  return (
    <PageShell width="narrow">
      <PageHeader className="animate-rise" title="Settings" description="Appearance, and what this app can and cannot do." />

      <div className="dm-acct-settings">
        <section className="dm-card dm-acct-set-appearance animate-rise" style={rise(1)} aria-labelledby="settings-appearance">
          <div className="min-w-0">
            <h2 id="settings-appearance" className="dm-acct-set-title">
              Appearance
            </h2>
            <p className="dm-acct-set-note">Saved in this browser only.</p>
          </div>
          {/* Its own words, never "appearance": the footer's toggle is the one button named "Switch to … appearance". */}
          <Button variant="outline" onClick={() => setDark(!dark)}>
            {dark ? 'Switch to light' : 'Switch to dark'}
          </Button>
        </section>

        <section className="dm-card dm-acct-set-card animate-rise" style={rise(2)} aria-labelledby="settings-build">
          <h2 id="settings-build" className="dm-acct-set-title">
            This build
          </h2>
          <dl className="dm-acct-build">
            <Stat label="Chain">Robinhood</Stat>
            <Stat label="Chain id">{CAPABILITIES.chainId}</Stat>
            <Stat label="Read contract">
              <span className="dm-acct-mono">{REQUEST_READ_CONTRACT}</span>
            </Stat>
            <Stat label="Automated signing">{CAPABILITIES.signingEnabled ? 'Enabled' : 'Not connected'}</Stat>
            <Stat label="Wallet transactions">
              {__DOMINO_WALLET_SESSION__ && CAPABILITIES.walletTransactionsBuilt ? 'Built in; each step reviewed in wallet' : 'Off'}
            </Stat>
          </dl>
          <p className="dm-acct-set-foot">
            Live reads are built in and switched on by the read service, never here. Nothing in this build signs a transaction, grants a spending permission or
            moves funds; a wallet connection only proves an address.
          </p>
        </section>

        <section className="dm-card dm-acct-caps animate-rise" style={rise(3)} aria-labelledby="settings-capabilities">
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
