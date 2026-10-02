/**
 * Choosing a wallet for the second chain (2026-10-01, the chain2 workstream, audit items G11 and G12): the wallets the
 * browser announces (EIP-6963), never window.ethereum; the account the person allows; then the wallet moved to the
 * registry's chain. A wallet that does not know the chain yet is offered to add it (EIP-3085, through the closed
 * signer's addChain, ../signer.ts, part B), and the switch is asked again once it is added; where the wallet declines or
 * cannot, or no add is wired, it is shown the network's details to add by hand. Names are the wallets' own text; their
 * icons are never used.
 */
import { useEffect, useState } from 'react'
import type { ChainConfig } from '../../../config/chainKit'
import { addChainParameters } from '../../../config/chainKit'
import { Button, IconButton, KeyValue, KeyValueList } from '../../../components/ui'
import { IconClose } from '../../../components/icons'
import { useDialog } from '../../../lib/useDialog'
import { connectAccount, discoverWallets, switchChain, type DiscoveredWallet, type Eip1193, type SwitchOutcome } from '../../eip6963'

/** Adds `chain` to the wallet behind `provider` (../signer.ts addChain). */
export type AddChain = (provider: Eip1193, chain: ChainConfig) => Promise<'added' | 'rejected' | 'failed'>

type Outcome = SwitchOutcome | 'asking' | 'adding' | 'add-refused' | 'add-failed'
type Step = { kind: 'choose' } | { kind: 'asking'; wallet: DiscoveredWallet } | { kind: 'switch'; wallet: DiscoveredWallet; account: string; outcome: Outcome } | { kind: 'refused'; wallet: DiscoveredWallet }

export interface PickerResult {
  readonly wallet: DiscoveredWallet
  readonly account: string
  readonly onChain: boolean
}

export function WalletPicker({ chain, onClose, onPicked, addChain = null }: { chain: ChainConfig; onClose: () => void; onPicked: (result: PickerResult) => void; addChain?: AddChain | null }) {
  const dialog = useDialog(true, onClose)
  const [wallets, setWallets] = useState<readonly DiscoveredWallet[]>([])
  const [step, setStep] = useState<Step>({ kind: 'choose' })

  useEffect(() => (typeof window === 'undefined' ? undefined : discoverWallets(window, setWallets)), [])

  async function switchTo(wallet: DiscoveredWallet, account: string) {
    setStep({ kind: 'switch', wallet, account, outcome: 'asking' })
    const outcome = await switchChain(wallet.provider, chain)
    setStep({ kind: 'switch', wallet, account, outcome })
    if (outcome === 'already' || outcome === 'switched') onPicked({ wallet, account, onChain: true })
  }

  async function choose(wallet: DiscoveredWallet) {
    setStep({ kind: 'asking', wallet })
    let account: string
    try {
      account = await connectAccount(wallet.provider)
    } catch {
      setStep({ kind: 'refused', wallet })
      return
    }
    await switchTo(wallet, account)
  }

  async function add(wallet: DiscoveredWallet, account: string) {
    if (!addChain) return
    setStep({ kind: 'switch', wallet, account, outcome: 'adding' })
    const added = await addChain(wallet.provider, chain)
    if (added === 'added') await switchTo(wallet, account)
    else setStep({ kind: 'switch', wallet, account, outcome: added === 'rejected' ? 'add-refused' : 'add-failed' })
  }

  const params = addChainParameters(chain)
  const byHand = (lead: string) => (
    <>
      <p className="text-body text-fg-muted">{lead} Add the network in your wallet with these details, then switch to it.</p>
      <KeyValueList>
        <KeyValue label="Network name">{params.chainName}</KeyValue>
        <KeyValue label="RPC address" mono>{params.rpcUrls[0]}</KeyValue>
        <KeyValue label="Chain ID" mono>{chain.id}</KeyValue>
        <KeyValue label="Currency">{params.nativeCurrency.symbol}</KeyValue>
        <KeyValue label="Explorer" mono>{params.blockExplorerUrls[0]}</KeyValue>
      </KeyValueList>
    </>
  )
  return (
    <div role="presentation" className="dm-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="chain2-wallet-title" className="dm-dialog" data-chain2-wallet="">
        <h2 id="chain2-wallet-title" className="dm-dialog-title pr-10">Connect a wallet</h2>
        <IconButton label="Close" icon={<IconClose />} variant="ghost" size="sm" className="dm-dialog-close" onClick={onClose} />
        {step.kind === 'choose' && (
          <>
            <p className="text-body text-fg-muted">Choose the wallet to use on {chain.name}.</p>
            {wallets.length === 0 ? (
              <p className="text-body text-fg-muted" role="status">No browser wallet found. Install or open one, and it appears here.</p>
            ) : (
              <ul className="grid gap-2">
                {wallets.map((wallet) => (
                  <li key={wallet.info.uuid}>
                    <Button variant="secondary" className="w-full" onClick={() => void choose(wallet)}>
                      <bdi>{wallet.info.name}</bdi>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {step.kind === 'asking' && (
          <p className="text-body text-fg-muted" role="status">
            Check <bdi>{step.wallet.info.name}</bdi>: it asks which account to share.
          </p>
        )}
        {step.kind === 'refused' && (
          <>
            <p className="text-body text-fg-muted" role="status">
              <bdi>{step.wallet.info.name}</bdi> did not share an account.
            </p>
            <Button variant="secondary" onClick={() => setStep({ kind: 'choose' })}>Choose a wallet</Button>
          </>
        )}
        {step.kind === 'switch' && (
          <div className="grid gap-3" role="status">
            {step.outcome === 'asking' && <p className="text-body text-fg-muted">Check your wallet: it asks to switch to {chain.name}.</p>}
            {step.outcome === 'adding' && <p className="text-body text-fg-muted">Check your wallet: it asks to add {chain.name}.</p>}
            {step.outcome === 'rejected' && (
              <>
                <p className="text-body text-fg-muted">You declined the switch to {chain.name}. Your wallet stays where it is.</p>
                <Button variant="secondary" onClick={() => void switchTo(step.wallet, step.account)}>Switch to {chain.name}</Button>
              </>
            )}
            {step.outcome === 'needs-add' && addChain && (
              <>
                <p className="text-body text-fg-muted">Your wallet doesn’t have {chain.name} yet. It can add it: your wallet shows the network’s details before it adds anything.</p>
                <Button variant="secondary" onClick={() => void add(step.wallet, step.account)}>Add {chain.name}</Button>
                <Button variant="ghost" onClick={() => onPicked({ wallet: step.wallet, account: step.account, onChain: false })}>Continue without switching</Button>
              </>
            )}
            {((step.outcome === 'needs-add' && !addChain) || step.outcome === 'failed' || step.outcome === 'add-refused' || step.outcome === 'add-failed') && (
              <>
                {byHand(
                  step.outcome === 'needs-add'
                    ? `Your wallet doesn't have ${chain.name} yet.`
                    : step.outcome === 'add-refused'
                      ? `You declined adding ${chain.name}.`
                      : step.outcome === 'add-failed'
                        ? `Your wallet couldn't add ${chain.name}.`
                        : `Your wallet couldn't switch to ${chain.name}.`,
                )}
                <Button variant="secondary" onClick={() => void switchTo(step.wallet, step.account)}>I added it: switch now</Button>
                <Button variant="ghost" onClick={() => onPicked({ wallet: step.wallet, account: step.account, onChain: false })}>Continue without switching</Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
