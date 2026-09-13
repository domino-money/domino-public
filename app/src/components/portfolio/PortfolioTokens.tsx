import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { catalogueTokens } from '../../config/selectedPoolCatalogue'
import type { WalletRow } from '../../lib/read/pagers'
import type { ItemView } from '../../lib/read/project'
import { ADDRESS_PROBLEM, COPY, failureText } from '../../lib/read/screens/copy'
import { NATIVE_CURRENCY, parseAddressInput } from '../../lib/read/screens/identity'
import { useReadSource } from '../../lib/read/screens/readContext'
import { WALLET_PAGE_CAP, createWalletSession, type WalletSession, type WalletSnapshot } from '../../lib/read/screens/walletSession'
import type { TokenDisplay } from '../../lib/read/types'
import { exploreHref } from '../explore/routes'
import { ScreenStatus } from '../read/screens/ScreenStatus'
import { TokenLabel } from '../read/TokenLabel'
import { TokenMark } from '../TokenIcon'
import { Button, Skeleton, cx } from '../ui'

type Step = 'first' | 'more' | 'restart'

const addressOf = (token: TokenDisplay) => (token.origin === 'read' ? token.address : '')

/** The pager's own closing sentence; the card says the same thing with the block number in it. */
const PAGER_FOOTNOTE = 'Balances at the snapshot block. Not proof of wallet control.'

/** The snapshot block, as the pager's freshness lines name it ("Block 123"), or null before a page arrives. */
const blockOf = (lines: readonly string[]) => lines.find((line) => /^Block \d+$/.test(line))?.slice('Block '.length) ?? null

/** A long balance may wrap, but only after a group separator or the decimal point, never inside a digit group. */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[,.])/)
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </span>
      ))}
    </>
  )
}

/**
 * A token's name, linked to its view on Markets by its address, never by its
 * symbol. The native currency has no token view, so it is plain text.
 */
function TokenName({ token }: { token: TokenDisplay }) {
  const address = addressOf(token)
  if (address === '' || address === NATIVE_CURRENCY) {
    return (
      <span className="dm-acct-token-name">
        <TokenLabel token={token} />
      </span>
    )
  }
  return (
    <a href={exploreHref(address)} className="dm-acct-token-name dm-acct-token-link" title="Pools for this token on Markets">
      <TokenLabel token={token} />
    </a>
  )
}

function TokenRow({ row }: { row: WalletRow }) {
  const amount = row.amount
  return (
    <li className="dm-acct-token" data-wallet-row={addressOf(row.token)}>
      <TokenMark token={row.token} size={24} ring="var(--surface-2)" />
      <span className="dm-acct-token-id">
        <TokenName token={row.token} />
        {row.old && <span className="dm-acct-token-old">{COPY.picker.fromEarlier}</span>}
      </span>
      <span className={cx('dm-acct-token-amount tnum', amount.state === 'unavailable' && 'is-unavailable')} data-balance={amount.state} title={`Page ${row.page} of the list`}>
        <Breakable text={amount.text} />
      </span>
    </li>
  )
}

/** An asset the page names whose balance could not be read: listed, so the list never looks complete when it is not. */
function UnavailableRow({ item }: { item: ItemView }) {
  const token = item.title.tokens?.[0]
  if (!token) return null
  return (
    <li className="dm-acct-token" data-wallet-row={addressOf(token)} data-wallet-unavailable="">
      <TokenMark token={token} size={24} ring="var(--surface-2)" />
      <span className="dm-acct-token-id">
        <TokenName token={token} />
        {item.old && <span className="dm-acct-token-old">{COPY.picker.fromEarlier}</span>}
      </span>
      <span className="dm-acct-token-amount is-unavailable" data-balance="unavailable">
        {item.facts[0]?.text ?? 'Unavailable'}
      </span>
    </li>
  )
}

/** Up to 10 token addresses to check balances for, when the server lists nothing by itself. */
function TokensForm({ onCheck }: { onCheck: (tokens: string[]) => void }) {
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parts = text.split(/[\s,]+/).filter((part) => part !== '')
    if (parts.length === 0) {
      setProblem('Enter at least one token address.')
      return
    }
    if (parts.length > 10) {
      setProblem('Up to 10 token addresses.')
      return
    }
    for (const part of parts) {
      const parsed = parseAddressInput(part)
      if (!parsed.ok) {
        setProblem(`Token addresses: ${ADDRESS_PROBLEM[parsed.reason]}`)
        return
      }
    }
    setProblem(null)
    onCheck(parts)
  }
  return (
    <details className="dm-details dm-acct-tokens-more">
      <summary>{COPY.picker.walletTokensLabel}</summary>
      <form onSubmit={submit} noValidate className="dm-acct-tokens-form" data-wallet-tokens-form="">
        <label htmlFor="portfolio-tokens" className="sr-only">
          {COPY.picker.walletTokensLabel}
        </label>
        <textarea
          id="portfolio-tokens"
          rows={2}
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={problem ? 'portfolio-tokens-hint portfolio-tokens-error' : 'portfolio-tokens-hint'}
          aria-invalid={problem ? true : undefined}
          className="dm-field dm-acct-mono-field"
        />
        <p id="portfolio-tokens-hint" className="dm-hint">
          {COPY.picker.walletTokensHint}
        </p>
        {problem && (
          <p id="portfolio-tokens-error" role="alert" className="dm-error">
            {problem}
          </p>
        )}
        <Button type="submit" variant="outline" size="sm" className="justify-self-start">
          Check balances
        </Button>
      </form>
    </details>
  )
}

/**
 * The ERC-20 assets a public address holds, through the wallet session: one
 * session per address and token list, read as soon as there is an address,
 * paged by hand up to the cap, and cancelled when the address changes or
 * the page is left. Balances are the session's own words: display units
 * when the token's decimals were read, the raw integer labelled raw when
 * not, never a guess. The continuation handle never leaves the pager.
 */
export function PortfolioTokens({ address }: { address: string }) {
  const source = useReadSource()
  const [tokens, setTokens] = useState<string[]>([])
  const [snap, setSnap] = useState<WalletSnapshot | null>(null)
  // The first page is asked for as soon as the source is there, so the list starts out loading.
  const [loading, setLoading] = useState(true)
  const [lastStep, setLastStep] = useState<Step>('first')
  const session = useRef<WalletSession | null>(null)
  const running = useRef<AbortController | null>(null)
  const generation = useRef(0)

  /** One step of the session, on its own signal; a result lands only if nothing newer was asked for meanwhile. */
  const read = useCallback((current: WalletSession, step: Step, settled?: (after: WalletSnapshot) => void) => {
    const gen = generation.current
    running.current?.abort()
    const mine = new AbortController()
    running.current = mine
    const call = step === 'first' ? current.first(mine.signal) : step === 'more' ? current.more(mine.signal) : current.restart(mine.signal)
    void call.then((after) => {
      if (gen !== generation.current || mine.signal.aborted) return
      if (running.current === mine) running.current = null
      setLoading(false)
      setSnap(after)
      settled?.(after)
    })
    return mine
  }, [])

  // The address whose empty listing was already followed by the verified-token check, so it happens once per address.
  const autoChecked = useRef<string | null>(null)

  // A new session for each address and token list, read at once; leaving, or asking for another list, cancels what is in flight.
  // When the service lists nothing by itself, the balances of the tokens the
  // selected pools hold are asked for once, by their exact addresses, so a
  // wallet that holds USDG or WETH sees them without pasting an address.
  useEffect(() => {
    if (!source) return
    generation.current += 1
    const current = createWalletSession(source, { wallet: address, tokens })
    session.current = current
    const mine = read(current, 'first', (after) => {
      if (!after.emptyHint || tokens.length > 0 || autoChecked.current === address) return
      autoChecked.current = address
      setSnap(null)
      setLoading(true)
      setLastStep('first')
      setTokens(catalogueTokens().map((token) => token.address))
    })
    return () => {
      mine.abort()
      if (running.current === mine) running.current = null
    }
  }, [source, address, tokens, read])

  const run = (step: Step) => {
    const current = session.current
    if (!current) return
    setLoading(true)
    setLastStep(step)
    read(current, step)
  }

  const check = (next: string[]) => {
    setSnap(null)
    setLoading(true)
    setLastStep('first')
    setTokens(next)
  }

  const more = () => {
    if (loading || !snap) return
    if (!snap.canLoadMore && snap.status !== 'handle_expired') return
    run('more')
  }

  const view = snap?.view
  const rows = view?.rows ?? []
  const unavailable = view?.unavailable ?? []
  const listed = rows.length + unavailable.length
  const canAskMore = Boolean(snap && (snap.canLoadMore || snap.status === 'handle_expired'))
  const moreLabel = loading ? 'Loading…' : canAskMore ? COPY.picker.loadMore : COPY.picker.allLoaded
  const failure = snap?.failure && snap.status !== 'restart_exhausted' ? failureText(snap.failure, 'wallet') : null
  const block = view ? blockOf(view.freshness) : null
  const provenance = view?.freshness.filter((line) => !/^Block \d+$/.test(line)) ?? []
  const notes = view?.notes.filter((note) => note !== PAGER_FOOTNOTE) ?? []

  return (
    <div className="dm-acct-tokens" data-portfolio-tokens="" data-wallet-pages={view?.pages ?? 0}>
      <p className="dm-acct-tokens-count" aria-live="polite">
        {view && view.pages > 0 ? (
          <>
            <span className="tnum">{rows.length}</span> token{rows.length === 1 ? '' : 's'} listed
            {unavailable.length > 0 && (
              <>
                , <span className="tnum">{unavailable.length}</span> unavailable
              </>
            )}
            {' · '}page <span className="tnum">{view.pages}</span> of up to <span className="tnum">{WALLET_PAGE_CAP}</span>
          </>
        ) : loading ? (
          'Reading the token list…'
        ) : (
          ''
        )}
      </p>

      {(listed > 0 || loading) && (
        <ul className="dm-acct-token-list" aria-label="Tokens held by this address">
          {rows.map((row) => (
            <TokenRow key={row.key} row={row} />
          ))}
          {unavailable.map((item) => (
            <UnavailableRow key={item.key} item={item} />
          ))}
          {loading &&
            [0, 1, 2].map((n) => (
              <li key={`wait-${n}`} className="dm-acct-token" aria-hidden="true">
                <Skeleton className="size-6 shrink-0 rounded-full" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="ml-auto h-3 w-12" />
              </li>
            ))}
        </ul>
      )}

      {!loading && snap && listed === 0 && !snap.failure && (
        <p className="dm-acct-tokens-empty">
          {snap.emptyHint && tokens.length === 0 ? COPY.picker.walletEmpty : block ? `No listed tokens at block ${block}.` : 'No listed tokens at this block.'}
        </p>
      )}

      {failure && <ScreenStatus line={failure} busy={loading} onRetry={() => run(lastStep)} />}
      {snap?.restarted && <p className="dm-acct-tokens-wait">{COPY.picker.walletRestarted}</p>}
      {snap?.status === 'restart_exhausted' && (
        <div className="dm-acct-tokens-restart">
          <p className="dm-acct-tokens-wait">{COPY.picker.walletExhausted}</p>
          <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => run('restart')}>
            {COPY.picker.restartList}
          </Button>
        </div>
      )}
      {snap?.status === 'handle_expired' && <p className="dm-acct-tokens-note">{COPY.picker.walletExpired}</p>}
      {snap?.capped && (
        <p className="dm-acct-tokens-note" data-wallet-capped="">
          {COPY.picker.walletCapped}
        </p>
      )}

      {view && view.pages > 0 && (canAskMore || loading) && (
        <Button type="button" variant="ghost" size="sm" className="justify-self-start" aria-disabled={loading || !canAskMore ? true : undefined} onClick={more}>
          {moreLabel}
        </Button>
      )}

      {view && view.pages > 0 && (
        <div className="dm-acct-tokens-foot">
          <p>{block ? `Balances at block ${block}. Public data, not proof of wallet control.` : 'Balances at the snapshot block. Public data, not proof of wallet control.'}</p>
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          {provenance.length > 0 && <p>{provenance.join(' · ')}</p>}
        </div>
      )}

      {snap && !snap.emptyHint && tokens.length > 0 && !loading && (
        <p className="dm-acct-tokens-note" data-wallet-verified-checked="">
          Balances checked for the verified pool tokens by their exact addresses. Any other token can be checked below.
        </p>
      )}
      {snap && !loading && (snap.emptyHint || tokens.length > 0) && <TokensForm onCheck={check} />}
    </div>
  )
}
