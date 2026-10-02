/**
 * The second chain's closed wallet signer (2026-10-01, the chain2 workstream, part B; tests/session.source-guard.test.mjs,
 * tests/read.test.mjs and tests/elysium-guards.test.mjs admit it by name, as they admit finance/wallet.ts): it sends
 * exactly the transaction of a draft rugged97's actions service prepared, once, from the wallet the person chose
 * (EIP-6963, never window.ethereum), and adds the chain to a wallet that does not know it. It mirrors his own adapter
 * (app/src/elysium/wallet.ts on his branch) with the chain id taken from the registry, not written in (audit item G12).
 *
 * Before the wallet is asked to send, through the wallet's own provider: the chain is the registry's; the account is the
 * draft's owner; the draft has not expired; the account's pending nonce is the draft's; the target is one of the draft's
 * code pins; and every pinned contract's code hashes to its pin. Then the chain, the account and the expiry once more.
 * The transaction sent is the draft's, field for field (no value, its gas, its fee caps, its nonce). A refusal in the
 * wallet (4001) says so; anything else is a failure. Nothing is ever sent twice: the flow (flow.ts) owns that, and asks
 * this signer once per draft.
 *
 * Still closed by four gates of its own: the section is off on domino.money (flag.ts), the actions service is not
 * reachable through this site until rugged97's Worker is bound (functions/_lib/uniswap-v3/edge.ts), the chain's
 * deployment is unqualified, and his actions contract rc.2 offers this site no wallet lane (adapter.ts PUBLIC_WALLET_LANE).
 */
import { ELYSIUM } from '../../config/chainElysium'
import { addChainParameters, hexChainId, type ChainConfig } from '../../config/chainKit'
import { keccak256 } from '../../../functions/_lib/uniswap-v3/words'
import type { Draft } from '../../../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/types'
import { errorCode, walletChain, type DiscoveredWallet, type Eip1193 } from '../eip6963'
import { EXPIRY_MARGIN_S, SignerError, type OwnerSigner } from './flow'

const HASH = /^0x[0-9a-fA-F]{64}$/
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/
const hex = (value: string | number | bigint) => `0x${BigInt(value).toString(16)}`

async function quantity(provider: Eip1193, method: string, params: readonly unknown[]): Promise<bigint> {
  const value = await provider.request({ method, params })
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new SignerError('failed', `invalid ${method}`)
  return BigInt(value)
}

async function account(provider: Eip1193): Promise<string | null> {
  const accounts = await provider.request({ method: 'eth_accounts' })
  return Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null
}

async function checkIdentity(provider: Eip1193, chain: ChainConfig, draft: Draft, now: () => number): Promise<void> {
  if ((await walletChain(provider)) !== chain.id) throw new SignerError('wrong_chain', 'wrong_chain')
  if ((await account(provider)) !== draft.owner) throw new SignerError('account_changed', 'account_changed')
  if (draft.expiresAt <= Math.floor(now() / 1000) + EXPIRY_MARGIN_S) throw new SignerError('expired', 'expired')
}

/** The signer for a chosen wallet, on the registry's Elysium chain. `now` is the tests' to replace. */
export function elysiumSignerFor(wallet: DiscoveredWallet, chain: ChainConfig = ELYSIUM, now: () => number = Date.now): OwnerSigner {
  const provider = wallet.provider
  return {
    async send(draft) {
      const tx = draft.transaction
      if (tx.chainId !== chain.id || tx.from !== draft.owner || tx.valueRaw !== '0') throw new SignerError('failed', 'draft_not_sendable')
      try {
        await checkIdentity(provider, chain, draft, now)
        if ((await quantity(provider, 'eth_getTransactionCount', [draft.owner, 'pending'])) !== BigInt(tx.nonce)) throw new SignerError('nonce_changed', 'nonce_changed')
        if (!draft.contractPins.some((pin) => pin.address === tx.to)) throw new SignerError('code_changed', 'target_not_pinned')
        for (const pin of draft.contractPins) {
          const code = await provider.request({ method: 'eth_getCode', params: [pin.address, 'latest'] })
          if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || keccak256(code.toLowerCase()) !== pin.codeHash) throw new SignerError('code_changed', 'code_changed')
        }
        await checkIdentity(provider, chain, draft, now)
      } catch (error) {
        if (error instanceof SignerError) throw error
        throw new SignerError('unavailable', 'wallet_unavailable')
      }
      let hash: unknown
      try {
        hash = await provider.request({
          method: 'eth_sendTransaction',
          params: [{ chainId: hexChainId(chain), from: tx.from, to: tx.to, data: tx.data, value: '0x0', gas: hex(tx.gasLimitRaw), maxFeePerGas: hex(tx.maxFeePerGasWeiRaw), maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGasWeiRaw), nonce: hex(tx.nonce) }],
        })
      } catch (error) {
        throw new SignerError(errorCode(error) === 4001 ? 'rejected' : 'failed', 'send_failed')
      }
      if (typeof hash !== 'string' || !HASH.test(hash)) throw new SignerError('failed', 'invalid_hash')
      return hash.toLowerCase()
    },
  }
}

/** Adds the registry's chain to a wallet that does not know it (EIP-3085); the picker then switches to it. */
export async function addChain(provider: Eip1193, chain: ChainConfig = ELYSIUM): Promise<'added' | 'rejected' | 'failed'> {
  try {
    await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParameters(chain)] })
    return 'added'
  } catch (error) {
    return errorCode(error) === 4001 ? 'rejected' : 'failed'
  }
}
