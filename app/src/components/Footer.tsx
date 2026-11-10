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
 *
 * 2026-09-27 (the owner's round 6, point 6): the Settings page is gone, and its
 * link with it; Docs, under Guides, says what it said.
 *
 * Changed on purpose 2026-10-03 (the owner: Domino covers more than one network now, and the footer had two things
 * too many): no Network column, no chain in the brand line, and no Pause motion row. Reduced motion (the system
 * setting) still stills every drawing, and the ticker still stops under the pointer or focus.
 *
 * Changed on purpose 2026-10-30 (QA round 2, Q16): the guides are the menu's own list (HeaderMenu.tsx GUIDES), so both
 * use the same names and go to the same places; Risks opens the docs' Risks page.
 *
 * Changed on purpose 2026-11-08 (the owner: Domino's repository is public): its GitHub link sits beside the X link, the
 * same chip, so the footer leaves the app for these two only (lib/sourceRepo.ts).
 */
import { SOURCE_REPO } from '../lib/sourceRepo'
import { automateHref, docsHref, marketsHref, newPositionHref, positionsHref } from './explore/routes'
import { GUIDES } from './HeaderMenu'
import '../styles/home-footer.css'

/** Domino's X account, confirmed by the owner on 2026-09-26. */
export const X_PROFILE = 'https://x.com/dominomoney'

/** The X mark (Simple Icons, CC0), drawn in the link's own colour. */
function XMark() {
  return (
    <svg viewBox="0 0 24 24" width="0.875rem" height="0.875rem" aria-hidden="true" focusable="false" className="dm-footer-social-mark">
      <path fill="currentColor" d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  )
}

/** The GitHub mark (Simple Icons, CC0), at the X mark's size and in the link's own colour. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" width="0.875rem" height="0.875rem" aria-hidden="true" focusable="false" className="dm-footer-social-mark">
      <path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
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
    ],
  },
  {
    heading: 'Guides',
    links: [{ label: 'Docs', href: docsHref() }, ...GUIDES.map(({ label, href }) => ({ label, href }))],
  },
]

/**
 * The page's only `<footer>` (V4, site/_kit.md .ft): a hairline that catches the ember, a row with the X and GitHub links
 * and the two link columns, then the big wordmark at the bottom, which is not a link (only the header's wordmark points at Home) and
 * holds no control.
 */
export function Footer() {
  return (
    <footer className="dm-footer">
      <div className="dm-footer-inner">
        <div className="dm-footer-row">
          <div className="dm-footer-socials">
            <a href={X_PROFILE} target="_blank" rel="noopener noreferrer" className="dm-footer-social" aria-label="Domino on X (opens in a new tab)">
              <XMark />
              <span>@dominomoney</span>
            </a>
            <a href={SOURCE_REPO} target="_blank" rel="noopener noreferrer" className="dm-footer-social" aria-label="Domino’s source code on GitHub (opens in a new tab)">
              <GitHubMark />
              <span>Source code</span>
            </a>
          </div>
          <div className="dm-footer-cols">
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
          </div>
        </div>
        <span className="dm-display dm-footer-wordmark">
          domino<span className="dm-footer-dot">.</span>
        </span>
      </div>
    </footer>
  )
}
