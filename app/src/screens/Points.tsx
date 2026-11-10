// The screens' shared stylesheet (styles/screens.css, F8), then the page's own (styles/v4-points.css), which comes in
// this screen's chunk alone.
import '../styles/screens.css'
import '../styles/v4-points.css'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Chip, Display, LinkButton, PageShell } from '../components/ui'
import { IconCheck, IconCopy } from '../components/icons'
import { newPositionHref } from '../components/explore/routes'
import { linkReferrer, pointsService, pointsSession, readPoints, subscribePointsSession, type LinkEnd, type PointsResponse, type PointsService, type PointsSession } from '../finance/points'
import { openWalletDialog, signInWithWallet } from '../finance/signedOut'
import { useRouteTitle } from '../lib/routeTitle'
import { useWalletIdentity } from '../lib/walletIdentity'
import type { RefStore } from '../points/capture'
import { clearRef, storedRef } from '../points/ref'
import { isZero, pointsText, shortAddress, shortHash, usdText, usdToPoints, utcClock } from '../points/format'
import { referralUrl, shownLink } from '../points/link'
import * as motion from '../points/motion'
import { seasonDay, seasonPhase } from '../points/season'
import { Tile } from '../points/Tile'
import { POINTS_WORDS as W, problemOf, type FeeKind, type PointsProblem } from '../points/words'

/**
 * Points (added 2026-11-07, the owner's Points page, Season 1, Stage 1: integ-logs/points/PROPOSAL.md, his decisions
 * D1-D5, and the design he chose, direction C "Corrente"). The page is the wallet's line of play: the referrer's tile,
 * the wallet's own double laid across, and the wallets it referred, joined end to end; under it the total, the link to
 * share, what earned the points, and Season 1's rules.
 *
 * It works with no points service at all. Season 1's dates and rules are the app's own (points/season.ts, points/words.ts);
 * the wallet's link needs only the connected wallet; a referral link's `?ref=` is kept by the entry (points/capture.ts).
 * The numbers and the referrer come from points-v1 (finance/points.ts), asked only once its capabilities say "live" and
 * only for the signed-in wallet. Linking a referrer signs one message, only on the Link referrer click, and only while
 * the service is live; otherwise the card says calmly that linking opens when points are counted.
 *
 * Motion (added 2026-11-08: PROPOSAL.md §11, the owner's animated prototype of 7 Nov; points/motion.ts): the line
 * settles once per browser session, when the page first knows what to show (held hidden until then, `data-entrance`);
 * later visits are silent. Each moment after it (linking a referrer, Copy link, a wallet that joined since the last
 * visit, the slot's breath, the season's shimmer) is called from here, as the state it leads into is drawn. What leaves
 * is kept in its place, hidden, so nothing around it moves.
 */

/** The page's clock: the browser's, or a test's fixed one in the builds that carry the test hooks. */
function nowMs(): number {
  if (__DOMINO_TEST_HOOKS__ && typeof window !== 'undefined') {
    const fixed = (window as { __dominoPointsNow?: unknown }).__dominoPointsNow
    if (typeof fixed === 'number' && Number.isFinite(fixed)) return fixed
  }
  return Date.now()
}

/** Re-read every minute, so the page turns from "starts 9 Nov" to the season on time. */
function useNow(): number {
  const [now, setNow] = useState(nowMs)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(nowMs()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

function browserStore(): RefStore | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Not now (decision D5): the card stays hidden until the next visit, and the stored link stays. */
let laterThisVisit = false
/** A referrer linked from this page, by wallet, until a points answer names it (the service counts it within the hour). */
const linkedThisVisit = new Map<string, string>()

const ENTRANCE_KEY = 'domino.points.seen'
/** The line settles once per browser session (the prototype's frequency rule). */
function firstVisit(): boolean {
  try {
    return window.sessionStorage.getItem(ENTRANCE_KEY) === null
  } catch {
    return false
  }
}
function markVisited(): void {
  try {
    window.sessionStorage.setItem(ENTRANCE_KEY, '1')
  } catch {
    // Nothing kept: the line settles again next time.
  }
}
/** How long the first visit's page waits, hidden, for what it will show; past it, it is drawn at once, with no entrance. */
const HOLD_MS = 1_500

/** How many wallets this browser last saw join this wallet's line, by wallet: a wallet that joined since then arrives. */
const LINE_KEY = 'domino.points.line'
function seenLine(): Record<string, unknown> {
  try {
    const kept: unknown = JSON.parse(window.localStorage.getItem(LINE_KEY) ?? '{}')
    return kept !== null && typeof kept === 'object' ? (kept as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
function seenReferees(wallet: string): number | null {
  const count = seenLine()[wallet]
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null
}
function keepReferees(wallet: string, count: number): void {
  try {
    window.localStorage.setItem(LINE_KEY, JSON.stringify({ ...seenLine(), [wallet]: count }))
  } catch {
    // Nothing kept: the next visit draws the line as it is.
  }
}

type Data =
  | { state: 'idle' }
  | { state: 'loading'; key: string }
  | { state: 'ok'; key: string; answer: PointsResponse }
  | { state: 'problem'; key: string; problem: PointsProblem }

type Linked = { state: 'recorded' | 'existing'; referrer: string; from: string }
type LinkState =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'declined' }
  | { state: 'problem'; text: string }
  | Linked

/** What the big line under the tiles says. */
type Lead =
  | { kind: 'wait' }
  | { kind: 'before' }
  | { kind: 'connect' }
  | { kind: 'sign_in'; ended: boolean }
  | { kind: 'off' }
  | { kind: 'problem'; text: string; again: () => void }
  | { kind: 'started' }
  | { kind: 'total'; answer: PointsResponse }

/** A wallet that joined since the last visit: the line is measured as it was (`before`), then drawn as it is (`after`). */
type Join = { key: string; from: number; phase: 'before' | 'after' }

const KINDS: readonly FeeKind[] = ['assistedSwap', 'automation', 'autoExit', 'bridge']
/** The referred wallets' tiles: each meets the one before it (the line of play); three places, a fourth tile at most. */
const REFEREE_PIPS = [[5, 1], [1, 4], [4, 2], [2, 6]] as const
const PLACES = 3

/** An address at a glance, whole in its title. */
function Mono({ address }: { address: string }) {
  return (
    <span className="pt-mono" title={address} translate="no">
      {shortAddress(address)}
    </span>
  )
}

export default function Points() {
  useRouteTitle(W.tab)
  const now = useNow()
  const phase = seasonPhase(now)
  const identity = useWalletIdentity()
  const wallet = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const session = useSyncExternalStore(subscribePointsSession, pointsSession, (): PointsSession => ({ kind: 'pending' }))
  const signedIn = session.kind === 'signed_in' && session.owner === wallet ? session : null
  const stage = useRef<HTMLElement>(null)
  const page = () => stage.current?.closest('main') ?? null

  // ---- Whether the points service answers (no session needed). Each ask is numbered; an answer counts for its own ask.
  const [serviceAsk, setServiceAsk] = useState(0)
  const [heard, setHeard] = useState<{ ask: number; answer: PointsService } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void pointsService(controller.signal).then((answer) => {
      if (answer !== 'aborted') setHeard({ ask: serviceAsk, answer })
    })
    return () => controller.abort()
  }, [serviceAsk])
  const service: PointsService | 'checking' = heard !== null && heard.ask === serviceAsk ? heard.answer : 'checking'

  // ---- The signed-in wallet's points, once the service is live; an answer counts for the key it was asked under.
  const [data, setData] = useState<Data>({ state: 'idle' })
  const [dataAsk, setDataAsk] = useState(0)
  const [ended, setEnded] = useState(false)
  const dataKey = signedIn && service === 'live' ? `${signedIn.epoch}|${signedIn.owner}|${dataAsk}` : null
  useEffect(() => {
    if (!dataKey || !signedIn) return
    const controller = new AbortController()
    void readPoints(signedIn.epoch, controller.signal).then((end) => {
      if (end.kind === 'aborted' || controller.signal.aborted) return
      if (end.kind === 'ok' && end.value.wallet.address.toLowerCase() !== signedIn.owner) return setData({ state: 'problem', key: dataKey, problem: problemOf('contract') })
      if (end.kind === 'ok') {
        setEnded(false)
        return setData({ state: 'ok', key: dataKey, answer: end.value })
      }
      const said = problemOf(end.code)
      if (said.kind === 'session') setEnded(true)
      setData({ state: 'problem', key: dataKey, problem: said })
    })
    return () => controller.abort()
  }, [dataKey, signedIn])
  const answer = data.state === 'ok' && data.key === dataKey ? data.answer : null
  const problem = data.state === 'problem' && data.key === dataKey ? data.problem : null

  // ---- The referral link this browser opened (the first one: points/capture.ts), and linking it (for one wallet).
  const [ref, setRef] = useState<string | null>(() => storedRef(browserStore()))
  const [later, setLater] = useState(laterThisVisit)
  const [linkFor, setLinkFor] = useState<{ wallet: string; link: LinkState } | null>(null)
  const link: LinkState = linkFor !== null && linkFor.wallet === wallet ? linkFor.link : { state: 'idle' }
  const invitedBy = ref !== null && ref !== wallet ? ref : null
  // What a screen reader hears when the referrer is linked (the card changes under the button that was pressed).
  const [said, setSaid] = useState('')
  // The wallet's own link is never a referral (PROPOSAL.md §6 step 1): forgotten once that wallet is seen connected, so
  // the next link opened here is the one kept (points/capture.ts stores the first).
  useEffect(() => {
    if (wallet !== null && ref === wallet) clearRef(browserStore())
  }, [wallet, ref])
  const referrer = answer?.wallet.referrer ?? (wallet ? linkedThisVisit.get(wallet) ?? null : null)

  const onLink = useCallback(async () => {
    if (!signedIn || !answer || !invitedBy) return
    const owner = signedIn.owner
    const set = (next: LinkState) => setLinkFor({ wallet: owner, link: next })
    set({ state: 'busy' })
    const end: LinkEnd = await linkReferrer({ epoch: signedIn.epoch, owner, season: answer.season.id, referrer: invitedBy })
    if (end.kind === 'aborted') return set({ state: 'idle' })
    if (end.kind === 'declined') return set({ state: 'declined' })
    if (end.kind === 'ok') {
      // Recorded or already there, the stored link has done its work (rugged97's spec, step 6).
      clearRef(browserStore())
      setRef(null)
      linkedThisVisit.set(owner, end.value.referrer.toLowerCase())
      setSaid(end.value.status === 'recorded' ? `${W.linkedTitle}.` : `${W.existingIs} ${shortAddress(end.value.referrer)}.`)
      return set({ state: end.value.status, referrer: end.value.referrer.toLowerCase(), from: invitedBy })
    }
    const said = problemOf(end.code)
    if (said.kind === 'session') setEnded(true)
    set({ state: 'problem', text: said.text })
  }, [signedIn, answer, invitedBy])
  const onLater = (card: Element | null) =>
    motion.later(card, () => {
      laterThisVisit = true
      setLater(true)
    })

  // ---- What the page shows.
  let lead: Lead
  if (phase === 'before') lead = { kind: 'before' }
  else if (identity.kind === 'unknown' || session.kind === 'pending') lead = { kind: 'wait' }
  else if (!wallet) lead = { kind: 'connect' }
  else if (!signedIn) lead = { kind: 'sign_in', ended }
  else if (service === 'checking') lead = { kind: 'wait' }
  else if (service === 'off') lead = { kind: 'off' }
  else if (service === 'unavailable') lead = { kind: 'problem', text: W.unavailable, again: () => setServiceAsk((n) => n + 1) }
  else if (problem?.kind === 'session') lead = { kind: 'sign_in', ended: true }
  else if (problem) lead = { kind: 'problem', text: problem.text, again: () => setDataAsk((n) => n + 1) }
  else if (!answer) lead = { kind: 'wait' }
  else if (answer.snapshot === null) lead = { kind: 'started' }
  else lead = { kind: 'total', answer }

  const total = lead.kind === 'total' ? lead.answer : null
  const settled = lead.kind !== 'wait' && service !== 'checking'

  // ---- The entrance: once per session, held hidden until the page first knows what to show (at most HOLD_MS).
  const [entrance, setEntrance] = useState<'hold' | 'play' | 'off'>(() => (firstVisit() ? 'hold' : 'off'))
  if (entrance === 'hold' && settled) setEntrance('play')
  useEffect(() => {
    if (entrance !== 'hold') return
    const timer = window.setTimeout(() => setEntrance('off'), HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [entrance])
  const playedAt = useRef<number | null>(null)
  useLayoutEffect(() => {
    const root = page()
    if (entrance !== 'play' || playedAt.current !== null || !root) return
    playedAt.current = performance.now()
    markVisited()
    motion.entrance(root)
  }, [entrance])
  /** A loop's first delay: `rest` after it is drawn, and never before the entrance is over. */
  const after = (rest: number) => Math.max(rest, playedAt.current === null ? 0 : motion.ENTRANCE_MS - (performance.now() - playedAt.current))

  // ---- A wallet referred joined since the last visit (not on the entrance, which brings every tile in anyway).
  const [join, setJoin] = useState<Join | null>(null)
  const [lineChecked, setLineChecked] = useState<string | null>(null)
  if (total && wallet && dataKey && lineChecked !== dataKey && entrance !== 'hold') {
    setLineChecked(dataKey)
    const seen = seenReferees(wallet)
    if (entrance === 'off' && seen !== null && total.wallet.referees > seen) setJoin({ key: dataKey, from: seen, phase: 'before' })
  }
  const joining = join !== null && join.key === dataKey && total ? join : null
  const joinPhase = joining?.phase ?? null
  const joinFrom = joining?.from ?? 0
  const placesBefore = useRef<motion.Places | null>(null)
  useLayoutEffect(() => {
    const root = page()
    if (joinPhase === null || !root) return
    if (joinPhase === 'before') {
      // The line drawn as last seen is measured (the FLIP's first frame), then drawn as it is on the next frame.
      placesBefore.current = motion.places(root)
      const frame = window.requestAnimationFrame(() => setJoin((now) => (now?.phase === 'before' ? { ...now, phase: 'after' } : now)))
      return () => window.cancelAnimationFrame(frame)
    }
    if (placesBefore.current) motion.joined(root, placesBefore.current, Math.min(joinFrom, REFEREE_PIPS.length))
    placesBefore.current = null
  }, [joinPhase, joinFrom])
  const referees = total ? total.wallet.referees : null
  useEffect(() => {
    if (wallet && referees !== null && lineChecked === dataKey && joining?.phase !== 'before') keepReferees(wallet, referees)
  }, [wallet, referees, lineChecked, dataKey, joining?.phase])

  // ---- The referral card: shown while a stored link names someone else and this wallet has no referrer yet.
  const linked = link.state === 'recorded' || link.state === 'existing' ? link : null
  // Signed out with the service live, the link waits for the sign-in: one line over the sign-in's own (PROPOSAL.md §3 c'),
  // so the page keeps one way to sign in.
  // Once linked, the card stays the one that asked (its answer in the ask's place: ReferralCard `done`).
  let ask: { who: string; note: string; button: boolean } | null = null
  let invitedLine: string | null = null
  let asks = false
  if (linked) ask = { who: linked.from, note: W.linkNote, button: true }
  else if (invitedBy && !later && !referrer && settled) {
    if (service !== 'live') ask = { who: invitedBy, note: W.linkWhenCounted, button: false }
    else if (lead.kind === 'connect' || lead.kind === 'sign_in') invitedLine = invitedBy
    else if (answer && answer.wallet.referrer === null) {
      asks = link.state !== 'busy'
      ask = { who: invitedBy, note: W.linkNote, button: true }
    }
  }
  const card: ReactNode = ask && <ReferralCard who={ask.who} note={ask.note} link={link} onLink={ask.button ? () => void onLink() : undefined} onLater={onLater} done={linked} />

  // ---- The link's moments: the slot breathes while it asks; the wallet asked; its answer.
  const breathFrom = useRef(400)
  useEffect(() => {
    const root = page()
    if (!asks || !root) return
    const breath = motion.breathe(root, after(breathFrom.current))
    return () => motion.stopBreath(root, breath)
  }, [asks])
  const busy = link.state === 'busy'
  useLayoutEffect(() => {
    if (!busy) return
    const pips = motion.asking(page())
    return () => motion.stop(pips)
  }, [busy])
  const lastLink = useRef(link.state)
  useLayoutEffect(() => {
    const was = lastLink.current
    lastLink.current = link.state
    if (was === link.state) return
    if (link.state === 'recorded' || link.state === 'existing') motion.linked(page())
    else if (was === 'busy') {
      motion.reset(page())
      breathFrom.current = 300
    }
  }, [link.state])

  // ---- Before 9 Nov, a slow light crosses "Counting starts 9 Nov" (after the entrance, if there is one).
  const before = lead.kind === 'before'
  useEffect(() => {
    if (!before || entrance === 'hold') return
    const light = motion.shimmer(page(), after(500))
    return () => motion.stop(light)
  }, [before, entrance])

  return (
    <PageShell className="dm-points-page" data-points-lead={lead.kind} data-points-service={service} data-entrance={entrance === 'off' ? undefined : entrance}>
      <div className="pt-title">
        <Display as="h1" className="dm-display-h1">
          {W.title}
        </Display>
        {wallet && (
          <Chip variant="plate" className="pt-chip" title={W.chip} data-connected-wallet="">
            <span className="pt-mono" title={wallet} translate="no">
              {shortAddress(wallet)}
            </span>
          </Chip>
        )}
      </div>

      <section ref={stage} className="pt-stage" aria-label={W.lineLabel} data-points-stage="">
        <Line lead={lead} referrer={referrer} invitedBy={invitedBy} wallet={wallet} arrived={linked?.from ?? null} shown={joining?.phase === 'before' ? joining.from : null} joinedFrom={joining?.phase === 'after' ? joining.from : null} />
        <LeadBlock lead={lead} wallet={wallet} invitedBy={invitedLine} />
      </section>

      {card}

      {wallet && <ShareLink wallet={wallet} />}

      <Lower total={total} now={now} />

      <p className="sr-only" aria-live="polite" data-points-said="">
        {said}
      </p>
    </PageShell>
  )
}

/** One caption of the line: what it is, and the figure or address under it. `left`: the words it had, leaving. */
function Caption({ cap, sub, num = false, left = false }: { cap: ReactNode; sub: ReactNode; num?: boolean; left?: boolean }) {
  return (
    <span className={left ? 'pt-capl pt-left' : 'pt-capl'} aria-hidden={left || undefined}>
      <span className="pt-cap">{cap}</span>
      {sub !== null && <span className={num ? 'pt-sub pt-num' : 'pt-sub'}>{sub}</span>}
    </span>
  )
}

/** Before the season: the words a slow light crosses (the copy over them is decoration; its text is the CSS's). */
function Shimmer({ text }: { text: string }) {
  return (
    <span className="pt-shimmer">
      {text}
      <span className="pt-hl" aria-hidden="true">
        <span data-text={text} />
      </span>
    </span>
  )
}

/**
 * The line of play: the referrer, you laid across, the wallets you referred; each with its caption under it.
 * `arrived`: the wallet a referrer was just linked from (its place and its words leave). `shown`: the wallets referred
 * as last seen (the line measured before one joins); `joinedFrom`: how many there were, while those since arrive.
 */
function Line({ lead, referrer, invitedBy, wallet, arrived, shown, joinedFrom }: { lead: Lead; referrer: string | null; invitedBy: string | null; wallet: string | null; arrived: string | null; shown: number | null; joinedFrom: number | null }) {
  const total = lead.kind === 'total' ? lead.answer.wallet : null
  const count = shown ?? (total ? total.referees : 0)
  const solids = Math.min(count, REFEREE_PIPS.length)
  const places = Math.max(PLACES, solids)
  const prev = referrer
    ? { cap: W.yourReferrer, sub: <Mono address={referrer} />, solid: true }
    : invitedBy
      ? { cap: <><Mono address={invitedBy} /> {W.invited}</>, sub: W.notLinked, solid: false }
      : { cap: W.yourReferrer, sub: W.referrerToCome, solid: false }
  const youSub = total ? W.fromUse(pointsText(total.usagePoints)) : lead.kind === 'before' ? <Shimmer text={W.countingStarts} /> : wallet ? <Mono address={wallet} /> : null
  const joinedCaption = (n: number) => (total && n > 0 ? { cap: W.joined(n), sub: W.referralPoints(pointsText(total.referralPoints)) } : { cap: W.joinHere, sub: W.joinShare })
  const next = joinedCaption(count)
  return (
    <div className="pt-chain" data-referees={total ? total.referees : 0} data-run={places}>
      <figure className="pt-node pt-prev" data-node="prev" data-solid={prev.solid ? '' : undefined}>
        <span className="pt-slot">
          {(!prev.solid || arrived !== null) && <Tile key="ghost" a={3} b={5} flat size="var(--cs)" kind="ghost" className={prev.solid ? 'dashed pt-left' : 'dashed'} />}
          {prev.solid && <Tile key="solid" a={3} b={5} flat size="var(--cs)" turn="rotateY(14deg)" />}
        </span>
        <figcaption>
          <span className="pt-swap">
            {arrived !== null && prev.solid && <Caption key="was" cap={<><Mono address={arrived} /> {W.invited}</>} sub={W.notLinked} left />}
            <Caption key="now" cap={prev.cap} sub={prev.sub} />
          </span>
        </figcaption>
      </figure>
      <figure className="pt-node pt-you" data-node="you">
        <Tile a={5} b={5} size="var(--ys)" turn="rotateX(6deg) rotateY(-12deg)" set={total && !isZero(total.points) ? 99 : 0} />
        <figcaption>
          <span className="pt-swap">
            <Caption cap={W.you} sub={youSub} />
          </span>
        </figcaption>
      </figure>
      <figure className="pt-node pt-next" data-node="next">
        <span className="pt-run">
          {Array.from({ length: places }, (_, index) => {
            const [a, b] = REFEREE_PIPS[index] ?? REFEREE_PIPS[0]
            const style = { '--i': index } as React.CSSProperties
            // A place that waited for a wallet that has joined since the last visit: it leaves as its tile arrives.
            const waited = joinedFrom !== null && index >= joinedFrom && index < PLACES
            return (
              <span key={index} className="pt-slot">
                {(index >= solids || waited) && <Tile key="ghost" a={a} b={b} flat size="var(--cs)" kind="ghost" className={index < solids ? 'future pt-left' : 'future'} style={style} />}
                {index < solids && <Tile key="solid" a={a} b={b} flat size="var(--cs)" turn={`rotateY(${-10 - index * 4}deg)`} style={style} />}
              </span>
            )
          })}
        </span>
        <figcaption>
          <span className="pt-swap">
            {joinedFrom !== null && <Caption key="was" {...joinedCaption(joinedFrom)} num left />}
            <Caption key="now" cap={next.cap} sub={next.sub} num />
          </span>
        </figcaption>
      </figure>
      <span className="pt-joints" aria-hidden="true" />
    </div>
  )
}

/** The total, digit by digit: each digit carries its drum (decoration; its text is the CSS's), the entrance rolls it. */
function Digits({ text }: { text: string }) {
  return (
    <span className="pt-num">
      {[...text].map((char, index) =>
        /\d/.test(char) ? (
          <span key={index} className="pt-dg" data-d={char}>
            <span className="pt-dw">{char}</span>
            <span className="pt-drum" aria-hidden="true">
              <span className="pt-strip" />
            </span>
          </span>
        ) : (
          <span key={index} className="pt-cm">
            {char}
          </span>
        ),
      )}
    </span>
  )
}

/** The words under the line: the total, or what the page can say instead, and what to do about it. */
function LeadBlock({ lead, wallet, invitedBy }: { lead: Lead; wallet: string | null; invitedBy: string | null }) {
  const invited = invitedBy && (
    <p className="pt-invited" data-points-invited="">
      <Mono address={invitedBy} /> {W.invited}. {W.invitedSignIn}
    </p>
  )
  switch (lead.kind) {
    case 'wait':
      return <div className="pt-lead-wait" aria-hidden="true" />
    case 'total': {
      const points = lead.answer.wallet.points
      return (
        <>
          <p className="pt-total" title={W.totalTitle(points)} data-points-total={points}>
            <Digits text={pointsText(points)} />
            <span className="pt-unit">{W.unit}</span>
          </p>
          <p className="pt-rule">{W.rule}</p>
        </>
      )
    }
    case 'before':
      return (
        <>
          <p className="pt-lead">{W.starts}</p>
          <p className="pt-rule">{W.startsBody}</p>
          {!wallet && <ConnectActions />}
        </>
      )
    case 'connect':
      return (
        <>
          {invited}
          <p className="pt-lead">{W.connectLead}</p>
          <ConnectActions />
          <p className="pt-note">{W.signInNote}</p>
        </>
      )
    case 'sign_in':
      return (
        <>
          {invited}
          <p className={lead.ended ? 'pt-lead pt-lead--line' : 'pt-lead'} role={lead.ended ? 'status' : undefined}>
            {lead.ended ? W.sessionEnded : W.signInLead}
          </p>
          <div className="pt-actions">
            <Button type="button" onClick={signInWithWallet} data-points-action="sign-in">
              {W.signIn}
            </Button>
          </div>
          <p className="pt-note">{W.signInNote}</p>
        </>
      )
    case 'off':
      return (
        <>
          <p className="pt-lead">{W.off}</p>
          <p className="pt-rule">{W.offBody}</p>
        </>
      )
    case 'started':
      return (
        <>
          <p className="pt-lead">{W.started}</p>
          <p className="pt-rule">{W.startedBody}</p>
        </>
      )
    case 'problem':
      return (
        <>
          <p className="pt-lead pt-lead--line" role="status">
            {lead.text}
          </p>
          <div className="pt-actions">
            <Button type="button" variant="outline" onClick={lead.again} data-points-action="retry">
              {W.retry}
            </Button>
          </div>
        </>
      )
  }
}

function ConnectActions() {
  return (
    <div className="pt-actions">
      <Button type="button" onClick={openWalletDialog} data-points-action="connect">
        {W.connect}
      </Button>
      <LinkButton href="/#learn" variant="ghost">
        {W.howItWorks}
      </LinkButton>
    </div>
  )
}

/**
 * Link your referrer (decisions D2, D5): the stored link's wallet, what linking does, and the one button that asks the
 * wallet to sign, only where it can work (`onLink`); otherwise a calm note on when linking opens. Once the service has
 * answered a link (`done`: recorded now, or there before, the first link holds), the answer takes the ask's place: the
 * ask stays there hidden, so the card keeps its size and nothing under it moves.
 */
function ReferralCard({ who, note, link, onLink, onLater, done = null }: { who: string; note: string; link?: LinkState; onLink?: () => void; onLater: (card: Element | null) => void; done?: Linked | null }) {
  const busy = link?.state === 'busy' || done !== null
  const line = link?.state === 'declined' ? W.declined : link?.state === 'problem' ? link.text : null
  return (
    <section className="pt-invite" aria-labelledby={done ? 'pt-done-title' : 'pt-invite-title'}>
      <div className="pt-swap">
        <div className={done ? 'pt-ask pt-left' : 'pt-ask'} data-points-card={onLink ? 'link' : 'later'} aria-hidden={done ? true : undefined} inert={done ? true : undefined}>
          <h2 id="pt-invite-title" className="pt-h2">
            {W.linkTitle}
          </h2>
          <p className="pt-invite-lead">
            {W.linkBody} <Mono address={who} />. {W.linkBodyRest}
          </p>
          <p className="pt-invite-note">{note}</p>
          <div className="pt-actions">
            {onLink && (
              <Button type="button" onClick={onLink} className="pt-link-btn" disabled={busy} aria-busy={busy || undefined} data-busy={busy ? '' : undefined} data-points-action="link">
                <span className="pt-swap">
                  <span className="pt-l-idle" aria-hidden={busy || undefined}>
                    {W.linkAction}
                  </span>
                  <span className="pt-l-busy" aria-hidden={!busy || undefined}>
                    {W.linkBusy}
                    <span className="pt-wait" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                </span>
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={(event) => onLater(event.currentTarget.closest('section'))} disabled={busy} data-points-action="later">
              {W.linkLater}
            </Button>
          </div>
          <p className="pt-invite-status" role="status" data-points-line={line ? '' : undefined}>
            {line}
          </p>
        </div>
        {done && (
          <div className="pt-done" data-points-card={done.state}>
            {done.state === 'recorded' ? (
              <>
                <h2 id="pt-done-title" className="pt-h2 pt-done-head">
                  {W.linkedTitle}
                  <span className="pt-check" aria-hidden="true">
                    <IconCheck size={14} />
                  </span>
                </h2>
                <p className="pt-invite-lead">
                  {W.linkedTo} <Mono address={done.referrer} />. {W.linkedRest}
                </p>
              </>
            ) : (
              <>
                <h2 id="pt-done-title" className="pt-h2">
                  {W.linkTitle}
                </h2>
                <p className="pt-invite-lead">
                  {W.existingIs} <Mono address={done.referrer} />. {W.existingRest}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** Your link (decision D1): shown short, copied whole. The button answers in its own place: a check and "Copied". */
function ShareLink({ wallet }: { wallet: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  const button = useRef<HTMLButtonElement>(null)
  const was = useRef(copied)
  useLayoutEffect(() => {
    if (was.current === copied) return
    was.current = copied
    motion.copied(button.current, !copied)
  }, [copied])
  const url = referralUrl(wallet)
  const shown = shownLink(wallet)
  const copy = () => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clipboard) return
    void clipboard.writeText(url).then(() => setCopied(true), () => undefined)
  }
  return (
    <section className="pt-share" aria-labelledby="pt-share-title" data-points-share="">
      <h2 id="pt-share-title" className="pt-h2">
        {W.yourLink}
      </h2>
      <div className="pt-link">
        <span className="pt-mono pt-link-text" title={url} translate="no" data-points-link={url}>
          {shown.lead}
          <wbr />
          <span className="pt-addr">{shown.wallet}</span>
        </span>
        <Button ref={button} type="button" onClick={copy} className="pt-copy" aria-label={copied ? W.copied : W.copyLabel} data-copied={copied ? '' : undefined} data-points-action="copy">
          <span className="pt-copy-icon" aria-hidden="true">
            <IconCopy size={16} className="pt-i-copy" />
            <IconCheck size={16} className="pt-i-check" />
          </span>
          <span className="pt-swap">
            <span className="pt-l-copy">{W.copy}</span>
            <span className="pt-l-copied">{W.copied}</span>
          </span>
        </Button>
      </div>
      <p className="sr-only" aria-live="polite">
        {copied ? W.copied : ''}
      </p>
    </section>
  )
}

/** Under the link: what earned the points (with them), or Season 1 and how to earn; then how points are counted. */
function Lower({ total, now }: { total: PointsResponse | null; now: number }) {
  const day = seasonDay(now)
  const kinds = total ? KINDS.filter((kind) => !isZero(total.wallet.revenueUsd[kind])) : []
  return (
    <section className="pt-lower" aria-labelledby="pt-lower-title" data-points-lower={total ? 'earned' : 'season'}>
      <h2 id="pt-lower-title" className="pt-h3">
        {total ? W.earnedBy : W.seasonTitle}
      </h2>
      {total ? (
        isZero(total.wallet.points) ? (
          <div className="pt-zero">
            <p>{W.zero}</p>
            <LinkButton href={newPositionHref()} variant="outline" size="sm">
              {W.zeroAction}
            </LinkButton>
          </div>
        ) : (
          <ul className="pt-ledger">
            {kinds.map((kind) => {
              const usd = total.wallet.revenueUsd[kind]
              const points = usdToPoints(usd)
              return (
                <li key={kind} data-kind={kind}>
                  <span className="lk">{W.kinds[kind]}</span>
                  <span className="lf pt-num" title={usd}>
                    {W.inFees(usdText(usd))}
                  </span>
                  <span className="lp pt-num" title={points}>
                    {pointsText(points)}
                  </span>
                </li>
              )
            })}
          </ul>
        )
      ) : (
        <>
          <p className="pt-dates">{W.seasonDates}</p>
          <ul className="pt-ledger pt-ways">
            {W.ways.map(([name, line]) => (
              <li key={name}>
                <span className="lk">{name}</span>
                <span className="lf">{line}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {total?.snapshot && (
        <p className="pt-count">
          {W.counted(utcClock(total.snapshot.takenAt))} {W.seasonLine(day)}
        </p>
      )}
      <details className="pt-details">
        <summary>
          <span>{W.detailsTitle}</span>
          <span aria-hidden="true" className="pt-chev" />
        </summary>
        <dl>
          {W.details.map(([term, line]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{line}</dd>
            </div>
          ))}
          {total && (
            <div>
              <dt>{W.rulesHash}</dt>
              <dd className="pt-mono" title={total.season.configSha256}>
                {shortHash(total.season.configSha256)}
              </dd>
            </div>
          )}
          {total?.snapshot && (
            <div>
              <dt>{W.countHash}</dt>
              <dd className="pt-mono" title={total.snapshot.sha256}>
                {shortHash(total.snapshot.sha256)}
              </dd>
            </div>
          )}
        </dl>
      </details>
      <LinkButton href="/docs/points" variant="ghost" size="sm" className="pt-docs" data-points-docs="">
        {W.docsLink}
      </LinkButton>
    </section>
  )
}
