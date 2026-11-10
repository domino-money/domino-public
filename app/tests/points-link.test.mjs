/**
 * The referral link a wallet shares and the one a referred wallet signs (added 2026-11-07, the owner's Points page,
 * Season 1; decision D1, PROPOSAL.md §6, rugged97's spec "Vincular"):
 *   - the shared link is https://domino.money/points?ref=<wallet in lower case>, shown without its scheme, copied whole;
 *   - the signed text is points-v1's referralText, byte for byte as the contract's example has it, and its signature
 *     is the example's signer's;
 *   - the signature is asked only by the Link referrer button, with issuedAt taken right before the wallet is asked, and
 *     sent at once; the stored link is cleared once the service records it, or answers that one already holds.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { recoverMessageAddress } from 'viem';
import { referralText } from '../../api-contracts/points-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '..');
const link = require('../.test-build/app/src/points/link.js');
const signed = JSON.parse(readFileSync(resolve(APP, '../api-contracts/points-v1/fixtures/signed-text.json'), 'utf8'));
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const source = (path) => strip(readFileSync(join(APP, path), 'utf8'));

test('the shared link: https://domino.money/points?ref= and the wallet in lower case, whatever the host; shown short, without its scheme', () => {
  const wallet = '0x4A62316623AD457F02CDC5D997DED67A383EC569';
  assert.equal(link.referralUrl(wallet), 'https://domino.money/points?ref=0x4a62316623ad457f02cdc5d997ded67a383ec569');
  assert.deepEqual(link.shownLink(wallet), { lead: 'domino.money/points?ref=', wallet: '0x4a62…c569' });
  // The page names the link from this module alone: no other host, and the page's own origin never.
  const screen = source('src/screens/Points.tsx');
  assert.match(screen, /const url = referralUrl\(wallet\)/);
  assert.match(screen, /clipboard\.writeText\(url\)/, 'Copy link copies the whole link');
  assert.doesNotMatch(screen, /location\.origin|https?:\/\//);
});

test('the signed text is points-v1’s referralText, byte for byte the contract’s example, and the example signature is the referred wallet’s', async () => {
  const text = referralText(signed.season, signed.referee, signed.referrer, signed.issuedAt);
  assert.equal(text, signed.text);
  assert.equal(await recoverMessageAddress({ message: text, signature: signed.signature }).then((address) => address.toLowerCase()), signed.referee);
  // Upper case addresses are written in lower case; an unknown season, a bad address or a bad time are refused.
  assert.equal(referralText(signed.season, signed.referee.toUpperCase().replace('0X', '0x'), signed.referrer, signed.issuedAt), signed.text);
  assert.throws(() => referralText('points-s2', signed.referee, signed.referrer, signed.issuedAt));
  assert.throws(() => referralText(signed.season, '0x12', signed.referrer, signed.issuedAt));
  assert.throws(() => referralText(signed.season, signed.referee, signed.referrer, 1.5));
});

test('the wallet is asked to sign only from the Link referrer button, right before the request, with the season the service named', () => {
  const screen = source('src/screens/Points.tsx');
  // One caller of linkReferrer: the button's handler (onLink), which the card's Link referrer button alone calls.
  assert.equal([...screen.matchAll(/linkReferrer\(/g)].length, 1);
  assert.match(screen, /const onLink = useCallback\(async \(\) => \{\n\s+if \(!signedIn \|\| !answer \|\| !invitedBy\) return/);
  assert.match(screen, /await linkReferrer\(\{ epoch: signedIn\.epoch, owner, season: answer\.season\.id, referrer: invitedBy \}\)/);
  assert.equal([...screen.matchAll(/onLink=\{/g)].length, 1, 'one button');
  assert.match(screen, /onLink && \(\n\s+<Button type="button" onClick=\{onLink\}/);
  // Nothing on mount, on a route change or on an answer asks for a signature.
  assert.doesNotMatch(screen, /useEffect\([^)]*onLink|signLoginMessage|personal_sign/);
  const binding = source('src/finance/points.ts');
  const issued = binding.indexOf('const issuedAt = Math.floor(now() / 1000)');
  const text = binding.indexOf('text = referralText(season, owner, referrer, issuedAt)');
  const sign = binding.indexOf('await signLoginMessage({ address: owner, message: text })');
  const send = binding.indexOf("askLink<LinkResponse>(post, csrf, runtime, { referrer: referrer.toLowerCase(), issuedAt, signature: signed.signature })");
  assert.ok(issued > 0 && issued < text && text < sign && sign < send, 'the time, the text, the signature, then the request');
  assert.match(binding, /if \(!signed\.ok\) return \{ kind: 'declined' \}/, 'nothing signed, nothing sent');
  assert.match(binding, /answer\.value\.referee\.toLowerCase\(\) !== owner\.toLowerCase\(\)/, 'the service’s referee is the wallet that signed');
  // Only this module and the session's own login ask the wallet to sign a message.
  const signers = ['src/finance/points.ts', 'src/wallet/session.ts'];
  for (const path of signers) assert.match(source(path), /signLoginMessage/, path);
});

test('recorded or existing, the stored link is cleared and the linked referrer kept for the visit', () => {
  const screen = source('src/screens/Points.tsx');
  const ok = screen.indexOf("if (end.kind === 'ok') {");
  const clear = screen.indexOf('clearRef(browserStore())', ok);
  const kept = screen.indexOf('linkedThisVisit.set(owner, end.value.referrer.toLowerCase())', ok);
  assert.ok(ok > 0 && clear > ok && kept > clear, 'cleared on recorded and on existing alike');
  // The only other clearing: the wallet's own link, never a referral (tests/points-capture.test.mjs).
  assert.equal([...screen.matchAll(/clearRef\(/g)].length, 2, 'nothing else clears it: Not now keeps it (decision D5)');
  assert.ok(screen.includes('if (wallet !== null && ref === wallet) clearRef(browserStore())'));
  assert.match(screen, /laterThisVisit = true/);
});
