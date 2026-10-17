import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconPlus } from '../../components/icons'
import { IconRangeArrows, IconShieldPlain, IconWithdrawTray } from '../../components/positions/actionIcons'
import { Button } from '../../components/ui'
import { HOOKED_COPY, ROOT_BLOCKS_CHANGE_RANGE, ROOT_CHANGE_RANGE_COPY } from './constants'
import { COPY } from './copy'
import { hookedPool, type ActionPosition } from './model'

/** Visible position actions, sharing the same owner, pool and automation guards as the original menu. */
export interface MoreAction {
  key: 'increase' | 'changeRange' | 'exit' | 'protect'
  label: string
  disabled?: boolean
  /** Why it is disabled, shown on hover, focus or touch. */
  why?: string | null
}

/**
 * The menu's entries for a position, in the order a person needs them (V1's page and the read-v6 page share this one
 * list): Add liquidity; Change range and Withdraw while it holds liquidity. A hooked pool disables each with its reason
 * [#6]; an armed root blocks Change range [#5]. A vault's successor has none: its sentence stands where the menu would.
 *
 * Changed on purpose 2026-10-04 (the owner: stop-loss and take-profit belong inside the position, as a button there):
 * the protection ends the list whenever the page's automation panel can turn it on for this position (`protect`,
 * ../autoexit/entry.ts); the pick opens the same dialog as the panel's own card. 2026-10-06 (the owner's point 5): its name
 * is Auto-exit, and it is offered only while none is on.
 */
export function positionMenuItems(action: ActionPosition, protect = false): MoreAction[] {
  if (action.vault?.role === 'successor') return []
  const blocked = hookedPool(action.pool) ? HOOKED_COPY : null
  const rangeBlocked = action.vault?.role === 'root' && action.vault.armed === true && ROOT_BLOCKS_CHANGE_RANGE
  const empty = action.liquidity === 0n
  return [
    { key: 'increase', label: COPY.button.add, disabled: blocked !== null, why: blocked },
    ...(empty ? [] : [{ key: 'changeRange' as const, label: COPY.button.changeRange, disabled: blocked !== null || rangeBlocked, why: blocked ?? (rangeBlocked ? ROOT_CHANGE_RANGE_COPY : null) }]),
    ...(empty ? [] : [{ key: 'exit' as const, label: COPY.button.withdraw, disabled: blocked !== null, why: blocked }]),
    ...(empty || !protect ? [] : [{ key: 'protect' as const, label: COPY.button.protect }]),
  ]
}

// The approved V4 row's glyphs (components/positions/actionIcons.tsx): the double arrow, the tray, the plain shield.
const ACTION_ICONS = { increase: IconPlus, changeRange: IconRangeArrows, exit: IconWithdrawTray, protect: IconShieldPlain } as const

/** Every action is visible. The old data hooks remain on the group and its buttons. */
export function MoreActions({ id, items, onPick, ...data }: { id: string; items: readonly MoreAction[]; onPick: (key: MoreAction['key']) => void } & Record<`data-${string}`, string>) {
  return (
    <span className="dm-position-tools" {...data}>
      <span id={id} role="group" aria-label="Position actions" className="dm-position-tools-list" data-position-v2-more="">
        {items.map((item) => {
          const Icon = ACTION_ICONS[item.key]
          return <ActionButton key={item.key} id={`${id}-${item.key}`} item={item} onPick={onPick}><Icon size={18} /><span>{item.label}</span></ActionButton>
        })}
      </span>
    </span>
  )
}
/** An unavailable action is still reachable by keyboard and touch so its reason can be asked for. */
function ActionButton({ id, item, children, onPick }: { id: string; item: MoreAction; children: ReactNode; onPick: (key: MoreAction['key']) => void }) {
  const [explained, setExplained] = useState(false)
  const wrapper = useRef<HTMLSpanElement>(null)
  const unavailable = item.disabled === true
  const hasReason = unavailable && !!item.why
  useEffect(() => {
    if (!explained) return
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setExplained(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [explained])
  return (
    <span ref={wrapper} className="dm-position-action-help" onMouseEnter={() => hasReason && setExplained(true)} onMouseLeave={() => setExplained(false)}
      onFocus={() => hasReason && setExplained(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setExplained(false) }}>
      <Button type="button" variant="outline" aria-haspopup={unavailable ? undefined : 'dialog'} aria-disabled={unavailable || undefined}
        aria-describedby={hasReason ? `${id}-reason` : undefined} data-position-v2-action={item.key}
        onKeyDown={(event) => { if (event.key === 'Escape' && explained) { event.stopPropagation(); setExplained(false) } }}
        onClick={() => { if (unavailable) { if (hasReason) setExplained(true); return } onPick(item.key) }}>
        {children}
      </Button>
      {hasReason && <span id={`${id}-reason`} role="tooltip" className="dm-position-action-tooltip" hidden={!explained} data-position-action-reason={item.key}>{item.why}</span>}
    </span>
  )
}
