/*
 * Every link here goes somewhere this app has: a route or a section of the
 * landing page. Social, documentation, security and status links are added
 * only once the owner confirms their URLs; until then they are not shown at
 * all, rather than pointing nowhere. The legal documents are pending, so they
 * are named as text, not linked.
 */
import type { ReactNode } from 'react'
import { BrandMark } from './BrandMark'
import { CAPABILITIES } from '../lib/capabilities'
import { automateHref, marketsHref, newPositionHref, positionsHref, settingsHref } from './explore/routes'

const COLUMNS: ReadonlyArray<{ heading: string; links: ReadonlyArray<{ label: string; href: string }> }> = [
  {
    heading: 'Product',
    links: [
      { label: 'Markets', href: marketsHref() },
      { label: 'Positions', href: positionsHref },
      { label: 'Automate', href: automateHref },
      { label: 'New position', href: newPositionHref() },
      { label: 'Settings', href: settingsHref },
    ],
  },
  {
    heading: 'Guides',
    links: [
      { label: 'How it works', href: '#/#learn' },
      { label: 'Ranges explained', href: '#/#ranges' },
      { label: 'What Domino does not do', href: '#/#limits' },
    ],
  },
]

/**
 * The page's only `<footer>`. `motion` (Pause motion / Resume motion) and
 * `appearance` (the appearance toggle) come from App and sit together in the
 * last row, in the footer's own flow, where they can never cover text.
 */
export function Footer({ appearance, motion }: { appearance?: ReactNode; motion?: ReactNode }) {
  return (
    <footer className="dm-footer">
      <div className="dm-footer-inner">
        <div className="dm-footer-body">
          <div className="dm-footer-grid">
            {/* Not a link: only the header's wordmark points at Home. */}
            <div className="dm-footer-brand">
              <span className="inline-flex items-center gap-2 text-fg">
                <BrandMark width={18} height={31} />
                <span className="dm-display text-[26px] leading-[26px] md:text-[30px] md:leading-[30px]">
                  domino<span className="text-primary">.</span>
                </span>
              </span>
              <p className="mt-4 max-w-[42ch] text-body text-fg-muted">
                Domino opens Uniswap positions on Robinhood Chain and puts their earned fees to work, only within limits your wallet signs.
              </p>
            </div>

            {COLUMNS.map((column) => (
              <nav key={column.heading} aria-label={column.heading}>
                <h2 className="dm-footer-heading">{column.heading}</h2>
                <ul className="dm-footer-links">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a href={link.href} className="dm-footer-link">
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}

            <div className="dm-footer-network">
              <h2 className="dm-footer-heading">Network</h2>
              <div className="mt-4 grid gap-3">
                <p className="dm-footer-note">Robinhood Chain</p>
                <p className="dm-footer-note tnum">Chain ID {CAPABILITIES.chainId}</p>
              </div>
            </div>
          </div>

          <div className="dm-footer-bottom">
            <p className="dm-footer-note">Terms of Service and Privacy Policy: pending</p>
            <div className="dm-footer-controls">
              {motion}
              {appearance}
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
