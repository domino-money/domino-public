/**
 * Added 2026-10-15 (pack 8, incident C5: no chain literal on the receipt path). One table per chain says who reads
 * whether a transaction the page sent is in a block, in which order, and who makes the one read at finality
 * (src/config/receiptSources.ts). Every money client, wait and queue on the receipt path asks it; none names a chain. On
 * ffbd80ab the files below tested `chainId === 4663` or `!== 4663` in a dozen places (the source guard fails there).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const sources = require('../../.test-build/app/src/config/receiptSources.js');
const { V2_CHAINS } = require('../../.test-build/app/src/v2/chains.js');

/** The receipt path of the design (incident design §3, package C5), as files of app/src. */
const RECEIPT_PATH = [
  'lib/confirmedOperations.ts',
  'finance/v2/transact.ts',
  'finance/v2/zap.ts',
  'finance/v2/vault.ts',
  'v2in/automate/session.tsx',
  'v2in/automate/steps.tsx',
  'v2in/journey/run.ts',
  'v2in/journey/receiptFollow.ts',
];
/** Comments are documentation: they may name a chain (session.source-guard.test.mjs strips them the same way). */
const code = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');

test('the receipt path holds no chain id: every file asks the chains\' receipt sources', () => {
  for (const path of RECEIPT_PATH) {
    assert.doesNotMatch(code(path), /\b(4663|8453|42161)\b|0x1237\b|0x2105\b|0xa4b1\b/, `${path} names a chain`);
  }
  // The table itself takes the chains' ids from the registry, never from a literal of its own.
  assert.doesNotMatch(code('config/receiptSources.ts'), /\b(4663|8453|42161)\b/);
});

test('one row per chain: the edge then the wallet on Robinhood Chain; the wallet alone on Base and Arbitrum One', () => {
  assert.deepEqual(V2_CHAINS.map((chain) => chain.chainId), [4663, 8453, 42161], 'every chain V2 serves has its row below');
  assert.deepEqual(sources.receiptSources(4663), { inclusion: ['edge', 'wallet'], finality: 'edge', finalAfterMs: 40 * 60_000, simulation: 'edge' });
  for (const chainId of [8453, 42161]) assert.deepEqual(sources.receiptSources(chainId), { inclusion: ['wallet'], finality: 'wallet', finalAfterMs: 20 * 60_000, simulation: 'wallet' });
  assert.deepEqual(sources.receiptSources(1), { inclusion: ['wallet'], finality: 'wallet', finalAfterMs: 20 * 60_000, simulation: 'wallet' }, 'the edge never reads a chain it does not serve');
  assert.deepEqual([4663, 8453, 42161, 1].map(sources.edgeReadsReceipts), [true, false, false, false]);
  assert.deepEqual([4663, 8453, 42161, 1].map(sources.walletReadsFinality), [false, true, true, true]);
  assert.deepEqual([4663, 8453, 42161, 1].map(sources.edgeSimulates), [true, false, false, false]);
  assert.ok(Object.isFrozen(sources.receiptSources(4663)) && Object.isFrozen(sources.receiptSources(4663).inclusion));
});

test('Base and Arbitrum One no longer follow a receipt until final: the journey and automation hand it to the queue', () => {
  // The follow stays for what waits on a block alone (a direct exit after its dialog closed, a block found again after
  // one left the chain); finality is the confirmation queue's on every chain.
  assert.doesNotMatch(code('v2in/automate/steps.tsx'), /RECEIPT_FOLLOW/);
  assert.match(code('v2in/automate/steps.tsx'), /recordConfirmedOperation\(\{[^]*?follow: \{/);
  const run = code('v2in/journey/run.ts');
  // Changed on purpose (2026-10-15, pack 8 review, L1): what is recorded is worked out by journeyOperation
  // (journey/model/receiptOperation.ts), for every receipt in a block where the wallet reads finality.
  assert.match(run, /journeyOperation\(\{[^]*?follow: \{ read: again, accept, available \}[^]*?recordConfirmedOperation\(operation\)/);
  assert.match(code('v2in/journey/model/receiptOperation.ts'), /walletReadsFinality\(input\.chainId\)/);
  assert.equal([...run.matchAll(/RECEIPT_FOLLOW\.follow\(/g)].length, 1, 'one follow left: looking for the new block after one left the chain');
  assert.match(run, /const seek = \(\) => RECEIPT_FOLLOW\.follow\(/);
});
