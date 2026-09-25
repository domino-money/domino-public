import { keccak256, type Address, type Hex } from 'viem'

/**
 * The EIP-7702 delegates this app recognizes on Robinhood Chain, by the hash of their runtime code.
 *
 * An EIP-7702 account runs its delegate's code on every call and payment it receives, so that code can move
 * anything the account holds: tokens, the position NFT a mint returns, a sequence's withdrawals. Sign-in admits
 * any delegate (the account's own key still signs; docs/WALLET_SESSIONS.md). Before new funds go in, a delegate
 * whose code is not one of these is said to the person, who continues only once they confirm they set it up
 * themselves (finance/setup.ts fund, components/create/CreatePosition.tsx). A delegate installed without them,
 * by someone holding their key, is typically a sweeper; recognizing wallets' own code keeps that question for
 * the rare account that needs it.
 *
 * Each entry was read through the own node at block 72,322,930 (25 Sep 2026) from the delegates of the accounts
 * that received a Uniswap v4 position in the 7 days before 24 Sep: 1,342 of 1,657 delegated accounts use one of
 * these. Every one is Sourcify-verified at its address, on 4663 or on chains whose code there equals 4663's byte
 * for byte, except where its line says otherwise. reports/eip7702-delegates-2026-09-25.json has the evidence.
 * Recognition is by code, not address: identical code behaves identically wherever it is deployed. It says
 * the code is a known wallet's, not that the account is safe: modules or keys the account installed live in its
 * own storage, which no code hash covers.
 */
export interface KnownDelegate {
  /** Who publishes it, as the person would name their wallet. */
  readonly wallet: string
  /** The verified contract and its version. */
  readonly contract: string
  /** Where it was read on Robinhood Chain. */
  readonly address: Address
  /** keccak256 of its runtime code there. */
  readonly codeHash: Hex
  /**
   * A proxy runs the implementation its account's own ERC-1967 slot names, so the proxy's code alone says nothing:
   * it is recognized only while that implementation's code is one of these.
   */
  readonly implementations?: readonly { readonly contract: string; readonly address: Address; readonly codeHash: Hex }[]
}

export const KNOWN_DELEGATES: readonly KnownDelegate[] = Object.freeze([
  { wallet: 'MetaMask', contract: 'EIP7702StatelessDeleGator 1.3.0', address: '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b', codeHash: '0xa06befcb6f1d7b6c566a607d9d5d932f9b267f3470e55940225c6ee9c4c5e6b0' },
  { wallet: 'Uniswap', contract: 'Calibur 1.0.0', address: '0x000000005c84f8fd50b21cac312528a64437030e', codeHash: '0xba697585ba58ba66ebd095ab4c7f980ed42ad115b2e3bb9b5b9bdf167bf08b1b' },
  { wallet: 'Uniswap', contract: 'Calibur 1.0.0', address: '0x612373d7003d694220f7800eeaf8e3924c0951d3', codeHash: '0xff0357b543bbb94845b6791a8becac5e87d467814f86538a62649c877227d631' },
  { wallet: 'Uniswap', contract: 'Calibur 1.0.0', address: '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00', codeHash: '0x7fa1bd2edb51499cb83a324acd9d0f35b31774cf8894e26fc13ac0474f4f57a4' },
  // Not verified at this address: its code is the verified Calibur's above, byte for byte, but for the two places
  // that hold the contract's own address.
  { wallet: 'Uniswap', contract: 'Calibur 1.0.0', address: '0xe8b12077f4f9c3e1b239a62f283fe4ef6ec9c449', codeHash: '0x7c14f7786d170873435db421ef3363025984b8b5b5f9963dd74859422bd8c9c3' },
  { wallet: 'Alchemy', contract: 'SemiModularAccount7702 1.1.0', address: '0x77021100bd87b7008e5e1989d0eb38555d0d0000', codeHash: '0x46fc4ecb190e16f7734d2ebe8f7e1d616a1b07c5e7cf1fc5c47dbb4e7c1a7ee0' },
  { wallet: 'Alchemy', contract: 'SemiModularAccount7702 1.0.0', address: '0x69007702764179f14f51cdce752f4f775d74e139', codeHash: '0xecfc0328ce4d953a4d452e11f54b578fa2d7f2f8126246d1120ca24d11845081' },
  { wallet: 'TokenPocket', contract: 'TokenPocketStatelessDelegator 1.1.0', address: '0x6c35fbcf24e57e5aa2e3aa2ca82e052499d02cf8', codeHash: '0xb47811be4a976fc14fb6d5e5f522e908f0ef200b11c42a5329dfb123440c7c9d' },
  { wallet: 'Coinbase', contract: 'EIP7702Proxy', address: '0x7702cb554e6bfb442cb743a7df23154544a7176c', codeHash: '0x002fe31551358806134e6166961fd583633bcbddd90160af866e0d71c26fcac9',
    implementations: [{ contract: 'CoinbaseSmartWallet', address: '0x000100abaad02f1cfc8bbe32bd5a564817339e72', codeHash: '0x179bcb847d3401ac830789a21cc37ed846fd5da9582a9c9d4b5140b6f26bd1a1' }] },
  { wallet: 'Simple7702Account', contract: 'Simple7702Account (EntryPoint v0.8)', address: '0xe6cae83bde06e4c305530e199d7217f42808555b', codeHash: '0xcc7b633aef4b2543cb8f37522adf1a401f910f0f6b2430c1eecc11f401ccfcf3' },
  { wallet: 'Ambire', contract: 'AmbireAccount7702', address: '0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d', codeHash: '0x386e55cb86f9a31fdb7926ceab54847aa4542b7a0517216144a956982a21ade3' },
  { wallet: 'ZeroDev', contract: 'Kernel 0.3.3', address: '0xd6cedde84be40893d153be9d467cd6ad37875b28', codeHash: '0x6f6d6691dc11fda98d3102802f20e7e816ccc576c16c9279ee1a884a51d1935d' },
  // Verified on chain 1; 4663's code differs from it only in the EIP-712 chain id and domain separator it caches.
  { wallet: 'Biconomy', contract: 'Nexus 1.2.0', address: '0x00000000383e8cbe298514674ea60ee1d1de50ac', codeHash: '0x410506042901d5b17d0cf1375da60f6bd5047d4fa5da2b2f6be7fb55c62183f0' },
] satisfies KnownDelegate[])

/** ERC-1967's implementation slot: where Coinbase's EIP7702Proxy keeps the account's implementation. */
export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

/**
 * What an account's code says about who controls it: no code, an EIP-7702 designator (with the delegate's entry
 * above, or null when its code is not one of them), or any other code.
 */
export type AccountCode =
  | { kind: 'plain' }
  | { kind: 'delegated'; delegate: Address; known: KnownDelegate | null }
  | { kind: 'contract' }

const fail = (code: string): never => { throw new Error(code) }
const CODE = /^0x(?:[0-9a-f]{2})*$/

/**
 * The delegate an EIP-7702 designator names: exactly `0xef0100` and a nonzero 20-byte address, as the backend's
 * session check reads it (backend/session_models.py). Anything else, a byte short or long included, is null.
 */
export function designatedDelegate(code: string): Address | null {
  const match = /^0xef0100([0-9a-f]{40})$/.exec(code.toLowerCase())
  return match && !/^0+$/.test(match[1]) ? `0x${match[1]}` : null
}

/** The recognized delegate at an address, for naming one; recognizing an account's code takes readAccountCode. */
export function knownDelegateAt(address: string): KnownDelegate | null {
  const wanted = address.toLowerCase()
  return KNOWN_DELEGATES.find((entry) => entry.address === wanted) ?? null
}

/**
 * The account's code at `block`, read through the wallet's own provider: no signature, no transaction. A delegate
 * is recognized by the hash of its code read at the same block, and a proxy entry also by its implementation's.
 * A reply that is not code or a storage word throws, as every other read of the finance clients does.
 */
export async function readAccountCode(read: (method: string, params: unknown[]) => Promise<unknown>, owner: Address,
  block = 'latest', table: readonly KnownDelegate[] = KNOWN_DELEGATES): Promise<AccountCode> {
  const code = async (address: string) => {
    const value = await read('eth_getCode', [address, block])
    return typeof value === 'string' && CODE.test(value.toLowerCase()) ? value.toLowerCase() as Hex : fail('invalid_wallet_reply')
  }
  const own = await code(owner)
  if (own === '0x') return { kind: 'plain' }
  const delegate = designatedDelegate(own)
  if (delegate === null) return { kind: 'contract' }
  const hash = keccak256(await code(delegate))
  const entry = table.find((known) => known.codeHash === hash) ?? null
  if (entry?.implementations) {
    const word = await read('eth_getStorageAt', [owner, ERC1967_IMPLEMENTATION_SLOT, block])
    if (typeof word !== 'string' || !/^0x[0-9a-f]{64}$/.test(word.toLowerCase())) return fail('invalid_wallet_reply')
    // A slot that holds anything but an address names no implementation.
    const slot = word.toLowerCase()
    const implementation = /^0x0{24}/.test(slot) ? `0x${slot.slice(26)}` : null
    const current = implementation === null ? null : keccak256(await code(implementation))
    if (!entry.implementations.some((known) => known.codeHash === current)) return { kind: 'delegated', delegate, known: null }
  }
  return { kind: 'delegated', delegate, known: entry }
}
