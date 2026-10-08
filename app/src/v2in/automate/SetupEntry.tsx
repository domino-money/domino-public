import { useEffect, useMemo, useState } from 'react'
import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { IconAutomate } from '../../components/icons'
import { Button, EmptyState, LinkButton, Skeleton } from '../../components/ui'
import type { Address } from '../../v2/types'
import { gateOpen, useGate } from './gate'
import { protectionIntent } from './intent'
import { portfolioFor, type Read6 } from './read6'
import { SetupFlow } from './SetupFlow'
import { setupPositions, setupRetryDelay } from './setupPositions'

/** V2 setup reads the connected wallet's V2 portfolio, independently of the inactive V1 catalogue and release. */
export default function SetupEntry({ owner, intent }: {
  owner: string
  intent: { mode: 'compound' | 'domino' | null; tokenId: string | null }
}) {
  const gate = useGate('vault', 4663)
  const exitGate = useGate('autoExit', 4663)
  const [own] = useState(() => (typeof window === 'undefined' ? null : protectionIntent(window.location.hash)) ?? intent)
  const [version, setVersion] = useState(0)
  const [{ answer, updating }, setRead] = useState<{ answer: Read6<PortfolioResponse> | null; updating: boolean }>({ answer: null, updating: false })
  // A just-minted NFT can precede read-v6's index. Wait a bounded amount for the requested NFT, not for a V1 mint event.
  useEffect(() => {
    if (!gateOpen(gate)) return
    let alive = true
    let stopWait: () => void = () => undefined
    void (async () => {
      for (let attempt = 0; alive; attempt++) {
        const value = await portfolioFor(owner.toLowerCase() as Address, gate).catch(() => null)
          ?? { wallet: owner.toLowerCase() as Address, reply: { kind: 'unavailable' as const, reason: 'network' as const } }
        if (!alive) return
        const body = value?.reply.kind === 'ok' ? value.reply.body : null
        const delay = body ? setupRetryDelay(body, owner, own.tokenId, attempt) : null
        setRead({ answer: value, updating: delay !== null })
        if (delay === null) return
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, delay)
          stopWait = () => { window.clearTimeout(timer); resolve() }
        })
      }
    })()
    return () => { alive = false; stopWait() }
  }, [owner, gate, version, own.tokenId])
  const body = answer?.reply.kind === 'ok' ? answer.reply.body : null
  const list = useMemo(() => body ? setupPositions(body, owner) : null, [body, owner])
  const retry = <Button type="button" variant="outline" size="sm" onClick={() => setVersion((n) => n + 1)}>Try again</Button>
  if (gate === null || (gateOpen(gate) && answer === null) || updating) return (
    <div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-v2in-setup="reading" data-sequence-positions="loading">
      {updating ? <p role="status" className="dm-acct-note">Updating your position…</p> : [0, 1, 2].map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
    </div>
  )
  if (!gateOpen(gate)) return <p className="dm-acct-block text-body text-fg-muted" data-v2in-setup="unavailable">Automation isn’t available right now.</p>
  if (!body || !list || (list.incomplete && !list.positions.length)) return (
    <div className="dm-acct-block" data-sequence-positions="failed">
      <p className="text-body text-fg-muted">Your positions couldn’t be checked right now.</p>
      {retry}
    </div>
  )
  const missing = own.tokenId !== null && !list.positions.some((position) => position.tokenId === own.tokenId)
  if (!list.positions.length) return (
    <EmptyState plate icon={<IconAutomate />} className="dm-acct-block" data-sequence-positions="empty"
      title="No positions available for setup"
      body={missing ? 'This position isn’t available for a new automation. Check its status in Positions.' : 'Check your positions to see their current status and automation.'}
      action={<><LinkButton href="#/positions" variant="primary" size="lg">View positions</LinkButton>{missing && retry}</>} />
  )
  return <>
    {missing && <p className="dm-acct-note" role="status" data-sequence-position-missing="">This position isn’t available for a new automation. Choose another position below. {retry}</p>}
    {list.incomplete && <p className="dm-acct-note" role="status">Some positions couldn’t be checked. {retry}</p>}
    <SetupFlow positions={list.positions} portfolio={body} intent={own} gate={gate} exitGate={exitGate} />
  </>
}
