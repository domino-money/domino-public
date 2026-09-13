import { useEffect, useState } from 'react'
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
export function PoolExplorer({ onSelection }: { onSelection?: (pool: PoolOption | null) => void } = {}) {
  const source = useReadSource()
  const [first, setFirst] = useState<TokenCandidate | null>(null)
  const [second, setSecond] = useState<TokenCandidate | null>(null)
  const [pool, setPool] = useState<PoolOption | null>(null)
  useEffect(() => { onSelection?.(pool) }, [pool, onSelection])
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
    <div className="dm-acct-block dm-acct-explorer" data-pool-explorer="">
      <aside aria-label="Pool exploration steps" className="dm-inset dm-acct-explorer-steps">
        <ol className="dm-acct-explorer-list">
          {['Select a pool', 'Explore a range'].map((label, index) => (
            <li key={label} aria-current={(choice === 'range' ? 1 : 0) === index ? 'step' : undefined} className="dm-acct-explorer-step">
              <span aria-hidden="true" className={cx('dm-step-marker', (choice === 'range' ? 1 : 0) === index ? 'bg-primary text-primary-fg' : 'bg-surface-3 text-fg-subtle')}>{index + 1}</span>
              <span><span className="dm-acct-explorer-kicker">Step {index + 1}</span>{label}</span>
            </li>
          ))}
        </ol>
      </aside>

      <Card className="dm-acct-explorer-card">
        <h2 className="dm-acct-panel-title">Select a pair</h2>
        <p className="dm-acct-panel-note">A pool pairs two assets. Choose a token; add a second to narrow the results.</p>
        <div className="dm-acct-explorer-pair">
          {(['first', 'second'] as const).map((which) => {
            const token = which === 'first' ? first : second
            return (
              <Button key={which} type="button" variant="outline" size="lg" className="min-w-0 justify-between"
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
          <details className="dm-details dm-acct-disclosure" data-pair-details="">
            <summary>Token details</summary>
            <div className="dm-acct-explorer-details">
              {[first, second].filter((token): token is TokenCandidate => token !== null).map((token) => (
                <div key={token.key}><SymbolText token={token.token} /> · {token.kind === 'native' ? 'Native currency' : 'ERC-20 candidate'}<Address value={token.key} />{token.decimalsUnavailable && <p>{COPY.selection.decimalsUnavailable}</p>}</div>
              ))}
              <p>{COPY.picker.nativeNote}</p>
            </div>
          </details>
        )}
        {second && <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => { setSecond(null); setPool(null); setRange(null) }}>Clear second token</Button>}

        <section aria-label="Pool results" className="dm-acct-explorer-results">
          {first && source ? (
            <PoolPicker key={`${first.key}:${second?.key ?? ''}`} source={source} token={first.key} paired={second?.key ?? null} pending={pool}
              onPending={(next) => { if (next?.key !== pool?.key) setRange(null); setPool(next) }} compact />
          ) : (
            <div className="dm-acct-explorer-empty">
              <span aria-hidden="true" className="dm-empty-tile">⇄</span>
              <h3 className="dm-acct-subtitle">Find your pair</h3>
              <p className="dm-acct-panel-note">Choose a token above to find existing pools and their fee tiers.</p>
            </div>
          )}
        </section>
        <Button type="button" size="lg" className="w-full" disabled={!pool} onClick={openRange}>Explore range <span aria-hidden="true">→</span></Button>
        <details className="dm-details dm-acct-disclosure">
          <summary>Create a new pool · coming later</summary>
          <p className="dm-acct-panel-note">{COPY.picker.newPool}</p>
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
