/**
 * A small exact ledger and its verified view (2026-10-02, RPC-SPEC §11.4), for the tests of what keeps or shows a
 * verified history (lib/fees/historyCache.ts, store.ts): a mint, an owner's collect, and an automatic compound (its
 * collect and re-add in one block), folded with the state at the ledger's block (lib/fees/ledger.ts). Not a suite of its own.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { foldLedger } = require('../../../.test-build/app/src/lib/fees/ledger.js');

export const ID = '7';
export const POOL = `0x${'ab'.repeat(32)}`;
export const T0 = 1_790_000_000;
export const B0 = 70_000_000;
const HASH = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const at = (block) => T0 + Math.floor((block - B0) / 10);
const CURRENCIES = [{ address: `0x${'01'.repeat(20)}`, symbol: 'AAA', decimals: 18 }, { address: `0x${'02'.repeat(20)}`, symbol: 'BBB', decimals: 6 }];

/** The ledger's own state at its block (a /state position). */
export function statePosition(patch = {}) {
  return {
    tokenId: ID, ok: true, owner: `0x${'11'.repeat(20)}`, poolId: POOL,
    poolKey: { currency0: CURRENCIES[0].address, currency1: CURRENCIES[1].address, fee: 3000, tickSpacing: 60, hooks: `0x${'00'.repeat(20)}` },
    currencies: CURRENCIES.map((one) => ({ ...one })), tickLower: -6000, tickUpper: 6000, liquidity: '3000', sqrtPriceX96: (2n ** 96n).toString(), tick: 0,
    feeGrowthInside0X128: '900', feeGrowthInside1X128: '900', feeGrowthInside0LastX128: '700', feeGrowthInside1LastX128: '800', unclaimed0: '5', unclaimed1: '6',
    ...patch,
  };
}

const entry = (block, kind, delta, fees, more = {}) => ({ block, index: 1, tx: HASH(block), t: at(block), kind, delta: String(delta), fees: fees && fees.map(String), ...more });

/** A ledger read (the store's LedgerRead): exact unless said, at `block`. */
export function ledgerRead({ block = B0 + 100_000, exact = true, why } = {}) {
  const entries = [entry(B0, 'mint', 1000, [0, 0]), entry(B0 + 10_000, 'collect', 0, [10, 20]), entry(B0 + 50_000, 'collect', 0, [30, 40], { auto: true, service: ['1', '2'] }), { ...entry(B0 + 50_000, 'increase', 2000, [0, 0], { auto: true }), index: 2 }];
  return { position: { tokenId: ID, ok: true, through: block, state: statePosition(), mint: { block: B0, tx: HASH(B0), t: at(B0) }, entries, exact, ...(why ? { why } : {}) }, block, timestamp: at(block) };
}

/** The PositionState of `read`'s own state, with `patch`. */
export function stateAt(read, patch = {}) {
  return { block: read.block, timestamp: read.timestamp, unclaimed: [5n, 6n], sqrtPriceX96: 2n ** 96n, tick: 0, tickLower: -6000, tickUpper: 6000, liquidity: 3000n, poolId: POOL, owner: `0x${'11'.repeat(20)}`, currencies: CURRENCIES.map((one) => ({ ...one })), ...patch };
}

/** The verified view of the default ledger and its state. */
export function verifiedView() {
  const read = ledgerRead();
  return foldLedger(read, stateAt(read));
}
