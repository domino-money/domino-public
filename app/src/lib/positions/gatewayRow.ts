/**
 * A position's page while the site's own chain routes cannot answer (RPC-SPEC D2 and P2, 2026-10-01): one row for its
 * header, from rugged97's read gateway through the site's read bridge, the page's existing other source. The NFT's own
 * read (read-v1 `nft-positions`: its owner, pool key, range, liquidity, principal and unsettled fees at the gateway's
 * snapshot), its pool's price (`pool-market`), and its tokens' names (this visit's chain reads first, else read-v1
 * `token`).
 *
 * Nothing is computed that the gateway did not give: every figure is one of its answers, checked field by field, and the
 * row passes the wallet list's own parser (lib/walletPositions.ts parseWalletAnswer) before it is drawn. Any read that
 * is not `ok`, an NFT that is not live at the snapshot, a pool with hooks or a dynamic fee (none of Domino's), another
 * PositionManager, or a pool answer for another pool: no row (null), and the page keeps its calm unavailable state.
 *
 * 2026-10-02 (review of the RPC switch, finding 9): one block for every figure. The gateway reads the NFT and the pool
 * each at its own snapshot, one after the other; when the pool's is not the NFT's, the NFT is read again at the pool's
 * block (read-v1 `nft-positions` takes a block number), so the principal, the fees, the range status and the price the
 * page labels "at block N" are all of that one block. A second read that does not answer: no row.
 *
 * Pure apart from the reads it is handed: no storage, no network of its own (the read source is the page's one).
 */
import { ROBINHOOD_POSITION_MANAGER } from '../../config/chainIdentity'
import { chainToken } from '../chainTokens'
import { readWithin } from '../read/screens/screenRead'
import type { ReadSource } from '../read/types'
import { parseWalletAnswer, type WalletPosition, type WalletToken } from '../walletPositions'

const NATIVE = '0x0000000000000000000000000000000000000000'
const ADDRESS = /^0x[0-9a-f]{40}$/
const TOKEN_ID = /^[1-9]\d{0,77}$/
const NATIVE_TOKEN: WalletToken = { address: NATIVE, symbol: 'ETH', decimals: 18 }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const lower = (value: unknown): string | null => (typeof value === 'string' && ADDRESS.test(value.toLowerCase()) ? value.toLowerCase() : null)

/** One currency's name: native ETH, a token this visit's chain reads named, or the gateway's `token` read; null when not read. */
async function tokenOf(source: ReadSource, address: string, signal: AbortSignal): Promise<WalletToken | null> {
  if (address === NATIVE) return NATIVE_TOKEN
  const known = chainToken(address)
  if (known) return { address, symbol: known.symbol, decimals: known.decimals }
  const outcome = await readWithin(source, 'token', { token: address }, { signal })
  if (outcome.state !== 'ok') return null
  const asset = outcome.data.asset
  if (lower(asset.address) !== address) return null
  return { address, symbol: asset.symbol, decimals: asset.displayUnitsAvailable ? asset.decimals : null }
}

/**
 * `tokenId`'s NFT from the gateway at `blockNumber` (null: its latest snapshot), checked as a row needs it, with that
 * snapshot's block; null when the read is not `ok` or the NFT is not one of Domino's live positions there.
 */
async function nftAt(source: ReadSource, tokenId: string, blockNumber: number | null, signal: AbortSignal) {
  const nfts = await readWithin(source, 'nft-positions', { tokenIds: [tokenId], blockNumber }, { signal })
  if (nfts.state !== 'ok') return null
  const block = nfts.data.snapshot.number
  if (blockNumber !== null && block !== blockNumber) return null
  const nft = nfts.data.items.find((item) => item.tokenId === tokenId)
  if (!nft || nft.status !== 'owner_verified_at_snapshot') return null
  const key = nft.poolKey
  // Only a pool Domino can hold a position in: a fixed fee and no hooks (New position refuses any other).
  if (key.feeMode !== 'fixed' || lower(key.hooks) !== NATIVE || lower(nft.positionManager) !== ROBINHOOD_POSITION_MANAGER) return null
  const owner = lower(nft.owner)
  const currency0 = lower(key.currency0)
  const currency1 = lower(key.currency1)
  const poolId = typeof nft.poolId === 'string' ? nft.poolId.toLowerCase() : ''
  if (!owner || !currency0 || !currency1 || !Array.isArray(nft.principalRaw) || !Array.isArray(nft.unsettledFeesRaw)) return null
  return { nft, key, owner, currency0, currency1, poolId, block }
}

/**
 * `tokenId`'s row from the read gateway, with the NFT's owner and the block every figure of it is at: what the page draws,
 * with no action on it, until its own read answers. Null when any read is not `ok` or anything is not what was asked for.
 */
export async function readGatewayRow(source: ReadSource, tokenId: string, signal: AbortSignal): Promise<{ row: WalletPosition; block: number; owner: string } | null> {
  if (!TOKEN_ID.test(tokenId) || signal.aborted) return null
  try {
    const first = await nftAt(source, tokenId, null, signal)
    if (!first) return null
    const { currency0, currency1, poolId } = first

    const markets = await readWithin(source, 'pool-market', { poolId, includePriceHistory: false }, { signal })
    if (markets.state !== 'ok') return null
    const pool = markets.data.pool
    if (!isRecord(pool) || String(pool.poolId).toLowerCase() !== poolId || String(markets.data.poolId).toLowerCase() !== poolId) return null
    if (lower(pool.poolKey.currency0) !== currency0 || lower(pool.poolKey.currency1) !== currency1) return null
    // The price's own block: the NFT is read again there when the gateway read it at another (finding 9).
    const priced = pool.snapshot.number
    if (!Number.isSafeInteger(priced) || priced < 0) return null
    const at = priced === first.block ? first : await nftAt(source, tokenId, priced, signal)
    if (!at || at.poolId !== poolId || at.currency0 !== currency0 || at.currency1 !== currency1) return null
    const { nft, key, owner, block } = at

    const tokens = [await tokenOf(source, currency0, signal), await tokenOf(source, currency1, signal)] as const
    if (!tokens[0] || !tokens[1] || signal.aborted) return null

    const row = {
      tokenId,
      status: nft.liquidityRaw !== '0' ? 'open' : 'closed',
      poolId,
      currencies: [tokens[0], tokens[1]],
      fee: key.fee_pips,
      tickSpacing: key.tick_spacing,
      hooks: NATIVE,
      tickLower: nft.tickLower,
      tickUpper: nft.tickUpper,
      liquidity: nft.liquidityRaw,
      sqrtPriceX96: pool.sqrtPriceX96,
      tick: pool.tick,
      unclaimedFees: nft.unsettledFeesRaw,
      principal: nft.principalRaw,
    }
    // Every field as the wallet's list takes it, or no row at all.
    const parsed = parseWalletAnswer({ owner, block, positions: [row], deposits: [] }, owner)
    return parsed ? { row: parsed.positions[0], block: parsed.block, owner } : null
  } catch {
    return null
  }
}
