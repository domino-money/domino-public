/*
 * Every link here goes somewhere this app has: a route or a section of the
 * landing page. Social, documentation, security and status links are added
 * only once the owner confirms their URLs; until then they are not shown at
 * all, rather than pointing nowhere. The legal documents are pending, so they
 * are named as text, not linked.
 */
import type { ReactNode } from 'react'

const COLUMNS = [
  {
    heading: 'Learn',
    links: [
      { label: 'How a position works', href: '#/#learn' },
      { label: 'Ranges explained', href: '#/#ranges' },
    ],
  },
  {
    heading: 'Product',
    links: [
      { label: 'Pools', href: '#/#pools' },
      { label: 'Positions', href: '#/app' },
    ],
  },
]

/** `appearance` is the appearance toggle: laid out in the footer's last row, in its flow, where it can never cover text. */
export function Footer({ appearance }: { appearance?: ReactNode }) {
  return (
    <footer className="mt-24 border-t">
      <div className="mx-auto max-w-[1220px] px-5 py-14">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(2,minmax(0,1fr))]">
          <div>
            <span className="font-display text-[22px]">
              domino<span style={{ color: 'var(--primary)' }}>.</span>
            </span>
            <p className="mt-3 max-w-[38ch] text-[13px] leading-relaxed text-fg-muted">
              Guided liquidity positions on Uniswap v4, built for Robinhood Chain. Your wallet stays
              the owner of everything it creates.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <nav key={col.heading} aria-label={col.heading}>
              <h4 className="text-[13px] font-medium">{col.heading}</h4>
              <ul className="mt-3 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href} className="text-[13px] text-fg-muted transition hover:text-fg">
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-fg-subtle">
            Invited read-only alpha. Figures come from live reads where enabled and show as unavailable otherwise.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <p className="text-[12px] text-fg-subtle">Terms of Service and Privacy Policy: pending</p>
            {appearance}
          </div>
        </div>
      </div>
    </footer>
  )
}
