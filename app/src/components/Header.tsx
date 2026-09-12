import { useEffect, useState } from 'react'
import { Button, cx } from './ui'

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
  { label: 'Settings', href: '#/settings', route: '/settings' },
]

/** Whether the page is scrolled to its very top. */
function useAtTop() {
  const [atTop, setAtTop] = useState(true)
  useEffect(() => {
    const update = () => setAtTop(window.scrollY < 8)
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [])
  return atTop
}

export function Header({ route }: { route: string }) {
  // On the landing page the header starts clear, so the hero backdrop runs
  // behind it, and takes its own background once anything scrolls beneath.
  const clear = useAtTop() && route === '/'
  return (
    <header
      className={cx(
        'sticky top-0 z-30 transition-[background-color,backdrop-filter] duration-300',
        clear ? 'bg-transparent' : 'bg-[var(--bg)]/85 backdrop-blur-md',
      )}
    >
      <div className="mx-auto flex h-[var(--header-h)] max-w-[1220px] items-center justify-between px-5">
        <Wordmark />

        <nav className="hidden items-center gap-1 rounded-[var(--radius-pill)] border bg-surface-1 p-1 md:flex">
          {NAV.map((item) => {
            const active = item.route === route
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
          {/* As on the base: disabled on every route. Wallet sign-in is a separate, later change with its own acceptance. */}
          <Button variant="outline" disabled title="Wallet connection is not implemented yet" className="whitespace-nowrap">
            Connect wallet
          </Button>
        </div>
      </div>
    </header>
  )
}
