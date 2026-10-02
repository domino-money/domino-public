/**
 * The transactions this browser sent through the second chain's section, and what became of each (2026-10-01, the
 * chain2 workstream): kept per chain and owner (chains/elysium/receipts.ts), a pending one looked at again by itself
 * every few seconds (his receipt route where it answers, else the chain's own receipt), never with a button.
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, EmptyState, PageHeader, Pill, TableShell, Td, Th } from '../../../components/ui'
import { IconReceipt, IconWallet } from '../../../components/icons'
import { browserStore } from '../../../lib/chainStorage'
import type { TokenInfo } from '../../types'
import { keepOutcome, loadReceipts, lookAgainAfter, lookReceipt, type ReceiptEntry, type ReceiptOutcome } from '../receipts'
import { agoText, stepText } from '../present'
import { useNow, useSection } from './context'
import { ExplorerLink } from './parts'

const TONE: Record<ReceiptOutcome, { tone: 'wait' | 'in' | 'out' | 'neutral'; text: string }> = {
  pending: { tone: 'wait', text: 'Waiting for the network' },
  confirmed: { tone: 'in', text: 'Confirmed' },
  reverted: { tone: 'out', text: 'Refused by the network' },
  replaced: { tone: 'neutral', text: 'Replaced in your wallet' },
}

/** A step's words need the pool's tokens; a receipt names only its vault, so its tokens are named generically. */
const ANY_TOKEN = (side: 0 | 1): TokenInfo => ({ address: '0x0000000000000000000000000000000000000000', symbol: side === 0 ? 'the first token' : 'the second token', decimals: null })

export function Receipts() {
  const { chain, wallet, connect, reader, api, adapter } = useSection()
  const now = useNow()
  const account = wallet.account
  // The kept list, read again for another account and after every look that settled one.
  const [version, setVersion] = useState(0)
  // Only receipts within their age are shown (fix round 1: the Privacy page's 30 days; lib/browserCopies.ts deletes older).
  const entries = useMemo<readonly ReceiptEntry[]>(() => (account && version >= 0 ? loadReceipts(browserStore(), chain, account, now) : []), [account, chain, version, now])

  // Every pending one, looked at again by itself until it settles: the next look starts only once the last one ended,
  // later each time it finds them still pending (lookAgainAfter), and not while the tab is hidden (fix round 1).
  const pending = entries.filter((entry) => entry.outcome === 'pending').map((entry) => entry.hash).join(',')
  useEffect(() => {
    if (!account || !pending) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let looks = 0
    let held = false
    const look = async () => {
      const store = browserStore()
      let settled = false
      for (const entry of loadReceipts(store, chain, account).filter((kept) => kept.outcome === 'pending')) {
        try {
          const seen = await lookReceipt(entry, { reader, api, identity: adapter.identity() }, controller.signal)
          if (controller.signal.aborted) return
          if (seen.outcome !== 'pending') {
            keepOutcome(store, chain, account, entry.hash, seen.outcome, seen.block)
            settled = true
          }
        } catch {
          // Looked at again at the next turn.
        }
      }
      if (controller.signal.aborted) return
      if (settled) setVersion((n) => n + 1)
      timer = setTimeout(next, lookAgainAfter(looks++))
    }
    const next = () => {
      if (controller.signal.aborted) return
      if (document.hidden) {
        held = true
        return
      }
      void look()
    }
    const shown = () => {
      if (!document.hidden && held) {
        held = false
        void look()
      }
    }
    document.addEventListener('visibilitychange', shown)
    void look()
    return () => {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [account, pending, chain, reader, api, adapter])

  return (
    <section data-chain2-screen="receipts">
      <PageHeader title="Receipts" description={`The transactions you sent on ${chain.name} from this browser.`} />
      <div className="mt-6">
        {!account ? (
          <EmptyState icon={<IconWallet size={18} />} title="Connect a wallet" body="Your receipts are kept in this browser, for the wallet that sent them." action={<Button onClick={connect}>Connect wallet</Button>} />
        ) : entries.length === 0 ? (
          <EmptyState icon={<IconReceipt size={18} />} title="No receipts yet" body={`Transactions you send on ${chain.name} from this browser appear here.`} />
        ) : (
          <TableShell label={`Receipts on ${chain.name}`}>
            <thead>
              <tr>
                <Th>What</Th>
                <Th>Status</Th>
                <Th>Sent</Th>
                <Th col="wide">Transaction</Th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.hash} data-chain2-receipt={entry.outcome}>
                  <Td>{stepText(entry.step, ANY_TOKEN(0), ANY_TOKEN(1))}</Td>
                  <Td>
                    <Pill tone={TONE[entry.outcome].tone} dot={entry.outcome !== 'replaced'}>{TONE[entry.outcome].text}</Pill>
                  </Td>
                  <Td>{agoText(Math.floor(entry.sentAt / 1000), now)}</Td>
                  <Td col="wide">
                    <ExplorerLink chain={chain} hash={entry.hash} />
                    {entry.block !== null && <span className="ml-1 text-caption text-fg-subtle">block {entry.block.toLocaleString('en-US')}</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </div>
    </section>
  )
}
