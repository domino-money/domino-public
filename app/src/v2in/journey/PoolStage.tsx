import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { StageToken, type PreselectStatus } from '../../components/create/StageToken'
import { IconCheck } from '../../components/icons'
import { Button, KeyValue, KeyValueList, Segmented } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { initialState as initialListState, withPool as withListPool, withToken as withListToken, type JourneyState as ListState } from '../../lib/create/journey'
import { useReadSource } from '../../lib/read/screens/readContext'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { pricesAtSqrt, typedBothWays, parsePriceText } from '../../v2/plan/initialPrice'
import { ZERO_ADDRESS, type Address, type Dex, type PoolRef, type V2ChainId } from '../../v2/types'
import { JOURNEY_POOL_CREATION_OFFERED, NEW_POOL_TITLE } from './constants'
import { useJourneyNetwork } from './context'
import { JOURNEY } from './copy'
import { journeyError, type JourneyError } from './errors'
import { dexName, feePercent, offeredPool, poolFromList, poolOf, tiersOf, type JourneyPool } from './model/pools'
import { priceInvertedOn, pricedPair } from './model/price'
import { startingPrice, type JourneyState, type StartingPriceText } from './model/state'
import { ErrorLine, PoolChips, TokenDiscPair, TokenName } from './parts'
import { cleanSymbol, labelOf, profileTokens, tokenBook, type JourneyToken } from './tokens'
import { connectJourney, inTurn } from './wallet'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const NO_LINK: PreselectStatus = { kind: 'none' }
const OTHER = 'other'
/** The page's clock when a pool was read (for its price's five minutes), outside render. */
const pageClock = (): number => Date.now()

/**
 * Step 1, Pool, on Domino's new contracts (spec F7 rev2 §2.6.1 card 1, §2.6.5, §6.2 "O que o read-v6 ainda não tem"): the
 * pool, in the journey's own look (the chosen pool's panel, the list's rows); no network choice (the owner, 2026-10-02).
 *
 *   - Robinhood Chain under a `live` gate: today's search and list (V1's read of the pool catalogue through rugged97's
 *     service, the very components of today's step 1), every pool there hookless with a fixed fee;
 *   - any network, the pool the person indicates (two tokens, the Uniswap version, the fee tier: Base's extra 0.02%,
 *     0.03% and 0.04% v3 tiers included), read through the wallet's own provider on that network, never a public RPC
 *     (decision #9); v4 pools with a hook are never offered (decision #6);
 *   - a pool with no price yet offers, apart and labeled, "Create a new pool (advanced)" (§2.6.5, decision #7): the
 *     starting price typed in either orientation, shown both ways round with the exact tick and initSqrtPriceX96.
 * No test data (the owner, 2026-10-02 night: real data only). On Robinhood Chain while its listed pools keep today's
 * steps (`finderOnly`, reached from today's pool step's "Create a new pool (advanced)"), a pool that today's journey can
 * open (a v4 pool with a price) is handed back to it (`onListed`, its own link #/new/<id>), and "Back to the pool list"
 * returns to today's step.
 */
export function PoolStage({ chainId, gate, state, finderOnly, preselect = NO_LINK, onPool, onStart, onListed }: {
  chainId: V2ChainId
  gate: Extract<V2Gate, { mode: 'preview' | 'live' }>
  state: JourneyState
  finderOnly: boolean
  /** What a pool's link came to (./linkedPool.ts), for the list's search; none without a link. */
  preselect?: PreselectStatus
  onPool: (pool: JourneyPool | null) => void
  onStart: (start: StartingPriceText | null) => void
  onListed: (poolId: string) => void
}) {
  const [changing, setChanging] = useState(false)
  const network = useJourneyNetwork()
  const chosen = state.pool && !changing ? state.pool : null
  const listed = chainId === 4663 && !finderOnly
  // QA round 2, N57 (as the owner's step, components/create/StageToken.tsx): Change pool and Keep this pool swap the panel
  // the focus was on for another, so the focus moves with them: to the search (or the finder's first choice), or back to
  // the chosen pool's button, never to the page's start. From the keyboard only for Change pool: the search opens its
  // list on focus, which a mouse click should not do over the pools it means to show.
  // Changed on purpose 2026-10-31 (QA round 2 follow-ups, N57): a click or a tap on Change pool (`keep`) puts the focus on
  // Keep this pool, the button in its place, as a search or finder not yet drawn does; it fell to the page's start when
  // the button clicked went away.
  const root = useRef<HTMLDivElement>(null)
  const focusNext = useRef<'search' | 'chosen' | 'keep' | null>(null)
  useEffect(() => {
    const next = focusNext.current
    focusNext.current = null
    const here = root.current
    if (!here || next === null) return
    const keep = here.querySelector<HTMLElement>('[data-keep-pool]')
    if (next === 'chosen') here.querySelector<HTMLElement>('[data-chosen-pool] button')?.focus()
    else if (next === 'keep') keep?.focus()
    else (here.querySelector<HTMLElement>('#create-token-search') ?? here.querySelector<HTMLElement>('[data-pool-finder] [role="radio"][tabindex="0"]') ?? keep)?.focus()
  }, [changing])
  const change = (event: MouseEvent<HTMLButtonElement>) => {
    focusNext.current = event.detail === 0 ? 'search' : 'keep'
    setChanging(true)
  }
  return (
    <div ref={root} className="dm-flow-stack" data-stage="pool" data-zap-pool-stage={chainId}>
      {network?.backToList && (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={network.backToList} data-network-back-to-list="">
            {JOURNEY.pool.backToList}
          </Button>
        </div>
      )}
      {chosen ? (
        <>
          <ChosenPool pool={chosen} onChange={change} />
          {!chosen.initialized && <StartingPrice pool={chosen} value={state.start} onChange={onStart} />}
        </>
      ) : (
        <>
          {state.pool && (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  focusNext.current = 'chosen'
                  setChanging(false)
                }}
                data-keep-pool=""
              >
                {CREATE.pool.keep}
              </Button>
            </div>
          )}
          {listed && (
            <ListedPools
              preselect={preselect}
              onPool={(pool) => {
                setChanging(false)
                onPool(pool)
              }}
            />
          )}
          <PoolFinder
            chainId={chainId}
            gate={gate}
            open={!listed}
            finderOnly={finderOnly}
            onPool={(pool) => {
              setChanging(false)
              onPool(pool)
            }}
            onListed={onListed}
          />
        </>
      )}
    </div>
  )
}

/**
 * The chosen pool, as today's step 1 draws it (components/create/StagePool.tsx ChosenPool): the pair, then its network, DEX
 * and fee. The pair as its price is written, base then quote (QA round 2, Q24: ./model/price.ts pricedPair).
 */
function ChosenPool({ pool, onChange }: { pool: JourneyPool; onChange: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const [base, quote] = pricedPair(pool.chainId, pool.pool.currency0, pool.pool.currency1, pool.tokens)
  return (
    <div className="dm-flow-panel" data-chosen-pool={pool.id} data-zap-pool={`${pool.chainId}:${pool.pool.dex}`} data-pool-source={pool.source}>
      <div className="dm-flow-pool-head">
        <span aria-hidden="true" className="dm-flow-chosen-check">
          <IconCheck size={12} />
        </span>
        <TokenDiscPair chainId={pool.chainId} first={base} second={quote} size={32} />
        <div className="dm-flow-pool-name">
          <p className="dm-flow-pool-pair">
            <TokenName token={base} /> / <TokenName token={quote} />
          </p>
          <span title={pool.readAt === null ? undefined : JOURNEY.pool.readAt(pool.block.toString())}>
            <PoolChips chainId={pool.chainId} dex={pool.pool.dex} fee={pool.pool.fee} />
          </span>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onChange}>
          {JOURNEY.pool.change}
        </Button>
      </div>
    </div>
  )
}

/**
 * Robinhood Chain under a `live` gate: today's step 1 itself (search a token, then one of its pools: V1's read of the pool
 * catalogue through rugged97's service), each pool it offers handed to the zap path as the same PoolRef (v4, hookless,
 * fixed fee). Its own small state, today's machine's: a token, then a pool.
 */
function ListedPools({ preselect, onPool }: { preselect: PreselectStatus; onPool: (pool: JourneyPool) => void }) {
  const source = useReadSource()
  const [list, setList] = useState<ListState>(initialListState)
  const [candidates, setCandidates] = useState<TokenCandidate[]>([])
  return (
    <div className="dm-flow-stack" data-zap-listed="">
      {/* Every pool of the list is Robinhood Chain's: said once, in the rows' chip style (no DEX chip there: ./parts.tsx PoolChips). */}
      <span className="flex flex-wrap items-center gap-1.5" data-pool-chips="listed">
        <span className="dm-chip shrink-0" data-chain-chip={4663}>{v2Chain(4663).name}</span>
      </span>
      <StageToken
        source={source}
        state={list}
        preselect={preselect}
        candidates={candidates}
        onCandidates={setCandidates}
        onToken={(candidate) => setList((was) => withListToken(was, candidate))}
        onPool={(option) => {
          setList((was) => withListPool(was, option, Date.now()))
          const pool = option ? poolFromList({ ...option, currencies: option.currencies, readAt: option.readAt }) : null
          if (pool) onPool(pool)
        }}
      />
    </div>
  )
}

type FinderState = { stage: 'idle' | 'reading' | 'unpriced' | 'listed'; pool: JourneyPool | null; error: JourneyError | null }

/**
 * The pool the person indicates (rev2 §6.2: read-v6 lists no pools, so Base and Arbitrum One have no list): two tokens
 * (the chain profile's ETH, WETH and stable, or another token's address), the Uniswap version and the fee tier, read at
 * once through the wallet's own provider on that network (the zap client's readPool and the tokens' own decimals() and
 * symbol(): never a guessed decimals count). A pool with a price is chosen; one without offers "Create a new pool
 * (advanced)". Collapsed under "Find a pool" beside today's list on Robinhood Chain.
 */
function PoolFinder({ chainId, gate, open, finderOnly, onPool, onListed }: {
  chainId: V2ChainId
  gate: Extract<V2Gate, { mode: 'preview' | 'live' }>
  open: boolean
  finderOnly: boolean
  onPool: (pool: JourneyPool) => void
  onListed: (poolId: string) => void
}) {
  const profile = useMemo(() => profileTokens(chainId), [chainId])
  const stable = profile.find((token) => token.address !== ZERO_ADDRESS && token.address !== v2Chain(chainId).wrappedNative.address) ?? profile[1]
  const [dex, setDex] = useState<Dex>(finderOnly ? 3 : 4)
  const [a, setA] = useState<string>(finderOnly ? profile[1].address : profile[0].address)
  const [b, setB] = useState<string>(stable.address)
  const [other, setOther] = useState('')
  const tiers = tiersOf(chainId, dex)
  const [tier, setTier] = useState<string>('3000')
  const [found, setFound] = useState<FinderState>({ stage: 'idle', pool: null, error: null })
  const book = useMemo(() => tokenBook(chainId), [chainId])
  const options = profile.filter((token) => !(dex === 3 && token.address === ZERO_ADDRESS))
  const otherAddress = ADDRESS.test(other.trim()) ? (other.trim().toLowerCase() as Address) : null
  const pick = (value: string): Address | null => (value === OTHER ? otherAddress : (value as Address))
  const chosenTier = tiers.find((t) => String(t.fee) === tier) ?? tiers.find((t) => t.fee === 3000) ?? tiers[0]
  /** The version chosen; v3 has no native ETH, so a choice of ETH moves to WETH. */
  const chooseDex = (next: Dex) => {
    setDex(next)
    if (next !== 3) return
    const weth = v2Chain(chainId).wrappedNative.address
    if (a === ZERO_ADDRESS) setA(weth)
    if (b === ZERO_ADDRESS) setB(weth)
  }

  async function read(pool: PoolRef) {
    setFound({ stage: 'reading', pool: null, error: null })
    try {
      const result = await inTurn(async () => {
        const connection = await connectJourney(chainId, gate.contracts)
        const onChain = await connection.zap.readPool(pool)
        const tokens = await connection.zap.readTokens([pool.currency0, pool.currency1])
        return { onChain, tokens }
      })
      const meta = (address: Address): JourneyToken => {
        const read = result.tokens.find((token) => token.address === address)
        const named = book.get(address)
        // The profile's own metadata wins; else the token's own decimals() (never guessed) and its symbol as untrusted text.
        if (named) return named
        return { address, decimals: read?.decimals ?? null, symbol: cleanSymbol(read?.symbol) }
      }
      const at = result.onChain
      const journeyPool: JourneyPool = {
        chainId, pool: at.pool, id: at.id, exists: at.exists, initialized: at.initialized, sqrtPriceX96: at.sqrtPriceX96, tick: at.tick,
        tokens: [meta(pool.currency0), meta(pool.currency1)], block: at.block, readAt: pageClock(), source: 'wallet',
      }
      if (!at.spacingOk || !offeredPool(at.pool)) return setFound({ stage: 'idle', pool: null, error: { copy: JOURNEY.pool.unsupported, code: 'pool_tier_not_enabled', recovery: 'none' } })
      if (journeyPool.tokens.some((token) => token.decimals === null)) return setFound({ stage: 'idle', pool: null, error: { copy: JOURNEY.pool.decimalsUnknown, code: 'token_decimals_unknown', recovery: 'none' } })
      // Robinhood Chain while its listed pools keep today's steps: a v4 pool with a price opens there, by its own link.
      if (finderOnly && at.pool.dex === 4 && at.initialized) return setFound({ stage: 'listed', pool: journeyPool, error: null })
      if (!at.initialized) return setFound({ stage: 'unpriced', pool: journeyPool, error: null })
      setFound({ stage: 'idle', pool: null, error: null })
      onPool(journeyPool)
    } catch (failure) {
      setFound({ stage: 'idle', pool: null, error: journeyError(failure, chainId, (token) => labelOf(book, token)) })
    }
  }

  const find = () => {
    const x = pick(a)
    const y = pick(b)
    if (!x || !y || !chosenTier) return
    const pool = poolOf(dex, x, y, chosenTier.fee, chosenTier.tickSpacing)
    if (!pool) return setFound({ stage: 'idle', pool: null, error: { copy: JOURNEY.pool.sameToken, code: 'pool_same_token', recovery: 'fix-fields' } })
    void read(pool)
  }

  const tokenItems = [...options.map((token) => ({ key: token.address as string, label: token.symbol ?? labelOf(book, token.address) })), { key: OTHER, label: JOURNEY.pool.otherAddress }]
  const body = (
    <div className="grid gap-3" data-pool-finder={dex}>
      <p className="text-caption text-fg-muted">{JOURNEY.pool.findLead}</p>
      {/* A pool is found by its version, so this control alone names the two: "Uniswap v4" / "Uniswap v3". Nowhere else does the version appear as text (./parts.tsx PoolChips). */}
      <Segmented label={JOURNEY.pool.version} items={[{ key: '4', label: dexName(4) }, { key: '3', label: dexName(3) }]} value={String(dex) as '3' | '4'} onChange={(next) => chooseDex(Number(next) as Dex)} />
      <Segmented label={JOURNEY.pool.tokenA} items={tokenItems} value={a} onChange={setA} />
      <Segmented label={JOURNEY.pool.tokenB} items={tokenItems} value={b} onChange={setB} />
      {(a === OTHER || b === OTHER) && (
        <div data-pool-finder-other="">
          <label htmlFor={`pool-finder-other-${chainId}`} className="dm-label">{JOURNEY.pool.otherAddress}</label>
          <input id={`pool-finder-other-${chainId}`} className="dm-field" autoComplete="off" spellCheck={false} placeholder="0x…" value={other} aria-invalid={other !== '' && !otherAddress} onChange={(event) => setOther(event.target.value)} />
          <p className="dm-hint">{JOURNEY.pool.otherAddressHint}</p>
        </div>
      )}
      <Segmented label={JOURNEY.pool.tier} items={tiers.map((t) => ({ key: String(t.fee), label: feePercent(t.fee) }))} value={String(chosenTier?.fee ?? '')} onChange={setTier} />
      <div className="flex justify-end">
        <Button type="button" variant="secondary" onClick={find} disabled={found.stage === 'reading' || !pick(a) || !pick(b)} data-pool-read="">
          {found.stage === 'reading' ? JOURNEY.pool.reading : JOURNEY.pool.read}
        </Button>
      </div>
      <ErrorLine error={found.error} />
      {found.stage === 'listed' && found.pool && (
        <div className="dm-flow-panel" data-pool-listed={found.pool.id}>
          <p className="text-body">{JOURNEY.pool.listed}</p>
          <div className="flex justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={() => found.pool && onListed(found.pool.id)} data-pool-use-listed="">
              {JOURNEY.pool.takeListed}
            </Button>
          </div>
        </div>
      )}
      {found.stage === 'unpriced' && found.pool && JOURNEY_POOL_CREATION_OFFERED && (
        <section className="dm-flow-panel" data-new-pool-offer={found.pool.id}>
          <p className="text-body font-medium">{NEW_POOL_TITLE}</p>
          <p className="text-caption text-fg-muted">{JOURNEY.newPool.lead}</p>
          <div className="flex justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={() => found.pool && onPool(found.pool)} data-new-pool-start="">
              {JOURNEY.newPool.start}
            </Button>
          </div>
        </section>
      )}
    </div>
  )
  if (open) return <section className="dm-flow-section" data-pool-find="">{body}</section>
  return (
    <details className="dm-details dm-flow-advanced" data-pool-find="">
      <summary>
        <span>{JOURNEY.pool.find}</span>
      </summary>
      <div>{body}</div>
    </details>
  )
}

/**
 * "Create a new pool (advanced)" (rev2 §2.6.5): the starting price typed in either orientation, shown both ways round,
 * with the exact tick and initSqrtPriceX96 the app computes and the price recomputed from that integer (the round trip).
 * Changed on purpose 2026-10-30 (QA round 2, Q24's review): the two choices, the price first asked for and the round trip
 * follow the pair as its price is written, base then quote (./model/price.ts pricedPair), as the chosen pool above names
 * it; startingPrice takes either base, so the price set on the pool is the same whichever way round it is typed.
 */
function StartingPrice({ pool, value, onChange }: { pool: JourneyPool; value: StartingPriceText | null; onChange: (next: StartingPriceText | null) => void }) {
  const inverted = priceInvertedOn(pool.chainId, pool.pool.currency0, pool.pool.currency1)
  const current = value ?? { base: inverted ? ('currency1' as const) : ('currency0' as const), text: '' }
  const [t0, t1] = pool.tokens
  const l0 = t0.symbol ?? labelOf(tokenBook(pool.chainId, [t0]), t0.address)
  const l1 = t1.symbol ?? labelOf(tokenBook(pool.chainId, [t1]), t1.address)
  const [base, quote] = current.base === 'currency0' ? [l0, l1] : [l1, l0]
  const price = parsePriceText(current.text)
  const exact = startingPrice(pool, current)
  const typed = price ? typedBothWays(price) : null
  const back = exact && t0.decimals !== null && t1.decimals !== null ? pricesAtSqrt(exact.sqrtPriceX96, t0.decimals, t1.decimals) : null
  return (
    <section className="dm-flow-panel" data-new-pool-price="">
      <p className="text-body font-medium">{NEW_POOL_TITLE}</p>
      <p className="text-caption text-fg-muted">{JOURNEY.newPool.lead}</p>
      <Segmented label={JOURNEY.newPool.base} items={pricedPair(pool.chainId, pool.pool.currency0, pool.pool.currency1, [{ key: 'currency0', label: l0 }, { key: 'currency1', label: l1 }] as const)} value={current.base} onChange={(next) => onChange({ ...current, base: next })} />
      <div>
        <label htmlFor={`new-pool-price-${pool.id}`} className="dm-label">{JOURNEY.newPool.price}</label>
        <div className="dm-flow-input" data-invalid={current.text !== '' && !exact ? '' : undefined}>
          <input id={`new-pool-price-${pool.id}`} className="dm-flow-input-control text-right tnum" inputMode="decimal" autoComplete="off" value={current.text} aria-invalid={current.text !== '' && !exact} onChange={(event) => onChange({ ...current, text: event.target.value })} data-new-pool-input="" />
          <span className="dm-flow-input-unit">{JOURNEY.newPool.in(base, quote)}</span>
        </div>
      </div>
      {typed && <p className="text-body" data-new-pool-both="">{JOURNEY.newPool.both(`1 ${base} = ${typed.forward} ${quote}`, `1 ${quote} = ${typed.inverse} ${base}`)}</p>}
      {current.text !== '' && !exact && <p className="dm-error">{JOURNEY.newPool.invalid}</p>}
      {exact && back && (
        <details className="dm-details" data-new-pool-details="">
          <summary>{CREATE_DETAILS}</summary>
          <KeyValueList>
            <KeyValue label={JOURNEY.newPool.roundTrip} data-new-pool-round-trip="">{JOURNEY.newPool.both(...pricedPair(pool.chainId, pool.pool.currency0, pool.pool.currency1, [`1 ${l0} = ${back.price0In1} ${l1}`, `1 ${l1} = ${back.price1In0} ${l0}`] as const))}</KeyValue>
            <KeyValue label={JOURNEY.newPool.tick} mono data-new-pool-tick="">{exact.tick}</KeyValue>
            <KeyValue label={JOURNEY.newPool.sqrt} mono data-new-pool-sqrt="">{exact.sqrtPriceX96.toString()}</KeyValue>
          </KeyValueList>
        </details>
      )}
      <p className="text-caption text-fg-muted">{JOURNEY.newPool.gas}</p>
    </section>
  )
}
const CREATE_DETAILS = 'Details'
