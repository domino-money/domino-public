/**
 * The chain-parameterized RPC client (src/lib/chain/client.ts, 2026-10-01, the chain2 workstream, audit item G4): the
 * endpoint, the chain id, the pace, the batch size, the refusals' rest and the log window all come from the registry
 * record it is given. Here over a fake endpoint and a fake clock.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const client = require('../.test-build/app/src/lib/chain/client.js');
const { ELYSIUM } = require('../.test-build/app/src/config/chains.js');

const URL_ = ELYSIUM.rpc.primary.url;
const hex = (n) => `0x${n.toString(16)}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * An endpoint: `answer(call)` gives one call's envelope (without jsonrpc/id), or a Response to send as it is. It records
 * every request with the clock's time.
 */
function endpoint(answer, { chainId = ELYSIUM.id } = {}) {
  let now = 1_000_000;
  const requests = [];
  const runtime = {
    now: () => now,
    pause: async (ms) => {
      now += Math.max(1, ms);
    },
    send: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, init, body, at: now });
      // Each call is answered once: a Response is sent as it is (a whole request's), anything else is its envelope.
      const one = (call) => {
        if (call.method === 'eth_chainId') return { jsonrpc: '2.0', id: call.id, result: hex(chainId) };
        const reply = answer(call);
        return reply instanceof Response ? reply : { jsonrpc: '2.0', id: call.id, ...reply };
      };
      if (Array.isArray(body)) return json(body.map(one));
      const single = one(body);
      return single instanceof Response ? single : json(single);
    },
  };
  return { runtime, requests, advance: (ms) => (now += ms), now: () => now };
}

test('the three helpers copied from functions/_lib/owned.ts behave as the originals', async () => {
  const owned = require('../.test-build/app/functions/_lib/owned.js');
  const vectors = [
    [429, ''], [-32005, 'query returned more than 10000 results'], [-32005, 'busy'], [-32000, 'rate limit exceeded'], [-32602, 'block range too large'],
    [-32000, 'execution timeout'], [3, 'execution reverted'], [-32601, 'method not found'], [-32017, 'rate limited, use an API key'], [-32000, 'capacity'],
  ];
  for (const [code, message] of vectors) assert.equal(client.classifyRpcError(code, message), owned.classifyRpcError(code, message), `${code} ${message}`);
  for (const [body, limit] of [['{"a":1}', 100], ['x'.repeat(50), 10], ['', 0]]) {
    assert.deepEqual(await client.bodyWithin(new Response(body), limit), await owned.bodyWithin(new Response(body), limit));
  }
  assert.ok(client.timeoutSignal(10) instanceof AbortSignal);
});

test('it reaches only the chain\'s own RPC, with no credentials and no referrer, and checks the chain id first, once', async () => {
  const e = endpoint(() => ({ result: '0x10' }));
  const c = client.createChainClient(ELYSIUM, e.runtime);
  assert.equal(await c.call('eth_blockNumber', []), '0x10');
  assert.equal(await c.call('eth_blockNumber', []), '0x10');
  assert.deepEqual(e.requests.map((r) => r.body.method), ['eth_chainId', 'eth_blockNumber', 'eth_blockNumber']);
  for (const r of e.requests) {
    assert.equal(r.url, URL_);
    assert.equal(r.init.credentials, 'omit');
    assert.equal(r.init.referrerPolicy, 'no-referrer');
    assert.equal(r.init.method, 'POST');
  }
  assert.equal(c.state().trusted, true);
});

test('an endpoint that says it is another chain is refused for every call', async () => {
  const e = endpoint(() => ({ result: '0x1' }), { chainId: 4663 });
  const c = client.createChainClient(ELYSIUM, e.runtime);
  await assert.rejects(c.call('eth_blockNumber', []), { kind: 'wrong_chain' });
  await assert.rejects(c.call('eth_blockNumber', []), { kind: 'wrong_chain' });
  assert.ok(e.requests.every((r) => r.body.method === 'eth_chainId'), 'nothing else was asked of it');
});

test('requests are paced: the endpoint\'s gap between requests, its calls a second, every batch item counted', async () => {
  const e = endpoint(() => ({ result: '0x1' }));
  const c = client.createChainClient(ELYSIUM, e.runtime);
  for (let i = 0; i < 4; i++) await c.call('eth_blockNumber', []);
  const gaps = e.requests.slice(1).map((r, i) => r.at - e.requests[i].at);
  assert.ok(gaps.every((gap) => gap >= ELYSIUM.rpc.primary.gapMs), gaps.join(','));
  // A batch of six counts six against the six-a-second budget: the next request waits for the second to pass.
  const before = e.requests.length;
  await c.batch(Array.from({ length: 6 }, () => ({ method: 'eth_blockNumber', params: [] })));
  await c.call('eth_blockNumber', []);
  const [batch, next] = e.requests.slice(before);
  assert.equal(batch.body.length, 6);
  assert.ok(next.at - batch.at >= 1_000, `${next.at - batch.at} ms`);
});

test('a batch larger than the chain\'s size is sent in several, and its outcomes come back in order', async () => {
  const e = endpoint((call) => ({ result: hex(call.params[0]) }));
  const c = client.createChainClient(ELYSIUM, e.runtime);
  const outcomes = await c.batch(Array.from({ length: 14 }, (_, i) => ({ method: 'eth_getBalance', params: [i] })));
  assert.deepEqual(outcomes.map((o) => o.result), Array.from({ length: 14 }, (_, i) => hex(i)));
  assert.deepEqual(e.requests.slice(1).map((r) => r.body.length), [6, 6, 2]);
});

test('items refused for rate inside a batch (-32017) rest the client and are asked again, alone', async () => {
  let refusals = 2;
  const e = endpoint((call) => (call.params[0] % 2 === 1 && refusals-- > 0 ? { error: { code: -32017, message: 'rate limited, use an API key' } } : { result: hex(call.params[0]) }));
  const c = client.createChainClient(ELYSIUM, e.runtime);
  const outcomes = await c.batch(Array.from({ length: 4 }, (_, i) => ({ method: 'eth_getBalance', params: [i] })));
  assert.deepEqual(outcomes.map((o) => o.ok && o.result), ['0x0', '0x1', '0x2', '0x3']);
  const [first, again] = e.requests.slice(1);
  assert.equal(first.body.length, 4);
  assert.deepEqual(again.body.map((call) => call.params[0]), [1, 3], 'only the refused items');
  assert.ok(again.at - first.at >= ELYSIUM.pace.firstRestMs, 'after the rest');
  assert.equal(c.state().rests, 1);
});

test('a whole refusal (HTTP 429) rests the client, longer at each one in a row, and gives up after its attempts', async () => {
  const e = endpoint(() => new Response(null, { status: 429 }));
  const c = client.createChainClient(ELYSIUM, e.runtime);
  await assert.rejects(c.call('eth_blockNumber', []), { kind: 'rate' });
  const asked = e.requests.filter((r) => r.body.method === 'eth_blockNumber');
  assert.equal(asked.length, client.RATE_ATTEMPTS);
  const gaps = asked.slice(1).map((r, i) => r.at - asked[i].at);
  assert.ok(gaps[0] >= ELYSIUM.pace.firstRestMs && gaps[1] >= ELYSIUM.pace.firstRestMs * 2, gaps.join(','));
  assert.ok(c.resting() > 0);
});

test('errors keep their meaning: a revert is the call\'s answer, a range is a range, anything else a refusal', async () => {
  const e = endpoint((call) => ({ error: call.method === 'eth_call' ? { code: 3, message: 'execution reverted' } : call.method === 'eth_getLogs' ? { code: -32005, message: 'query returned more than 10000 results' } : { code: -32602, message: 'invalid params' } }));
  const c = client.createChainClient(ELYSIUM, e.runtime);
  await assert.rejects(c.call('eth_call', [{}]), { kind: 'revert' });
  await assert.rejects(c.call('eth_getLogs', [{}]), { kind: 'range' });
  await assert.rejects(c.call('eth_getBalance', []), { kind: 'refused' });
});

test('replies that are not JSON-RPC answers to what was asked are refused', async () => {
  const cases = [
    [() => new Response('<html>busy</html>', { status: 502 }), 'unreachable'],
    [() => new Response('not json', { status: 200 }), 'invalid'],
    [() => json({ jsonrpc: '2.0', id: 999, result: '0x1' }), 'invalid'],
    [() => json({ jsonrpc: '2.0', id: 999, result: '0x1', extra: 1 }), 'invalid'],
  ];
  for (const [reply, kind] of cases) {
    const e = endpoint(() => reply());
    await assert.rejects(client.createChainClient(ELYSIUM, e.runtime).call('eth_blockNumber', []), { kind });
  }
  // A provider's refusal of a whole request with id null answers every call of it.
  const e = endpoint(() => json({ jsonrpc: '2.0', id: null, error: { code: -32017, message: 'rate limit' } }));
  await assert.rejects(client.createChainClient(ELYSIUM, e.runtime).call('eth_blockNumber', []), { kind: 'rate' });
});

test('logs are read window by window, clamped to the head, in order', async () => {
  const head = 350_000;
  const e = endpoint((call) => {
    if (call.method === 'eth_getBlockByNumber') return { result: { number: hex(head), timestamp: hex(1_790_000_000), hash: `0x${'a'.repeat(64)}` } };
    const { fromBlock, toBlock } = call.params[0];
    const [from, to] = [Number(fromBlock), Number(toBlock)];
    if (to > head) return { error: { code: -32000, message: 'invalid block range params' } };
    const log = (block, index) => ({ address: '0x' + '1'.repeat(40), topics: ['0x' + 'f'.repeat(64)], data: '0x', blockNumber: hex(block), blockHash: '0x' + 'b'.repeat(64), transactionHash: '0x' + 'c'.repeat(64), transactionIndex: '0x0', logIndex: hex(index) });
    return { result: [from + 10, to - 10].filter((b) => b >= from && b <= to).map((b, i) => log(b, i)) };
  });
  const c = client.createChainClient(ELYSIUM, e.runtime);
  const logs = await c.logs({ address: '0x' + '1'.repeat(40), topics: ['0x' + 'f'.repeat(64)] }, 100_000, 999_999);
  const windows = e.requests.filter((r) => r.body.method === 'eth_getLogs').map((r) => [Number(r.body.params[0].fromBlock), Number(r.body.params[0].toBlock)]);
  assert.deepEqual(windows, [[100_000, 199_999], [200_000, 299_999], [300_000, head]]);
  assert.deepEqual(logs.map((l) => l.blockNumber), [100_010, 199_989, 200_010, 299_989, 300_010, head - 10]);
});

test('a window the RPC finds too large is split in two, down to the smallest; a read past MAX_LOGS is refused', async () => {
  const e = endpoint((call) => {
    if (call.method === 'eth_getBlockByNumber') return { result: { number: hex(10_000_000), timestamp: '0x1', hash: `0x${'a'.repeat(64)}` } };
    const [from, to] = [Number(call.params[0].fromBlock), Number(call.params[0].toBlock)];
    return to - from + 1 > 30_000 ? { error: { code: -32005, message: 'query returned more than 10000 results' } } : { result: [] };
  });
  const c = client.createChainClient(ELYSIUM, e.runtime);
  assert.deepEqual(await c.logs({ address: '0x' + '1'.repeat(40), topics: [] }, 0, 99_999), []);
  const widths = e.requests.filter((r) => r.body.method === 'eth_getLogs').map((r) => Number(r.body.params[0].toBlock) - Number(r.body.params[0].fromBlock) + 1);
  assert.ok(widths.every((w) => w <= 100_000) && widths.includes(25_000), widths.join(','));

  // Three windows of 8,000 logs each: the third passes MAX_LOGS, and the read is refused rather than cut short.
  const many = endpoint((call) => {
    if (call.method === 'eth_getBlockByNumber') return { result: { number: hex(10_000_000), timestamp: '0x1', hash: `0x${'a'.repeat(64)}` } };
    const from = Number(call.params[0].fromBlock);
    const log = { address: '0x' + '1'.repeat(40), topics: [], data: '0x', blockNumber: hex(from), blockHash: '0x' + 'b'.repeat(64), transactionHash: '0x' + 'c'.repeat(64), transactionIndex: '0x0', logIndex: '0x0' };
    return { result: Array.from({ length: 8_000 }, () => log) };
  });
  await assert.rejects(client.createChainClient(ELYSIUM, many.runtime).logs({ address: '0x' + '1'.repeat(40), topics: [] }, 0, 249_999), { kind: 'range', message: 'too_many_logs' });
  // One reply past the client's byte cap is a range too large: split, and refused at the smallest window.
  const huge = endpoint((call) => {
    if (call.method === 'eth_getBlockByNumber') return { result: { number: hex(10_000_000), timestamp: '0x1', hash: `0x${'a'.repeat(64)}` } };
    return { result: [{ address: '0x' + '1'.repeat(40), topics: [], data: `0x${'ab'.repeat(client.MAX_LOG_REPLY_BYTES / 2)}`, blockNumber: call.params[0].fromBlock, blockHash: '0x' + 'b'.repeat(64), transactionHash: '0x' + 'c'.repeat(64), transactionIndex: '0x0', logIndex: '0x0' }] };
  });
  await assert.rejects(client.createChainClient(ELYSIUM, huge.runtime).logs({ address: '0x' + '1'.repeat(40), topics: [] }, 0, 1_999), { kind: 'range', message: 'reply_too_large' });
});

test('a removed log, or one outside the window asked, is refused rather than read', async () => {
  for (const bad of [{ removed: true }, { blockNumber: hex(1) }]) {
    const e = endpoint((call) => {
      if (call.method === 'eth_getBlockByNumber') return { result: { number: hex(50_000), timestamp: '0x1', hash: `0x${'a'.repeat(64)}` } };
      return { result: [{ address: '0x' + '1'.repeat(40), topics: [], data: '0x', blockNumber: hex(20_000), blockHash: '0x' + 'b'.repeat(64), transactionHash: '0x' + 'c'.repeat(64), transactionIndex: '0x0', logIndex: '0x0', ...bad }] };
    });
    await assert.rejects(client.createChainClient(ELYSIUM, e.runtime).logs({ address: '0x' + '1'.repeat(40), topics: [] }, 10_000, 30_000), { kind: 'invalid' });
  }
});

test('the chain check is no one caller\'s: one that leaves does not fail the others waiting on it', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let now = 1_000_000;
  const runtime = {
    now: () => now,
    pause: async (ms) => void (now += ms),
    send: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'eth_chainId') await gate;
      return json({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? hex(ELYSIUM.id) : '0x7' });
    },
  };
  const c = client.createChainClient(ELYSIUM, runtime);
  const leaving = new AbortController();
  const first = c.call('eth_blockNumber', [], leaving.signal);
  const second = c.call('eth_blockNumber', []);
  leaving.abort();
  release();
  await assert.rejects(first, { kind: 'aborted' });
  assert.equal(await second, '0x7');
  assert.equal(c.state().trusted, true);
});

test('a read nobody wants any more stops, and asks nothing more', async () => {
  const e = endpoint(() => ({ result: '0x1' }));
  const c = client.createChainClient(ELYSIUM, e.runtime);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(c.call('eth_blockNumber', [], controller.signal), { kind: 'aborted' });
  assert.equal(e.requests.length, 0);
});

test('the head is the latest block\'s number, time and hash, checked', async () => {
  const e = endpoint(() => ({ result: { number: '0x10', timestamp: '0x20', hash: `0x${'A'.repeat(64)}` } }));
  assert.deepEqual(await client.createChainClient(ELYSIUM, e.runtime).head(), { number: 16, timestamp: 32, hash: `0x${'a'.repeat(64)}` });
  const bad = endpoint(() => ({ result: { number: '0x10', timestamp: '0x20', hash: 'nope' } }));
  await assert.rejects(client.createChainClient(ELYSIUM, bad.runtime).head(), { kind: 'invalid' });
});
