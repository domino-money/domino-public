import { Fragment, useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { IconPlus } from '../../components/icons'
import { SheetChoices } from '../../components/positions/ActionSheet'
import { TokenMarkPair } from '../../components/TokenIcon'
import { Segmented, Select } from '../../components/ui'
import { rootScale } from '../../lib/rootScale'
import { awayShort } from '../../lib/create/plain'
import { priceText, rangeBothWays } from '../../v2/plan/present'
import { ZERO_ADDRESS, type Address } from '../../v2/types'
import { RANGE_PRESETS, type Share } from './constants'
import { COPY } from './copy'
import { amountTokens, otherTokens, rangeReferencePrice, ticksOf, type AmountsValue, type RangeValue } from './forms'
import { markOf } from './marks'
import type { ActionPosition } from './model'
import { decimalsOf, labelOf, type TokenBook } from './tokens'
import { Mark, Note } from './ui'
import type { OpenGate } from './wallet'

/*
 * The position dialogs' forms (Changed on purpose 2026-10-03, the owner, point 9: "two stacked pill rows with no
 * hierarchy, a bare input, a disclosure that looks like a field: a raw form, not a product"), in New position's visual
 * language (components/create/PairedAmounts.tsx, RangeStep.tsx, PositionPreview.tsx):
 *   - Add liquidity: the amount large in New position's panel, the token it is paid with as a chip in the panel (the
 *     pool's two tokens, then the other tokens the chain's profile names: "Another token" lives in that list), and one
 *     light switch for paying with both tokens, which opens the second panel under a +;
 *   - Change range: the price now, the new range drawn on the pool's price over the range the position has now, the
 *     widths as cards, the new range's ends as two panels (typed in for Custom), the other way round in one quiet line;
 *   - Withdraw: how much, then what you receive as three cards (both tokens, or either one), the fee in one line.
 * The same values, choices and hooks as before; nothing here reads anything.
 */

/**
 * The site's Select (components/ui.tsx) as the amount panel's token chip, its list floating over the dialog: fixed to the
 * viewport at the chip's end edge, below it (above it when there is more room there), placed as it mounts (a mutation
 * observer's callback runs before the first paint) and on every scroll and resize, so the dialog's scrolling body never
 * clips it. The Select itself is untouched: its keyboard, its focus on the trigger, its outside press. Its gaps and height
 * limits are design px at the root's scale (changed on purpose 2026-10-03, lib/rootScale.ts); the chip's box is CSS px.
 */
function ChipSelect<T extends string>({ id, label, value, options, onChange }: { id: string; label: string; value: T; options: ReadonlyArray<{ value: T; label: ReactNode; icon?: ReactNode; separatorAfter?: boolean }>; onChange: (next: T) => void }) {
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const root = box.current
    if (!root) return
    const place = () => {
      const list = root.querySelector<HTMLElement>('[role="listbox"]')
      const chip = root.querySelector<HTMLElement>('.dm-select')?.getBoundingClientRect()
      if (!list || !chip) return
      const s = rootScale()
      const below = window.innerHeight - chip.bottom - 12 * s
      const above = chip.top - 12 * s
      const up = below < 180 * s && above > below
      Object.assign(list.style, {
        position: 'fixed',
        top: up ? 'auto' : `${chip.bottom + 6 * s}px`,
        bottom: up ? `${window.innerHeight - chip.top + 6 * s}px` : 'auto',
        left: 'auto',
        right: `${document.documentElement.clientWidth - chip.right}px`,
        maxHeight: `${Math.max(120 * s, Math.min(320 * s, up ? above : below))}px`,
      })
    }
    const observer = new MutationObserver(place)
    observer.observe(root, { childList: true, subtree: true })
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [])
  return (
    <span ref={box} className="dm-pa-chip-box">
      <Select id={id} label={label} value={value} options={options} onChange={onChange} className="dm-pa-chip" />
    </span>
  )
}

/** How large the amount is drawn, by its length (components/create/fields.tsx's own steps). */
const lengthStep = (length: number) => (length <= 8 ? 's' : length <= 12 ? 'm' : length <= 16 ? 'l' : 'xl')

/** What an add puts in: one of the pool's tokens, both, or another token the chain's profile names (swapped by a leg). */
export function AmountsField({ chainId, position, book, value, onChange }: { chainId: OpenGate['chainId']; position: ActionPosition; book: TokenBook; value: AmountsValue; onChange: (next: AmountsValue) => void }) {
  const pool = position.pool
  const own: readonly Address[] = [pool.currency0, pool.currency1]
  const others = otherTokens(chainId, pool)
  const tokens = amountTokens(value, pool)
  const single = value.mode !== 'both'
  // One token: the pool's own ("one") or another the profile names ("other"); the last one chosen is kept across the switch.
  const pick = (token: Address) => onChange({ ...value, mode: own.includes(token) ? 'one' : 'other', token })
  const options = [...own, ...others].map((token, index) => ({
    value: token,
    label: labelOf(book, token),
    icon: <Mark chainId={chainId} book={book} token={token} size={20} />,
    separatorAfter: index === own.length - 1 && others.length > 0,
  }))
  return (
    <div className="dm-pa-field" data-position-amounts={value.mode}>
      <div className="dm-pa-field-head">
        <span className="dm-pa-label">{COPY.form.youAdd}</span>
        <Segmented
          size="sm"
          className="dm-pa-mode"
          label={COPY.form.amounts}
          items={[
            { key: 'single', label: COPY.form.oneToken },
            { key: 'both', label: COPY.form.bothTokens },
          ]}
          value={single ? 'single' : 'both'}
          onChange={(next) => onChange({ ...value, mode: next === 'both' ? 'both' : own.includes(value.token) ? 'one' : 'other' })}
        />
      </div>
      <div className="dm-flow-pair">
        {tokens.map((token, index) => {
          const text = value.text[token] ?? ''
          const label = labelOf(book, token)
          return (
            <Fragment key={token}>
              {/* Between the two panels, as New position joins its two: decoration only. */}
              {index === 1 && (
                <span aria-hidden="true" className="dm-flow-link">
                  <IconPlus size={16} />
                </span>
              )}
              <div className="dm-flow-pair-row">
                <div className="dm-flow-amount" data-position-amount={token}>
                  <div className="dm-flow-amount-row">
                    <input
                      className="dm-flow-amount-input tnum"
                      inputMode="decimal"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="0"
                      aria-label={COPY.form.amountOf(label)}
                      value={text}
                      title={text || undefined}
                      data-len={lengthStep(text.length)}
                      onChange={(event) => onChange({ ...value, text: { ...value.text, [token]: event.target.value } })}
                    />
                    {single ? (
                      <ChipSelect id={`position-v2-pay-${position.tokenId}`} label={COPY.form.payWith} value={value.token} options={options} onChange={(next) => pick(next)} />
                    ) : (
                      <span className="dm-flow-amount-unit">
                        <Mark chainId={chainId} book={book} token={token} size={20} />
                        <span>{label}</span>
                      </span>
                    )}
                  </div>
                  {decimalsOf(book, token) === null && (
                    <span className="dm-pa-amount-raw">
                      {COPY.form.rawUnits} of {label}
                    </span>
                  )}
                </div>
              </div>
            </Fragment>
          )
        })}
      </div>
      {tokens.some((token) => token === ZERO_ADDRESS) && <Note>{COPY.review.ethDirect}</Note>}
    </div>
  )
}

/** "1 ETH = 2,160.34 USDC" ends of a range, and how far each sits from the price now. */
function ends(position: ActionPosition, book: TokenBook, ticks: { tickLower: number; tickUpper: number } | null) {
  const pool = position.pool
  const d0 = decimalsOf(book, pool.currency0)
  const d1 = decimalsOf(book, pool.currency1)
  const both = ticks ? rangeBothWays(ticks.tickLower, ticks.tickUpper, d0, d1) : null
  const away = (tick: number) => (position.tick === null ? null : awayShort(tick, position.tick))
  return {
    both,
    lower: both ? priceText(both.forward.low) : null,
    upper: both ? priceText(both.forward.high) : null,
    lowerAway: ticks ? away(ticks.tickLower) : null,
    upperAway: ticks ? away(ticks.tickUpper) : null,
  }
}

/** A new range around the price now (presets, or custom prices on the pool's spacing), drawn, and shown both ways round. */
export function RangeField({ position, book, value, onChange, ticks, sameRange }: { position: ActionPosition; book: TokenBook; value: RangeValue; onChange: (next: RangeValue) => void; ticks: { tickLower: number; tickUpper: number } | null; sameRange: boolean }) {
  const pool = position.pool
  const d0 = decimalsOf(book, pool.currency0)
  const d1 = decimalsOf(book, pool.currency1)
  const l0 = labelOf(book, pool.currency0)
  const l1 = labelOf(book, pool.currency1)
  // The same pool observation that backs the position, not a tick-rounded substitute.
  const now = rangeReferencePrice(position, book)
  const shown = ends(position, book, ticks)
  // The range the position has now, as the custom fields' hint (never a value: nothing is typed for the person).
  const current = rangeBothWays(position.tickLower, position.tickUpper, d0, d1)
  const custom = value.preset === 'custom'
  const typed = value.lower.trim() !== '' || value.upper.trim() !== ''
  // Each width with its little picture (V4's choice glyphs, decoration only); pointing at a preset previews its band in
  // the comparison well below (RangePicture's `previews`), as the approved sheet does before anything is chosen.
  const items = [
    ...RANGE_PRESETS.map((preset) => ({ key: preset.key, title: preset.label.split(' ')[0], icon: <RangeGlyph kind={preset.key} />, disabled: position.tick === null, data: { 'data-range-choice': preset.key } })),
    { key: 'custom', title: COPY.form.custom, icon: <RangeGlyph kind="custom" />, disabled: d0 === null || d1 === null, data: { 'data-range-choice': 'custom' } },
  ]
  const tick = position.tick
  const previews = tick === null ? null : Object.fromEntries(RANGE_PRESETS.map((preset) => [preset.key, ticksOf({ preset: preset.key, lower: '', upper: '' }, pool, tick, book)]))
  return (
    <div className="dm-pa-field dm-range-edit" data-position-range={value.preset}>
      <div className="dm-range-reference">
        <span className="dm-pa-label">{COPY.form.priceNow}</span>
        <p data-position-price-now="">{now === null ? 'Pool price unavailable' : <><span>1 {l0} = </span><strong>{now}</strong><span> {l1}</span></>}</p>
      </div>
      <div className="dm-range-width">
        <span className="dm-pa-label">Choose your new range</span>
        <SheetChoices label={COPY.form.range} value={value.preset} items={items} onChange={(preset) => onChange({ ...value, preset })} className="dm-pa-choices--compact" />
      </div>
      <div className="dm-pa-bounds" data-position-range-ticks={ticks ? `${ticks.tickLower}:${ticks.tickUpper}` : undefined}>
        {(['lower', 'upper'] as const).map((side) => {
          const label = side === 'lower' ? COPY.form.lower : COPY.form.upper
          const price = side === 'lower' ? shown.lower : shown.upper
          const away = side === 'lower' ? shown.lowerAway : shown.upperAway
          const hint = priceText(side === 'lower' ? current.forward.low : current.forward.high)
          return (
            <div key={side} className="dm-pa-bound" data-position-bound={side} data-editing={custom ? '' : undefined}>
              <div className="dm-pa-bound-head">
                <span className="dm-pa-label">{label}</span>
                {away && <span className="dm-pa-bound-away">{away}</span>}
              </div>
              {custom ? (
                <input className="dm-pa-bound-input tnum" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder={hint ?? '0'} value={value[side]} aria-label={label} onChange={(event) => onChange({ ...value, [side]: event.target.value })} />
              ) : (
                <p className="dm-pa-bound-price">{price ?? '—'}</p>
              )}
              <span className="dm-pa-bound-unit">{COPY.form.per(l0, l1)}</span>
            </div>
          )
        })}
      </div>
      <div className="dm-range-comparison">
        <RangePicture position={position} ticks={ticks} previews={previews} />
      </div>
      {/* The result line under the well (V4's .as-rs), its hooks and words unchanged. */}
      <p className="dm-range-result" role="status" data-position-range-result={ticks === null || position.tick === null ? 'unknown' : position.tick >= ticks.tickLower && position.tick < ticks.tickUpper ? 'inside' : 'outside'}>
        {ticks === null ? 'Set both prices to preview your new range.' : position.tick === null ? 'The pool price is unavailable right now.' : position.tick >= ticks.tickLower && position.tick < ticks.tickUpper ? 'The price is inside your new range.' : 'The price is outside your new range. Fees start when it enters.'}
      </p>
      <details className="dm-range-detail">
        <summary>Compare exact prices</summary>
        <dl><div><dt>{COPY.form.currentRange}</dt><dd>{priceText(current.forward.low) ?? '—'} — {priceText(current.forward.high) ?? '—'} {l1} per {l0}</dd></div>
        {shown.both && <div><dt>New range · reverse quote</dt><dd className="dm-pa-inverse">1 {l1} = {priceText(shown.both.inverse.low) ?? '—'} to {priceText(shown.both.inverse.high) ?? '—'} {l0}</dd></div>}</dl>
      </details>
      {sameRange && (
        <p className="dm-error" data-position-same-range="">
          {COPY.planErrors.position_plan_range_invalid}
        </p>
      )}
      {!ticks && custom && typed && <p className="dm-error">{COPY.form.rangeInvalid}</p>}
    </div>
  )
}

/**
 * The new range on the pool's price (the preview's picture, components/create/PositionPreview.tsx RangeStage, in this
 * dialog's size): the band from its lowest to its highest price with its Tangerine edges, the range the position has now
 * as a hatched band behind it, and the price now as a dotted line down to a dot on the axis; under each edge, how far it
 * sits from the price now. Ticks are a log price axis already, so the picture is drawn in them: no decimals are needed.
 * Decoration: the panels under it say every figure.
 */
export function RangePicture({ position, ticks, previews = null }: { position: ActionPosition; ticks: { tickLower: number; tickUpper: number } | null; previews?: Record<string, { tickLower: number; tickUpper: number } | null> | null }) {
  const now = position.tick
  const points = [position.tickLower, position.tickUpper, ...(ticks ? [ticks.tickLower, ticks.tickUpper] : []), ...(now === null ? [] : [now])]
  const span = Math.max(...points) - Math.min(...points)
  const pad = Math.max(span * 0.2, position.pool.tickSpacing * 2)
  const lo = Math.min(...points) - pad
  const hi = Math.max(...points) + pad
  const x = (tick: number) => ((tick - lo) / (hi - lo)) * 100
  const band = (a: number, b: number) => ({ left: `${x(a)}%`, width: `${Math.max(0.8, x(b) - x(a))}%` })
  const inside = ticks === null || now === null || (now >= ticks.tickLower && now < ticks.tickUpper)
  // A preset's band where the pointer previews it (v4-position.css reads these; clamped to the drawn axis).
  const clamp = (value: number) => Math.min(100, Math.max(0, value))
  const preview: Record<string, string> = {}
  for (const [key, short] of [['narrow', 'n'], ['medium', 'm'], ['wide', 'w']] as const) {
    const at = previews?.[key]
    if (!at) continue
    const left = clamp(x(at.tickLower)), right = clamp(x(at.tickUpper))
    preview[`--${short}l`] = `${left}%`
    preview[`--${short}w`] = `${Math.max(0.8, right - left)}%`
  }
  return (
    <div className="dm-pa-range dm-range-tracks" data-in={String(inside)} aria-hidden="true" style={preview as CSSProperties}>
      <div className="dm-range-track-head"><span data-key="was">Current range</span><span data-key="now">{now === null ? 'Price unavailable' : '● Price now'}</span></div>
      <div className="dm-range-track"><span className="dm-pa-range-was" style={band(position.tickLower, position.tickUpper)} />{now !== null && <span className="dm-pa-range-now" style={{ left: `${x(now)}%` }} />}</div>
      <div className="dm-range-track-head"><span data-key="new">New range</span>{ticks && now !== null && <span><span data-side="start">{awayShort(ticks.tickLower, now)}</span> to <span data-side="end">{awayShort(ticks.tickUpper, now)}</span></span>}</div>
      <div className="dm-range-track"><span className="dm-pa-range-axis" />{ticks && <span className="dm-pa-range-band" style={band(ticks.tickLower, ticks.tickUpper)} />}{now !== null && <span className="dm-pa-range-now" style={{ left: `${x(now)}%` }} />}</div>
    </div>
  )
}

/** A width's picture (V4's choice glyph, 56 × 20): the axis, the price now dashed, the band between its two handles. */
const GLYPH_BANDS: Record<string, readonly [number, number]> = { narrow: [23, 10], medium: [17, 22], wide: [7, 42], custom: [14, 30] }
function RangeGlyph({ kind }: { kind: string }) {
  const [x, width] = GLYPH_BANDS[kind] ?? GLYPH_BANDS.custom
  return (
    <svg className="dm-range-glyph" data-glyph={kind} width="56" height="20" viewBox="0 0 56 20" fill="none" aria-hidden="true" focusable="false">
      <path className="dm-gl-ax" d="M2 10h52" />
      <path className="dm-gl-now" d="M28 2v16" />
      <g className="dm-gl-b">
        <rect className="dm-gl-band" x={x} y="6" width={width} height="8" rx="1.5" />
        <path className="dm-gl-hd" d={`M${x} 4v12M${x + width} 4v12`} />
      </g>
    </svg>
  )
}

/** How much of the position a change of range or a withdrawal moves: all of it, half or a quarter. */
export function ShareField({ value, onChange, label = COPY.form.howMuch }: { value: Share; onChange: (next: Share) => void; label?: string }) {
  return (
    <div className="dm-pa-field">
      <span className="dm-pa-label">{label}</span>
      <Segmented label={COPY.form.howMuch} className="dm-pa-share" items={[{ key: '100', label: COPY.form.all }, { key: '50', label: '50%' }, { key: '25', label: '25%' }]} value={value} onChange={(next) => onChange(next as Share)} />
    </div>
  )
}

/** What a withdrawal pays out: both tokens (straight at Uniswap), or either one alone (Domino swaps the other into it). */
export function ReceiveField({ chainId, book, position, way, convertTo, onChange }: { chainId: OpenGate['chainId']; book: TokenBook; position: ActionPosition; way: 'both' | 'convert'; convertTo: Address; onChange: (way: 'both' | 'convert', convertTo: Address) => void }) {
  const pool = position.pool
  const meta = (token: Address) => markOf(chainId, book.get(token.toLowerCase()) ?? { address: token, symbol: null, decimals: null })
  return (
    <div className="dm-pa-field">
      <span className="dm-pa-label">{COPY.wallet.youReceive}</span>
      <SheetChoices
        label={COPY.wallet.youReceive}
        value={way === 'both' ? 'both' : convertTo}
        items={[
          { key: 'both', title: COPY.form.both, icon: <TokenMarkPair base={meta(pool.currency0)} quote={meta(pool.currency1)} size={24} ring="var(--surface-1)" /> },
          ...[pool.currency0, pool.currency1].map((token) => ({ key: token, title: labelOf(book, token), icon: <Mark chainId={chainId} book={book} token={token} size={24} /> })),
        ]}
        onChange={(key) => (key === 'both' ? onChange('both', convertTo) : onChange('convert', key as Address))}
      />
      <Note key={way} data-position-way-note={way}>{way === 'both' ? COPY.form.directNote : COPY.form.convertNote}</Note>
    </div>
  )
}
