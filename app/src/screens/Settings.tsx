import { useAppearance } from '../lib/appearance'
import { CAPABILITIES, ROADMAP, type Availability } from '../lib/capabilities'
import { Button, Card, Display, Eyebrow, Pill } from '../components/ui'

const LABEL: Record<Availability, { text: string; tone: 'in' | 'wait' | 'neutral' }> = {
  'not-in-alpha': { text: 'Not available in the alpha', tone: 'neutral' },
  planned: { text: 'Planned', tone: 'wait' },
  'not-connected': { text: 'Not connected', tone: 'neutral' },
}

export function Settings() {
  const { dark, setDark } = useAppearance()

  return (
    <main className="mx-auto max-w-[900px] px-5 py-10">
      <Display as="h1" className="text-[38px]">Settings</Display>
      <p className="mt-1 text-[13px] text-fg-muted">Appearance, and what this build can and cannot do.</p>

      <div className="mt-8 grid gap-5">
        <Card className="flex items-center justify-between gap-4 p-6">
          <div>
            <h2 className="text-[15px] font-medium">Appearance</h2>
            <p className="mt-0.5 text-[13px] text-fg-muted">Saved in this browser only.</p>
          </div>
          <Button variant="outline" onClick={() => setDark(!dark)}>{dark ? 'Switch to light' : 'Switch to dark'}</Button>
        </Card>

        <Card className="p-6">
          <Eyebrow>Capabilities</Eyebrow>
          <div className="mt-4 grid gap-0">
            {ROADMAP.map((row) => (
              <div key={row.name} className="flex items-start justify-between gap-4 border-b border-dashed py-3.5 last:border-b-0">
                <div>
                  <p className="text-[14px] font-medium">{row.name}</p>
                  <p className="mt-0.5 text-[12px] text-fg-muted">{row.note}</p>
                </div>
                <Pill tone={LABEL[row.status].tone}>{LABEL[row.status].text}</Pill>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-6">
          <Eyebrow>This build</Eyebrow>
          <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {(
              [
                ['Chain', `Robinhood Chain · ${CAPABILITIES.chainId}`],
                ['Live reads', 'Built in, switched on by the server'],
                ['Automated signing', CAPABILITIES.signingEnabled ? 'Enabled' : 'Not connected'],
                ['Wallet transactions', CAPABILITIES.walletTransactionsBuilt ? 'Built in; each step reviewed in wallet' : 'Off'],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 border-b border-dashed py-2">
                <dt className="text-[13px] text-fg-muted">{k}</dt>
                <dd className="tnum font-mono text-[13px]">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </main>
  )
}
