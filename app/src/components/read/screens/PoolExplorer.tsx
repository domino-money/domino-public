import { useState } from 'react'
import { COPY } from '../../../lib/read/screens/copy'
import { poolPrice, presetRange, type PracticeRange } from '../../../lib/read/screens/poolRange'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { selectable, type TokenCandidate } from '../../../lib/read/screens/tokens'
import { TokenMark } from '../../TokenIcon'
import { Button, Card, cx } from '../../ui'
import { Address } from './Address'
import { PoolPicker } from './PoolPicker'
import { PoolRangeControls } from './PoolRangeControls'
import { PoolSelectionDialog } from './PoolSelectionDialog'
import { SymbolText } from './SymbolText'
import { TokenPicker } from './TokenPicker'

type Choice = 'first' | 'second' | 'range' | null
const TOKEN_ACTION_LABELS = { first: COPY.picker.useToken, second: COPY.picker.useAsset }

/** Page-local selection. Never persisted or passed to a financial workflow. */
export function PoolExplorer() {
  const source = useReadSource()
  const [first, setFirst] = useState<TokenCandidate | null>(null)
  const [second, setSecond] = useState<TokenCandidate | null>(null)
  const [pool, setPool] = useState<PoolOption | null>(null)
  const [range, setRange] = useState<PracticeRange | null>(null)
  const [choice, setChoice] = useState<Choice>(null)
  const [pending, setPending] = useState<TokenCandidate | null>(null)
  const [candidates, setCandidates] = useState<TokenCandidate[]>([])

  const openToken = (which: 'first' | 'second') => {
    setPending(which === 'first' ? first : second)
    setChoice(which)
  }
  const applyToken = () => {
    if (!pending || !selectable(pending) || (choice === 'second' && pending.key === first?.key)) return
    const previous = choice === 'first' ? first : second
    if (pending.key !== previous?.key) {
      setPool(null)
      setRange(null)
      if (choice === 'first') setSecond(null)
    }
    if (choice === 'first') setFirst(pending)
    else setSecond(pending)
    setChoice(null)
  }
  const openRange = () => {
    if (!pool) return
    const price = poolPrice(pool, 0)
    setRange((previous) => previous ?? (price.state === 'usable' ? presetRange(price.tick, price.tickSpacing, 'standard') : null))
    setChoice('range')
  }

  return (
    <div className="mt-7 grid items-start gap-5 md:grid-cols-[210px_minmax(0,1fr)]" data-pool-explorer="">
      <aside aria-label="Pool exploration steps" className="rounded-[var(--radius-lg)] border p-4">
        <ol className="grid grid-cols-2 gap-4 md:grid-cols-1 md:gap-6">
          {['Select a pool', 'Explore a range'].map((label, index) => (
            <li key={label} aria-current={(choice === 'range' ? 1 : 0) === index ? 'step' : undefined} className="flex items-start gap-2.5 text-[12px]">
              <span aria-hidden="true" className={cx('grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono', (choice === 'range' ? 1 : 0) === index ? 'bg-primary text-primary-fg' : 'bg-surface-3 text-fg-subtle')}>{index + 1}</span>
              <span><span className="block text-[11px] text-fg-subtle">Step {index + 1}</span>{label}</span>
            </li>
          ))}
        </ol>
      </aside>

      <Card className="min-w-0 p-4 sm:p-5">
        <h2 className="text-[16px] font-medium">Select a pair</h2>
        <p className="mt-1 text-[12px] text-fg-muted">A pool pairs two assets. Choose a token; add a second to narrow the results.</p>
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(['first', 'second'] as const).map((which) => {
            const token = which === 'first' ? first : second
            return (
              <Button key={which} type="button" variant="outline" className="min-w-0 justify-between rounded-[var(--radius)] px-4 py-3.5"
                disabled={!source || (which === 'second' && !first)}
                aria-label={which === 'first' ? 'Choose first token' : 'Choose second token (optional)'} onClick={() => openToken(which)}>
                <span className="flex min-w-0 items-center gap-2">
                  {token ? <><TokenMark token={token.token} size={22} /><span className="min-w-0 truncate"><SymbolText token={token.token} /></span></> : which === 'first' ? 'Choose first token' : 'Choose second token'}
                </span>
                <span aria-hidden="true">⌄</span>
              </Button>
            )
          })}
        </div>
        {first && (
          <details className="mt-3 text-[12px] text-fg-muted" data-pair-details="">
            <summary className="cursor-pointer">Token details</summary>
            <div className="mt-2 grid gap-2">
              {[first, second].filter((token): token is TokenCandidate => token !== null).map((token) => (
                <div key={token.key}><SymbolText token={token.token} /> · {token.kind === 'native' ? 'Native currency' : 'ERC-20 candidate'}<Address value={token.key} />{token.decimalsUnavailable && <p>{COPY.selection.decimalsUnavailable}</p>}</div>
              ))}
              <p>{COPY.picker.nativeNote}</p>
            </div>
          </details>
        )}
        {second && <Button type="button" variant="ghost" className="mt-2" onClick={() => { setSecond(null); setPool(null); setRange(null) }}>Clear second token</Button>}

        <section aria-label="Pool results" className="mt-5 border-t pt-5">
          {first && source ? (
            <PoolPicker key={`${first.key}:${second?.key ?? ''}`} source={source} token={first.key} paired={second?.key ?? null} pending={pool}
              onPending={(next) => { if (next?.key !== pool?.key) setRange(null); setPool(next) }} compact />
          ) : (
            <div className="grid min-h-[200px] content-center justify-items-center gap-2 px-4 text-center">
              <span aria-hidden="true" className="mb-1 grid h-11 w-11 place-items-center rounded-full bg-surface-3 text-xl text-primary">⇄</span>
              <h3 className="text-[14px] font-medium">Find your pair</h3>
              <p className="max-w-[38ch] text-[12px] leading-relaxed text-fg-muted">Choose a token above to find existing pools and their fee tiers.</p>
            </div>
          )}
        </section>
        <Button type="button" className="mt-5 w-full py-3" disabled={!pool} onClick={openRange}>Explore range <span aria-hidden="true">→</span></Button>
        <details className="mt-4 text-[12px] text-fg-subtle">
          <summary className="cursor-pointer">Create a new pool · coming later</summary>
          <p className="mt-2 leading-relaxed">{COPY.picker.newPool}</p>
        </details>
      </Card>

      {choice && source && (
        <PoolSelectionDialog onClose={() => setChoice(null)} title={choice === 'range' ? COPY.range.title : choice === 'first' ? COPY.picker.tokenTitle : COPY.picker.pairTitle}
          description={choice === 'range' ? COPY.range.description : choice === 'first' ? COPY.picker.tokenDescription : COPY.picker.pairDescription}
          footer={choice === 'range' ? <Button type="button" onClick={() => setChoice(null)}>Done</Button> :
            <Button type="button" disabled={!pending || !selectable(pending) || (choice === 'second' && pending.key === first?.key)} onClick={applyToken}>{TOKEN_ACTION_LABELS[choice]}</Button>}>
          {choice === 'range' && first && pool ? (
            <PoolRangeControls source={source} token={first.key} paired={second?.key ?? null} option={pool} onOption={setPool} range={range} onRange={setRange} />
          ) : (
            <TokenPicker source={source} variant={choice === 'second' ? 'pair' : 'token'} exclude={choice === 'second' ? first?.key ?? null : null}
              candidates={candidates} onCandidates={setCandidates} pending={pending} onPending={setPending} />
          )}
        </PoolSelectionDialog>
      )}
    </div>
  )
}
