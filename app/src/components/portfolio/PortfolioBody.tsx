import { useEffect, useState, type FormEvent } from 'react'
import { ADDRESS_PROBLEM } from '../../lib/read/screens/copy'
import { parseAddressInput, shortAddress, type AddressKey } from '../../lib/read/screens/identity'
import { portfolioHash, portfolioRoute } from '../../lib/read/screens/positions'
import type { WalletIdentityView } from '../../lib/walletIdentity'
import { CopyButton } from '../read/screens/CopyButton'
import { Button, SearchField, Skeleton, cx } from '../ui'
import { PortfolioTokens } from './PortfolioTokens'

/** Whose tokens the card shows: an address, and where it came from. Never a claim that anyone here controls it. */
interface Subject {
  /** Exactly as it will go on the wire: as pasted, or the wallet's checksummed form. */
  wire: string
  key: AddressKey
  source: 'wallet' | 'link'
  /** The wallet's own network, when the address came from one. Reads are on Robinhood Chain regardless. */
  walletChainId: number | null
}

const PROBLEM: typeof ADDRESS_PROBLEM = { ...ADDRESS_PROBLEM, empty: 'Enter a public address.' }
/**
 * The View address form's own words (QA round 2, N100): whatever is wrong with typed text that is not an address, it says
 * so in one sentence, rather than one rule at a time ("Remove the spaces.", then "Only 0–9 and a–f…"). An empty field and
 * a pasted line break keep their own lines. A link's address keeps PROBLEM's exact rules above.
 */
const NOT_AN_ADDRESS = 'That isn’t a valid address. An address is 0x followed by 40 characters, 0–9 and a–f.'
const FORM_PROBLEM: typeof ADDRESS_PROBLEM = { ...PROBLEM, whitespace: NOT_AN_ADDRESS, prefix: NOT_AN_ADDRESS, hex: NOT_AN_ADDRESS, length: NOT_AN_ADDRESS }
/** Spaces and tabs at the ends of typed or pasted text (N100); anything inside, and any line break, is still refused. */
const trimEnds = (text: string) => text.replace(/^[ \t]+|[ \t]+$/g, '')

/**
 * Goes to another link without leaving the page. A new history entry, so Back
 * returns to the link before, and no hashchange, so the page keeps its scroll
 * position; the card follows its own state, and whoever reads the hash later
 * reads the new one.
 */
function go(hash: string) {
  if (window.location.hash !== hash) window.history.pushState(null, '', hash)
}

function AddressForm({ id, onView, className, inert }: { id: string; onView: (wire: string) => void; className?: string; inert?: boolean }) {
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const inputId = `${id}-input`
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseAddressInput(trimEnds(text))
    if (!parsed.ok) {
      setProblem(FORM_PROBLEM[parsed.reason])
      return
    }
    setProblem(null)
    onView(parsed.wire)
  }
  return (
    <form id={id} onSubmit={submit} noValidate className={cx('dm-acct-address-form', className)} inert={inert || undefined}>
      <label htmlFor={inputId} className="sr-only">
        Public address
      </label>
      {/* No hint under the field: how the address is sent, and what viewing it proves, is its title. */}
      <SearchField
        id={inputId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Public address, 0x…"
        title="Spaces at the ends are removed. Viewing an address proves nothing about who controls it."
        aria-describedby={problem ? `${id}-error` : undefined}
        aria-invalid={problem ? true : undefined}
      />
      {problem && (
        <p id={`${id}-error`} role="alert" className="dm-error">
          {problem}
        </p>
      )}
      <Button type="submit" variant="outline" size="sm" className="justify-self-start">
        View address
      </Button>
    </form>
  )
}

/**
 * The Wallet card on Positions: the public tokens an address holds on
 * Robinhood Chain, read at one block.
 *
 * Its subject is, in this order: the address in a `#/portfolio/<address>`
 * link (an unusable one shows the problem and nothing else, never the
 * wallet's holdings in its place); otherwise the connected wallet; otherwise
 * none. Tokens are read as soon as there is a subject, so a connected wallet's
 * tokens appear without a click; with none, nothing is read. On
 * `#/portfolio/<address>` this card owns the link; on `#/positions` it never
 * writes it.
 *
 * `onLinked` (2026-10-01, audit V7: View address showed the address's tokens
 * only): told the address a link views (lowercase), or null while the card
 * shows the connected wallet or nothing, so the page can list that address's
 * positions beside its tokens.
 */
export default function PortfolioBody({ identity, onLinked }: { identity: WalletIdentityView; onLinked?: (address: string | null) => void }) {
  const [route, setRoute] = useState(() => portfolioRoute(window.location.hash))
  // V4 (presentational, the approved positions-address.html .vform): the other-address form folds away over 450ms when
  // it closes, so it stays drawn (inert, `is-closing`) for that long; whether it is open is `showForm`, as before.
  const [form, setForm] = useState<'shut' | 'open' | 'folding'>('shut')
  const showForm = form === 'open'
  const setShowForm = (open: boolean) => setForm((before) => (open ? 'open' : before === 'open' ? 'folding' : before))
  useEffect(() => {
    if (form !== 'folding') return
    const timer = window.setTimeout(() => setForm((before) => (before === 'folding' ? 'shut' : before)), 450)
    return () => window.clearTimeout(timer)
  }, [form])

  useEffect(() => {
    const onChange = () => setRoute(portfolioRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    window.addEventListener('popstate', onChange)
    return () => {
      window.removeEventListener('hashchange', onChange)
      window.removeEventListener('popstate', onChange)
    }
  }, [])

  const typed = route.onRoute && route.address !== '' ? parseAddressInput(route.address) : null
  const linkProblem = typed && !typed.ok ? PROBLEM[typed.reason] : null
  const walletConnected = identity.kind === 'connected'
  const subject: Subject | null = typed
    ? typed.ok
      ? { wire: typed.wire, key: typed.key, source: 'link', walletChainId: null }
      : null
    : identity.kind === 'connected'
      ? { wire: identity.address, key: identity.address.toLowerCase() as AddressKey, source: 'wallet', walletChainId: identity.chainId }
      : null
  const linked = subject?.source === 'link' ? subject.key : null
  useEffect(() => {
    onLinked?.(linked)
  }, [linked, onLinked])

  // "View address" and "View another address" go to that address's link.
  const view = (wire: string) => {
    setShowForm(false)
    go(portfolioHash(wire))
    setRoute({ onRoute: true, address: wire })
  }
  const useWallet = () => {
    setShowForm(false)
    go('#/positions')
    setRoute({ onRoute: false })
  }

  const formId = 'portfolio-other-address'

  return (
    <section className="dm-card dm-lit dm-acct-rail dm-acct-wallet" aria-labelledby="wallet-card-title" data-portfolio-address={subject?.key}>
      <div className="dm-acct-rail-head">
        <h2 id="wallet-card-title" className="dm-title">
          Wallet
        </h2>
        {subject && (
          <span className="dm-acct-subject" title={subject.source === 'wallet' ? 'The connected wallet' : 'The address in this link'}>
            <span className="dm-acct-mono" translate="no">
              <span aria-hidden="true">{shortAddress(subject.wire)}</span>
              <span className="sr-only">{subject.wire}</span>
            </span>
            <CopyButton value={subject.wire} label="Copy address" />
          </span>
        )}
      </div>

      {!subject && !typed && identity.kind === 'unknown' ? (
        // 2026-10-01 (audit C5): while the wallet control is still finding the wallet, nothing is offered: a returning
        // visitor's wallet reconnects in a moment, and the address form flashed in its place.
        <div className="dm-acct-rail-empty" data-empty="portfolio-waiting" aria-busy="true">
          <Skeleton className="block h-4 w-48 max-w-full" />
        </div>
      ) : subject ? (
        <>
          <PortfolioTokens key={subject.key} address={subject.wire} />
          {/* V4 (look only, positions-address.html .cfoot .grp): another address's card offers the way back to the
              connected wallet first, then View another address, which is a button there (16px regular, `--link`). */}
          <div className={subject.source === 'link' ? 'dm-acct-rail-actions dm-acct-rail-actions--link' : 'dm-acct-rail-actions'}>
            {subject.source === 'link' && walletConnected && (
              <Button type="button" variant="ghost" size="sm" onClick={useWallet}>
                Use the connected wallet
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" aria-expanded={showForm} aria-controls={formId} onClick={() => setShowForm(!showForm)}>
              View another address
            </Button>
          </div>
          {form !== 'shut' && <AddressForm id={formId} className={form === 'folding' ? 'dm-acct-rail-form is-closing' : 'dm-acct-rail-form'} inert={form === 'folding'} onView={view} />}
        </>
      ) : (
        <div className="dm-acct-rail-empty" data-empty="portfolio">
          <p className="dm-acct-rail-text">Connect a wallet to see its tokens, or view any public address.</p>
          {linkProblem && (
            <p role="alert" className="dm-error" data-link-problem="">
              The address in this link can’t be used: {linkProblem}
            </p>
          )}
          <AddressForm id="portfolio-address" onView={view} />
        </div>
      )}
    </section>
  )
}
