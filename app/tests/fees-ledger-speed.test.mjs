/**
 * How many answers a position's Fees earned and Your APR wait for (2026-11-09, the owner: "I don't want slowness, the site
 * is live"): the ledger route (functions/_lib/feesLedger.ts) over a fake node that takes POST_MS a POST, a position 1, 10
 * and 35 days old with a collect every week, asked again REASK_MS after each `reading` answer (lib/fees/store.ts
 * LEDGER_READING_MS), with and without the mint hint the page sends; and a list of eight positions of different ages,
 * each id asked alone after the first batch (the store before 2026-11-09) or the ids still being read together (after).
 * Prints the measures (node --test diagnostics) and holds the route to them. Nothing reaches the network.
 *
 * Measured on origin/main d1538069 (one window an answer, each `reading` id asked again alone), POST_MS 250:
 *   1 day   1 answer,   9 POSTs,  2.3 s        10 days  9 answers,  43 POSTs, 26.8 s
 *   35 days 31 answers, 137 POSTs, 94.3 s (33 answers, 143 POSTs, 99.8 s without the hint)
 *   the list of eight: 31 rounds, 118 requests, 526 POSTs, 99.3 s
 * and after (2026-11-09): 1 day 1 answer; 10 days 1 answer, 26 POSTs, 6.5 s; 35 days 3 answers, 74 POSTs, 22.5 s (76,
 * 23 s cold); the list together 4 rounds, 4 requests, 102 POSTs, 31.5 s (each alone on the new route: 3 rounds, 13
 * requests, 310 POSTs, 24.3 s).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fakeNode } from './support/fake-node.mjs';
import { RPC_URL } from './support/browser-chain.mjs';
import { memoryCache } from './support/fees/fake-chain.mjs';
import { HOLDER, KEY, OWNER_STATE, ledgerWorld } from './support/fees/ledger-world.mjs';
import { positionLogs, txOf } from './support/fees/ledger-chain.mjs';

const require = createRequire(import.meta.url);
const routes = require('../.test-build/app/functions/_lib/chainRoutes.js');

const ORIGIN = 'https://domino.money';
const ENV = { LOCAL_RPC_URL: 'https://rpc.domino.money/test-token-0123456789abcdef/' };
/** Robinhood Chain makes about 0.85 million blocks a day (about 9.9 a second). */
const BLOCKS_PER_DAY = 850_000;
const HEAD = 110_000_000;
/** The model's round trip of one POST to the node through the tunnel. */
const POST_MS = 250;
/** lib/fees/store.ts LEDGER_READING_MS: a `reading` ledger is asked again this soon. */
const REASK_MS = 2_000;

/** Positions of `ages` days, each a plain one with its own mint and a collect every week, on one chain. */
function world(ages) {
  const poolId = ledgerWorld().poolId;
  const positions = ages.map((days, i) => {
    const tokenId = 7_000_000n + BigInt(i);
    const mint = { block: HEAD - Math.round(days * BLOCKS_PER_DAY), liquidity: 10n ** 15n };
    const steps = [];
    // A week after the mint, then every week, never in another position's mint block.
    for (let at = mint.block + 7 * BLOCKS_PER_DAY + 1_234; at < HEAD - 1_000; at += 7 * BLOCKS_PER_DAY) steps.push({ block: at, kind: 'collect', fees: [1_000n + BigInt(i), 2_000n] });
    return { tokenId, mint, steps };
  });
  const [first, ...rest] = positions;
  const range = { tickLower: OWNER_STATE.tickLower, tickUpper: OWNER_STATE.tickUpper };
  const extra = rest.map((p) => positionLogs({ tokenId: p.tokenId, owner: HOLDER, key: KEY, poolId, ...range, vault: null, mint: p.mint, steps: p.steps }));
  const { chain } = ledgerWorld({
    tokenId: first.tokenId,
    vault: null,
    mint: first.mint,
    steps: first.steps,
    head: HEAD,
    extraLogs: extra.flatMap((one) => one.logs),
    extraPositions: rest.map((p, i) => ({ tokenId: p.tokenId, holder: HOLDER, minter: HOLDER, key: KEY, ...range, liquidity: extra[i].liquidity, unclaimed: [0n, 0n], mintBlock: p.mint.block })),
  });
  const hints = new Map(positions.map((p) => [String(p.tokenId), { tokenId: String(p.tokenId), block: p.mint.block, tx: txOf(p.mint.block) }]));
  return { chain, ids: positions.map((p) => String(p.tokenId)), hints };
}

/** The route over `chain` as one isolate with one edge cache, on a clock each POST moves by POST_MS. */
function edge(chain) {
  const clock = { time: 1_000_000 };
  const { cache } = memoryCache();
  const node = fakeNode({ fetch: (_url, init) => chain.fetch(RPC_URL, init) });
  const spent = { posts: 0 };
  const runtime = {
    upstream: async (url, init) => {
      spent.posts += 1;
      clock.time += POST_MS;
      return node(url, init);
    },
    cache,
    now: () => clock.time,
    sleep: async (ms) => {
      clock.time += ms;
    },
    memory: routes.chainRouteMemory(),
    log: () => {},
  };
  const ask = async (ids, hints) => {
    const body = { tokenIds: ids, ...(hints?.length ? { mintHints: hints } : {}) };
    const request = new Request(`${ORIGIN}/api/fees/v2/ledger`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(body) });
    const started = clock.time;
    const response = await routes.answerChainRoute('ledger', { request, env: ENV }, runtime);
    assert.equal(response.status, 200);
    return { body: await response.json(), ms: clock.time - started };
  };
  return { ask, clock, spent };
}

/** One position `days` old, asked until its ledger is no longer `reading`: answers, node POSTs, seconds waited. */
async function single(days, hinted) {
  routes.resetChainRouteMemory();
  const w = world([days]);
  const e = edge(w.chain);
  let answers = 0;
  let waited = 0;
  let longest = 0;
  for (;;) {
    const { body, ms } = await e.ask(w.ids, hinted ? [w.hints.get(w.ids[0])] : undefined);
    answers += 1;
    waited += ms;
    longest = Math.max(longest, ms);
    const [position] = body.positions;
    if (position.why !== 'reading') {
      assert.equal(position.exact, true, position.why);
      assert.equal(position.entries.filter((entry) => entry.kind === 'collect').length, Math.floor((days * BLOCKS_PER_DAY - 2_234) / (7 * BLOCKS_PER_DAY)));
      break;
    }
    assert.ok(answers < 80, 'the ledger completes');
    e.clock.time += REASK_MS;
    waited += REASK_MS;
  }
  return { answers, posts: e.spent.posts, seconds: Math.round(waited / 100) / 10, longest: Math.round(longest / 100) / 10 };
}

/**
 * Eight positions on one list: one batch first, then each id still `reading` asked alone (`alone`, the store before
 * 2026-11-09, the requests of a round side by side) or together, eight a request (`together`). Rounds until every ledger
 * is answered, requests sent, node POSTs, seconds waited (each round as long as its slowest request, then REASK_MS).
 */
async function list(ages, mode) {
  routes.resetChainRouteMemory();
  const w = world(ages);
  const e = edge(w.chain);
  let pending = [...w.ids];
  let rounds = 0;
  let requests = 0;
  let waited = 0;
  /** When each position's rate was known: seconds from the first ask. */
  const known = new Map();
  while (pending.length > 0) {
    const asks = rounds === 0 || mode === 'together' ? Array.from({ length: Math.ceil(pending.length / 8) }, (_, i) => pending.slice(i * 8, i * 8 + 8)) : pending.map((id) => [id]);
    let slowest = 0;
    const next = [];
    for (const ids of asks) {
      const { body, ms } = await e.ask(ids, ids.map((id) => w.hints.get(id)));
      requests += 1;
      slowest = Math.max(slowest, ms);
      for (const position of body.positions) {
        if (position.why === 'reading') next.push(position.tokenId);
        else {
          assert.equal(position.exact, true, position.why);
          if (!known.has(position.tokenId)) known.set(position.tokenId, waited + ms);
        }
      }
    }
    rounds += 1;
    waited += slowest;
    pending = next;
    if (pending.length > 0) waited += REASK_MS;
    assert.ok(rounds < 80, 'every ledger completes');
  }
  const at = w.ids.map((id) => Math.round(known.get(id) / 100) / 10);
  return { rounds, requests, posts: e.spent.posts, seconds: Math.round(waited / 100) / 10, at };
}

const AGES = [1, 10, 35];
const LIST = [35, 30, 25, 20, 15, 10, 5, 1];

test('answers a position waits for, 1, 10 and 35 days old, with and without its mint hint', async (t) => {
  const rows = [];
  for (const hinted of [true, false]) for (const days of AGES) rows.push({ days, hinted, ...(await single(days, hinted)) });
  for (const row of rows) t.diagnostic(`${row.days} days ${row.hinted ? 'hinted' : 'cold   '}: ${row.answers} answers, ${row.posts} POSTs, ${row.seconds} s waited, longest answer ${row.longest} s`);
  const of = (days, hinted) => rows.find((row) => row.days === days && row.hinted === hinted);
  for (const hinted of [true, false]) {
    assert.equal(of(1, hinted).answers, 1);
    assert.equal(of(10, hinted).answers, 1);
    assert.ok(of(35, hinted).answers <= 3, `35 days ${hinted ? 'hinted' : 'cold'}: ${of(35, hinted).answers} answers`);
  }
  // No answer runs past the time the route gives its passes, plus the one pass it lets finish.
  assert.ok(rows.every((row) => row.longest <= 12), JSON.stringify(rows));
});

test('a list of eight positions of different ages: rounds, requests and POSTs until every rate is known', async (t) => {
  const alone = await list(LIST, 'alone');
  const together = await list(LIST, 'together');
  for (const [name, run] of [['each alone (the store before)', alone], ['together (the store now)', together]]) {
    t.diagnostic(`${name}: ${run.rounds} rounds, ${run.requests} requests, ${run.posts} POSTs, ${run.seconds} s; rate known at ${LIST.map((days, i) => `${days} d ${run.at[i]} s`).join(', ')}`);
  }
  assert.ok(together.requests <= 5, `${together.requests} requests`);
  assert.ok(together.posts * 2 < alone.posts, `${together.posts} POSTs together, ${alone.posts} alone`);
  assert.ok(together.seconds <= 40, `${together.seconds} s`);
  // The youngest is answered by the first request; none waits past the last round.
  assert.ok(together.at[LIST.indexOf(1)] <= 8, `the day-old position at ${together.at[LIST.indexOf(1)]} s`);
});
