import { useId } from 'react'
import { FigureDash } from '../../components/ui'
import { VAULT_UI_MAX_PRICE_GAP_BPS, VAULT_UI_MAX_SLIPPAGE_BPS } from './constants'
import { bandWarning, bpsText, floorExample, intervalWords, observationAgeWords, PROBLEM_FIELD, SETTINGS_PROBLEM_TEXT, type VaultSettingsForm } from './form'

/**
 * A vault's limits in Set up automation's own fields (spec F7 rev2 §5.2; decisions #12, #27, #29): the Domino-only
 * fields for Domino-compound (V1's defaults; the contract validates them in either mode), the slippage "on top of the pool
 * fee" with its floor example, the band between the pool price and the reference price (never V1's "price impact"
 * wording) with its growing warning, both up to 5% on screen; the reference price's age and the minimum interval FIXED,
 * said and never edited; and the current distance between the pool price and the reference price, unavailable until a
 * reference price can be read (§5.2, §6.2).
 */

type Editable = 'triggerPercent' | 'maxOverlapPercent' | 'maxPositions' | 'upsidePercent' | 'maxSlippagePercent' | 'maxPriceGapPercent'

const LABEL: Readonly<Record<Editable, string>> = {
  upsidePercent: 'Next range higher by (%)',
  maxPositions: 'Maximum positions',
  triggerPercent: 'Distance to the top of the range (%)',
  maxOverlapPercent: 'Maximum range overlap (%)',
  maxSlippagePercent: 'Swap slippage limit (%)',
  maxPriceGapPercent: 'Price gap limit (%)',
}

const HELP: Readonly<Record<Editable, string>> = {
  upsidePercent: 'The next range must end at least this much above the top of this range.',
  maxPositions: 'Includes this position and any following positions.',
  triggerPercent: 'How close the price must get to the top of this range before Domino can consider the next position.',
  maxOverlapPercent: 'How far the next range may extend below the top of this range.',
  maxSlippagePercent: 'The allowed change in a swap price, on top of the pool fee.',
  maxPriceGapPercent: 'Automation waits when the pool price differs from the reference price by more than this.',
}

export function LimitsFields({ form, onChange, problems, dex, disabled }: {
  form: VaultSettingsForm
  onChange: (next: VaultSettingsForm) => void
  problems: readonly string[]
  dex: 3 | 4
  disabled?: boolean
}) {
  const fieldId = useId()
  const problemFor = (field: keyof VaultSettingsForm | 'fixed'): string | null => {
    const code = problems.find((p) => PROBLEM_FIELD[p] === field)
    return code ? (SETTINGS_PROBLEM_TEXT[code] ?? null) : null
  }
  const field = (name: Editable, hint?: string | null) => (
    <div key={name} className="dm-seq-limit" data-invalid={problemFor(name) ? '' : undefined} data-setting={name}>
      <label className="dm-label dm-acct-lf">
        {LABEL[name]}
        <input className="dm-field" inputMode="decimal" disabled={disabled} value={form[name]} aria-invalid={problemFor(name) ? true : undefined} aria-describedby={`${fieldId}-${name}-hint${problemFor(name) ? ` ${fieldId}-${name}-error` : ''}`} onChange={(event) => onChange({ ...form, [name]: event.target.value })} data-setting-input={name} />
        {/* V4 (the approved sequence.html .fld span): the unit inside the field, decoration only (the label already says %). */}
        {name.endsWith('Percent') && <span className="dm-seq-limit-unit" aria-hidden="true">%</span>}
      </label>
      <p className="dm-seq-hint" id={`${fieldId}-${name}-hint`}>{HELP[name]}{hint ? ` ${hint}` : ''}</p>
      {problemFor(name) && <p className="dm-seq-limit-why" id={`${fieldId}-${name}-error`}>{problemFor(name)}</p>}
    </div>
  )
  const warning = bandWarning(form.maxPriceGapPercent)
  const distanceReason = dex === 3
    ? "The reference price Domino's automation uses on Uniswap v3 pools isn't published yet, so the distance can't be shown."
    : "The reference price for Uniswap v4 pools can't be read by this page yet, so the distance can't be shown."
  return (
    <>
      {form.mode === 2 && <div className="dm-acct-fields" data-domino-settings="">{(['upsidePercent', 'maxPositions'] as const).map((name) => field(name))}</div>}
      <details className="dm-details dm-acct-disclosure" open={problems.some((p) => ['maxSlippagePercent', 'maxPriceGapPercent', 'fixed', 'triggerPercent', 'maxOverlapPercent'].includes(PROBLEM_FIELD[p] ?? '')) || undefined}>
        <summary>More limits</summary>
        <div className="dm-acct-disclosure-body grid gap-3" data-vault-limits="">
          <div className="dm-acct-fields">
            {form.mode === 2 && field('triggerPercent')}
            {form.mode === 2 && field('maxOverlapPercent')}
            {field('maxSlippagePercent', [floorExample(form.maxSlippagePercent), `Up to ${bpsText(VAULT_UI_MAX_SLIPPAGE_BPS)}%.`].filter(Boolean).join(' '))}
            {field('maxPriceGapPercent', `Up to ${bpsText(VAULT_UI_MAX_PRICE_GAP_BPS)}%.`)}
          </div>
          {warning && (
            <p className="text-body" role="note" data-band-warning="">
              {warning}
            </p>
          )}
          <p className="dm-seq-hint" data-fixed-age={String(form.observationAgeSeconds)}>{observationAgeWords(form.observationAgeSeconds)}.</p>
          <p className="dm-seq-hint" data-fixed-interval={String(form.minimumIntervalSeconds)}>{intervalWords(form.minimumIntervalSeconds)}</p>
          {problemFor('fixed') && <p className="dm-seq-limit-why">{problemFor('fixed')}</p>}
          <p className="dm-seq-hint" data-band-distance="unavailable">
            How far the pool price is from the reference price right now: <FigureDash reason={distanceReason} />
          </p>
        </div>
      </details>
    </>
  )
}
