/**
 * TEST-ONLY. A wallet of any size for the Positions Wallet card (incident of 2026-10-13, package D2, 2026-10-14),
 * mirroring the owner's live numbers of 2026-10-14: wallet-assets pages of up to 20 tokens beside native ETH (read-v1's
 * bound on a provider page's rows), some rows with a zero balance, and a provider table where the three largest holdings
 * have qualified pairs (UFG $2,609.94, AI $784.94, SCORE $18.58), ten more are dust with a qualified pair, five have a
 * pool too thin to count, and every other one has no market at all.
 */
const ZERO = '0x0000000000000000000000000000000000000000';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const E18 = 10n ** 18n;

/** A pair on Robinhood Chain quoting `address` against USDG at `usd`, holding `liquidity` dollars. */
export function pairFor(address, symbol, usd, liquidity) {
  return {
    chainId: 'robinhood', dexId: 'uniswap', pairAddress: `0x${address.slice(2, 34)}${'ab'.repeat(16)}`,
    baseToken: { address, symbol }, quoteToken: { address: USDG, symbol: 'USDG' },
    priceUsd: usd, priceNative: usd, liquidity: { usd: liquidity },
  };
}

const nth = (n) => `0x${(0xa11ce000 + n).toString(16).padStart(40, '0')}`;

/** A selected pool's token (config/selectedPoolCatalogue.ts): one of the tokens Domino knows. */
export const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
/**
 * Review of D2 (2026-10-14): 1,000 PONS at $1 in a $50,000 pool ($1,000.00), as a scaleWallet `late` holding: one the
 * wallet started holding after an earlier visit (a collect or a withdraw from a PONS pool), listed on the last page.
 */
export const PONS_HOLDING = [PONS, 'PONS', 18, String(1_000n * E18), [pairFor(PONS, 'PONS', '1', 50_000)]];

/**
 * `held` tokens with a balance (native ETH and USDG among them), `zeros` rows with none, spread over pages of `perPage`
 * ERC-20 rows each (native ETH heads every page, as the read service lists it); `more`: the last page says there are
 * more (a list longer than the card reads). `bigLate`: UFG is listed last, after the first 30 held tokens, instead of among
 * the first ten. `late`: more holdings ([address, symbol, decimals, raw balance, pairs], PONS_HOLDING), listed after
 * every other row, on the last page. `firstBlock`: the first page's block, each next page one more (a list read after a
 * confirmed action's receipt block). Returns the pages (gateway bodies, by cursor), the held tokens and rows, and the
 * provider's table. The priced tokens add up to $3,421.98 (UFG, AI, SCORE, 0.002 ETH at $4,000, 0.5 USDG and ten dust
 * tokens of $0.002), the `late` ones aside.
 */
export function scaleWallet({ held, zeros = 0, perPage = 16, more = false, bigLate = false, late = [], firstBlock = 700, now = Math.floor(Date.now() / 1000) }) {
  const tokens = [];
  // [address, symbol, decimals, raw balance, pairs]
  tokens.push([USDG, 'USDG', 6, '500000', null]);
  const ufg = [UFG, 'UFG', 18, String(1_000_000n * E18), [pairFor(UFG, 'UFG', '0.00260994', 150_000)]];
  const ai = [nth(1), 'AI', 18, String(1_000n * E18), [pairFor(nth(1), 'AI', '0.78494', 50_000)]];
  const score = [nth(2), 'SCORE', 18, String(1_000n * E18), [pairFor(nth(2), 'SCORE', '0.01858', 20_000)]];
  const filler = [];
  for (let i = 0; filler.length < Math.max(0, held - 5); i++) {
    const address = nth(100 + i), symbol = `TK${String(i).padStart(3, '0')}`;
    // Ten dust tokens with a qualified pair ($0.002 each), five with a pool too thin to count, the rest no market.
    const pairs = i < 10 ? [pairFor(address, symbol, '0.001', 12_000)] : i < 15 ? [pairFor(address, symbol, '5', 500)] : [];
    filler.push([address, symbol, 18, String(2n * E18), pairs]);
  }
  const named = bigLate ? [ai, score] : [ufg, ai, score];
  tokens.push(...named.slice(0, Math.max(0, held - 2)));
  const lead = filler.slice(0, bigLate ? 26 : 6);
  tokens.splice(1, 0, ...lead);
  tokens.push(...filler.slice(lead.length));
  if (bigLate && held >= 3) tokens.push(ufg);
  const heldTokens = tokens.slice(0, Math.max(0, held - 1));
  for (let i = 0; i < zeros; i++) heldTokens.push([nth(5000 + i), `ZZ${String(i).padStart(3, '0')}`, 18, '0', null]);
  heldTokens.push(...late);
  const pairs = new Map(heldTokens.filter(([, , , , list]) => list).map(([address, , , , list]) => [address, list]));
  pairs.set(WETH, [pairFor(WETH, 'WETH', '4000', 5_000_000)]);
  const item = ([address, symbol, decimals, amountRaw]) => ({
    address, amountRaw, balanceStatus: 'read_at_block', decimals, discoveredByProvider: true, displayUnitsAvailable: true,
    executionAvailable: false, kind: 'erc20_candidate', metadataIssues: {}, readStatus: 'available', requestedByAddress: false, symbol,
  });
  const native = { address: ZERO, amountRaw: String(2n * 10n ** 15n), balanceStatus: 'read_at_block', decimals: 18, discoveredByProvider: false, displayUnitsAvailable: true, executionAvailable: false, kind: 'native', metadataIssues: {}, readStatus: 'available', requestedByAddress: false, symbol: 'ETH' };
  const chunks = [];
  for (let i = 0; i < heldTokens.length; i += perPage) chunks.push(heldTokens.slice(i, i + perPage));
  if (chunks.length === 0) chunks.push([]);
  const cursor = (n) => n.toString(16).padStart(64, 'c');
  const pages = new Map(chunks.map((chunk, index) => {
    const last = index === chunks.length - 1;
    const hasMore = !last || more;
    const items = [native, ...chunk.map(item)];
    return [index === 0 ? null : cursor(index), JSON.stringify({
      balanceCoverage: 'requested_and_page_addresses_only', chainId: 4663,
      inventory: { asOfBlock: null, candidatesProbed: chunk.length, candidatesSkipped: 0, coverage: 'provider_page_only', excludedRows: 0, hasMore, nextCursor: hasMore ? cursor(index + 1) : null, retrievedAt: now, rowsReceived: chunk.length, skippedReason: null, source: 'alchemy', status: 'page_received' },
      items, liveExecution: false, mode: 'public_address_read_only', schemaVersion: 2,
      snapshot: { hash: `0x${'ab'.repeat(32)}`, number: firstBlock + index, timestamp: now }, unavailableAssets: [], walletControlVerified: false,
    })];
  }));
  const rows = [[ZERO, 'ETH', 18, native.amountRaw], ...heldTokens.filter(([, , , raw]) => raw !== '0').map(([address, symbol, decimals, raw]) => [address, symbol, decimals, raw])];
  return {
    pages,
    /** Every token with a balance, native ETH first. */
    held: rows.map(([address]) => address),
    /** Every held token as [address, symbol, decimals, raw balance], native ETH first. */
    rows,
    pairs,
    /** The token addresses a page names as held (ERC-20 only). */
    listed: heldTokens.map(([address]) => address),
  };
}

/** The qualified quote the provider's table gives `address` (the most liquid pair of at least $10,000), or null. */
function quoteOf(wallet, address) {
  const best = (wallet.pairs.get(address === ZERO ? WETH : address) ?? []).filter((pair) => pair.liquidity.usd >= 10_000).sort((a, b) => b.liquidity.usd - a.liquidity.usd)[0];
  return best ? [best.priceUsd, best.liquidity.usd] : null;
}

/**
 * The Wallet card's entry in this browser (lib/walletMemory.ts, `domino-wallet-v2:4663`) as an earlier visit at `at`
 * (wall ms) left it: the list read whole, every held token, and each token's price as the provider gave it then. The
 * tokens in `lost` had a qualified price then (`lostQuote`: [usd, liquidity]) that the provider's table no longer gives.
 * The tokens in `without` were not held then (neither row nor price). USDG is never asked, so never kept.
 */
export function rememberedWallet(owner, wallet, at, { lost = [], lostQuote = ['5', 12_000], without = [] } = {}) {
  const rows = wallet.rows.filter(([address]) => !without.includes(address));
  const sources = [...new Set(rows.map(([address]) => (address === ZERO ? WETH : address)).filter((address) => address !== USDG))];
  const quotes = sources.map((source) => {
    const quote = lost.includes(source) ? lostQuote : quoteOf(wallet, source);
    return [source, quote ? quote[0] : null, quote ? quote[1] : null, at];
  });
  return { v: 1, wallets: { [owner]: { at, whole: true, rows: rows.map(([address, symbol, decimals, raw]) => [address, symbol, decimals, raw, 700]), quotes } } };
}

/** The address of the `i`th filler token (TK000 is 0): TK010 to TK014 have a pool too thin to count. */
export const fillerAddress = (i) => nth(100 + i);

/** The read stub's gateway answer for wallet-assets, by page (the request's cursor). */
export function walletAssetsAnswer(wallet, onAsk = () => undefined) {
  return (route, body) => {
    if (route !== 'wallet-assets') return undefined;
    onAsk(body);
    return wallet.pages.get(body.cursor ?? null);
  };
}
