/*
 * Every link here goes somewhere this app has: a route or a section of the
 * landing page. The docs are one of those routes (`#/docs`), written and
 * served by this app. Social, external documentation, security and status
 * links are added only once the owner confirms their URLs; until then they are
 * not shown at all, rather than pointing nowhere. The same holds for the Terms
 * of Service and the Privacy Policy: the footer neither links nor names them
 * until the documents exist.
 *
 * 2026-09-26: the owner confirmed Domino's X account, https://x.com/dominomoney,
 * so it is the one link that leaves the app. It opens in a new tab with no
 * opener and no referrer, and nothing is ever fetched from it.
 */
import type { ReactNode } from 'react'
import { CAPABILITIES } from '../lib/capabilities'
import { automateHref, docsHref, marketsHref, newPositionHref, positionsHref, settingsHref } from './explore/routes'

/** Domino's X account, confirmed by the owner on 2026-09-26. */
export const X_PROFILE = 'https://x.com/dominomoney'

/** The X mark (Simple Icons, CC0), drawn in the link's own colour. */
function XMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" className="dm-footer-social-mark">
      <path fill="currentColor" d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  )
}

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
      { label: 'Docs', href: docsHref() },
      { label: 'How it works', href: '#/#learn' },
      { label: 'Ranges explained', href: '#/#ranges' },
      { label: 'What Domino does not do', href: '#/#limits' },
    ],
  },
]

/**
 * The page's only `<footer>`. `motion` (Pause motion / Resume motion) comes
 * from App and sits in the last row, in the footer's own flow, where it can
 * never cover text. The site has one look, the dark one (owner, 2026-09-26:
 * dark only), so there is no control for it.
 */
export function Footer({ motion }: { motion?: ReactNode }) {
  return (
    <footer className="dm-footer">
      <div className="dm-footer-inner">
        <div className="dm-footer-body">
          <div className="dm-footer-grid">
            {/* Not a link: only the header's wordmark points at Home. */}
            <div className="dm-footer-brand">
              <span className="inline-flex items-center gap-2 text-fg">
                <span className="dm-display text-[26px] leading-[26px] md:text-[30px] md:leading-[30px]">
                  domino<span className="text-primary">.</span>
                </span>
              </span>
              <p className="mt-4 max-w-[42ch] text-body text-fg-muted">
                Domino opens Uniswap positions on Robinhood Chain and puts their earned fees to work, only within limits your wallet signs.
              </p>
              <a href={X_PROFILE} target="_blank" rel="noopener noreferrer" className="dm-footer-social" aria-label="Domino on X (opens in a new tab)">
                <XMark />
                <span>@dominomoney</span>
              </a>
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
            {/* The motion control: at the start of the row on a phone, like the rest of the footer, and at its end from 768px. */}
            <div className="dm-footer-controls md:ml-auto">{motion}</div>
          </div>
        </div>
      </div>
    </footer>
  )
}
