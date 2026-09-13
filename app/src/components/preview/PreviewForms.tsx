/**
 * The two preview forms. Labelled fields, issues tied to their field with
 * aria-invalid and aria-describedby, and amounts entered as raw integers with
 * the curated catalog's decimals shown beside them. Nothing is sent from here;
 * the screen sends only when the user presses Get preview.
 */
import { useId, type ReactNode } from 'react'
import { poolOf, tokenOf, type PreviewCatalog } from '../../onboarding/catalog'
import type { InputIssue, PositionForm, SwapForm } from '../../onboarding/inputs'
import { formatTokenAmount, isRaw } from '../../lib/raw'

const INPUT =
  'mt-1 w-full rounded-[var(--radius)] border border-line-strong bg-surface-1 px-3 py-2 font-mono text-[13px] text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ring)] aria-[invalid=true]:border-[var(--money-out)]'

function Field({
  label,
  issue,
  hint,
  children,
}: {
  label: string
  issue: InputIssue | undefined
  hint?: string | null
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode
}) {
  const id = useId()
  const described = [issue ? `${id}-issue` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined
  return (
    <div>
      <label htmlFor={id} className="text-[12px] font-medium text-fg-muted">
        {label}
      </label>
      {children({ id, 'aria-invalid': Boolean(issue), 'aria-describedby': described })}
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-[12px] text-fg-subtle">
          {hint}
        </p>
      )}
      {issue && (
        <p id={`${id}-issue`} className="mt-1 text-[12px] text-money-out">
          {issue.message}
        </p>
      )}
    </div>
  )
}

const issueFor = (issues: readonly InputIssue[], field: string) => issues.find((issue) => issue.field === field)

function unitsHint(catalog: PreviewCatalog, address: string, raw: string): string | null {
  const token = tokenOf(catalog, address)
  if (!token || !isRaw(raw.trim())) return null
  return `= ${formatTokenAmount(raw.trim(), token.decimals, token.symbol)} (${token.decimals} decimals, from the synthetic catalog)`
}

export function SwapFormFields({
  form,
  onChange,
  issues,
  catalog,
}: {
  form: SwapForm
  onChange: (next: SwapForm) => void
  issues: readonly InputIssue[]
  catalog: PreviewCatalog
}) {
  const set = (patch: Partial<SwapForm>) => onChange({ ...form, ...patch })
  const tokens = catalog.tokens.filter((token) => !token.native)
  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="sr-only">Swap preview inputs</legend>
      <Field label="You send" issue={issueFor(issues, 'tokenIn')}>
        {(props) => (
          <select {...props} className={INPUT} value={form.tokenIn} onChange={(event) => set({ tokenIn: event.target.value })}>
            {tokens.map((token) => (
              <option key={token.address} value={token.address}>
                {token.symbol} ({catalog.label})
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="You receive" issue={issueFor(issues, 'tokenOut')}>
        {(props) => (
          <select {...props} className={INPUT} value={form.tokenOut} onChange={(event) => set({ tokenOut: event.target.value })}>
            {tokens.map((token) => (
              <option key={token.address} value={token.address}>
                {token.symbol} ({catalog.label})
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Amount to send (raw units)" issue={issueFor(issues, 'amountRaw')} hint={unitsHint(catalog, form.tokenIn, form.amountRaw)}>
        {(props) => <input {...props} className={INPUT} inputMode="numeric" autoComplete="off" value={form.amountRaw} onChange={(event) => set({ amountRaw: event.target.value })} />}
      </Field>
      <Field label="Slippage (basis points)" issue={issueFor(issues, 'slippageBps')}>
        {(props) => <input {...props} className={INPUT} inputMode="numeric" autoComplete="off" value={form.slippageBps} onChange={(event) => set({ slippageBps: event.target.value })} />}
      </Field>
      <Field label="Maximum price impact (basis points)" issue={issueFor(issues, 'maxPriceImpactBps')}>
        {(props) => (
          <input {...props} className={INPUT} inputMode="numeric" autoComplete="off" value={form.maxPriceImpactBps} onChange={(event) => set({ maxPriceImpactBps: event.target.value })} />
        )}
      </Field>
    </fieldset>
  )
}

export function PositionFormFields({
  form,
  onChange,
  issues,
  catalog,
}: {
  form: PositionForm
  onChange: (next: PositionForm) => void
  issues: readonly InputIssue[]
  catalog: PreviewCatalog
}) {
  const set = (patch: Partial<PositionForm>) => onChange({ ...form, ...patch })
  const pool = poolOf(catalog, form.poolId)
  const symbol = (address: string | undefined) => (address ? (tokenOf(catalog, address)?.symbol ?? address) : '?')
  const independent = pool ? (form.independent === '0' ? pool.poolKey.currency0 : pool.poolKey.currency1) : null
  const text = (field: keyof PositionForm, label: string, hint?: string | null) => (
    <Field label={label} issue={issueFor(issues, field)} hint={hint}>
      {(props) => <input {...props} className={INPUT} inputMode="numeric" autoComplete="off" value={form[field]} onChange={(event) => set({ [field]: event.target.value })} />}
    </Field>
  )
  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="sr-only">Position preview inputs</legend>
      <Field label="Pool" issue={issueFor(issues, 'poolId')}>
        {(props) => (
          <select {...props} className={INPUT} value={form.poolId} onChange={(event) => set({ poolId: event.target.value })}>
            {catalog.pools.map((entry) => (
              <option key={entry.poolId} value={entry.poolId}>
                {entry.label} ({catalog.label})
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="The amount is for" issue={undefined}>
        {(props) => (
          <select {...props} className={INPUT} value={form.independent} onChange={(event) => set({ independent: event.target.value === '1' ? '1' : '0' })}>
            <option value="0">Currency 0 ({symbol(pool?.poolKey.currency0)})</option>
            <option value="1">Currency 1 ({symbol(pool?.poolKey.currency1)})</option>
          </select>
        )}
      </Field>
      {text('amountRaw', 'Amount (raw units)', independent ? unitsHint(catalog, independent, form.amountRaw) : null)}
      {text('slippageBps', 'Slippage (basis points)')}
      {text('tickLower', 'Lower tick', pool ? `Multiples of ${pool.poolKey.tick_spacing} in this pool.` : null)}
      {text('tickUpper', 'Upper tick')}
      {text('budget0Raw', `Budget for currency 0 (raw units, blank for not given)`)}
      {text('budget1Raw', `Budget for currency 1 (raw units, blank for not given)`)}
      {text('nativeBalanceRaw', 'Native ETH balance (wei, you enter it; not verified)')}
      {text('nativeGasReserveRaw', 'Native gas reserve (wei, blank for not given)')}
    </fieldset>
  )
}
