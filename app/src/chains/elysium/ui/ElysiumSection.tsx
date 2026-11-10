/**
 * The second chain's section: the lazy entry the app routes `#/elysium…` to (2026-10-01, the chain2 workstream; the
 * owner's decision on audit item G2, option B: Elysium lives inside this app, in its design, beginner-first, behind a
 * flag that is off in production until there is a qualified deployment and on in preview).
 *
 * Loaded lazily and only from its route (App.tsx opens ElysiumEntry.tsx, which hands this the part-B pieces), so the
 * Robinhood screens carry none of it. It takes its network as props (`transport`: the page's one admitted fetcher for
 * the chain's RPC and for this site's /uniswap-v3/ route, ../transport.ts), the closed wallet signer (`signerFor`,
 * ../signer.ts) and the wallet's one-click network add (`addChain`, the same module), each with its guards; without a
 * transport it says it is not connected, without a signer the New position flow stops before the wallet and says why,
 * and without the add a wallet that lacks the chain is shown its details to add by hand.
 *
 * What it reads is chosen once, here: the chain from the registry (config/chainElysium.ts ELYSIUM), the mode from the page's
 * origin (flag.ts), the contracts for that mode (the registry's, or rugged97's public testnet rehearsal in preview),
 * the chain client over the transport (lib/chain/client.ts: the registry's endpoint, pace and log window), his services
 * with his own runtimes (vendored by pinned hash), and the adapter over them (adapter.ts).
 */
import { useEffect, useMemo, useState } from 'react'
import { LinkButton, PageHeader, PageShell } from '../../../components/ui'
import { ELYSIUM } from '../../../config/chainElysium'
import { createChainClient, pauseFor } from '../../../lib/chain/client'
import { browserStore } from '../../../lib/chainStorage'
import { useRouteTitle } from '../../../lib/routeTitle'
import { currentRoute, onRoute } from '../../../lib/route'
import * as readRuntime from '../../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-read-v1/runtime.mjs'
import * as actionsRuntime from '../../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/runtime.mjs'
import readPin from '../../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-read-v1/pin.json'
import actionsPin from '../../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/pin.json'
import { currentAccount, walletChain, watchWallet, type DiscoveredWallet } from '../../eip6963'
import { createElysiumAdapter } from '../adapter'
import { createV3Api, type ActionsRuntime, type ContractRuntime } from '../api'
import { sectionMode, sectionSource } from '../flag'
import type { OwnerSigner } from '../flow'
import type { ElysiumTransport } from '../transport'
import { SectionContext, type Section, type WalletState } from './context'
import { Markets } from './Markets'
import { NewPosition } from './NewPosition'
import { PoolPage } from './PoolPage'
import { PositionPage } from './PositionPage'
import { Positions } from './Positions'
import { Receipts } from './Receipts'
import { parseSectionHash, sectionTitle, type SectionRoute } from './routes'
import { SectionNav } from './SectionNav'
import { useRead } from './useRead'
import { WalletPicker, type AddChain, type PickerResult } from './WalletPicker'

export type { ElysiumTransport }

export interface ElysiumSectionProps {
  /** The page's network for the chain (../transport.ts, the one admitted fetcher); absent: not connected. */
  readonly transport?: ElysiumTransport | null
  /** The closed signer for a chosen wallet (../signer.ts); absent: the flow stops before the wallet and says why. */
  readonly signerFor?: ((wallet: DiscoveredWallet) => OwnerSigner) | null
  /** Adds the chain to a wallet that does not know it (../signer.ts addChain); absent: its details, to add by hand. */
  readonly addChain?: AddChain | null
  /** The page's origin (location.origin); a prop so tests can name one. */
  readonly origin?: string
}

/** The clock the chain client paces with: milliseconds now. */
const nowMs = (): number => Date.now()

const RUNTIMES = {
  read: { runtime: readRuntime as unknown as ContractRuntime, pin: readPin },
  actions: { runtime: actionsRuntime as unknown as ActionsRuntime, pin: actionsPin },
}

function useSectionRoute(): SectionRoute {
  const read = () => parseSectionHash(currentRoute(), ELYSIUM) ?? { screen: 'markets' as const, param: '' }
  const [route, setRoute] = useState<SectionRoute>(read)
  useEffect(() => onRoute(() => setRoute(read())), [])
  return route
}

function Closed({ title, body }: { title: string; body: string }) {
  return (
    <PageShell data-chain2-section="closed">
      <PageHeader title={title} description={body} actions={<LinkButton variant="secondary" href="/">Back to Domino</LinkButton>} />
    </PageShell>
  )
}

export default function ElysiumSection({ transport = null, signerFor = null, addChain = null, origin }: ElysiumSectionProps) {
  const chain = ELYSIUM
  const mode = sectionMode(origin ?? (typeof window === 'undefined' ? '' : window.location.origin), chain)
  const source = useMemo(() => sectionSource(mode, ELYSIUM), [mode])
  const route = useSectionRoute()
  // Each screen names its tab, and a move between them is announced (fix round 1, item E11), the closed states too.
  useRouteTitle(mode === 'off' || !source ? chain.name : sectionTitle(chain, route))
  const [wallet, setWallet] = useState<WalletState>({ wallet: null, account: null, onChain: false })
  const [picking, setPicking] = useState(false)

  const parts = useMemo(() => {
    if (!transport || !source) return null
    const reader = createChainClient(ELYSIUM, { send: (url, init) => transport.rpc(url, init), now: nowMs, pause: pauseFor })
    const api = createV3Api((path, init) => transport.api(path, init), RUNTIMES)
    const adapter = createElysiumAdapter({ chain: ELYSIUM, mode, source, reader, api, signer: signerFor !== null })
    return { reader, api, adapter }
  }, [transport, source, mode, signerFor])

  const caps = useRead('capabilities', (signal) => (parts ? parts.adapter.capabilities(signal) : Promise.reject(new Error('not_connected'))), 60_000, parts !== null)

  // The chosen wallet's account and chain, followed as they change in the wallet.
  const chosen = wallet.wallet
  useEffect(() => {
    if (!chosen) return
    return watchWallet(chosen.provider, () => {
      void walletChain(chosen.provider).then(
        (id) => setWallet((old) => (old.wallet === chosen ? { ...old, onChain: id === chain.id } : old)),
        () => undefined,
      )
      void currentAccount(chosen.provider).then(
        (account) => setWallet((old) => (old.wallet === chosen ? { ...old, account } : old)),
        () => undefined,
      )
    })
  }, [chosen, chain])

  if (mode === 'off' || !source) return <Closed title={`${chain.name} isn't open here yet`} body={`Domino on ${chain.name} is still being tested. It opens on this site once it is ready.`} />
  if (!parts) return <Closed title={`${chain.name} isn't connected in this version`} body={`This version of the site doesn't read ${chain.name} yet.`} />

  const section: Section = {
    chain,
    mode,
    source,
    adapter: parts.adapter,
    caps: caps.value,
    api: parts.api,
    reader: parts.reader,
    signerFor,
    wallet,
    connect: () => setPicking(true),
    store: browserStore(),
  }
  const picked = (result: PickerResult) => {
    setWallet({ wallet: result.wallet, account: result.account, onChain: result.onChain })
    setPicking(false)
  }

  return (
    <SectionContext.Provider value={section}>
      <PageShell data-chain2-section={mode} data-chain2-source={source.kind}>
        <SectionNav screen={route.screen} />
        {/* Only classes the app's stylesheet already has: the section adds no rule to the Robinhood entry's CSS. */}
        <div className="mt-6">
          {route.screen === 'markets' && <Markets />}
          {route.screen === 'pool' && <PoolPage param={route.param} />}
          {route.screen === 'positions' && <Positions />}
          {route.screen === 'position' && <PositionPage param={route.param} />}
          {route.screen === 'new' && <NewPosition param={route.param} />}
          {route.screen === 'receipts' && <Receipts />}
        </div>
      </PageShell>
      {picking && <WalletPicker chain={chain} onClose={() => setPicking(false)} onPicked={picked} addChain={addChain} />}
    </SectionContext.Provider>
  )
}
