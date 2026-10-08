/** TEST ONLY: read-v6's current custody answer for the NFTs in the public-position fake chain. */
import { poolIdOf } from './browser-chain.mjs';
import { READ6, read6Answer } from './v2-auto-page.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';

export function plainPortfolio(chain, wallet, edit = () => {}) {
  return read6Answer('portfolio', 'portfolio-custody-lost', [[READ6.wallet, wallet]], (body) => {
    const template = body.positions[0];
    body.vaults = [];
    body.mandates = [];
    body.credits = [];
    body.positions = chain.positions.filter((position) => !position.burned).map((position) => {
      const pool = chain.pools[poolIdOf(position.key)] ?? { sqrtPriceX96: 2n ** 96n, tick: 0 };
      return {
        ...template, tokenId: String(position.tokenId), vault: null,
        state: {
          ...template.state, owner: position.holder.toLowerCase(),
          custody: { approved: null, subscriber: position.subscriber ?? null },
          freshness: { status: 'fresh', ageSeconds: 0 },
          pool: { dex: 4, ...position.key },
          tickLower: position.tickLower, tickUpper: position.tickUpper,
          liquidity: String(position.liquidity), sqrtPriceX96: String(pool.sqrtPriceX96), tick: pool.tick,
          inRange: pool.tick >= position.tickLower && pool.tick < position.tickUpper,
          feesOwed: (position.unclaimed ?? [0n, 0n]).map(String), principalAtSpot: ['0', '0'],
        },
      };
    });
    const currencies = new Set(body.positions.flatMap((item) => [item.state.pool.currency0, item.state.pool.currency1]));
    body.tokens = [...currencies].map((address) => {
      const token = address === ZERO ? { symbol: 'ETH', decimals: 18 } : chain.tokens[address];
      return { chainId: 4663, address, status: token ? 'available' : 'not_read', symbol: token?.symbol ?? null, decimals: token?.decimals ?? null, price: null, priceReason: 'no_qualified_price_source' };
    });
    edit(body);
  });
}
