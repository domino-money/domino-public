// How Create position funds a position from what the wallet holds
// (src/lib/create/depositPlan.ts): both tokens as the range pairs them, or one
// token alone, part of which DominoSetup.swap exchanges for the other inside
// the pool before the mint. Checked against the same v4-core helpers the
// paired amount and the mint use (pairAmount.ts, mintPlan.ts): after the
// split, the side kept and the side bought make the same liquidity across the
// mint's band, so the mint uses both. The swap's size is checked against a
// constant-liquidity pool simulated with v4-core's own swap math: the size the
// quotes settle on makes (nearly) the largest position any size makes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ASSISTED_SWAP_FEE_BPS, SWAP_QUOTES, costOf, depositPlan, endSqrtPrice, isqrt, liquidityAfterSwap, needsSides, priceAfterSwap, proceedsOf, quoteWithin, refineSplit, sizeSwap, splitFor, swapFeePips, withRoom } from '../.test-build/app/src/lib/create/depositPlan.js';
import { bandFor, bandLiquidity, mintPlanFor } from '../.test-build/app/src/lib/create/mintPlan.js';
import { pairedAmount } from '../.test-build/app/src/lib/create/pairAmount.js';
import { sqrtPriceAtTick } from '../.test-build/app/src/lib/read/screens/poolRange.js';

const terms = (tick, tickLower, tickUpper, feePips = 3000, assistedFeeBps = ASSISTED_SWAP_FEE_BPS, sqrtPriceX96 = sqrtPriceAtTick(tick), slippageBps = 50) => ({ sqrtPriceX96, tickLower, tickUpper, feePips, assistedFeeBps, slippageBps });

/** The liquidity each side covers across the mint's band at the terms' price (mintPlan.ts): [from token 0, from token 1]. */
function liquidities(t, amount0, amount1) {
  const band = bandFor(t.sqrtPriceX96, t.tickLower, t.tickUpper, t.slippageBps);
  assert.ok(band);
  return bandLiquidity(band, amount0, amount1);
}
/** Whether two liquidities are within 0.1% of each other. */
const within = (x, y, bps = 10n) => {
  const [low, high] = x < y ? [x, y] : [y, x];
  return high > 0n && (high - low) * 10_000n <= high * bps;
};
/** What a one-token balance becomes after `swapped` of it buys the other at `rate` (bought per sold, as a quote gives it): [amount0, amount1]. */
function afterSwap(balance, from, swapped, bought) {
  const kept = balance - swapped;
  return from === 0 ? [kept, bought] : [bought, kept];
}

// Prices and ranges the product meets: a 1:1 pool at the standard range, a narrow one, a range the price sits near the
// top of, and an ETH/USDC-like pool (18 and 6 decimals, a raw price near 2·10⁻⁹) around its price.
const INSIDE = [
  terms(0, -3600, 4080),
  terms(0, -600, 600, 500),
  terms(3900, -3600, 4080, 10000),
  terms(-200040, -201000, -199020, 500),
  terms(-200040, -201000, -199020, 3000, 0),
];

test('the assisted-swap fee Review estimates with is the V1 deployment’s 65 bps, the most DominoSetup allows', () => {
  assert.equal(ASSISTED_SWAP_FEE_BPS, 65);
  const setup = readFileSync(new URL('../../contracts/src/DominoSetup.sol', import.meta.url), 'utf8');
  assert.match(setup, /feeBps_ > 65\b/, 'the contract refuses a higher fee');
});

test('withRoom adds the slippage limit, rounded up, and leaves nothing as nothing', () => {
  assert.equal(withRoom(1_000_000n, 50), 1_005_000n);
  assert.equal(withRoom(1_000_001n, 50), 1_005_002n, '1,005,001.005 rounds up');
  assert.equal(withRoom(1n, 10), 2n, 'a single unit still gets room');
  assert.equal(withRoom(0n, 500), 0n);
});

test('costOf and proceedsOf are inverses: costOf is the least input that buys the amount, after the pool fee and the assisted fee', () => {
  // At a price of one, with no fees, a unit buys a unit.
  const par = terms(0, -600, 600, 0, 0, 1n << 96n);
  for (const amount of [1n, 999n, 10n ** 18n]) {
    assert.equal(costOf(amount, 0, par), amount);
    assert.equal(proceedsOf(amount, 1, par), amount);
  }
  // Both fees come off the input: 10⁶ × (1 − 0.30%) × (1 − 0.65%) = 990,519.5, rounded down.
  assert.equal(proceedsOf(1_000_000n, 0, terms(0, -600, 600, 3000, 65, 1n << 96n)), 990_519n);
  for (const t of INSIDE) {
    for (const from of [0, 1]) {
      for (const amount of [1n, 999n, 1_000_000n, 12_345_678_901_234_567n, 10n ** 18n]) {
        const gross = costOf(amount, from, t);
        assert.ok(gross > 0n);
        const bought = proceedsOf(gross, from, t);
        assert.ok(bought >= amount, `${t.feePips} pips from ${from}: ${gross} buys ${bought}, at least ${amount}`);
        // Close: the least such input, so one unit less falls short, and the overshoot is under one input unit's worth.
        assert.ok(proceedsOf(gross - 1n, from, t) < amount, `${gross - 1n} already buys ${amount}`);
        assert.ok(bought - amount <= proceedsOf(1n, from, t) + 1n);
        // And the other way round: what a gross buys never costs more than that gross.
        assert.ok(costOf(proceedsOf(amount, from, t), from, t) <= amount);
      }
      assert.equal(costOf(0n, from, t), 0n);
      assert.equal(proceedsOf(0n, from, t), 0n);
      assert.equal(proceedsOf(-5n, from, t), 0n);
    }
  }
  // A higher fee makes the same amount cost more.
  const cheap = terms(0, -600, 600, 500, 0), dear = terms(0, -600, 600, 10000, 65);
  assert.ok(costOf(10n ** 18n, 0, dear) > costOf(10n ** 18n, 0, cheap));
});

test('splitFor leaves the side kept and the side bought in the range’s ratio across the mint’s band: their liquidities agree within 0.1%', () => {
  for (const t of INSIDE) {
    assert.deepEqual(needsSides(t), [true, true]);
    for (const from of [0, 1]) {
      // In the ETH/USDC-like pool a few million wei buy a few units of USDC: its balances are ones that buy something.
      for (const balance of t.tickLower < -100000 ? [10n ** 18n, 10n ** 21n] : [10n ** 18n, 3_000_000_000n, 1_000_000n]) {
        const swapped = splitFor(balance, from, t);
        assert.ok(swapped > 0n && swapped < balance, `${t.tickLower}..${t.tickUpper} at ${t.sqrtPriceX96} from ${from}: ${swapped} of ${balance}`);
        const [l0, l1] = liquidities(t, ...afterSwap(balance, from, swapped, proceedsOf(swapped, from, t)));
        assert.ok(within(l0, l1), `${t.tickLower}..${t.tickUpper} from ${from}, ${balance}: liquidity ${l0} against ${l1}`);
      }
    }
  }
  // Near the top of the range the position is mostly token 1: from token 0 most of it is swapped, from token 1 little.
  const high = terms(3900, -3600, 4080);
  assert.ok(splitFor(10n ** 18n, 0, high) > 9n * 10n ** 17n);
  assert.ok(splitFor(10n ** 18n, 1, high) < 10n ** 17n);
  assert.equal(splitFor(0n, 0, high), 0n, 'nothing held, nothing swapped');
});

test('outside the range the position is one token: that token is kept whole, the other swapped whole', () => {
  const below = terms(-5000, -3600, 4080), above = terms(5000, -3600, 4080);
  assert.deepEqual(needsSides(below), [true, false], 'below the range, all token 0');
  assert.deepEqual(needsSides(above), [false, true], 'above it, all token 1');
  const balance = 7n * 10n ** 17n;
  assert.equal(splitFor(balance, 0, below), 0n);
  assert.equal(splitFor(balance, 1, below), balance);
  assert.equal(splitFor(balance, 1, above), 0n);
  assert.equal(splitFor(balance, 0, above), balance);
  // refineSplit has nothing to balance there and keeps the first split.
  assert.equal(refineSplit(balance, 1, below, balance, 123n), balance);
  assert.equal(refineSplit(balance, 0, above, balance, 123n), balance);
});

test('near an edge of the range the band decides: a price just below it still needs both tokens, since the mint may land inside', () => {
  // 20 ticks below the range's floor, with a 0.5% limit the band (±0.25% in square root, about ±50 ticks) reaches into the range.
  const edge = terms(-3620, -3600, 4080);
  assert.deepEqual(needsSides(edge), [true, true]);
  assert.ok(splitFor(10n ** 18n, 0, edge) > 0n, 'some token 0 is swapped for the token 1 the band may need');
  // With the smallest limit, 0.1%, the band stays below the floor: token 0 alone.
  assert.deepEqual(needsSides({ ...edge, sqrtPriceX96: sqrtPriceAtTick(-3700), slippageBps: 10 }), [true, false]);
});

test('a fee that takes everything buys nothing: costOf is out of reach and the plan is short, never a division by zero', () => {
  for (const [feePips, assistedFeeBps] of [[1_000_000, 65], [3000, 10_000], [-1, 65]]) {
    const t = terms(0, -600, 600, feePips, assistedFeeBps);
    assert.ok(costOf(1n, 0, t) > 10n ** 70n);
    assert.equal(proceedsOf(10n ** 18n, 0, t), 0n);
    const [need0, need1] = [1_000_000n, 1_000_000n];
    assert.equal(depositPlan({ terms: t, independent: 1, typedRaw: need1, need0, need1, slippageBps: 50, balances: [10n ** 30n, 0n] }).kind, 'short');
  }
});

test('refineSplit re-balances at the rate a quote shows: a worse rate than the fee-only estimate swaps more, a better one less, and the sides then agree at that rate', () => {
  const t = terms(0, -3600, 4080);
  const balance = 10n ** 18n;
  for (const from of [0, 1]) {
    const first = splitFor(balance, from, t);
    const estimate = proceedsOf(first, from, t);
    // A quote equal to the estimate changes (almost) nothing.
    const same = refineSplit(balance, from, t, first, estimate);
    assert.ok(same - first <= 1n && first - same <= 1n, `${same} against ${first}`);
    // Price impact: 2% less than the fees alone. Each unit sold buys less, so more is sold to buy the side the range needs.
    const worse = (estimate * 98n) / 100n;
    const refined = refineSplit(balance, from, t, first, worse);
    assert.ok(refined > first && refined < balance, `from ${from}: ${refined} after a worse quote, ${first} before`);
    const [l0, l1] = liquidities(t, ...afterSwap(balance, from, refined, (refined * worse) / first));
    assert.ok(within(l0, l1), `at the quoted rate the sides agree: ${l0} against ${l1}`);
    // Without the refinement, the worse rate leaves the side bought short.
    const [u0, u1] = liquidities(t, ...afterSwap(balance, from, first, worse));
    assert.ok(!within(u0, u1), 'the first split is off by the impact');
    // A better quote than the estimate: less is swapped.
    assert.ok(refineSplit(balance, from, t, first, (estimate * 102n) / 100n) < first);
    // Never more than the balance, never nothing: a quote of a single unit swaps (almost) everything, and a zero first split or quote is left as it came.
    const extreme = refineSplit(balance, from, t, first, 1n);
    assert.ok(extreme <= balance && extreme > first);
    assert.equal(refineSplit(balance, from, t, 0n, estimate), 0n);
    assert.equal(refineSplit(balance, from, t, first, 0n), first);
    assert.equal(refineSplit(10n, from, t, 10n ** 18n, 10n ** 30n), 1n, 'clamped to at least one unit');
  }
});

// The read stub's pool in the browser tests: ETH (18 decimals) / TOKEN (6), 0.30%, tick 0, the standard range.
const STUB = terms(0, -3600, 4080, 3000, 65, 1n << 96n);
/** What the position takes of each token when `typed` of token `independent` is typed: the typed amount and the paired one (pairAmount.ts). */
function needs(independent, typed, t = STUB) {
  const other = pairedAmount({ sqrtPriceX96: String(t.sqrtPriceX96), tickLower: t.tickLower, tickUpper: t.tickUpper, independent, amountRaw: String(typed) });
  assert.equal(other.kind, 'amount');
  return independent === 0 ? [typed, BigInt(other.raw)] : [BigInt(other.raw), typed];
}
const plan = (independent, typed, balances, slippageBps = 50, t = STUB) => {
  const [need0, need1] = needs(independent, typed, t);
  return depositPlan({ terms: t, independent, typedRaw: typed, need0, need1, slippageBps, balances });
};

test('depositPlan: with both tokens at hand, both are deposited with the slippage room, capped at what the wallet holds', () => {
  const typed = 1_000_000n; // 1 TOKEN
  const [need0, need1] = needs(1, typed);
  assert.ok(need0 > 1_000_000n && need0 < 1_200_000n, `1 TOKEN pairs with ${need0} wei here`);
  // Unknown balances: both, with the room; the chain decides at Create position.
  assert.deepEqual(plan(1, typed, null), { kind: 'both', amount0: withRoom(need0, 50), amount1: withRoom(need1, 50) });
  assert.deepEqual(plan(1, typed, [10n ** 18n, 10n ** 18n]), { kind: 'both', amount0: withRoom(need0, 50), amount1: withRoom(need1, 50) });
  // Exactly the need of each: the room is capped at the balance, and the mint is sized to what was deposited.
  assert.deepEqual(plan(1, typed, [need0, need1]), { kind: 'both', amount0: need0, amount1: need1 });
  assert.deepEqual(plan(1, typed, [need0 + 1n, 10n ** 18n]), { kind: 'both', amount0: need0 + 1n, amount1: withRoom(need1, 50) });
  // The room follows the slippage limit.
  assert.deepEqual(plan(1, typed, [10n ** 18n, 10n ** 18n], 500), { kind: 'both', amount0: withRoom(need0, 500), amount1: withRoom(need1, 500) });
});

test('depositPlan: short of the paired token, the typed amount is the budget, deposited alone and partly swapped', () => {
  const typed = 1_000_000n;
  const [need0] = needs(1, typed);
  for (const eth of [0n, need0 - 1n]) {
    const result = plan(1, typed, [eth, 5_000_000n]);
    const swapped = splitFor(typed, 1, STUB);
    assert.deepEqual(result, { kind: 'swap', from: 1, deposit: typed, swap: swapped, receive: proceedsOf(swapped, 1, STUB) });
    // What the position holds after the swap: the rest of the TOKEN and the ETH bought, in the range's ratio.
    const [l0, l1] = liquidities(STUB, result.receive, result.deposit - result.swap);
    assert.ok(within(l0, l1));
  }
  // ETH typed, TOKEN short: the same rule from token 0.
  const typedEth = 10n ** 15n;
  const result = plan(0, typedEth, [typedEth, 0n]);
  const swapped = splitFor(typedEth, 0, STUB);
  assert.deepEqual(result, { kind: 'swap', from: 0, deposit: typedEth, swap: swapped, receive: proceedsOf(swapped, 0, STUB) });
});

test('depositPlan: short of the typed token, the other pays for the whole position: its own share and the cost of the typed amount, with room', () => {
  const typed = 1_000_000n;
  const [need0, need1] = needs(1, typed);
  const whole = withRoom(need0 + costOf(need1, 0, STUB), 50);
  for (const token of [0n, typed - 1n]) {
    const result = plan(1, typed, [10n ** 18n, token]);
    const swapped = splitFor(whole, 0, STUB);
    assert.deepEqual(result, { kind: 'swap', from: 0, deposit: whole, swap: swapped, receive: proceedsOf(swapped, 0, STUB) });
    // The deposit covers the position as typed: after the swap each side is at least what it needs.
    assert.ok(result.deposit - result.swap >= need0, `${result.deposit - result.swap} ETH kept, ${need0} needed`);
    assert.ok(result.receive >= need1, `${result.receive} TOKEN bought, ${need1} needed`);
  }
  // Exactly the whole is enough; a unit less is not.
  assert.equal(plan(1, typed, [whole, 0n]).kind, 'swap');
  assert.deepEqual(plan(1, typed, [whole - 1n, 0n]), { kind: 'short', token: 1, have: 0n, need: typed });
  // ETH typed, only TOKEN held: TOKEN pays for both sides.
  const typedEth = 10n ** 15n;
  const [n0, n1] = needs(0, typedEth);
  const byToken = withRoom(n1 + costOf(n0, 1, STUB), 50);
  const result = plan(0, typedEth, [0n, 10n ** 18n]);
  assert.deepEqual(result, { kind: 'swap', from: 1, deposit: byToken, swap: splitFor(byToken, 1, STUB), receive: proceedsOf(splitFor(byToken, 1, STUB), 1, STUB) });
  assert.ok(result.receive >= n0 && result.deposit - result.swap >= n1);
});

test('depositPlan: with neither way open the wallet is short of the typed token, by how much it holds and needs', () => {
  const typed = 1_000_000n;
  assert.deepEqual(plan(1, typed, [0n, 0n]), { kind: 'short', token: 1, have: 0n, need: typed });
  assert.deepEqual(plan(1, typed, [5n, typed - 1n]), { kind: 'short', token: 1, have: typed - 1n, need: typed });
  assert.deepEqual(plan(0, 10n ** 15n, [10n ** 14n, 3n]), { kind: 'short', token: 0, have: 10n ** 14n, need: 10n ** 15n });
});

test('depositPlan outside the range: the one token the range takes is deposited as it is, or bought whole with the other', () => {
  // Below the range the position is all ETH: typing ETH needs no TOKEN at all.
  const below = terms(-5000, -3600, 4080, 3000, 65);
  const typed = 10n ** 15n;
  assert.deepEqual(plan(0, typed, [10n ** 18n, 0n], 50, below), { kind: 'both', amount0: withRoom(typed, 50), amount1: 0n });
  // Holding only TOKEN, all of the deposit is swapped for the ETH the range takes.
  const result = plan(0, typed, [0n, 10n ** 30n], 50, below);
  assert.equal(result.kind, 'swap');
  assert.equal(result.from, 1);
  assert.equal(result.swap, result.deposit, 'swapped whole');
  assert.ok(result.receive >= typed);
});

// ---------------------------------------------------------------------------
// The swap's size, against a pool that behaves as v4-core does
// ---------------------------------------------------------------------------

const Q96 = 1n << 96n;
/**
 * A pool of constant liquidity `L` around `sqrtPriceX96`, swapping as v4-core's SqrtPriceMath does, behind
 * DominoSetup.swap: the assisted fee off the gross, the pool's fee off the rest. `limit` is the swap's price limit;
 * a swap that would cross it is refused, as the contract refuses a partial fill. Returns [output, price after].
 */
function simulatedPool(t, L) {
  return (from, gross, limit) => {
    const net = gross - (gross * BigInt(t.assistedFeeBps)) / 10_000n;
    const curve = (net * (1_000_000n - BigInt(t.feePips))) / 1_000_000n;
    const p = t.sqrtPriceX96;
    if (curve <= 0n) return null;
    if (from === 0) {
      // getNextSqrtPriceFromAmount0RoundingUp, then getAmount1Delta rounded down.
      const after = (L * Q96 * p + (L * Q96 + curve * p) - 1n) / (L * Q96 + curve * p);
      if (limit !== undefined && after < limit) return null;
      return [(L * (p - after)) / Q96, after];
    }
    // getNextSqrtPriceFromAmount1RoundingDown, then getAmount0Delta rounded down.
    const after = p + (curve * Q96) / L;
    if (limit !== undefined && after > limit) return null;
    return [(L * Q96 * (after - p)) / after / p, after];
  };
}

test('priceAfterSwap reads the price a swap leaves from what it paid: exact along a constant-liquidity curve', () => {
  let checked = 0;
  for (const t of [terms(0, -3600, 4080), terms(-200040, -201000, -199020, 500)]) {
    for (const L of [10n ** 18n, 10n ** 21n, 10n ** 24n]) {
      const pool = simulatedPool(t, L);
      for (const from of [0, 1]) {
        for (const gross of [10n ** 12n, 10n ** 15n, 10n ** 17n]) {
          const swapped = pool(from, gross);
          // Enough output that its own rounding is far below the 0.01% asked.
          if (!swapped || swapped[0] <= 10n ** 7n) continue;
          const [output, after] = swapped;
          const inferred = priceAfterSwap(t, from, gross, output);
          assert.ok(inferred !== null);
          // Within 0.01% in square root: the rounding of a few units of output, nothing more.
          const gap = inferred > after ? inferred - after : after - inferred;
          assert.ok(gap * 10_000n <= after, `L ${L}, from ${from}, gross ${gross}: ${inferred} against ${after}`);
          assert.ok(from === 0 ? inferred <= t.sqrtPriceX96 : inferred >= t.sqrtPriceX96, 'the direction the swap moves it');
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 15, `${checked} swaps checked`);
  assert.equal(priceAfterSwap(terms(0, -600, 600), 0, 0n, 5n), null);
  assert.equal(priceAfterSwap(terms(0, -600, 600), 0, 5n, 0n), null);
});

/** The mint the operation makes after `gross` was swapped in the simulated pool, at the price the pool is really left at. */
function mintedAfter(t, pool, from, balance, gross) {
  const swapped = pool(from, gross);
  if (!swapped) return 0n;
  const [output, after] = swapped;
  const kept = balance - gross;
  const plan = mintPlanFor({ sqrtPriceX96: String(after), tickLower: t.tickLower, tickUpper: t.tickUpper, balance0: from === 0 ? kept : output, balance1: from === 0 ? output : kept, slippageBps: t.slippageBps });
  return plan ? plan.liquidity : 0n;
}

test('sizeSwap settles, in at most ten quotes, on a size whose position is within 0.2% of the largest any size makes, even with a 5% price impact', async () => {
  const cases = [
    [terms(0, -3600, 4080), 10n ** 24n, 10n ** 20n], // deep pool: next to no impact
    [terms(0, -3600, 4080), 10n ** 21n, 10n ** 20n], // shallow pool: several percent of impact
    [terms(0, -600, 600, 500), 10n ** 22n, 10n ** 20n], // narrow range
    [terms(3900, -3600, 4080, 10000), 10n ** 22n, 10n ** 20n], // price near the top of the range
    [terms(-200040, -201000, -199020, 500), 10n ** 16n, 10n ** 18n], // ETH/USDC-like decimals
  ];
  for (const [t, L, balance] of cases) {
    const pool = simulatedPool(t, L);
    for (const from of [0, 1]) {
      const bal = from === 0 ? balance : (t.tickLower < -100000 ? 10n ** 9n : balance);
      let asked = 0;
      const sized = await sizeSwap(t, from, bal, async (gross) => {
        asked++;
        const swapped = pool(from, gross);
        return swapped ? swapped[0] : null;
      });
      assert.ok(sized, `${t.tickLower}..${t.tickUpper}, L ${L}, from ${from}: a size`);
      assert.ok(asked <= SWAP_QUOTES, `${asked} quotes`);
      // The best any size makes, found by brute force over a fine grid around the answer and across the whole balance.
      let best = 0n;
      for (let i = 1n; i < 400n; i++) {
        const coarse = mintedAfter(t, pool, from, bal, (bal * i) / 400n);
        if (coarse > best) best = coarse;
      }
      for (let i = -200n; i <= 200n; i++) {
        const g = sized.gross + (sized.gross * i) / 20_000n;
        if (g <= 0n || g >= bal) continue;
        const fine = mintedAfter(t, pool, from, bal, g);
        if (fine > best) best = fine;
      }
      const got = mintedAfter(t, pool, from, bal, sized.gross);
      assert.ok(got * 1000n >= best * 998n, `${t.tickLower}..${t.tickUpper}, L ${L}, from ${from}: ${got} against the best ${best}`);
      // What the sizer expected of the mint agrees with what the mint then makes at the price the pool is really at.
      assert.ok(got <= sized.liquidity && got * 1000n >= sized.liquidity * 995n, `expected ${sized.liquidity}, made ${got}`);
    }
  }
});

test('sizeSwap backs off a size the pool refuses, and gives up only when every size is refused', async () => {
  const t = terms(0, -3600, 4080);
  const pool = simulatedPool(t, 10n ** 21n);
  // A price limit 1% below the price, in square root: the balanced size would cross it, so a smaller one is found.
  const limit = (t.sqrtPriceX96 * 9900n) / 10000n;
  const balance = 10n ** 21n;
  const sized = await sizeSwap(t, 0, balance, async (gross) => {
    const swapped = pool(0, gross, limit);
    return swapped ? swapped[0] : null;
  });
  assert.ok(sized && sized.gross > 0n);
  assert.ok(pool(0, sized.gross, limit), 'the size settled on is one the pool fills inside the limit');
  assert.equal(await sizeSwap(t, 0, balance, async () => null), null, 'nothing fills: no size');
  assert.equal(await sizeSwap(t, 0, 0n, async () => 1n), null, 'nothing held: no size');
});

test('sizeSwap swaps the whole deposit when the range takes only the other token', async () => {
  const above = terms(5000, -3600, 4080);
  const pool = simulatedPool(above, 10n ** 24n);
  const balance = 10n ** 18n;
  const sized = await sizeSwap(above, 0, balance, async (gross) => pool(0, gross)?.[0] ?? null);
  assert.ok(sized);
  assert.ok(sized.gross * 1000n >= balance * 999n, `${sized.gross} of ${balance}`);
  const after = liquidityAfterSwap(above, 0, balance, sized.gross, sized.output);
  assert.equal(after.kept, null, 'the kept token is not needed above the range');
});

// ---------------------------------------------------------------------------
// Before a one-token deposit: the pool's own quotes, and where a swap ends
// ---------------------------------------------------------------------------

test('swapFeePips is v4-core’s calculateSwapFee on the packed protocol fees read on Robinhood Chain (2026-09-23)', () => {
  // [packed slot0.protocolFee, lpFee, the fee a swap pays in pips]: the same both ways, 12 bits per direction.
  const onChain = [
    [213044, 200, 252], // WETH/USDG: 52/52 on 200
    [2048500, 3000, 3499], // PONS/USDG: 500/500 on 3000
    [4097000, 80000, 80920], // USDG/NET 8%, the owner's pool: 1000/1000 on 80000
    [4097000, 50000, 50950], // USDG/MARLIN: 1000/1000 on 50000
    [1073414, 1500, 1762], // USDG/cbBTC: 262/262 on 1500
    [81940, 75, 95], // USDG/U: 20/20 on 75
    [102425, 100, 125], // ETH/USDG: 25/25 on 100
    [0, 3000, 3000], // no protocol fee: the LP fee alone
  ];
  for (const [raw, lp, fee] of onChain) {
    assert.equal(swapFeePips(lp, raw, true), fee, `${raw} on ${lp}, token 0 in`);
    assert.equal(swapFeePips(lp, raw, false), fee, `${raw} on ${lp}, token 1 in`);
  }
  // One direction each: token 0 in reads the low 12 bits, token 1 in the high 12.
  const packed = (1000 << 12) | 0;
  assert.deepEqual([swapFeePips(3000, packed, true), swapFeePips(3000, packed, false)], [3000, 3997]);
  assert.deepEqual([swapFeePips(3000, 250, true), swapFeePips(3000, 250, false)], [3250, 3000]);
});

test('isqrt is the floor of the square root, at the sizes the price maths meets', () => {
  for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 99n, 100n, 101n, 2n ** 96n, 2n ** 192n, 2n ** 192n - 1n, 3n ** 200n, 91475816417046462998559025046n ** 2n, 91475816417046462998559025046n ** 2n - 1n]) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1n) * (r + 1n) > n, `isqrt(${n}) = ${r}`);
  }
  assert.equal(isqrt(91475816417046462998559025046n ** 2n), 91475816417046462998559025046n, 'the owner’s pool’s square-root price squared, back to itself');
  assert.equal(isqrt(-5n), 0n);
});

/** Two quotes of one pool at net and net + step, as V4Quoter answers them: [out, outNext], or null when it cannot fill. */
const twoQuotes = (quote, from, net, step) => {
  const first = quote(from, net), second = quote(from, net + step);
  return first && second ? [first[0], second[0]] : null;
};

test('endSqrtPrice reads where a swap ends from two quotes of it, within 0.1 bps along a constant-liquidity curve, both ways', () => {
  let checked = 0;
  // The quoter is asked for the net amount: no assisted fee, the pool's own fee only. Moves up to 10% in square root,
  // the band the swap's 5% limit lives in, with outputs large enough that a unit of rounding is far below 0.1 bps.
  for (const t of [terms(0, -3600, 4080, 3000, 0), terms(0, -3600, 4080, 80920, 0), terms(-200040, -201000, -199020, 252, 0)]) {
    for (const L of [10n ** 20n, 10n ** 22n]) {
      const quote = simulatedPool(t, L);
      for (const from of [0, 1]) {
        for (const net of [10n ** 16n, 10n ** 18n, 5n * 10n ** 18n]) {
          const swapped = quote(from, net);
          if (!swapped || swapped[0] <= 10n ** 12n) continue;
          const truth = swapped[1];
          const move = truth > t.sqrtPriceX96 ? truth - t.sqrtPriceX96 : t.sqrtPriceX96 - truth;
          if (move * 10n > t.sqrtPriceX96) continue;
          const step = net / 10_000n > 1_000n ? net / 10_000n : 1_000n;
          const [out, outNext] = twoQuotes(quote, from, net, step);
          const end = endSqrtPrice(from === 0, step, outNext - out, t.feePips);
          assert.ok(end !== null);
          const gap = end > truth ? end - truth : truth - end;
          assert.ok(gap * 100_000n <= truth, `fee ${t.feePips}, L ${L}, from ${from}, net ${net}: ${end} against ${truth}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked >= 20, `${checked} swaps checked`);
  assert.equal(endSqrtPrice(true, 0n, 5n, 3000), null, 'no step');
  assert.equal(endSqrtPrice(true, 5n, 0n, 3000), null, 'nothing more out: the pool says nothing');
  assert.equal(endSqrtPrice(false, 5n, 5n, 1_000_000), null, 'a fee that takes everything');
  assert.equal(endSqrtPrice(false, 5n, 5n, 1.5), null);
});

test('quoteWithin refuses a size the pool cannot fill or that would end past the check, and sizeSwap backs off to one that ends inside it', async () => {
  // A pool so shallow that the balanced split would move the square-root price far past 5%.
  const t = terms(0, -3600, 4080);
  const L = 2n * 10n ** 19n;
  const behindSetup = simulatedPool(t, L); // the setup contract's swap of a gross amount
  const quoter = simulatedPool({ ...t, assistedFeeBps: 0 }, L); // the quoter's answer for the net amount
  const balance = 10n ** 19n;
  for (const from of [0, 1]) {
    const zeroForOne = from === 0;
    const limit = (t.sqrtPriceX96 * (zeroForOne ? 9500n : 10500n)) / 10000n;
    const check = (t.sqrtPriceX96 * (zeroForOne ? 9550n : 10450n)) / 10000n;
    const balanced = splitFor(balance, from, t);
    assert.equal(behindSetup(from, balanced, limit), null, 'the balanced split would pass the swap’s 5% limit');
    const asked = [];
    const ask = async (net, step) => {
      asked.push([net, step]);
      const both = twoQuotes(quoter, from, net, step);
      return both ? { kind: 'quote', out: both[0], outNext: both[1] } : { kind: 'refused', reason: 'not_enough_liquidity' };
    };
    const sized = await sizeSwap(t, from, balance, quoteWithin(t.assistedFeeBps, zeroForOne, t.feePips, check, ask));
    assert.ok(sized, `from ${from}: a size`);
    assert.ok(sized.gross < balanced, `from ${from}: backed off from ${balanced} to ${sized.gross}`);
    // What the quoter said for it is what the setup contract's swap of it gives, and that swap fills inside the limit.
    const filled = behindSetup(from, sized.gross, limit);
    assert.ok(filled, `from ${from}: the setup contract fills ${sized.gross} inside its limit`);
    assert.equal(sized.output, filled[0]);
    assert.ok(zeroForOne ? filled[1] > check - check / 100_000n : filled[1] < check + check / 100_000n, 'it ends inside the check');
    // Every size was asked net of the assisted fee, with a step of a ten-thousandth, at least 1,000 units.
    for (const [net, step] of asked) assert.equal(step, net / 10_000n > 1_000n ? net / 10_000n : 1_000n);
    assert.ok(asked.length <= SWAP_QUOTES);
  }
  const refusing = quoteWithin(65, true, 3000, 1n, async () => ({ kind: 'refused', reason: 'not_enough_liquidity' }));
  assert.equal(await refusing(10n ** 18n), null, 'refused by the pool');
  assert.equal(await sizeSwap(t, 0, balance, refusing), null, 'a pool that refuses every size: no size, and so no deposit');
  const flat = quoteWithin(65, true, 3000, 1n, async () => ({ kind: 'quote', out: 10n, outNext: 10n }));
  assert.equal(await flat(10n ** 18n), null, 'nothing more for more in: says nothing');
  assert.equal(await quoteWithin(10_000, true, 3000, 1n, async () => assert.fail('never asked'))(10n ** 18n), null, 'nothing left after the fee');
});
