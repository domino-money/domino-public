import { Button, Pill, cx } from './ui'

function Wordmark() {
  return (
    <a href="#/" className="flex items-center gap-2.5">
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
        <rect x="1" y="1" width="24" height="24" rx="7" fill="var(--primary)" />
        <circle cx="13" cy="8" r="2.1" fill="var(--primary-fg)" />
        <rect x="6.5" y="12.4" width="13" height="1.3" rx="0.65" fill="var(--primary-fg)" />
        <circle cx="13" cy="18" r="2.1" fill="var(--primary-fg)" />
      </svg>
      <span className="font-display text-[24px] leading-none">
        domino<span style={{ color: 'var(--primary)' }}>.</span>
      </span>
    </a>
  )
}

const NAV = [
  { label: 'Overview', href: '#/', route: '/' },
  { label: 'Positions', href: '#/app', route: '/app' },
  { label: 'Activity', href: '#/app#activity', route: '' },
  { label: 'Settings', href: '#/settings', route: '/settings' },
]

export function Header({ route }: { route: string }) {
  return (
    <header className="sticky top-0 z-30 bg-[var(--bg)]/85 backdrop-blur-md">
      <div className="mx-auto flex h-[72px] max-w-[1220px] items-center justify-between px-5">
        <Wordmark />

        <nav className="hidden items-center gap-1 rounded-[var(--radius-pill)] border bg-surface-1 p-1 md:flex">
          {NAV.map((item) => {
            const active = item.route !== '' && item.route === route
            return (
              <a
                key={item.label}
                href={item.href}
                className={cx('rounded-[var(--radius-pill)] px-3.5 py-1.5 text-[13px] transition', active ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:text-fg')}
              >
                {item.label}
              </a>
            )
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2.5">
          <div className="hidden lg:block">
            <Pill tone="neutral">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--money-wait)' }} aria-hidden="true" />
              Practice mode
            </Pill>
          </div>
          {route === '/' ? (
            <Button onClick={() => (window.location.hash = '#/app')} className="whitespace-nowrap">
              Open workspace
            </Button>
          ) : (
            <Button variant="outline" disabled title="Wallet connection is not implemented yet" className="whitespace-nowrap">
              Connect wallet
            </Button>
          )}
        </div>
      </div>
    </header>
  )
}
