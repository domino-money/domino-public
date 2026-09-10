import { compactUsd, feeTierLabel, listMarkets, turnover, type Metric } from '../lib/markets'
import { Button, Display, Pill, cx } from './ui'
import { TokenPair } from './TokenIcon'

function Cell({ metric, suffix, strong }: { metric: Metric; suffix?: string; strong?: boolean }) {
  if (metric.value === null) return <span className="text-[13px] text-fg-subtle">Unavailable</span>
  return (
    <span
      className={cx('tnum font-mono text-[13px]', strong && 'text-fg')}
      style={metric.state === 'placeholder' && !strong ? { color: 'var(--fg-muted)' } : undefined}
      title={metric.state === 'placeholder' ? 'Sample figure, not an observation' : undefined}
    >
      {suffix ? `${Number(metric.value).toFixed(2)}${suffix}` : compactUsd(metric)}
    </span>
  )
}

const HEAD = ['#', 'Pool', 'TVL', '1D vol', '30D vol', '1D vol/TVL', 'Pool APR']

export function MarketsTable() {
  const { markets, source, notice, network } = listMarkets()

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Display className="text-[30px]">Top pools</Display>
            {source === 'placeholder' && <Pill tone="wait">Sample data</Pill>}
          </div>
          <p className="mt-2 max-w-[60ch] text-[14px] text-fg-muted">
            Pools on {network}, built from tokens that exist on the network.
            {notice ? ` ${notice}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 rounded-[var(--radius-pill)] border bg-surface-1 px-3 py-1.5 text-[12px]">
            <span className="h-2 w-2 rounded-full" style={{ background: '#00c805' }} aria-hidden="true" />
            {network}
          </span>
          <Button variant="ghost">View all pools →</Button>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-[20px] border bg-surface-1">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse">
            <thead>
              <tr className="border-b bg-surface-2/60 text-left">
                {HEAD.map((h, i) => (
                  <th key={h} scope="col" className={cx('px-5 py-3 text-[12px] font-normal text-fg-subtle', i >= 2 && 'text-right', i === 0 && 'w-12')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {markets.map((m, i) => (
                <tr key={m.poolId} className="group cursor-pointer border-b transition last:border-b-0 hover:bg-surface-2">
                  <td className="px-5 py-4 text-[13px] text-fg-subtle">{i + 1}</td>
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <TokenPair base={m.base} quote={m.quote} size={30} ring="var(--surface-1)" />
                      <span className="text-[14px] font-medium">
                        {m.base}/{m.quote}
                      </span>
                      <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                        <span className="rounded-[6px] bg-surface-3 px-1.5 py-0.5 font-mono">{m.protocol}</span>
                        <span>·</span>
                        <span className="font-mono">{feeTierLabel(m.feePips)}</span>
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-4 text-right"><Cell metric={m.tvlUsd} strong /></td>
                  <td className="px-5 py-4 text-right"><Cell metric={m.volume24hUsd} /></td>
                  <td className="px-5 py-4 text-right"><Cell metric={m.volume30dUsd} /></td>
                  <td className="tnum px-5 py-4 text-right font-mono text-[13px] text-fg-muted">{turnover(m)}</td>
                  <td className="px-5 py-4 text-right">
                    <span className="inline-flex items-center gap-2">
                      <Cell metric={m.feeAprPercent} suffix="%" strong />
                      <span className="text-fg-subtle transition group-hover:translate-x-0.5" aria-hidden="true">›</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t px-5 py-3 text-[12px] leading-relaxed text-fg-subtle">
          Pool APR describes a pool, not a position. It is not a forecast, not a return on your deposit, and says nothing about what a given range would have earned.
        </p>
      </div>
    </div>
  )
}
