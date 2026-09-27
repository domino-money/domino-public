import { useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { suggestGasBudget } from '../../finance/gas'
import { readRelease } from '../../finance/release'
import { saveSetupProfile, savedSetupProfile } from '../../finance/recoveryProfile'
import { createSetupClient, deploymentFrom } from '../../finance/setup'
import { setupWallet } from '../../finance/wallet'
import { errorCode, financeErrorText } from '../../finance/words'
import { useWalletIdentity, walletKey } from '../../lib/walletIdentity'
import { Button } from '../ui'
import type { PositionCurrency } from './PositionActions'
import { QuietMarkPair } from './visual/QuietMarks'
import { amountText, currencyName, isRejection, outcomeUnknown, watchReceipt } from './walletSteps'

/**
 * Deposits this wallet made into Domino's setup contract (DominoSetupV1) that
 * never became a position: the funds are still held there, under the wallet's
 * own operation. Each can be refunded to the wallet with one transaction,
 * `cancel(operationId)`, through the same setup client Create position
 * refunds with (finance/setup.ts): the published deployment profile, checked
 * on chain through the wallet, and no Domino session. Cancelling needs no
 * published release: when it is off, expired or out of reach, the profile
 * this browser saved (finance/recoveryProfile.ts) is checked on chain the
 * same way, as Setup's owner recovery does.
 *
 * Shown only to the owner, connected on Robinhood Chain, and only when there
 * is something to refund. Opened lazily by the Positions screens in wallet builds.
 */

export interface HeldDeposit {
  operationId: string
  currency0: string
  currency1: string
  fee: number
  tickSpacing: number
  hooks: string
  balance0: string
  balance1: string
  currencies: readonly [PositionCurrency, PositionCurrency]
}
/** `onBusy`: told true when a refund starts and false once it is over, whatever became of it (the list's refresh waits meanwhile). */
export interface HeldDepositsProps { owner: string; deposits: readonly HeldDeposit[]; onChanged: () => void; onBusy?: (busy: boolean) => void }

type Stage = 'wallet' | 'chain' | 'done' | 'failed'
/**
 * What the page says under a deposit. Changed on purpose (2026-09-25, audit of 754014c): it no longer points to
 * "Setup's owner recovery", a page with no recovery in the very state that shows the notice (no release, no saved
 * profile: it renders nothing to do), or else the raw Network budget and Operation ID form.
 */
interface Notice { text: string; code: string | null }
interface Refund { stage: Stage; notice: Notice | null }

const OPERATION = /^0x[0-9a-f]{64}$/
const RAW = /^(0|[1-9][0-9]{0,77})$/
const PROGRESS: Partial<Record<Stage, string>> = { wallet: 'Confirm in your wallet…', chain: 'Waiting for the network', done: 'Refunded to your wallet' }
const readSetupRelease = () => readRelease('/api/setup/v1/release', (value) => deploymentFrom(value))
/** Release reads that may answer at the next press: the network, a timeout, a route not answering yet. */
const PASSING_RELEASE: ReadonlySet<string> = new Set(['network', 'timeout', 'route_missing'])
/** Neither a published release nor a saved profile: why the refund cannot be prepared here, in words that stay true. */
function releaseNotice(reason: string): Notice {
  if (PASSING_RELEASE.has(reason)) return { text: 'The deployment could not be confirmed just now. Nothing was sent. Try again in a moment.', code: reason }
  return { text: 'The refund can’t be prepared on this page right now. Nothing was sent: your deposit stays held and refundable.', code: reason }
}
const WATCHED_TEXT = {
  reverted: 'The refund reverted on chain. Your deposit is still held; only network gas was spent.',
  reorged: 'The block that held the refund left the chain. Check your wallet activity before trying again.',
  waiting: 'The refund is still waiting to be included. Check your wallet activity: nothing is sent twice.',
  unknown: outcomeUnknown('refund'),
} as const
const OWN_TEXT: Readonly<Record<string, string>> = {
  operation_already_closed: 'This deposit was already refunded or used.',
  operation_not_owned: 'This deposit belongs to another wallet.',
  wallet_identity_changed: 'Your wallet account or network changed. Nothing was sent.',
  pending_wallet_transaction: 'Your wallet has a transaction waiting. Let it finish, then try again.',
  native_gas_reserve_insufficient: 'Your ETH does not cover the network fee for the refund.',
  native_eth_refused: "Your wallet can't receive ETH right now: its smart-account delegation (EIP-7702) refuses plain ETH. The ETH stays safely in this deposit until you change or turn off that delegation in your wallet.",
  wallet_review_required: 'The refund took too long to reach your wallet. Try again.',
  wallet_review_expired: 'The refund took too long to reach your wallet. Try again.',
}
function failureText(error: unknown): { text: string; code: string | null } {
  const code = errorCode(error)
  if (isRejection(error)) return { text: 'You declined in your wallet. Your deposit is still held.', code: 'declined' }
  if (code && Object.hasOwn(OWN_TEXT, code)) return { text: OWN_TEXT[code], code }
  return { text: financeErrorText(code, 'The refund could not be completed. Your deposit is still held.', 'Create position'), code }
}

function Amount({ raw, currency }: { raw: string; currency: PositionCurrency }) {
  const name = currencyName(currency)
  const shown = RAW.test(raw) ? amountText(raw, currency.decimals) : null
  if (!shown) return <span title={RAW.test(raw) ? `${name}’s decimals are unknown.` : 'This amount could not be read.'}>— {name}</span>
  return (
    <span className="tnum" title={`${shown.exact} ${name}`}>
      {shown.text} {name}
    </span>
  )
}

export default function HeldDeposits({ owner, deposits, onChanged, onBusy }: HeldDepositsProps) {
  const identity = useWalletIdentity()
  const wallet = walletKey(identity)
  const mine = wallet !== null && identity.kind === 'connected' && identity.address.toLowerCase() === owner.toLowerCase()
  const [refunds, setRefunds] = useState<Readonly<Record<string, Refund>>>({})
  const generation = useRef(0)
  const changed = useRef(onChanged)
  useEffect(() => {
    changed.current = onChanged
  }, [onChanged])
  const [seenWallet, setSeenWallet] = useState(wallet)
  if (seenWallet !== wallet) {
    setSeenWallet(wallet)
    setRefunds({})
  }
  useEffect(() => {
    generation.current++
  }, [wallet])
  useEffect(() => () => void generation.current++, [])

  if (!mine || deposits.length === 0) return null

  const busy = Object.values(refunds).some((refund) => refund.stage === 'wallet' || refund.stage === 'chain')
  const mark = (id: string, refund: Refund) => setRefunds((all) => ({ ...all, [id]: refund }))

  /** One refund: the deposit read back and simulated through the wallet, offered once, then watched until it is in a block. */
  async function refund(deposit: HeldDeposit) {
    const id = deposit.operationId.toLowerCase()
    if (!OPERATION.test(id) || busy) return
    const gen = generation.current
    const alive = () => generation.current === gen
    mark(id, { stage: 'wallet', notice: null })
    onBusy?.(true)
    let sent = false
    try {
      const live = await readSetupRelease()
      // A refund needs no published release: without one, the profile this browser saved, checked on chain the same way.
      const deployment = live.kind === 'available' ? live.deployment : savedSetupProfile()
      if (deployment === null) {
        if (alive()) mark(id, { stage: 'failed', notice: releaseNotice(live.kind === 'unavailable' ? live.reason : 'release_not_available') })
        return
      }
      const rpc = await setupWallet()
      const setup = createSetupClient(rpc, deployment)
      const step = await setup.cancel(id as Hex, await suggestGasBudget(rpc))
      if (!alive()) return
      // Verified on chain through the wallet just now: kept for a refund made while no release is published.
      if (live.kind === 'available') saveSetupProfile(live.deployment)
      const hash = await setup.send(step, true)
      sent = true
      if (!alive()) return
      mark(id, { stage: 'chain', notice: null })
      const outcome = await watchReceipt(() => setup.receipt(hash, id as Hex), alive)
      if (outcome === 'stopped' || !alive()) return
      if (outcome === 'included') {
        mark(id, { stage: 'done', notice: null })
        changed.current()
      } else mark(id, { stage: 'failed', notice: { text: WATCHED_TEXT[outcome], code: outcome } })
    } catch (error) {
      // Once sent, a failure is a watch that could not conclude, never a refund known to have failed.
      if (alive()) mark(id, { stage: 'failed', notice: sent ? { text: WATCHED_TEXT.unknown, code: errorCode(error) ?? 'unknown' } : failureText(error) })
    } finally {
      onBusy?.(false)
    }
  }

  return (
    <section className="dm-card dm-acct-card dm-held" aria-labelledby="held-deposits-title" data-held-deposits={deposits.length}>
      <div className="dm-acct-card-head">
        <h2 id="held-deposits-title" className="dm-title">
          Deposits not yet in a position
        </h2>
      </div>
      <ul className="dm-held-list">
        {deposits.map((deposit) => {
          const id = deposit.operationId.toLowerCase()
          const state = refunds[id]
          const pair = `${currencyName(deposit.currencies[0])} / ${currencyName(deposit.currencies[1])}`
          return (
            <li key={id} className="dm-held-row" data-held-deposit={id}>
              <div className="dm-held-main">
                <QuietMarkPair addresses={[deposit.currencies[0].address, deposit.currencies[1].address]} size={32} />
                <div className="dm-held-text">
                  <span className="dm-held-pair">{pair}</span>
                  <span className="dm-held-amounts">
                    <Amount raw={deposit.balance0} currency={deposit.currencies[0]} /> · <Amount raw={deposit.balance1} currency={deposit.currencies[1]} />
                  </span>
                </div>
                {state?.stage !== 'done' && (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="dm-held-refund"
                    disabled={busy || !OPERATION.test(id)}
                    aria-busy={state?.stage === 'wallet' || state?.stage === 'chain' || undefined}
                    data-held-refund={id}
                    onClick={() => void refund(deposit)}
                  >
                    Refund to wallet
                  </Button>
                )}
              </div>
              {state && PROGRESS[state.stage] && (
                <p role="status" className="dm-held-line dm-held-line--strong" data-held-progress={state.stage}>
                  {PROGRESS[state.stage]}
                </p>
              )}
              {state?.notice && (
                <p role="alert" className="dm-held-line" data-held-notice={state.notice.code ?? 'said'}>
                  {state.notice.text}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
