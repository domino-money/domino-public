import type { ComponentType } from 'react'
import type { Page } from '../App'
import { Menu, type MenuEntry } from './ui'
import { IconAutomate, IconBook, IconClose, IconInfo, IconMarkets, IconMenu, IconMore, IconPlus, IconPositions, IconRange, IconSettings, type IconProps } from './icons'
import { automateHref, marketsHref, newPositionHref, positionsHref, settingsHref } from './explore/routes'

/**
 * The product's three places, in the header's nav pill and at the top of the
 * phone menu. A pool page belongs to Markets, the new-position flow to
 * Positions, and the wallet flows to Automate, so those stay lit inside them.
 * Home and Settings light nothing.
 */
export const PRIMARY_NAV: ReadonlyArray<{ label: string; href: string; icon: ComponentType<IconProps>; pages: readonly Page[] }> = [
  { label: 'Markets', href: marketsHref(), icon: IconMarkets, pages: ['markets', 'pool'] },
  { label: 'Positions', href: positionsHref, icon: IconPositions, pages: ['positions', 'new'] },
  { label: 'Automate', href: automateHref, icon: IconAutomate, pages: ['automate', 'setup', 'sequence'] },
]

/**
 * The ≡ menu (DESIGN.md D.3). Every entry is a route or a section of Home.
 * No wallet control, no appearance or motion toggle and no external link live
 * here: the wallet control stays the header's only dialog trigger, and both
 * toggles stay in the footer's flow.
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
    { kind: 'link', href: settingsHref, label: 'Settings', icon: <IconSettings />, current: page === 'settings' },
    { kind: 'separator' },
    { kind: 'heading', label: 'Guides' },
    { kind: 'link', href: '#/#learn', label: 'How it works', icon: <IconBook /> },
    { kind: 'link', href: '#/#ranges', label: 'Ranges explained', icon: <IconRange /> },
    { kind: 'link', href: '#/#limits', label: 'What Domino does not do', icon: <IconInfo /> },
  ]
  // Two resting glyphs, both rendered and switched by CSS: three dots from 768px (the nav pill carries the places),
  // the hamburger below. Both are aria-hidden; the button's name is Menu.
  const trigger = (
    <span className="dm-menu-glyph">
      <IconMore className="dm-menu-glyph-more" />
      <IconMenu className="dm-menu-glyph-open" />
      <IconClose className="dm-menu-glyph-close" />
    </span>
  )
  return <Menu id="site-menu" label="Menu" items={items} trigger={trigger} />
}
