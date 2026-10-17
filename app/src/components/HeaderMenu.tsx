import type { ComponentType } from 'react'
import type { Page } from '../App'
import { Menu, type MenuEntry } from './ui'
import { IconAutomate, IconBook, IconCoins, IconInfo, IconMarkets, IconPlus, IconPositions, IconRange, IconShield, type IconProps } from './icons'
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
 * phone menu. A pool page belongs to Markets, the new-position flow to
 * Positions, and the wallet flows to Automate, so those stay lit inside them.
 * Home and the docs light nothing.
 */
export const PRIMARY_NAV: ReadonlyArray<{ label: string; href: string; icon: ComponentType<IconProps>; pages: readonly Page[] }> = [
  { label: 'Markets', href: marketsHref(), icon: IconMarkets, pages: ['markets', 'pool'] },
  { label: 'Positions', href: positionsHref, icon: IconPositions, pages: ['positions', 'new'] },
  { label: 'Automate', href: automateHref, icon: IconAutomate, pages: ['automate', 'setup', 'sequence'] },
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
 * works wears the info mark and What Domino does not do the shield Home's own
 * limits card wears.
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
    { kind: 'link', href: docsHref(), label: 'Docs', icon: <IconBook />, current: page === 'docs' },
    ...(ELYSIUM_LINKED ? [{ kind: 'link', href: `#/${ELYSIUM_KEY}`, label: ELYSIUM_NAME, icon: <IconCoins />, current: page === 'elysium' } as const] : []),
    { kind: 'separator' },
    { kind: 'heading', label: 'Guides' },
    { kind: 'link', href: '#/#learn', label: 'How it works', icon: <IconInfo /> },
    { kind: 'link', href: '#/#ranges', label: 'Ranges explained', icon: <IconRange /> },
    { kind: 'link', href: '#/#limits', label: 'What Domino does not do', icon: <IconShield /> },
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
