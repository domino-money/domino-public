/**
 * One position on the second chain (2026-10-01, the chain2 workstream, audit items G5 and G7): where its range sits
 * against the price, what it holds, the fees it earned and has not collected (Uniswap v3's own arithmetic, at one
 * block), who looks after it (a Domino vault and its automation, or the wallet itself), and what happened to it (his
 * read service's history where it answers, else the vault's events on the chain). Ticks, raw liquidity and addresses
 * are in the closed Details.
 */
import { LinkButton, PageHeader, Pill, RangeBar, Skeleton, Stat, StatStrip } from '../../../components/ui'
import type { PositionRef, PositionState } from '../../types'
import { positionRef } from '../../types'
import { agoText, feeTierText, historyText, priceLine, rangeLine, shortAddress, tokenLabel } from '../present'
import { useNow, useSection } from './context'
import { Amount, ExplorerLink, Missing, PairMarks, PairName, ReadAt } from './parts'
import { sectionHref } from './routes'
import { useRead } from './useRead'
import { priceInvertedOn } from '../../../config/chainKit'

const EVERY_MS = 30_000

/** Where the range and the price sit on one line, the page's way round: fractions of the drawn width. */
function bar(state: PositionState, inverted: boolean): { lower: number; upper: number; current: number } {
  const [lo, hi, now] = inverted ? [-state.tickUpper, -state.tickLower, -state.tick] : [state.tickLower, state.tickUpper, state.tick]
  const span = Math.max(hi - lo, 1)
  const from = Math.min(lo, now) - span * 0.5
  const to = Math.max(hi, now) + span * 0.5
  const at = (tick: number) => (tick - from) / (to - from)
  return { lower: at(lo), upper: at(hi), current: at(now) }
}

function Automation({ vault }: { vault: string }) {
  const { chain, adapter } = useSection()
  const read = useRead(`vault:${vault}`, (signal) => adapter.vault(vault, signal), 60_000)
  const v = read.value
  const mode = !v ? null : !v.policy || v.policy.serviceFeeBps === 0 ? 'Not set up yet' : v.policy.serviceFeeBps === 200 ? 'Auto-compound' : v.policy.serviceFeeBps === 400 ? 'Domino-compound' : 'Custom'
  return (
    <div className="dm-card dm-card-pad mt-6" data-chain2-vault={vault}>
      <h2 className="dm-title">Automation</h2>
      <p className="mt-1 text-body text-fg-muted">This position is in a Domino vault on {chain.name}. Only the vault owner's wallet can take it out.</p>
      <dl className="dm-kv mt-3">
        <div><dt>Mode</dt><dd>{mode ?? <Skeleton className="block h-5 w-28" />}</dd></div>
        <div><dt>Status</dt><dd>{v ? (v.paused ? <Pill tone="wait">Paused</Pill> : <Pill tone="in" dot>On</Pill>) : <Skeleton className="block h-5 w-16" />}</dd></div>
        {v?.policy && v.policy.serviceFeeBps > 0 && <div><dt>Service fee</dt><dd>{v.policy.serviceFeeBps / 100}% of the fees it adds back, never of your deposit</dd></div>}
      </dl>
    </div>
  )
}

function History({ reference, state }: { reference: PositionRef; state: PositionState }) {
  const { adapter } = useSection()
  const now = useNow(30_000)
  const read = useRead(`history:${reference.tokenId}`, (signal) => adapter.history(reference, signal), 120_000)
  const page = read.value
  if (state.holder.kind !== 'vault') return null
  return (
    <div className="dm-card dm-card-pad mt-6" data-chain2-history="">
      <h2 className="dm-title">Activity</h2>
      {!page ? (
        <div className="mt-3 grid gap-2" aria-hidden="true">
          <Skeleton className="block h-5 w-full" />
          <Skeleton className="block h-5 w-40" />
        </div>
      ) : page.items.length === 0 ? (
        <p className="mt-2 text-body text-fg-muted">Nothing has happened to this position yet.</p>
      ) : (
        <ul className="mt-3 grid gap-3">
          {[...page.items].reverse().map((item) => (
            <li key={`${item.transactionHash}:${item.kind}:${item.block}`} className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-body text-fg">{historyText(item.kind)}</span>
              <span className="grid text-right text-caption text-fg-muted">
                {item.amounts[0] !== null && item.amounts[0] > 0n && <Amount raw={item.amounts[0]} token={state.token0} />}
                {item.amounts[1] !== null && item.amounts[1] > 0n && <Amount raw={item.amounts[1]} token={state.token1} />}
                <span>{item.timestamp !== null ? agoText(item.timestamp, now) : `Block ${item.block.toLocaleString('en-US')}`}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {page && !page.complete && <Missing>The record of this vault is not complete yet: older activity may be missing.</Missing>}
    </div>
  )
}

function Facts({ state }: { state: PositionState }) {
  const { chain } = useSection()
  return (
    <details className="dm-details mt-6" data-chain2-position-details="">
      <summary>Details</summary>
      <dl className="dm-kv">
        <div><dt>Position NFT</dt><dd className="dm-kv-mono">#{state.ref.tokenId}</dd></div>
        <div><dt>Position manager</dt><dd><ExplorerLink chain={chain} address={state.ref.positionManager} /></dd></div>
        <div><dt>{state.holder.kind === 'vault' ? 'Vault' : 'Held by'}</dt><dd><ExplorerLink chain={chain} address={state.holder.kind === 'vault' ? state.holder.vault : state.holder.owner} /></dd></div>
        {state.holder.kind === 'vault' && <div><dt>Vault owner</dt><dd><ExplorerLink chain={chain} address={state.holder.owner} /></dd></div>}
        <div><dt>Pool</dt><dd><ExplorerLink chain={chain} address={state.pool.id} /></dd></div>
        <div><dt>Ticks</dt><dd className="dm-kv-mono">{state.tickLower} to {state.tickUpper} · now {state.tick}</dd></div>
        <div><dt>Liquidity</dt><dd className="dm-kv-mono">{state.liquidity.toString()}</dd></div>
        <div><dt>Read at block</dt><dd className="dm-kv-mono">{state.at.block}</dd></div>
      </dl>
    </details>
  )
}

export function PositionPage({ param }: { param: string }) {
  const { chain, adapter, source } = useSection()
  const now = useNow()
  const reference = positionRef(chain, source.positionManager, param)
  const read = useRead(`position:${reference?.tokenId ?? 'none'}`, (signal) => (reference ? adapter.position(reference, signal) : Promise.reject(new Error('not_a_position'))), EVERY_MS, reference !== null)
  if (!reference || read.phase === 'gone') {
    return (
      <section data-chain2-screen="position" data-chain2-gone={reference ? '' : undefined}>
        <PageHeader title="Position not found" description={`That link doesn't name a position on ${chain.name}.`} actions={<LinkButton variant="secondary" href={sectionHref(chain, 'positions')}>Your positions</LinkButton>} />
      </section>
    )
  }
  const state = read.value
  const range = state ? rangeLine(chain, state) : null
  const price = state ? priceLine(chain, state) : null
  const inverted = state ? priceInvertedOn(chain, state.token0.address, state.token1.address) : false
  const closed = state ? !state.active || state.liquidity === 0n : false
  const drawn = state && !closed ? bar(state, inverted) : null
  return (
    <section data-chain2-screen="position" data-chain2-position={reference.tokenId}>
      <PageHeader
        eyebrow={state ? `Uniswap · ${feeTierText(state.fee)}` : 'Uniswap'}
        title={
          range ? (
            <span className="inline-flex items-center gap-3">
              <PairMarks token0={range.base} token1={range.quote} size={36} />
              <span><PairName base={range.base} quote={range.quote} /></span>
            </span>
          ) : (
            'Position'
          )
        }
        description={state ? (state.holder.kind === 'vault' ? `In a Domino vault, ${shortAddress(state.holder.vault)}, owned by ${shortAddress(state.holder.owner)}.` : `Held directly in a wallet, ${shortAddress(state.holder.owner)}, outside Domino.`) : read.phase === 'waiting' ? `Reading this position on ${chain.name}…` : undefined}
        actions={state ? <LinkButton variant="secondary" href={sectionHref(chain, 'pool', state.pool.id)}>Open the pool</LinkButton> : undefined}
      />
      {state && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {closed ? <Pill tone="neutral">Closed</Pill> : <Pill tone={state.inRange ? 'in' : 'out'} dot>{state.inRange ? 'In range: earning fees' : 'Out of range: not earning now'}</Pill>}
        </div>
      )}
      {drawn && state && <RangeBar className="mt-4" lower={drawn.lower} upper={drawn.upper} current={drawn.current} inRange={state.inRange} label="Your price range and today's price" />}
      <div className="mt-6">
        <StatStrip cols={4} layout="tiles">
          <Stat label="You hold">
            {state ? (
              <span className="grid whitespace-normal break-words">
                <Amount raw={state.amounts[0]} token={state.token0} />
                <Amount raw={state.amounts[1]} token={state.token1} />
              </span>
            ) : (
              <Skeleton className="block h-5 w-28" />
            )}
          </Stat>
          <Stat label="Fees earned, not collected" info="What collecting would pay the position now, read from the network: fees it earned since it last collected.">
            {state ? (
              <span className="grid whitespace-normal break-words">
                <Amount raw={state.fees[0]} token={state.token0} />
                <Amount raw={state.fees[1]} token={state.token1} />
              </span>
            ) : (
              <Skeleton className="block h-5 w-24" />
            )}
          </Stat>
          <Stat label="Price range">
            {range ? (
              range.low !== null && range.high !== null ? (
                <span className="tnum whitespace-normal break-words">
                  {range.low} – {range.high} <bdi className="text-body text-fg-muted">{tokenLabel(range.quote)}</bdi>
                </span>
              ) : (
                <span className="text-fg-subtle">—</span>
              )
            ) : (
              <Skeleton className="block h-5 w-32" />
            )}
          </Stat>
          <Stat label="Price now">
            {price?.text ? (
              <span className="tnum whitespace-normal break-words">
                {price.text} <bdi className="text-body text-fg-muted">{tokenLabel(price.quote)}</bdi>
              </span>
            ) : state ? (
              <span className="text-fg-subtle">—</span>
            ) : (
              <Skeleton className="block h-5 w-24" />
            )}
          </Stat>
        </StatStrip>
      </div>
      {range && <p className="mt-3 text-caption text-fg-muted">Prices are for 1 <bdi>{tokenLabel(range.base)}</bdi>, in <bdi>{tokenLabel(range.quote)}</bdi>.</p>}
      {state && <ReadAt className="mt-1" at={state.at} chain={chain} now={now} />}
      {state?.holder.kind === 'vault' && <Automation vault={state.holder.vault} />}
      {state && <History reference={reference} state={state} />}
      {state && <Facts state={state} />}
    </section>
  )
}
