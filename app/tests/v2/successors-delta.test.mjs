/**
 * rugged97's F7 delta of 5 Oct 2026 (Domino-compound's successors: the automation mints them), as the app shows it
 * (src/v2in/automate/portfolio.ts):
 *   - §6.2: the five new waiting reasons with the delta's own words, and owner_benefit_insufficient's new text, one for a
 *     compound and for the next position's mint; max_positions_reached names the vault's own maxPositions;
 *   - §5.5, "Na tela": a Domino-compound vault's "Next position" line, about the sequence's newest member.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const portfolio = require('../../.test-build/app/src/v2in/automate/portfolio.js');

const NOW = 1_790_000_000;
const waiting = (reason, error = null) => ({ reason, error, since: NOW - 120, sinceBlock: 1, checkedAt: NOW - 10, checkedBlock: 2, lastRevert: null });
const textOf = (reason, error, vault) => portfolio.waitingWords(waiting(reason, error), 8453, NOW, vault)?.text.replace(/ · since .*$/, '');

test('§6.2: the new waiting reasons say the delta\'s words; owner_benefit_insufficient serves a compound and a mint', () => {
  assert.equal(textOf('awaiting_successor'), 'Waiting to open the next position');
  assert.equal(textOf('successor_range_unavailable'), "Waiting: the next position can't start at the current price within your overlap limit");
  assert.equal(textOf('successor_anchor_unstable'), 'Waiting for the reference price to settle before opening the next position');
  assert.equal(textOf('reverted_invalid_tick', 'InvalidTick'), "Waiting: the next position's range isn't valid at this price");
  assert.equal(portfolio.waitingWords(waiting('reverted_invalid_tick', 'InvalidTick'), 8453, NOW).code, 'InvalidTick');
  assert.equal(textOf('owner_benefit_insufficient'), "Waiting: running now wouldn't pay off yet");
  assert.equal(textOf('gas_not_covered'), 'Waiting until fees cover the network cost', 'the codes of always keep their words');
  assert.equal(textOf('twap_history_short'), 'Waiting for this pool to record enough price history', 'rugged97 #358');
  // max_positions_reached: the vault's own maxPositions, else the same sentence without the number.
  assert.equal(textOf('max_positions_reached', null, { maxPositions: 3 }), 'Waiting: your sequence has reached 3 positions. Raise the limit or withdraw a position to continue');
  assert.equal(textOf('max_positions_reached'), 'Waiting: your sequence has reached its position limit. Raise the limit or withdraw a position to continue');
  assert.match(portfolio.waitingWords(waiting('awaiting_successor'), 8453, NOW).text, / · since /, 'with its age, as every waiting line');
});

test('§5.5: a Domino-compound vault\'s next position opens from its newest member, with its trigger and its upside', () => {
  const member = (tokenId, role, state, parent = null) => ({ tokenId, role, state, parent });
  const vault = (members, extra = {}) => ({ mode: 2, policy: { triggerDistanceBps: 500 }, limits: { upsideBps: 5000 }, members, rootTokenId: 11n, ...extra });
  assert.equal(portfolio.nextPositionWords(vault([member(11n, 'root', 'armed')])), "Opens when the price is within 5% of #11's ceiling, starting at the current price, with a ceiling at least 50% higher.", 'the root, while it has no successor');
  // A sequence root → 12 → 13: 13 has no successor, so it is the newest.
  const sequence = [member(11n, 'root', 'armed'), member(12n, 'successor', 'active', 11n), member(13n, 'successor', 'active', 12n)];
  assert.match(portfolio.nextPositionWords(vault(sequence)), /of #13's ceiling/);
  // A successor withdrawn is no longer in the sequence: its parent is the newest again.
  assert.match(portfolio.nextPositionWords(vault([member(11n, 'root', 'armed'), member(12n, 'successor', 'withdrawn', 11n)])), /of #11's ceiling/);
  assert.match(portfolio.nextPositionWords(vault([member(11n, 'root', 'armed')], { policy: { triggerDistanceBps: 250 }, limits: { upsideBps: 12_500 } })), /within 2\.5% of #11's ceiling, starting at the current price, with a ceiling at least 125% higher\.$/);
  assert.equal(portfolio.nextPositionWords(vault(sequence, { mode: 1 })), null, 'Auto-compound opens no next position');
  assert.equal(portfolio.nextPositionWords(vault(sequence, { policy: null })), null, 'not read: nothing said');
  assert.equal(portfolio.nextPositionWords(vault(sequence, { limits: null })), null);
});
