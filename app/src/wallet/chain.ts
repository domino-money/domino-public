import { defineChain, numberToHex } from 'viem'
import { ROBINHOOD_EXPLORER, ROBINHOOD_ID, ROBINHOOD_NAME, ROBINHOOD_NATIVE, ROBINHOOD_RPC_URL } from '../config/chainIdentity'

/**
 * Robinhood Chain, the only network this app talks to.
 *
 * Declared here rather than imported from viem/chains so that the wallet
 * configuration names no RPC transport: anything the wallet feature asks of the
 * chain goes through the connected wallet's provider.
 *
 * Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G3): its id, name, currency, RPCs and explorer
 * are the chain registry's (config/chainIdentity.ts), here and in ADD_ROBINHOOD_CHAIN below; the same values.
 */
export const robinhoodChain = defineChain({
  id: ROBINHOOD_ID,
  name: ROBINHOOD_NAME,
  nativeCurrency: { ...ROBINHOOD_NATIVE },
  rpcUrls: { default: { http: [] } },
})

/**
 * What a wallet that does not know Robinhood Chain is asked to add (EIP-3085 wallet_addEthereumChain), fixed in this
 * build. Changed on purpose 2026-10-01 (audit C1, the owner's OK): until then the person had to add the network by
 * hand, and nothing on the site gave its details. The explorer is the one viem's chain registry names for chain 4663.
 * The wallet shows all of it to the person before it adds anything; the page never fetches these URLs.
 * Changed on purpose 2026-10-01 (RPC-SPEC, the owner's rule: nothing is read from a public RPC): the one RPC is the
 * chain's official one, the wallet's own RPC (config/chainIdentity.ts ROBINHOOD_RPC_URL); this site never reads it, and
 * the public fallback it offered beside it is gone. Pending rugged's answer on a public endpoint of his node (PLANO §5.6).
 */
export const ADD_ROBINHOOD_CHAIN = Object.freeze({
  chainId: numberToHex(ROBINHOOD_ID),
  chainName: ROBINHOOD_NAME,
  nativeCurrency: Object.freeze({ ...ROBINHOOD_NATIVE }),
  rpcUrls: Object.freeze([ROBINHOOD_RPC_URL]),
  blockExplorerUrls: Object.freeze([ROBINHOOD_EXPLORER]),
})
