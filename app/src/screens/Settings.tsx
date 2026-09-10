import { useLocalWorkspace } from 'core/local-workspace'
import { CAPABILITIES, ROADMAP, type Availability } from '../lib/capabilities'
import { Button, Card, Display, Eyebrow, Pill } from '../components/ui'

const LABEL: Record<Availability, { text: string; tone: 'in' | 'wait' | 'neutral' }> = {
  practice: { text: 'Practice available', tone: 'in' },
  planned: { text: 'Planned', tone: 'wait' },
  'not-connected': { text: 'Not connected', tone: 'neutral' },
}

export function Settings() {
  const { dark, setDark, book } = useLocalWorkspace()

  return (
    <main className="mx-auto max-w-[900px] px-5 py-10">
      <Display as="h1" className="text-[38px]">Settings</Display>
      <p className="mt-1 text-[13px] text-fg-muted">Appearance, what this build can do, and where your practice data lives.</p>

      <div className="mt-8 grid gap-5">
        <Card className="flex items-center justify-between gap-4 p-6">
          <div>
            <h2 className="text-[15px] font-medium">Appearance</h2>
            <p className="mt-0.5 text-[13px] text-fg-muted">Shared with the workbench through the same saved preference.</p>
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
                ['Mode', CAPABILITIES.mode],
                ['Chain', `Robinhood Chain · ${CAPABILITIES.chainId}`],
                ['Reinvestment policy', `Version ${CAPABILITIES.simulation.reinvestmentPolicyVersion}`],
                ['Gas buffer in the cost check', `${CAPABILITIES.simulation.gasBufferBps / 100}%`],
                ['Fixed idle reserve', `${CAPABILITIES.simulation.fixedReserveBps}%`],
                ['Signing', CAPABILITIES.signingEnabled ? 'Enabled' : 'Off'],
                ['Live chain data', CAPABILITIES.liveDataEnabled ? 'Enabled' : 'Off'],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 border-b border-dashed py-2">
                <dt className="text-[13px] text-fg-muted">{k}</dt>
                <dd className="tnum font-mono text-[13px]">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="p-6">
          <Eyebrow>Practice data</Eyebrow>
          <p className="mt-3 text-[13px] leading-relaxed text-fg-muted">
            {book.positions.length} practice position{book.positions.length === 1 ? '' : 's'} and {book.events.length} event{book.events.length === 1 ? '' : 's'} are stored in this browser only. Nothing is sent anywhere, and there is no wallet, chain read or transaction behind any of it.
          </p>
        </Card>
      </div>
    </main>
  )
}
