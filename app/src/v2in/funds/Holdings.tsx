import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui'
import { browserOriginWallet, type OriginWallet } from '../../finance/v2/crosschain'
import { CANDIDATE_ORIGINS, createHoldingsCache, readHoldingsReport, scanHoldings, type Holding, type HoldingsReport, type HoldingsScan, type HoldingsSwitchOutcome } from '../../finance/v2/holdings'
import { amountText } from '../../v2/crosschain/amounts'
import type { V2ChainId } from '../../v2/types'
import { switchToChain, switchToOrigin, v2SwitchNotice, type ChainSwitchOutcome } from '../../wallet/port'
import { FUNDS_TEXT } from './copy'

export type BringOutcome = 'prefilled' | 'locked' | 'no_route'
type ScanState =
  | { state: 'idle' }
  | { state: 'running'; chainId: number | null; name: string | null; phase: 'switching' | 'reading' }
  | { state: 'done'; scan: HoldingsScan }
  | { state: 'no_wallet' }
type HereState = { key: string; report: HoldingsReport | null; failed: boolean }
const cachedRead = createHoldingsCache()
const narrow = (outcome: ChainSwitchOutcome): HoldingsSwitchOutcome =>
  outcome === 'switched' || outcome === 'unknown_chain' || outcome === 'user_rejected' || outcome === 'pending' ? outcome : 'error'
const words = (names: readonly string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
const nameOf = (chainId: number) => CANDIDATE_ORIGINS.find((c) => c.chainId === chainId)?.name ?? `network ${chainId}`
const amountOf = (holding: Holding) => amountText(holding.raw.toString(), holding.token, { symbol: holding.symbol, decimals: holding.decimals })

/** Reads the connected network automatically. Other networks require the wallet's explicit switch permission until
 * Domino has a qualified multi-chain balance service. No read-only discovery is allowed to open wallet prompts. */
export function Holdings({ chainId, homeName, walletChainId, walletKey, busy, bringDisabled, locked, onBring }: {
  chainId: V2ChainId
  homeName: string
  walletChainId: number | null
  /** Connector and account, so another connection never inherits this one's balances. */
  walletKey: string
  busy: boolean
  bringDisabled: boolean
  locked: boolean
  onBring: (holding: Holding) => BringOutcome
}) {
  const [scan, setScan] = useState<ScanState>({ state: 'idle' })
  const [here, setHere] = useState<HereState | null>(null)
  const [notice, setNotice] = useState<{ kind: Exclude<BringOutcome, 'prefilled'>; copy: string } | null>(null)
  const alive = useRef(true)
  const scanning = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const hereChain = walletChainId !== null && walletChainId !== chainId && CANDIDATE_ORIGINS.some((c) => c.chainId === walletChainId) ? walletChainId : null
  const hereKey = hereChain === null ? null : `${walletKey}|${hereChain}`
  useEffect(() => {
    if (busy || scanning.current || hereChain === null || hereKey === null) return
    const candidate = CANDIDATE_ORIGINS.find((c) => c.chainId === hereChain)
    if (!candidate) return
    let wanted = true
    void cachedRead(hereKey, async () => readHoldingsReport(await browserOriginWallet(), candidate))
      .then((report) => { if (wanted) setHere({ key: hereKey, report, failed: false }) })
      .catch(() => { if (wanted) setHere({ key: hereKey, report: null, failed: true }) })
    return () => { wanted = false }
  }, [busy, hereChain, hereKey])

  const look = async () => {
    if (scanning.current || busy) return
    scanning.current = true
    setNotice(null)
    setScan({ state: 'running', chainId: null, name: null, phase: 'switching' })
    let own: OriginWallet
    try { own = await browserOriginWallet() }
    catch { if (alive.current) setScan({ state: 'no_wallet' }); scanning.current = false; return }
    const result = await scanHoldings({
      wallet: { ...own, current: () => alive.current && own.current() },
      switchTo: (id) => (id === chainId ? switchToChain(chainId) : switchToOrigin(id)).then(narrow),
      homeChainId: chainId,
      onProgress: (progress) => { if (alive.current) setScan({ state: 'running', ...progress }) },
    })
    scanning.current = false
    if (alive.current) setScan(result.stoppedBy === 'wallet_changed' ? { state: 'no_wallet' } : { state: 'done', scan: result })
  }
  const press = (holding: Holding) => {
    const outcome = onBring(holding)
    setNotice(outcome === 'prefilled' ? null : { kind: outcome, copy: outcome === 'locked' ? FUNDS_TEXT.locked : FUNDS_TEXT.noRoute(holding.symbol, holding.chainName, homeName) })
  }
  const current = hereKey !== null && here?.key === hereKey ? here : null
  const result: HoldingsScan | null = scan.state === 'done' ? scan.scan : current?.report && hereChain !== null ? {
    holdings: current.report.holdings,
    read: current.report.unread.length === 0 ? [hereChain] : [],
    skipped: current.report.unread.length > 0 ? [{ chainId: hereChain, reason: 'error' }] : [],
    stoppedBy: null, returned: true,
  } : null
  const found = result?.holdings ?? []
  const running = scan.state === 'running'
  const readingHere = hereKey !== null && !current && !running
  const origins = CANDIDATE_ORIGINS.filter((c) => c.chainId !== chainId).map((c) => c.name)
  const failed = !!current?.failed || !!result?.skipped.length
  return (
    <section className="dm-funds-holdings" data-funds-holdings={readingHere ? 'reading' : scan.state}>
      {readingHere && <p role="status" className="dm-funds-status" aria-busy="true" data-funds-scan-progress="reading">{FUNDS_TEXT.reading(nameOf(hereChain!))}</p>}
      {found.length > 0 && (
        <div className="dm-funds-found" data-funds-found="">
          <span className="dm-label">Available in your wallet</span>
          {found.map((holding) => (
            <div key={`${holding.chainId}:${holding.token}`} className="dm-funds-source" data-funds-holdings-chain={holding.chainId}>
              <div><strong>{amountOf(holding)}</strong><span>{holding.chainName}</span></div>
              <Button variant="outline" size="sm" disabled={bringDisabled || running || locked} onClick={() => press(holding)} data-funds-bring={`${holding.chainId}:${holding.token}`}>Use {holding.symbol}</Button>
            </div>
          ))}
        </div>
      )}
      {result && found.length === 0 && result.read.length > 0 && !failed && (
        <p className="dm-hint" data-funds-nothing="">{FUNDS_TEXT.nothingFound(words(result.read.map(nameOf)))}</p>
      )}
      {failed && <p role="status" className="dm-hint" data-funds-read-partial="">Some balances could not be checked. They are not counted as zero.</p>}
      {!locked && !readingHere && !running && scan.state !== 'done' && (
        <div className="dm-funds-check">
          <p className="dm-hint">Your wallet needs permission to check other networks.</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void look()} data-funds-scan="">{FUNDS_TEXT.scan}</Button>
          <span className="dm-hint">{FUNDS_TEXT.scanWhat(words(origins), homeName)}</span>
        </div>
      )}
      {!locked && scan.state === 'done' && <Button variant="ghost" size="sm" className="justify-self-start" disabled={busy} onClick={() => void look()} data-funds-scan="">Check again</Button>}
      {running && scan.name !== null && <p role="status" aria-busy="true" className="dm-funds-status" data-funds-scan-progress={scan.phase}>{scan.phase === 'reading' ? FUNDS_TEXT.reading(scan.name) : FUNDS_TEXT.switching(scan.name)}</p>}
      {result?.skipped.filter((s) => s.reason !== 'user_rejected').map((s) => <p key={s.chainId} className="dm-hint" data-funds-skipped={s.chainId} data-funds-skipped-reason={s.reason}>{s.reason === 'unknown_chain' ? FUNDS_TEXT.notInWallet(nameOf(s.chainId)) : s.reason === 'pending' ? v2SwitchNotice('pending', nameOf(s.chainId)) : FUNDS_TEXT.couldNotRead(nameOf(s.chainId))}</p>)}
      {result?.stoppedBy === 'user_rejected' && <p role="status" className="dm-hint" data-funds-scan-stopped="">{FUNDS_TEXT.scanStopped}</p>}
      {result && !result.returned && <p role="alert" className="dm-error" data-funds-switch-back="">{FUNDS_TEXT.switchBack(homeName)}</p>}
      {notice && <p role="status" className="dm-hint" data-funds-locked={notice.kind === 'locked' ? '' : undefined} data-funds-no-route={notice.kind === 'no_route' ? '' : undefined}>{notice.copy}</p>}
      {scan.state === 'no_wallet' && <p role="status" className="dm-hint" data-funds-scan-no-wallet="">{FUNDS_TEXT.walletGone}</p>}
    </section>
  )
}
