import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { PositionChartOptions } from './PositionChartOptions'

/** Switching views changes visibility only: each chart retains its reads, period and inspection state. */
export function PositionInsights({ fees, range }: { fees: ReactNode; range: ReactNode }) {
  const id = useId()
  const [active, setActive] = useState<'fees' | 'range'>('fees')
  const [expanded, setExpanded] = useState(false)
  const [showPoints, setShowPoints] = useState(false)
  const options = useMemo(() => ({ expanded, showPoints }), [expanded, showPoints])
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const choices = [{ key: 'fees', label: 'Fees' }, { key: 'range', label: 'Price range' }] as const
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? 1 - index : null
    if (next === null) return
    event.preventDefault()
    setActive(choices[next].key)
    tabs.current[next]?.focus()
  }
  return <PositionChartOptions.Provider value={options}><div className="dm-position-workspace" data-position-insights="" data-insight={active} data-chart-expanded={expanded ? '' : undefined}>
    <section className="dm-position-analysis" aria-label="Position charts">
      <div className="dm-position-chart-head">
        <div className="dm-position-chart-tabs" role="tablist" aria-label="Position chart">
          {choices.map((choice, index) => <button key={choice.key} ref={node => { tabs.current[index] = node }} type="button" role="tab"
            id={`${id}-${choice.key}-tab`} aria-controls={`${id}-${choice.key}-panel`} aria-selected={active === choice.key}
            tabIndex={active === choice.key ? 0 : -1} onClick={() => setActive(choice.key)} onKeyDown={event => move(event, index)}>{choice.label}</button>)}
        </div>
        <div className="dm-position-chart-tools" role="group" aria-label="Chart display">
          <button type="button" aria-label="Show measured points" title="Show measured points" aria-pressed={showPoints} onClick={() => setShowPoints(value => !value)}>
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="m3 14 7-8 7 5" /><circle cx="3" cy="14" r="2" /><circle cx="10" cy="6" r="2" /><circle cx="17" cy="11" r="2" /></svg>
          </button>
          <button type="button" aria-label={expanded ? 'Collapse chart' : 'Expand chart'} title={expanded ? 'Collapse chart' : 'Expand chart'} aria-expanded={expanded} aria-controls={`${id}-${active}-panel`} onClick={() => setExpanded(value => !value)}>
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">{expanded ? <path d="M3 7h4V3m6 0v4h4M3 13h4v4m6 0v-4h4" /> : <path d="M7 3H3v4m14 0V3h-4M3 13v4h4m6 0h4v-4" />}</svg>
          </button>
        </div>
      </div>
      <div id={`${id}-fees-panel`} role="tabpanel" aria-labelledby={`${id}-fees-tab`} hidden={active !== 'fees'} data-position-chart-panel="fees">{fees}</div>
      <div id={`${id}-range-panel`} role="tabpanel" aria-labelledby={`${id}-range-tab`} hidden={active !== 'range'} data-position-chart-panel="range">{range}</div>
    </section>
  </div></PositionChartOptions.Provider>
}
