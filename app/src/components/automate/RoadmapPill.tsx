import { Pill, cx } from '../ui'
import { ROADMAP, ROADMAP_PILL, ROADMAP_PILL_TITLE } from '../../lib/capabilities'

/**
 * Where a ROADMAP entry stands, as the pill a person scans for. Read from
 * ROADMAP every time, never written by hand, so the pill changes by itself
 * when the entry does; an entry that is not listed, or whose status wears no
 * pill (ROADMAP_PILL), shows nothing. Every status is the neutral pill: the
 * words say where it stands, never a colour.
 *
 * Its own module since 2026-10-01 (platform workstream, F1): Home, the docs and Positions show it too, and from
 * screens/Automate.tsx it kept the whole Automate screen in the entry every visitor downloads.
 *
 * 2026-10-01 (audit E3): the pill's meaning is its title, for whoever hovers or focuses it.
 */
export function RoadmapPill({ name, className }: { name: string; className?: string }) {
  const status = ROADMAP.find((entry) => entry.name === name)?.status
  const label = status && ROADMAP_PILL[status]
  if (!label) return null
  return (
    <Pill className={cx('dm-acct-status', className)} title={ROADMAP_PILL_TITLE[status]}>
      {label}
    </Pill>
  )
}
