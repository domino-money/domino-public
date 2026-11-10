import type { ComponentType } from 'react'
import type { Page } from '../App'
import { Menu, type MenuEntry } from './ui'
import { IconAutomate, IconBook, IconCoins, IconInfo, IconMarkets, IconPlus, IconPositions, IconRange, IconShield, IconStar, type IconProps } from './icons'
import { automateHref, docsHref, marketsHref, newPositionHref, positionsHref } from './explore/routes'
import { ELYSIUM_KEY, ELYSIUM_NAME, ELYSIUM_STATUS } from '../config/chainIdentity'
import { sectionLinked } from '../chains/elysium/mode'

/**
 * The second chain's section (2026-10-01, the chain2 workstream, part B): linked from the menu only where its mode is
 * not off (chains/elysium/mode.ts sectionMode: the preview alias and the local development server today; on
 * domino.money not until the chain's deployment is qualified), under its name in the registry. Decided once, from the
 * page's own origin. Only the chain's identity comes into the page for it (config/chainIdentity.ts), never its record.
 */
const ELYSIUM_LINKED = typeof location !== 'undefined' && sectionLinked(location.origin, ELYSIUM_STATUS)

/**
 * The product's three places, in the header's nav pill and at the top of the
 * phone menu. A pool page belongs to Markets and the wallet flows to Automate,
 * so those stay lit inside them. Home, the docs and the new-position flow light
 * nothing; the menu's own New position marks itself there. Changed on purpose
 * 2026-10-30 (QA round 2, Q25): the flow lit Positions, which read as a jump to
 * a list the person may not have when they came from Markets.
 */
export const PRIMARY_NAV: ReadonlyArray<{ label: string; href: string; icon: ComponentType<IconProps>; pages: readonly Page[] }> = [
  { label: 'Markets', href: marketsHref(), icon: IconMarkets, pages: ['markets', 'pool'] },
  { label: 'Positions', href: positionsHref, icon: IconPositions, pages: ['positions'] },
  { label: 'Automate', href: automateHref, icon: IconAutomate, pages: ['automate', 'setup', 'sequence'] },
]

/** The guides, under the same names and to the same places in the menu and the footer (components/Footer.tsx). */
export const GUIDES: ReadonlyArray<{ label: string; href: string; icon: ComponentType<IconProps> }> = [
  { label: 'How it works', href: '/#learn', icon: IconInfo },
  { label: 'Price ranges', href: '/#ranges', icon: IconRange },
  { label: 'Risks', href: docsHref('risks'), icon: IconShield },
]

/**
 * The ≡ menu (DESIGN.md D.3). Every entry is a route or a section of Home.
 * No wallet control, no motion toggle and no external link live here: the
 * wallet control stays the header's only dialog trigger, and the motion toggle
 * stays in the footer's flow.
 *
 * 2026-09-27 (the owner's round 6, point 6): Settings is gone. Docs takes its
 * place beside New position, since the docs say what Settings said, and an old
 * `#/settings` link opens them. The book is the docs' mark now, so How it
 * works wears the info mark and Risks the shield Home's own limits card wears.
 *
 * Changed on purpose 2026-10-30 (QA round 2, Q16): the guides carry the footer's
 * names and go where the footer's go, "Price ranges" as the docs and Home name
 * them, and Risks opens the docs' Risks page, which its name promised (Home's
 * section is titled "Stay informed").
 */
export function HeaderMenu({ page }: { page: Page }) {
  const items: MenuEntry[] = [
    ...PRIMARY_NAV.map(({ label, href, icon: Icon, pages }): MenuEntry => ({
      kind: 'link',
      href,
      label,
      icon: <Icon />,
      current: pages.includes(page),
      mobileOnly: true,
    })),
    { kind: 'separator', mobileOnly: true },
    { kind: 'link', href: newPositionHref(), label: 'New position', icon: <IconPlus />, current: page === 'new' },
    // Added 2026-11-07 (the owner's Points page, Season 1, decision D4): always here, under New position, on every width,
    // in every build that carries the wallet (each deployed one); the page itself says what the points service shows yet.
    ...(__DOMINO_WALLET_SESSION__ ? [{ kind: 'link', href: '/points', label: 'Points', icon: <IconStar />, current: page === 'points' } as const] : []),
    { kind: 'link', href: docsHref(), label: 'Docs', icon: <IconBook />, current: page === 'docs' },
    ...(ELYSIUM_LINKED ? [{ kind: 'link', href: `/${ELYSIUM_KEY}`, label: ELYSIUM_NAME, icon: <IconCoins />, current: page === 'elysium' } as const] : []),
    { kind: 'separator' },
    { kind: 'heading', label: 'Guides' },
    ...GUIDES.map(({ label, href, icon: Icon }): MenuEntry => ({ kind: 'link', href, label, icon: <Icon /> })),
  ]
  // Two drawn glyphs (V4), both rendered and switched by CSS: three dots from 768px (the nav carries the places), which
  // spread while open, and three bars below, which turn into a cross while open. Decorative; the button's name is Menu.
  const trigger = (
    <span className="dm-menu-glyph" aria-hidden="true">
      <span className="dm-menu-dots"><i /><i /><i /></span>
      <span className="dm-menu-bars"><i /><i /><i /></span>
    </span>
  )
  return <Menu id="site-menu" label="Menu" items={items} trigger={trigger} />
}
