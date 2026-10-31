import { useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { suggestGasBudget } from '../../finance/gas'
import { readRelease } from '../../finance/release'
import { saveSetupProfile, savedSetupProfile } from '../../finance/recoveryProfile'
import { createSetupClient, deploymentFrom, type SetupDeployment } from '../../finance/setup'
import { setupWallet } from '../../finance/wallet'
import { errorCode, financeErrorText } from '../../finance/words'
import { useWalletIdentity, walletKey } from '../../lib/walletIdentity'
import { Button } from '../ui'
import type { PositionCurrency } from './PositionActions'
import { QuietMarkPair } from './visual/QuietMarks'
import { amountText, currencyName, outcomeUnknown, readAfterReplaced, watchReceipt } from './walletSteps'
// The person's own refusal, by the nonce latch's rule: 4001, WalletConnect's 5000, a hardware wallet's words (fix round 1).
import { personRefused as isRejection } from '../../finance/nonce'

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
/**
 * `onBusy`: told true when a refund starts and false once it is over, whatever became of it (the list's refresh waits
 * meanwhile). `onChanged`: a refund was included on chain, with its block when the receipt named it (RPC fix round 2).
 */
export interface HeldDepositsProps { owner: string; deposits: readonly HeldDeposit[]; onChanged: (block?: bigint) => void; onBusy?: (busy: boolean) => void }

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
/**
 * (QA round 2, HELD-REFUND, 2026-10-30) The V1 setup deployment this build ships for refunds, as finance/reservesLive.ts
 * ships the sequence's for withdrawing fee reserves (finance/pin.ts SEQUENCE_RECOVERY_RECORD): the release published on
 * 2026-09-21 (docs/deployments/v1-robinhood-mainnet-2026-09-21/setup-release.json), which expired on 2026-10-21. Since
 * then a wallet with no profile saved in its browser could not refund a held deposit at all. It is the last resort, after
 * the published release and the saved profile; parsed as strictly as the release at any age and marked expired, as a
 * saved profile is, so it can only read and cancel: the setup contract and the position manager must be the build's pins
 * (finance/setup.ts deploymentFrom), and the setup contract's code and getters are checked on chain before the refund is
 * offered to the wallet (setup.ts verify, recovery). The refund is the same cancel(operationId), unchanged. Test builds:
 * only a record a test injects (window.__dominoSetupRecoveryRecord), so no other test's refund meets one.
 */
const SETUP_RECOVERY_RECORD = {
  contractVersion: '1.0.0-rc.1',
  chainId: 4663,
  available: true,
  deployment: {
    setup: '0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a',
    setupCodeHash: '0x3d634de8bfa34c5d3ef1231f066b9ad11960d828062d2ef0f7bb13d2ad206c50',
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    poolManagerCodeHash: '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626',
    positionManagerCodeHash: '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2',
    stateViewCodeHash: '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6',
    feeRecipient: '0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4',
    feeBps: 65,
    tariffVersion: '1',
    expiresAt: 1792609290,
  },
} as const
function shippedSetupProfile(): SetupDeployment | null {
  const value: unknown = __DOMINO_TEST_HOOKS__ ? (window as { __dominoSetupRecoveryRecord?: unknown }).__dominoSetupRecoveryRecord : SETUP_RECOVERY_RECORD
  if (value === undefined) return null
  try {
    const parsed = deploymentFrom(value, 0)
    return parsed ? { ...parsed, expiresAt: 0 } : null
  } catch {
    return null
  }
}
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
  // 2026-10-01 (audit C14): "Cancel" in the wallet, read back from the chain: the deposit's operation is still open.
  replaced: 'Your wallet replaced the refund with another transaction, and your deposit is still held. Try the refund again.',
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
      // A refund needs no published release: without one, the profile this browser saved, else the one this build ships
      // (HELD-REFUND), each checked on chain the same way.
      const deployment = live.kind === 'available' ? live.deployment : (savedSetupProfile() ?? shippedSetupProfile())
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
      // RPC fix round 2: the block it was included in, so the wallet's list waits for a read at or past it (walletChanged).
      let included: bigint | undefined
      let outcome = await watchReceipt(async () => {
        const receipt = await setup.receipt(hash, id as Hex)
        if ('blockNumber' in receipt) included = receipt.blockNumber
        return receipt
      }, alive)
      if (outcome === 'stopped' || !alive()) return
      if (outcome === 'replaced') {
        // 2026-10-01 (audit C14): replaced in the wallet ("Speed up" or "Cancel"). Refunded only if the deposit's operation
        // reads closed now: a sped-up refund closed it, a cancelled one did not. Nothing is sent again.
        const refunded = await readAfterReplaced(() => setup.inspect(id as Hex), (operation) => operation.closed, alive)
        if (refunded === null || !alive()) return
        if (refunded) outcome = 'included'
      }
      if (outcome === 'included') {
        mark(id, { stage: 'done', notice: null })
        changed.current(included)
      } else mark(id, { stage: 'failed', notice: { text: WATCHED_TEXT[outcome], code: outcome } })
    } catch (error) {
      // Once sent, a failure is a watch that could not conclude, never a refund known to have failed.
      if (alive()) mark(id, { stage: 'failed', notice: sent ? { text: WATCHED_TEXT.unknown, code: errorCode(error) ?? 'unknown' } : failureText(error) })
    } finally {
      onBusy?.(false)
    }
  }

  return (
    <section className="dm-card dm-lit dm-acct-card dm-held" aria-labelledby="held-deposits-title" data-held-deposits={deposits.length}>
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
