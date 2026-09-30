/**
 * The in-app documentation (#/docs), checked as data before a browser sees it:
 * every page, section and term id, every link, every sentence, the numbers
 * that must match the contracts and the addresses that must match the
 * backend, and the size the pages add to the entry bundle. The render suite
 * drives the built pages themselves.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { findForbidden } from '../scripts/deploy-markers.mjs';

const require = createRequire(import.meta.url);
const docs = require('../.test-build/app/src/lib/docs/registry.js');
const { ROADMAP, ROADMAP_PILL } = require('../.test-build/app/src/lib/capabilities.js');
const { SHOTS } = require('../.test-build/app/src/lib/docs/shots.js');
const { shotSrc } = require('../.test-build/app/src/lib/docs/blocks.js');

const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..');
/** The verified record of Domino V1 on Robinhood Chain (docs/V1_MAINNET_FRONTEND_HANDOFF_0XDECIMAL.md §3): the pages name its contracts and its state. */
const DEPLOYMENT = JSON.parse(readFileSync(join(REPO, 'docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json'), 'utf8'));
const { DOC_GROUPS, DOC_PAGES } = docs;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS = new Set(['p', 'list', 'steps', 'note', 'facts', 'addresses', 'split', 'terms', 'shot', 'diagram']);

/** Every string under a value, however deep. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
}

const blocksOf = (page) => page.sections.flatMap((section) => [...section.blocks, ...(section.subsections ?? []).flatMap((sub) => sub.blocks)]);

function inlinesOf(block) {
  switch (block.kind) {
    case 'p':
    case 'note':
      return block.text;
    case 'list':
      return block.items.flat();
    case 'steps':
      return block.items.flatMap((step) => step.body);
    case 'split':
      return block.columns.flatMap((column) => column.items.flat());
    case 'terms':
      return block.items.flatMap((item) => item.text);
    default:
      return [];
  }
}

const linksOf = (page) => blocksOf(page).flatMap(inlinesOf).filter((part) => typeof part === 'object' && 'to' in part);

/** Inline parts as the page reads them: words, bold words, code and link text, run together. */
const inlineText = (parts) => parts.map((part) => (typeof part === 'string' ? part : (part.b ?? part.mono ?? part.text))).join('');

function blockText(block) {
  switch (block.kind) {
    case 'p':
      return inlineText(block.text);
    case 'note':
      return [block.title ?? '', inlineText(block.text)].join('\n');
    case 'list':
      return block.items.map(inlineText).join('\n');
    case 'steps':
      return block.items.map((step) => `${step.title}\n${inlineText(step.body)}`).join('\n');
    case 'facts':
      return block.rows.map((row) => [row.label, row.value, row.note ?? ''].join('\n')).join('\n');
    case 'addresses':
      return block.rows.map((row) => `${row.label}\n${row.role}\n${row.address}`).join('\n');
    case 'split':
      return block.columns.map((column) => `${column.title}\n${column.items.map(inlineText).join('\n')}`).join('\n');
    case 'terms':
      return block.items.map((item) => `${item.term}\n${inlineText(item.text)}`).join('\n');
    // 2026-09-27: a picture's or a drawing's line under it is read like the prose, and counts in the page's words.
    case 'shot':
    case 'diagram':
      return block.caption;
    default:
      return '';
  }
}

/** A page's readable text, one line per title, sentence group or row: what a reader sees, without ids or hrefs. */
function textOf(page) {
  const lines = [page.title, page.summary, page.lead ?? ''];
  for (const section of page.sections) {
    lines.push(section.title, ...section.blocks.map(blockText));
    for (const sub of section.subsections ?? []) lines.push(sub.title, ...sub.blocks.map(blockText));
  }
  return lines.filter(Boolean).join('\n');
}
/** One section's readable text, its subsections included. */
function sectionText(entry, id) {
  const section = entry.sections.find((candidate) => candidate.id === id);
  assert.ok(section, `${entry.slug} has no section ${id}`);
  return [section.title, ...section.blocks.map(blockText), ...(section.subsections ?? []).flatMap((sub) => [sub.title, ...sub.blocks.map(blockText)])].join('\n');
}
/** One glossary term's definition, as the page reads it. */
function termText(entry, id) {
  const item = blocksOf(entry).filter((block) => block.kind === 'terms').flatMap((block) => block.items).find((candidate) => candidate.id === id);
  assert.ok(item, `${entry.slug} has no term ${id}`);
  return inlineText(item.text);
}
const sectionIds = (page) => page.sections.flatMap((section) => [section.id, ...(section.subsections ?? []).map((sub) => sub.id)]);
const termIds = (page) => blocksOf(page).filter((block) => block.kind === 'terms').flatMap((block) => block.items.map((item) => item.id));
const idsOf = (page) => [...sectionIds(page), ...termIds(page)];
const rowsOf = (page, kind) => blocksOf(page).filter((block) => block.kind === kind).flatMap((block) => block.rows);
const page = (slug) => {
  const found = docs.findDocPage(slug);
  assert.ok(found, `no page ${slug}`);
  return found;
};

test('every group has pages, every slug is unique and kebab-case, and only a page’s own slug finds it', () => {
  assert.equal(DOC_GROUPS.length, 6);
  assert.equal(new Set(DOC_GROUPS.map((group) => group.key)).size, DOC_GROUPS.length);
  for (const group of DOC_GROUPS) {
    assert.match(group.key, SLUG);
    assert.ok(group.pages.length > 0, `${group.key} has no page`);
  }
  assert.deepEqual(DOC_PAGES, DOC_GROUPS.flatMap((group) => group.pages), 'the pages in sidebar order');
  const slugs = DOC_PAGES.map((entry) => entry.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'slugs are unique');
  for (const slug of slugs) assert.match(slug, SLUG);
  // Home's custody card and the naming the owner approved both link here.
  assert.ok(docs.findDocPage('non-custodial'));
  assert.ok(docs.findDocPage('domino-compounder'));
  assert.equal(docs.findDocPage('domino-sequences'), null, 'the old name is gone');
  for (const slug of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'Non-custodial', '', ' non-custodial']) assert.equal(docs.findDocPage(slug), null, JSON.stringify(slug));
  assert.deepEqual([...docs.DOC_START], ['what-is-domino', 'ranges', 'non-custodial']);
  for (const slug of docs.DOC_START) assert.ok(docs.findDocPage(slug), slug);
  for (const entry of DOC_PAGES) {
    assert.equal(docs.docGroupOf(entry.slug).pages.includes(entry), true, `${entry.slug} is in its group`);
    assert.ok(entry.sections.length > 0, `${entry.slug} has sections`);
    for (const block of blocksOf(entry)) assert.ok(KINDS.has(block.kind), `${entry.slug}: unknown block ${block.kind}`);
  }
  assert.equal(docs.docGroupOf('constructor'), null);
});

test('section, subsection and term ids are unique on their page, kebab-case, and never an id of the docs chrome or the shell', () => {
  // Ids the shell renders around every screen: the React root, the menu and the wallet dialogs.
  const shell = new Set(['root']);
  const files = ['src/components/Header.tsx', 'src/components/HeaderMenu.tsx', 'src/components/Footer.tsx', 'src/components/ui.tsx', ...readdirSync(join(APP, 'src/components/wallet')).map((file) => `src/components/wallet/${file}`)];
  for (const file of files) for (const match of readFileSync(join(APP, file), 'utf8').matchAll(/\bid="([^"]+)"/g)) shell.add(match[1]);
  assert.ok(shell.has('site-menu'), 'the menu id is among the shell ids');
  for (const entry of DOC_PAGES) {
    const ids = idsOf(entry);
    assert.equal(new Set(ids).size, ids.length, `${entry.slug} repeats an id: ${ids.join(', ')}`);
    for (const id of ids) {
      assert.match(id, SLUG, `${entry.slug}: ${id}`);
      assert.ok(!id.startsWith('docs-'), `${entry.slug}: ${id} is the docs chrome's`);
      assert.ok(!shell.has(id), `${entry.slug}: ${id} is the shell's`);
    }
    assert.deepEqual(
      docs.tocOf(entry).map((line) => [line.id, line.depth]),
      entry.sections.flatMap((section) => [[section.id, 2], ...(section.subsections ?? []).map((sub) => [sub.id, 3])]),
      `${entry.slug}: On this page lists every section and subsection, in order`,
    );
    // The renderers key rows by these, so each must be unique within its block.
    for (const block of blocksOf(entry)) {
      const keys =
        block.kind === 'facts' ? block.rows.map((row) => row.label)
        : block.kind === 'addresses' ? block.rows.map((row) => row.address)
        : block.kind === 'steps' ? block.items.map((step) => step.title)
        : block.kind === 'split' ? block.columns.map((column) => column.title)
        : [];
      assert.equal(new Set(keys).size, keys.length, `${entry.slug}: a ${block.kind} block repeats ${keys.join(', ')}`);
    }
  }
});

test('every link stays inside this app, and names a docs page and a section of it that exist', () => {
  // The routes and Home sections a docs page may send a reader to (tests/render.test.mjs keeps the same list for the footer).
  // Changed on purpose (2026-09-27, the owner's round 6, point 6): Settings is gone, and an old link to it opens the docs.
  const screens = new Set(['#/', '#/markets', '#/positions', '#/automate', '#/new', '#/#learn', '#/#ranges', '#/#limits']);
  let count = 0;
  for (const entry of DOC_PAGES) {
    for (const link of linksOf(entry)) {
      count += 1;
      assert.ok(link.text.trim().length > 0, `${entry.slug}: a link without words`);
      if (screens.has(link.to)) continue;
      const match = /^#\/docs\/([a-z0-9-]+)(?:#([a-z0-9-]+))?$/.exec(link.to);
      assert.ok(match, `${entry.slug}: ${link.to} is not a docs link or a screen of this app`);
      const target = docs.findDocPage(match[1]);
      assert.ok(target, `${entry.slug}: ${link.to} names no page`);
      if (match[2]) assert.ok(idsOf(target).includes(match[2]), `${entry.slug}: ${link.to} names no section of ${target.slug}`);
      assert.notEqual(target.slug === entry.slug && !match[2], true, `${entry.slug} links to itself`);
    }
  }
  assert.ok(count >= 20, `${count} links`);
});

test('the words: no build marker, no URL, no self-description, no dollar figure, no wallet method or API path, no promise, no provider, no token', () => {
  const all = strings([DOC_GROUPS, docs.DOCS_HOME, SHOTS]);
  assert.ok(all.length > 300, `${all.length} strings`);
  for (const text of all) {
    assert.deepEqual(findForbidden(text), [], text);
    assert.doesNotMatch(text, /(https?|wss?):\/\//, text);
    assert.doesNotMatch(text, /\balpha\b|\bbeta\b|\bv4\b|\bpreview\b|not enabled yet|not connected yet|read-only|coming soon/i, text);
    assert.doesNotMatch(text, /\$\s?\d/, text);
    // Nor in words (2026-09-28): "1 million dollars" states a figure as surely as "$1M", and the pictures cannot keep up with it.
    assert.doesNotMatch(text, /\d[\d,.]*\s*(?:thousand|million|billion)?\s*dollars?\b|\b(?:hundred|thousand|million|billion)\s+dollars?\b/i, text);
    assert.doesNotMatch(
      text,
      /personal_sign|eth_[a-z]|wallet_[a-zA-Z]|\/api\/|fetch\(|innerHTML|127\.0\.0\.1|\.create\(|\.prepare\(|\.send\(|approve\s*\(|sendTransaction|writeContract|signTypedData|Wallet sending isn|Synthetic fixture|live-preview|swap-preview/,
      text,
    );
    assert.doesNotMatch(text, /guarantee|risk-free|will earn|\bsafe(?:ly|ty)?\b|maximum return|impermanent loss|\bprofitable\b/i, text);
    assert.doesNotMatch(text, /GeckoTerminal|DexScreener|CoinGecko|Alchemy/i, text);
    assert.doesNotMatch(text, /Domino token|Domino sequences?\b/i, text);
  }
  // Figures are described by where they come from, never as current, live, updated or qualified.
  for (const text of strings(page('figures'))) assert.doesNotMatch(text, /\b(current|live|updated|qualified)\b/i, text);
});

test('the automation is Domino Compounder in the docs and Domino-compound in the app; sequence names only the vault', () => {
  const compounder = page('domino-compounder');
  assert.equal(compounder.title, 'Domino Compounder');
  assert.match(textOf(compounder), /In the app you choose it as Domino-compound\./);
  // New position creates a plain position and offers no automation choice: its page names none of the three, and says where the choice is made.
  assert.doesNotMatch(textOf(page('new-position')), /Self-managing|Auto-compound|Domino-compound|Automation step/);
  assert.match(textOf(page('new-position')), /Automation is set up afterwards, from Automate, on the position you opened\./);
  const glossary = termIds(page('glossary'));
  // Changed on purpose (2026-09-24, the three features joined up): the choice with no automation is named Plain position
  // everywhere it is offered (Automate, New position's success, a position's state), so the glossary names it so too.
  for (const id of ['domino-compounder', 'sequence', 'plain-position', 'auto-compound', 'operator']) assert.ok(glossary.includes(id), id);
  assert.equal(glossary.includes('domino-sequence'), false);
  // Wherever a reader meets "sequence", it is the vault, the Automate button that creates one, or that creation.
  const lines = DOC_PAGES.flatMap((entry) => textOf(entry).split('\n')).filter((line) => /\bsequences?\b/i.test(line));
  assert.ok(lines.length >= 5, `${lines.length} lines name the sequence`);
  for (const line of lines) {
    for (const [phrase] of line.matchAll(/(?:\S+\s+){0,4}sequences?\b(?:\s+\S+)?/gi)) {
      assert.match(phrase, /sequence vault|sequence creation|(your|the|its|a new|each owner and|that exact) sequence\b|Create or manage a sequence|^Sequence$|^Per sequence$/i, `"${phrase}" in: ${line}`);
    }
  }
});

test('the custody page opens with the approved sentence, word for word, then says who holds what, the operator’s limits and the owner’s controls', () => {
  const custody = page('non-custodial');
  assert.equal(
    custody.lead,
    'When you create an automation using Domino, you are the sole owner and only you can control it. Every step is fully automated by a contract whose controller is your signed wallet.',
  );
  assert.deepEqual(sectionIds(custody), ['your-wallet', 'sequence-vault', 'operator', 'pause-revoke-withdraw', 'sign-in-grants-nothing']);
  const text = textOf(custody);
  assert.match(text, /that NFT stays in your wallet/);
  // Changed on purpose (2026-09-28, the owner's round 6, point 1): one plain phrase for what automation puts back, "added
  // back", here as everywhere (was "not yet reinvested").
  assert.match(text, /earned fees not yet added back, are held by your own sequence vault until you withdraw them/);
  assert.match(text, /Only your wallet controls the vault/);
  assert.match(text, /The operator cannot[\s\S]*Withdraw positions or fees/);
  // Sequence.tsx: the owner's own controls. setPolicy and setExecutionLimits are onlyOwner and refuse a pause flip,
  // so changing the limits is a row of its own; setOperator is offered only while the operator is revoked.
  const controls = rowsOf(custody, 'facts');
  assert.deepEqual(controls.map((row) => row.label), ['Pause', 'Change your limits', 'Revoke the operator', 'Revoke the NFT approval', 'Withdraw']);
  const control = (label) => controls.find((row) => row.label === label);
  assert.equal(control('Change your limits').value, 'You');
  assert.equal(control('Change your limits').note, 'The automation rules, and the limits every run is bound by. The paused state is unchanged.');
  assert.match(control('Revoke the operator').note, /Once revoked, you can authorise the same operator again\./);
  assert.match(text, /This request does not authorize transactions or automation\./);

  // The owner kept the lead; the operator section opens by squaring it with an operator that can act and pause.
  const operator = custody.sections.find((section) => section.id === 'operator');
  assert.deepEqual(operator.blocks[0], { kind: 'p', text: ['Your wallet stays the vault’s only owner. The operator named in your review can only run fee-only steps within your limits, and pause.'] });
  // Both automations leave the NFT in the wallet (New position's review asks the same approval for either).
  assert.match(sectionText(custody, 'your-wallet'), /When you start Auto-compound or Domino-compound from it, that NFT stays in your wallet\./);
  // Funds in a setup operation (DominoSetup.sol open/cancel): held until mint or refund, which only the owner can do, with no fee.
  // 2026-09-27: Create position is where a reader meets it (it deposits through Setup since 2026-09-23), not Setup's screen.
  assert.match(sectionText(custody, 'your-wallet'), /Create position first deposits your tokens in Domino’s Setup contract, then turns them into your position\. Until then the tokens you fund wait in a setup operation until you mint or refund\. Only your wallet can do either, and a refund carries no Domino fee\./);
  // The partner's list (PLANO D7): permission over earned fees only, and positions automation opens are standard NFTs too.
  const vault = sectionText(custody, 'sequence-vault');
  assert.match(vault, /Your permission covers earned fees only, including fees still uncollected on your starting position when you create the sequence\. Principal is never used\./);
  assert.match(vault, /Positions it opens are standard Uniswap position NFTs too\./);
  // DominoExecutionEngineV4 swaps earned fees in the vault's own pool, within the owner's slippage and price-impact limits.
  const can = operator.blocks.find((block) => block.kind === 'split').columns.find((column) => column.title === 'The operator can').items.map(inlineText);
  assert.deepEqual(can, ['Add a position’s earned fees back into it.', 'Open or fund the next position from earned fees, within your limits.', 'Swap earned fees in the same pool, within your slippage and price-impact limits.', 'Pause automation.']);
  // The operator's boundary did not move when the owner gained screens: what it cannot do, the controls above say the owner can.
  const cannot = operator.blocks.find((block) => block.kind === 'split').columns.find((column) => column.title === 'The operator cannot').items.map(inlineText);
  assert.deepEqual(cannot, ['Withdraw positions or fees.', 'Change your limits, or resume automation after a pause.', 'Reduce a position’s liquidity, or pull tokens from your wallet.', 'Send anything to an address of its choosing.']);
});

test('figures: Domino history first where the deployment provides it, the provider and the estimate after it, the protocol fee in the estimate, and every way a missing figure shows', () => {
  const figures = page('figures');
  assert.deepEqual(sectionIds(figures), ['read-from-chain', 'domino-history', 'reported-by-a-provider', 'calculated-by-domino', 'age', 'unavailable']);
  // project.ts: TVL and volume take Domino's figure only when usableAsCurrent24h; the APR cell also shows a stale Domino APR before the estimate.
  assert.match(sectionText(figures, 'domino-history'), /Where the deployment provides it, Domino keeps its own record of each pool’s last 24 hours\. When that record covers them in full, a pool’s TVL, 24h volume, 24h fees and APR come from it, marked Domino history\./);
  assert.match(sectionText(figures, 'domino-history'), /Otherwise TVL and 24h volume are a provider’s, and the APR is the estimate below or an older full day of Domino history, dated in its title\. 24h fees come only from Domino history\./);
  assert.match(sectionText(figures, 'reported-by-a-provider'), /^Reported by a provider\nTVL and 24h volume that Domino history does not cover, and hourly candles of either token’s USD price with volume, come from a market data provider/);
  // backend/pool_apr.py scales the LP fee by the protocol fee, and gives no estimate when the two directions differ.
  const estimate = blocksOf(figures).flatMap(inlinesOf).filter((part) => typeof part === 'object' && 'mono' in part).map((part) => part.mono);
  assert.deepEqual(estimate.map((formula) => formula.replace(/\u00a0/g, ' ')), ['24h volume × fee tier × (1 − protocol fee) × 365 ÷ TVL']);
  // No-break spaces hold each term together, so a narrow screen wraps the formula only at a ×.
  assert.deepEqual(estimate[0].split(' × '), ['24h\u00a0volume', 'fee\u00a0tier', '(1\u00a0−\u00a0protocol\u00a0fee)', '365\u00a0÷\u00a0TVL']);
  assert.match(sectionText(figures, 'calculated-by-domino'), /No estimate is given when a pool’s protocol fee differs by swap direction\./);
  // Chain figures name their block; a provider's names the provider and its retrieval age; Domino history's age is on the row.
  assert.match(sectionText(figures, 'read-from-chain'), /Each names the block it was read at\./);
  assert.match(sectionText(figures, 'age'), /a figure read from chain names its block\. In a pools table, hover a pool’s name for its row’s sources, including how old its Domino history is\./);
  assert.doesNotMatch(textOf(figures), /Every figure names its source and age|Hover a figure to see where it comes from and how long ago/);
  // MetricCell: Unavailable, Not reported by <provider>, Not current. The figures page says the last without the word.
  assert.match(sectionText(figures, 'unavailable'), /shows as a dash or as Unavailable, and one its source did not report shows as Not reported\. Domino history over less than a full 24 hours shows a word saying so, not a number\. None is shown as zero/);
  const markets = page('markets');
  assert.match(sectionText(markets, 'unavailable-figures'), /shows a dash, Unavailable, Not reported or Not current, never a zero\./);
  assert.match(sectionText(markets, 'pools-table'), /The APR is Domino’s own where its history covers the day, and the estimated APR otherwise\./);
  // Changed on purpose (2026-09-28, featured-policy v2): the daily list ranks by today's estimated APR, above a volume
  // and a TVL floor, with only the safety rules. The floors are named without figures, so the pictured list, which is
  // not held to them, never contradicts the words above it.
  assert.match(sectionText(markets, 'pools-table'), /Once a day, at 12:00 UTC, Domino ranks pools by estimated 24h fee APR\. A pool needs no hooks, a fixed fee, tokens that pass Domino’s checks, and enough 24h volume and TVL\./);
  assert.doesNotMatch(sectionText(markets, 'pools-table'), /hundred|thousand|million|billion|\d{3}/i);
  // Risks and the glossary say the same, and no page still calls TVL or volume a provider's figure only.
  assert.match(sectionText(page('risks'), 'figures-describe-pools'), /TVL and 24h volume come from Domino history where the deployment provides it, and otherwise from a market data provider that Domino does not reconcile\./);
  const glossary = page('glossary');
  assert.equal(termText(glossary, 'domino-history'), 'Domino’s own record of a pool’s last 24 hours, where the deployment provides it. Figures from it are marked Domino history.');
  assert.match(termText(glossary, 'tvl'), /from Domino history or, where it has none, a market data provider\.$/);
  assert.match(termText(glossary, 'volume-24h'), /from Domino history or, where it has none, a market data provider\.$/);
  assert.match(termText(glossary, 'estimated-apr'), /24h volume and TVL, its fee tier and its protocol fee\. It describes the pool, not a position, and is shown where Domino history gives no APR\.$/);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /as a market data provider reports it|reported by a provider and not reconciled by Domino/, entry.slug);
});

test('Auto-compound sets up on a position NFT you opened with Domino, with two wallet transactions; activation is a separate conditional third step', () => {
  const auto = page('auto-compound');
  const start = sectionText(auto, 'where-it-starts');
  // Changed on purpose (2026-09-24): the automation page lists the positions the wallet opened with Domino, so the page
  // no longer says any NFT the wallet holds, wherever it was opened.
  assert.match(start, /Auto-compound runs on a position NFT you opened with Domino and still hold\. Setup takes two wallet transactions: approve that one NFT to its sequence vault, then create the sequence, which starts paused\. Activation is a separate wallet transaction when the service is ready for your sequence\./);
  // Changed on purpose (2026-09-28, the owner's round 6, point 1): one plain phrase for what automation puts back, "added
  // back", here as everywhere (was "not yet reinvested").
  assert.match(start, /Custody is the same as for Domino Compounder: the NFT stays in your wallet, and your sequence vault holds earned fees not yet added back until you withdraw them\./);
  // Changed on purpose (2026-09-27, review of 260a76a): Collect fees and Close position on the position's page stop it too.
  assert.match(start, /Changes made to that NFT outside Domino can stop it, and so do Collect fees and Close position on its page: see Risks\./);
  // New position offers no automation choice any more, so the page no longer says choosing it there records anything.
  assert.doesNotMatch(textOf(auto), /New position|records the choice/);
  const links = linksOf(auto).map((link) => link.to);
  for (const to of ['#/docs/non-custodial#sequence-vault', '#/docs/non-custodial#pause-revoke-withdraw', '#/docs/risks#automation-stops']) assert.ok(links.includes(to), to);
  // Changed on purpose (2026-09-27): Automate has offered Set up Auto-compound since the three features joined up
  // (2026-09-24, screens/Automate.tsx), and a plain position's row offers Automate, so the page names both.
  assert.doesNotMatch(textOf(auto), /opened in Setup|Create or manage a sequence|Open a position/);
  assert.match(start, /On Automate, Set up Auto-compound opens the setup: choose the position, then one button asks your wallet for both transactions\. Automate on a plain position in Positions opens it with that position chosen\./);
  // 2026-09-24: what the automation page used to explain beside its controls, moved here (the owner: explanations live in the docs).
  const choices = sectionText(auto, 'choices');
  assert.match(choices, /The quote currency is the token prices are counted in\. It sets which way prices count as higher for your sequence, and it cannot be changed once the sequence is created\./);
  assert.match(choices, /Every run also keeps within limits that start at defaults you can change: the least time between runs, the most a swap may lose to slippage or move the price, a gas cap per run, how old a price reading may be, and how far ahead fees are forecast\./);
  assert.ok(links.every((to) => to.startsWith('#/docs/')), links.join(', '));
});

test('Domino Compounder names the screen its Automate button opens, and Risks says what else stops automation, which repairs that screen offers and which restart still takes a call it does not make', () => {
  const compounder = page('domino-compounder');
  const start = sectionText(compounder, 'start-and-stop');
  // Changed on purpose (2026-09-24, the owner's simpler automation page): Automate's button opens a setup with one action, and
  // the page no longer pauses, revokes or withdraws; those stay transactions the owner's wallet signs on the vault.
  assert.match(start, /On Automate, Set up Domino-compound opens the setup, where one button asks your wallet for both transactions\. You pause, revoke and withdraw with your wallet on your sequence vault\./);
  assert.doesNotMatch(textOf(compounder), /Create or manage a sequence|It is also where you pause/);
  assert.doesNotMatch(start, /The same screen is where/);
  assert.ok(linksOf(compounder).some((link) => link.to === '#/docs/risks#automation-stops'));
  // DominoVaultV4 notifyModifyLiquidity, notifyUnsubscribe and notifyBurn invalidate the root. Sequence.tsx offers rearmRoot
  // while rootPermissionValid is false, and setOperator while the operator is the zero address; rearmRoot re-subscribes through
  // the position manager, so it needs the NFT approval the vault already holds. Nothing gives that approval back to a vault
  // that exists: the create flow only ever approves the next predicted vault, so the last sentence stays true as written.
  const stops = sectionText(page('risks'), 'automation-stops');
  assert.match(stops, /Automation stops if the position you started from has its fees collected or its liquidity changed outside Domino, or leaves your wallet\./);
  // 2026-09-27: Collect fees and Close position on a position's page (PositionActions.tsx) stop it too, as their dialog says.
  assert.match(stops, /Collect fees and Close position on its page stop it too, and so does revoking the operator or the NFT approval\./);
  // 2026-09-24: no Domino screen repairs a vault any more (the owner removed its controls); the repair is the owner's own wallet transaction.
  assert.match(stops, /Restoring the vault’s permission over that position, while the position is still yours and still approved to the vault, or naming the operator again while it is revoked, is a transaction your wallet signs on your sequence vault\./);
  assert.match(stops, /Activation stays a separate step you sign\./);
  assert.match(stops, /Restoring that permission consents again to the fees the position has not collected, exactly as creating the vault did\./);
  assert.match(stops, /After you revoke the NFT approval, or the position leaves your wallet, restarting takes a contract call that no Domino screen makes\./);
  // The old sentence said restarting always takes a call no screen makes; the repair and the operator now have buttons.
  assert.doesNotMatch(stops, /Restarting it after that, or after you revoke the operator or the NFT approval/);
  // Your sequences starts the upside empty: 50% is only what the app draws the next range with (DEFAULT_UPSIDE_PERCENT in journey.ts), and no page says New position draws it, which offers no automation.
  const glossary = page('glossary');
  assert.equal(termText(glossary, 'upside'), 'How far above the previous ceiling a next position’s ceiling sits, at least. You set it; the app draws it at 50%.');
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /New position draws/, entry.slug);
  // Changed on purpose (2026-09-28, the owner's round 6, point 1): one plain phrase for what automation puts back, "added
  // back", here as everywhere (was "not yet reinvested").
  assert.equal(termText(glossary, 'sequence'), 'The vault contract created for your wallet that holds the positions automation opens and earned fees not yet added back. Only your wallet can withdraw from it.');
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /50% by default/, entry.slug);
});

test('the wallet, pools, fees, markets, new position, positions, risks and what Domino is pages say what the app and contracts do', () => {
  const wallet = page('wallet');
  const needs = blocksOf(wallet).find((block) => block.kind === 'list').items.map(inlineText);
  // Changed on purpose (owner, 2026-09-22): Review's deposit-amount estimate was deleted, so it needs no sign-in any more.
  // Changed on purpose (2026-09-27, docs for beginners): Setup's deposit drafts and its swap quote left the list. Create
  // position makes the one-token swap in place with no sign-in (since 2026-09-23), and Setup's screen is linked from no
  // page, so a reader is never sent there; what needs sign-in is what automation did, and the check before activation.
  // Changed on purpose again (2026-09-27, the owner's point 10): a position's page shows what automation added back with
  // no sign-in (lib/automationImpact.ts), so the list names only the two Positions cards that need a session.
  assert.deepEqual(needs, [
    'Managed positions and Receipts, on Positions: what automation did across your positions.',
    'Checking whether the automation service is ready for your sequence before activation.',
  ]);
  assert.match(sectionText(wallet, 'what-needs-sign-in'), /Public pages need no sign-in, a position’s page included, with what automation added back to it\./);
  assert.match(sectionText(wallet, 'what-needs-sign-in'), /Neither does anything your wallet does: creating a position, collecting its fees, closing it, setting up automation, pausing, revoking or withdrawing\. Activation is the one step that also requires a live service check bound to your signed-in address and your sequence vault\./);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /Setup’s advanced section|assisted swap quote in Setup/, entry.slug);
  assert.match(sectionText(wallet, 'sign-in'), /Only standard wallet accounts can sign in, not an address with contract code\./);

  // Outside its range a position holds one token, so the sentence says in range, and is written here, not imported.
  const pools = page('pools');
  assert.match(sectionText(pools, 'two-tokens'), /and a position in range holds some of each\./);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /a position holds some of each/, entry.slug);
  assert.match(sectionText(pools, 'fee-tiers'), /A pool can also carry Uniswap’s protocol fee, taken from what a swap sells into the pool before the fee tier\. It does not go to liquidity providers\./);
  assert.match(termText(page('glossary'), 'protocol-fee'), /taken from what a swap sells into the pool before the fee tier/);
  const fees = page('fees');
  const trading = rowsOf(fees, 'facts').find((row) => row.label === 'Pool trading fee');
  assert.equal(trading.note, 'Paid by swappers to the pool’s liquidity providers, on each trade. Not a charge on your deposit; a swap you make pays it.');
  assert.match(sectionText(fees, 'pool-trading-fee'), /A swap you make, such as the one Create position makes when your wallet holds one token, pays it, and any protocol fee, like any other\./);

  const markets = page('markets');
  assert.match(sectionText(markets, 'find-a-token'), /Type the name of a token from the selected pools, or paste any token’s contract address\.\nThe token is read from chain\. Find pools then lists its existing pools, each verified on chain\./);
  const poolPage = sectionText(markets, 'pool-page');
  // Changed on purpose (2026-09-27, round 6, the pool page for beginners): the page leads with what the pool earns, its
  // chart is its own swaps' price, the estimate and the typical range are new, and everything technical is in Details.
  assert.match(poolPage, /one sentence on what the pool is and what it earns, then its APR, 24h volume, TVL and price/);
  // Changed on purpose (2026-09-28, round 6 review): the estimate is a share of the pool's fees, not the APR applied
  // to the amount alone, and a pool Domino can't open positions in has neither card.
  assert.match(poolPage, /Estimate your earnings works out your share of the pool’s recent fees for an amount you type\./);
  assert.match(poolPage, /A pool Domino can’t open positions in says why instead\./);
  assert.match(poolPage, /Details, closed until opened, lists the pool id, tokens, fees, tick spacing, hooks, where the figures come from and the block the pool was verified at\./);
  assert.match(poolPage, /Create a position opens the same four steps of New position as anywhere else, with this pool already chosen\./, 'one flow, wherever it starts (point 8)');
  assert.doesNotMatch(poolPage, /hourly USD price and volume|Plan a range|hourly candles/);

  assert.match(sectionText(page('new-position'), 'review'), /^Review\nReview lists every choice and the wallet steps in order\. The steps are what your wallet signs when you press Create position: any approval, the deposit, then the position\. Automation is set up afterwards, from Automate, on the position you opened\./);
  // Changed on purpose (owner, 2026-09-22): the estimate paragraph went with Review's deposit amounts; the swap a
  // one-token wallet needs is said in its place, with the fee the V1 deployment charges on the swapped part.
  assert.match(sectionText(page('new-position'), 'review'), /\nIf your wallet holds only one of the two tokens, part of it is swapped for the other inside the same pool before the position is created: one more signature, and the pool’s fee and Domino’s assisted-swap fee \(0\.65%\) on the swapped part\. Review shows how much is swapped before you sign\.$/);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /deposit-amount estimate|expected to take, and the most it may take|Hover a figure to see until when/, entry.slug);
  const create = sectionText(page('new-position'), 'create');
  assert.match(create, /the deposit of both tokens \(or of the one your wallet holds, then the swap of part of it inside the pool\), and the position itself\./);
  // Added 2026-09-24: a one-token deposit is made only into a pool that can swap part of it (CreatePosition.tsx swapPreflight).
  assert.match(create, /With one token, the pool is checked first: if it cannot swap part of your deposit, Create position says so before anything is deposited\./);
  assert.match(create, /A direct position carries no Domino percentage fee, except the assisted-swap fee on the part swapped when your wallet holds one token; network gas still applies\./);
  // Four steps, none of them Automation, and the summary counts them.
  const newPosition = page('new-position');
  assert.match(newPosition.summary, /^Plan a position in four steps,/);
  assert.deepEqual(blocksOf(newPosition).find((block) => block.kind === 'steps').items.map((step) => step.title), ['Pool', 'Range', 'Amount', 'Review']);
  const positions = page('positions');
  // Changed on purpose (owner, 2026-09-24): the list is the positions the wallet created with Domino, read from chain; no lookup by NFT id.
  // Changed on purpose (2026-09-28, the owner's phone: the list stayed on its loading rows while the RPC refused his
  // address): the browser keeps a copy of the list, drawn at once while the chain is read (OwnedPositions.tsx).
  assert.match(sectionText(positions, 'your-positions'), /Positions lists the positions it created with Domino, read from the chain: there is no ID to type, and your browser keeps only a copy of the list\./);
  assert.match(sectionText(positions, 'your-positions'), /Position NFTs made elsewhere are not listed\./);
  assert.doesNotMatch(sectionText(positions, 'your-positions'), /Look up by NFT id|enter up to 10 IDs/);
  assert.doesNotMatch(textOf(positions), /always looked up by its ID|cannot list the positions a wallet holds/);
  assert.match(termText(page('glossary'), 'position-nft'), /Positions lists the ones your wallet created with Domino\./);

  assert.match(sectionText(page('risks'), 'tokens-and-contracts'), /Positions and automation run on smart contracts, and a contract can have defects\./);
  const intro = page('what-is-domino');
  assert.match(sectionText(intro, 'your-wallet-signs'), /^Your wallet signs every step you take\n/);
  // Changed on purpose (2026-09-27, review of 260a76a, the owner's point 6): the sequence vault and the operator are
  // explained where a beginner first meets them, and Domino never "holds your tokens" is gone: Create position deposits
  // them in the Setup contract before the mint (Non-custodial says so).
  const signs = sectionText(intro, 'your-wallet-signs');
  assert.match(signs, /Automation works through a sequence vault: a contract made for your wallet alone, which only your wallet controls\. Domino’s automation service, the operator, sends its transactions within the limits you signed\./);
  assert.match(signs, /Domino never holds your keys, and only your wallet can take your tokens out\./);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /never holds your keys or your tokens/, entry.slug);
  // Words the first page used with no explanation: activation, revocation and withdrawal are Non-custodial's, and the
  // factory and Setup are named on Contracts.
  assert.doesNotMatch(textOf(intro), /revocation|\bfactory\b|\bSetup\b/);
});

// 2026-09-27, the review of 260a76a: statements that were wrong or contradicted another page, and the words the
// position page and Positions use since round 5 (points 2, 4, 6, 7 and 10).
test('the docs use the product’s words for a position’s figures, say what Auto-compound did and where, and state the fees and the dialogs as they are', () => {
  const positions = page('positions');
  const all = DOC_PAGES.map(textOf).join('\n');
  // Principal and Unclaimed fees are Position value (Value on the list) and Fees ready to collect on every screen.
  assert.doesNotMatch(all, /Unclaimed fees|unclaimed fees|the principal \(/);
  // Changed on purpose (round 6, 2026-09-27, the owner: each position's APR on the list): the row's Your APR too.
  // Changed on purpose (2026-09-28, hotfix: the list no longer measures the APR itself): once its page was opened.
  assert.match(sectionText(positions, 'your-positions'), /its value, its fees ready to collect and Your APR, once you open its page\./);
  const details = sectionText(positions, 'position-details');
  for (const label of ['Position value', 'Fees ready to collect', 'Your APR', 'Current price']) assert.match(details, new RegExp(`\\n${label}: `), label);
  assert.match(details, /Your APR: this position’s own fees as a yearly rate, from its history\. Not the pool’s APR, and not a promise\./);
  assert.match(details, /With automation, its Fees earned card says how much was added back, and the chart marks each time\. No sign-in is needed\./);
  assert.match(sectionText(page('earned-fees'), 'unsettled-fees'), /^Fees ready to collect\n/);
  const glossary = page('glossary');
  assert.ok(termIds(glossary).includes('fees-ready-to-collect') && termIds(glossary).includes('your-apr') && !termIds(glossary).includes('unclaimed-fees'));
  assert.match(termText(glossary, 'your-apr'), /Not the pool’s APR, and not a promise\./);
  assert.match(termText(glossary, 'principal'), /its Position value\./);
  // What Auto-compound did: on the position's own page, with no sign-in (the owner's point 10).
  assert.match(sectionText(page('auto-compound'), 'what-it-did'), /A position’s page shows, with no sign-in, how much Auto-compound added back and how many times, and marks each time on its Fees earned chart\./);
  assert.ok(linksOf(page('auto-compound')).some((link) => link.to === '#/docs/positions#position-details'));
  // Managed positions and Receipts only are what signing in adds; Receipts has See all.
  const managed = sectionText(positions, 'managed-positions');
  assert.match(managed, /Sign in, and Positions adds two cards\. Managed positions shows each position under automation over the last 24 hours/);
  assert.match(managed, /See all opens every receipt on a page of its own\./);
  assert.doesNotMatch(managed, /Positions shows what automation did for you/);
  // Only Close has an "At least" row and a slippage choice (PositionActions.tsx).
  assert.match(sectionText(positions, 'collect-and-close'), /Each shows what you receive and the network fee before your wallet asks you to sign; Close also shows the least you receive within your slippage limit\./);
  // The service fee is 2% of the fees used: of 100 used, 2 are the fee and 98 go back (FeeAccounting.sol).
  assert.match(sectionText(page('auto-compound'), 'service-fee'), /2% of the earned fees it uses, taken once: of 100 USDG of fees it uses, 2 go to the service fee and 98 back into your position\./);
  assert.match(sectionText(page('fees'), 'service-fee'), /of 100 USDG of fees Auto-compound uses, 2 go to the service fee and 98 back into your position\./);
  assert.doesNotMatch(all, /fees it puts back, taken once|of fees put back by Auto-compound/);
  // A pair can have several pools of one fee tier, apart by their other settings.
  assert.match(sectionText(page('pools'), 'fee-tiers'), /The same two tokens can have several pools, for example one per fee tier\./);
  // Domino's own Collect fees and Close position stop automation, on each page that says what stops it.
  assert.match(sectionText(page('domino-compounder'), 'start-and-stop'), /Collect fees, Close position and changes made outside Domino stop it too: see Risks\./);
});

test('a status names a ROADMAP entry, so the pill beside the title always comes from ROADMAP', () => {
  const names = new Set(ROADMAP.map((entry) => entry.name));
  const statuses = DOC_PAGES.filter((entry) => entry.status !== undefined).map((entry) => [entry.slug, entry.status]);
  assert.deepEqual(statuses, [['auto-compound', 'Compound'], ['domino-compounder', 'Domino']]);
  for (const [, status] of statuses) assert.ok(names.has(status), status);
});

test('the limits and fees match the contracts: 20% trigger and overlap, a positions cap, an upside the owner sets, 2% simple / 4% Domino service and 0.65% swap cap', () => {
  const contract = (name) => readFileSync(join(REPO, 'contracts/src', name), 'utf8');
  const policy = contract('PolicyValidation.sol');
  assert.match(policy, /MAX_TRIGGER_DISTANCE_BPS = 2000;/, 'trigger distance is capped at 2,000 bps');
  assert.match(policy, /MAX_OVERLAP_BPS = 2000;/, 'overlap is capped at 2,000 bps');
  const accounting = contract('FeeAccounting.sol');
  assert.match(accounting, /SIMPLE_SERVICE_FEE_BPS = 200;/);
  assert.match(accounting, /DOMINO_SERVICE_FEE_BPS = 400;/);
  assert.match(accounting, /MAX_SERVICE_FEE_BPS = DOMINO_SERVICE_FEE_BPS;/);
  assert.match(policy, /FeeAccounting\.validTariff\(next\.serviceFeeBps\)/, 'only the two selected tariffs are valid');
  assert.match(contract('DominoSetup.sol'), /feeBps_ > 65\b/, 'the assisted swap fee is capped at 65 bps');
  assert.match(contract('DominoVaultV4.sol'), /limits\.upsideBps == 0 \|\| limits\.upsideBps > 1_000_000/, 'the upside is the owner’s own limit');
  assert.match(contract('DominoVaultV4.sol'), /activePositions >= _policy\.maxPositions/, 'a sequence has a positions cap');
  // The verified record carries the same tariffs (handoff §6): 2% and 4% once on consumed earned fees, no extra fee on the automation's swaps, 65 bps on the assisted swap.
  assert.deepEqual(
    [DEPLOYMENT.policies.simpleCompoundFeeBps, DEPLOYMENT.policies.dominoCompoundFeeBps, DEPLOYMENT.policies.additionalAutomationSwapFeeBps, DEPLOYMENT.policies.assistedSwapFeeBps],
    [200, 400, 0, 65],
  );
  assert.equal(DEPLOYMENT.policies.automationFeeBasis, 'consumed_original_earned_fees_once_not_principal');

  const limits = Object.fromEntries(rowsOf(page('domino-compounder'), 'facts').map((row) => [row.label, row]));
  assert.equal(limits['Trigger distance'].value, 'Up to 20%');
  assert.equal(limits['Maximum overlap'].value, 'Up to 20%');
  // Your sequences starts the field empty (Sequence.tsx); 50% is what the app draws the next range with (DEFAULT_UPSIDE_PERCENT, journey.ts).
  assert.equal(limits.Upside.value, 'You set it; the app draws the next range at 50%');
  assert.match(limits.Positions.note, /Counts the position it starts from/);

  const fees = Object.fromEntries(rowsOf(page('fees'), 'facts').map((row) => [row.label, row]));
  assert.equal(fees['Domino service fee'].value, 'Auto-compound 2%; Domino-compound 4% of earned fees consumed');
  assert.match(fees['Domino service fee'].note, /Never on principal, never on a direct deposit/);
  assert.equal(fees['Assisted swap fee'].value, '0.65% of the amount swapped');
  assert.equal(fees['Network gas'].value, 'Paid by the wallet that sends it');
});

test('the Uniswap addresses are the ones the backend is configured with, the Domino V1 addresses the ones the record verified, each a lowercase address', () => {
  const backend = (file) => readFileSync(join(REPO, 'backend', file), 'utf8');
  const constant = (text, name) => new RegExp(`^${name} = '(0x[0-9a-f]{40})'`, 'm').exec(text)?.[1];
  const discovery = backend('discovery.py');
  const expected = [
    ['PoolManager', constant(discovery, 'POOL_MANAGER')],
    ['PositionManager', constant(discovery, 'POSITION_MANAGER')],
    ['StateView', constant(discovery, 'STATE_VIEW')],
    ['Permit2', constant(backend('deposit_prepare.py'), 'PERMIT2')],
  ];
  for (const [name, address] of expected) assert.match(address ?? '', /^0x[0-9a-f]{40}$/, `backend ${name}`);
  const contracts = page('contracts');
  assert.deepEqual(sectionIds(contracts), ['domino-contracts', 'uniswap-contracts', 'network']);
  const rows = (id) => contracts.sections.find((section) => section.id === id).blocks.filter((block) => block.kind === 'addresses').flatMap((block) => block.rows.map((row) => [row.label, row.address]));
  assert.deepEqual(rows('uniswap-contracts'), expected);
  // The record's Uniswap dependencies are the backend's, so the page describes one chain.
  assert.deepEqual([DEPLOYMENT.dependencies.poolManager, DEPLOYMENT.dependencies.positionManager, DEPLOYMENT.dependencies.stateView], expected.slice(0, 3).map(([, address]) => address));
  // Domino V1: only the two contracts a wallet meets, under the names the record and the explorer give them. The vault is a clone
  // made per owner and the implementation is its template (handoff §2), so neither has an address here.
  assert.deepEqual(rows('domino-contracts'), [
    [DEPLOYMENT.contractNames.setup, DEPLOYMENT.contracts.setup],
    [DEPLOYMENT.contractNames.factory, DEPLOYMENT.contracts.factory],
  ]);
  assert.deepEqual([DEPLOYMENT.contractNames.setup, DEPLOYMENT.contractNames.factory], ['DominoSetupV1', 'DominoVaultFactoryV1']);
  assert.equal(rowsOf(contracts, 'facts').find((row) => row.label === 'Chain ID').value, String(DEPLOYMENT.chain.chainId));
  assert.equal(DEPLOYMENT.chain.chainId, 4663);
  for (const entry of DOC_PAGES) for (const row of rowsOf(entry, 'addresses')) assert.match(row.address, /^0x[0-9a-f]{40}$/, `${entry.slug}: ${row.label}`);
});

test('Domino V1 is deployed; owner-scoped automation copy keeps each new sequence paused until its own service check passes', () => {
  assert.equal(DEPLOYMENT.publicReleaseVersion, 1);
  assert.equal(DEPLOYMENT.contractsDeployed, true);
  // Changed on purpose (2026-09-27, the owner's round 6, point 6): the Settings page that listed ROADMAP with a note per
  // row is gone, and the notes with it; ROADMAP names only the two automations whose pill a page shows.
  assert.deepEqual(ROADMAP.map((row) => row.name), ['Compound', 'Domino']);
  for (const entry of ROADMAP) {
    assert.equal(entry.status, 'owner-scoped');
    assert.equal(ROADMAP_PILL[entry.status], 'Per sequence');
    assert.deepEqual(Object.keys(entry), ['name', 'status'], `${entry.name} carries no note`);
  }
  // Changed on purpose (2026-09-25, audit of 754014c): the automation page lost its owner controls, so no Domino screen
  // activates, pauses, revokes or withdraws any more. The docs and Settings said this site offered activation after a
  // readiness check; they now say what is true: those are transactions the wallet signs on the sequence vault,
  // activation once the service confirms readiness, and no Domino screen makes them today.
  // Changed on purpose again (owner, 2026-09-25): a position's page offers Turn on once the automation service confirms it
  // is ready for that sequence, and Pause while it runs (components/positions/SequenceSwitch.tsx); the docs say so.
  const TRUE = /A new sequence starts paused\. Activation, pause, revocation and withdrawal are transactions your wallet signs on your sequence vault\. Your position’s page offers Turn on once the automation service confirms it is ready for your sequence, and Pause while it runs\./;
  for (const [slug, section] of [['auto-compound', 'where-it-starts'], ['domino-compounder', 'start-and-stop']]) {
    const copy = sectionText(page(slug), section);
    assert.match(copy, /Per sequence\nAutomation availability is checked for each owner and sequence\./);
    assert.match(copy, TRUE, slug);
  }
  // Changed on purpose (2026-09-27, review of 260a76a): What Domino is says the same in a beginner's words; the
  // transactions themselves are Non-custodial's.
  assert.match(sectionText(page('what-is-domino'), 'your-wallet-signs'), /Automation starts paused\. Once the service is ready for it, your position’s page offers Turn on, and Pause while it runs\./);
  const activate = blocksOf(page('domino-compounder')).find((block) => block.kind === 'steps').items.find((step) => step.title === 'Activate it');
  assert.match(inlineText(activate.body), /After the service confirms readiness for your sequence, a separate wallet transaction takes it out of pause\. Signing in or opening a page never does\./);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /offers? activation|review activation|may activate|remain available through your wallet/i, entry.slug);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /No Domino screen makes them today/, entry.slug);
  // The review of 2026-09-25: Turn on and Pause have no review wall (the owner's rule), so no text may say that every
  // wallet step shows its amounts and limits first; the docs name the two exceptions. (Settings said the same until the
  // owner removed it, 2026-09-27.)
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /Each step shows its amounts/, entry.slug);
  assert.match(sectionText(page('what-is-domino'), 'your-wallet-signs'), /and Pause while it runs\. Turn on and Pause go straight to your wallet, which shows the transaction\./);
  // Changed on purpose (2026-09-27, review of 260a76a): no contract name a beginner has not met; Contracts names them.
  assert.match(sectionText(page('what-is-domino'), 'built-on-uniswap'), /Domino’s own contracts, Domino V1, run there too: one opens your positions, and another makes your sequence vault\./);
  assert.match(sectionText(page('contracts'), 'domino-contracts'), /deployed on Robinhood Chain as Domino V1\.[\s\S]*Service readiness is checked for each owner and vault before activation/);
  assert.match(sectionText(page('wallet'), 'what-needs-sign-in'), /Checking whether the automation service is ready for your sequence before activation/);
  for (const entry of DOC_PAGES) {
    const text = textOf(entry);
    assert.doesNotMatch(text, /automation is (?:now )?(?:active|running|live|on|in operation)\b|active automation|automation (?:now )?runs\b|automation is not running|service (?:that carries it out )?is not in operation/i, entry.slug);
    // No date and no promise; the public name is Domino V1, and the implementation's own version number stays out of the client's docs.
    assert.doesNotMatch(text, /\bsoon\b|\bshortly\b|\bwill be\b|\bplanned\b|\broadmap\b|version 4|implementation version/i, entry.slug);
  }
});

// 2026-09-27, the owner's round 6. Point 1: one plain phrase for what automation puts back, "added back", never
// "re-added". Point 6: the Settings page is gone, so no page names it; what it said is in the docs, checked here. And the
// docs say what the round changed: the Positions table's APR (point 3), the Wallet card's top three tokens (point 4), the
// simpler range simulator (point 3), the reworked pool page (point 7) and one New position wherever it starts (point 8).
test('round 6: "added back" everywhere, no Settings, and the docs describe the round’s screens', () => {
  const all = strings([DOC_GROUPS, docs.DOCS_HOME, SHOTS]);
  for (const text of all) {
    assert.doesNotMatch(text, /re-?\u2060?add/i, `"re-add" in: ${text}`);
    // 2026-09-28 (review): the Settings page by its name. The plain word "settings", as in a pool's own settings, stays;
    // the link check below rejects any #/settings link.
    assert.doesNotMatch(text, /\bSettings\b/, `Settings in: ${text}`);
  }
  for (const entry of DOC_PAGES) for (const link of linksOf(entry)) assert.doesNotMatch(link.to, /settings/, `${entry.slug}: ${link.to}`);
  const positions = page('positions');
  assert.match(sectionText(positions, 'managed-positions'), /Receipts lists each automation run and the fees it added back;/);
  assert.match(SHOTS.receipts.alt, /added a position’s fees back, with what it added back\.$/);
  // Point 3: the table's own APR, beside how each row's fees are used. Point 4: the Wallet card, every token in dollars,
  // the three worth the most always shown. 2026-09-28 (review): the Positions picture, its size and its description are
  // r6/postable's, which re-shot it with the APR column; this branch leaves them as they were, so they merge unchanged.
  assert.match(sectionText(positions, 'your-positions'), /Open rows also say how their fees are used, or offer Automate\./);
  assert.match(sectionText(positions, 'wallet-balances'), /The Wallet card shows the tokens of the connected wallet, or any address, in dollars: the three largest first, the rest under Show all\./);
  // Point 3: the simulator in plain words. Point 7: Plan a range left the pool page, and its typical range took the place.
  const ranges = page('ranges');
  assert.match(sectionText(ranges, 'try-a-range'), /range simulator on Home lets you move the price and see, in plain words, whether a position earns fees and what it holds\./);
  assert.match(sectionText(ranges, 'try-a-range'), /On a pool’s page, A typical range draws the band New position starts on against that pool’s price\. Nothing is saved or sent\./);
  assert.ok(linksOf(ranges).some((link) => link.to === '#/#ranges'), 'the simulator is linked where it lives');
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /Plan a range/, entry.slug);
  // Points 8 and 9: one New position wherever it starts, its steps in plain words, and slippage under Advanced.
  const create = page('new-position');
  // 2026-09-28 (review): the pool page's button has one name in the docs, Create a position (r6/poolpage's label).
  assert.match(sectionText(create, 'four-steps'), /From a pool’s page, Create a position opens these same four steps, with that pool already chosen\./);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /pool’s page, New position\b/, entry.slug);
  assert.doesNotMatch(textOf(create), /largest TVL first/);
  assert.match(sectionText(create, 'step-range'), /Closer and Wider are ready-made ranges around the pool’s price; Custom takes your own lowest and highest price\./);
  assert.match(sectionText(create, 'step-amount'), /Under Advanced, slippage tolerance is how far the price may move before a step stops\. It starts at 0\.5%; choose 0\.1% to 5%\./);
  // Point 7: technical facts live in Details on a pool's page, which Pools and fee tiers says of the protocol fee too.
  assert.match(sectionText(page('pools'), 'fee-tiers'), /A pool’s page shows it in Details\./);
  // 2026-09-28 (review): round 5's plain words for what makes a pool's id stay. Tick spacing is first explained on the
  // next page, Price ranges, so it is not named here.
  assert.match(sectionText(page('pools'), 'pool-identity'), /pools by their id, which comes from the two tokens, the fee and the pool’s other settings\./);
  assert.doesNotMatch(sectionText(page('pools'), 'pool-identity'), /tick spacing/i);
  // What Settings said, the docs say: the chain and its id, the service fees and the assisted swap's, that the automation's
  // own balancing swaps cost nothing extra, and that every wallet step is shown by the wallet before it is signed.
  assert.equal(rowsOf(page('contracts'), 'facts').find((row) => row.label === 'Chain ID').value, '4663');
  assert.match(sectionText(page('fees'), 'service-fee'), /Auto-compound charges 2% of the earned fees it uses\. Domino-compound charges 4%/);
  assert.match(sectionText(page('fees'), 'assisted-swap-fee'), /the automation’s own balancing swaps carry no swap fee\./);
  assert.match(sectionText(page('what-is-domino'), 'your-wallet-signs'), /Nothing moves until your wallet signs\. Your wallet shows each transaction before you sign it\./);
  assert.match(sectionText(page('wallet'), 'sign-in'), /It approves no token, deposits nothing, swaps nothing, withdraws nothing and starts no automation\./);
});

test('previous and next walk the pages in sidebar order: nothing before the first, nothing after the last', () => {
  DOC_PAGES.forEach((entry, index) => {
    const { previous, next } = docs.docNeighbours(entry.slug);
    assert.equal(previous?.slug ?? null, DOC_PAGES[index - 1]?.slug ?? null, `before ${entry.slug}`);
    assert.equal(next?.slug ?? null, DOC_PAGES[index + 1]?.slug ?? null, `after ${entry.slug}`);
  });
  assert.equal(docs.docNeighbours(DOC_PAGES[0].slug).previous, null);
  assert.equal(docs.docNeighbours(DOC_PAGES.at(-1).slug).next, null);
  assert.deepEqual(docs.docNeighbours('constructor'), { previous: null, next: null });
});

test('titles are short, a summary is one line ending in a period, and every page stays short', (t) => {
  assert.ok(docs.DOCS_HOME.summary.length <= 140 && docs.DOCS_HOME.summary.endsWith('.'));
  for (const entry of DOC_PAGES) {
    assert.ok(entry.title.length <= 40, `${entry.slug}: title`);
    assert.ok(entry.summary.length <= 140, `${entry.slug}: summary is ${entry.summary.length} characters`);
    assert.ok(entry.summary.endsWith('.'), `${entry.slug}: summary`);
    if (entry.lead !== undefined) assert.ok(entry.lead.endsWith('.') && entry.lead !== entry.summary, `${entry.slug}: lead`);
    for (const section of entry.sections) assert.ok(section.title.length <= 60, `${entry.slug}: ${section.title}`);
    const words = textOf(entry).split(/\s+/).filter(Boolean).length;
    t.diagnostic(`${entry.slug}: ${words} words`);
    // 450: Non-custodial covers the partner's list and the setup operation; Figures, Domino history beside the provider and the estimate.
    // 480 for Non-custodial: its controls table names what the owner can do, and changing the limits became one of them.
    // 480 for Domino Compounder: the availability note under its pill, since the contracts shipped without the service (2026-09-21).
    // 680 for the Glossary (2026-09-27, the owner's docs for complete beginners, point 8): The basics, seven words a first-time
    // reader meets before any other (liquidity, liquidity provider, position, APR, slippage tolerance, gas, smart contract),
    // after every other definition was shortened; measured at 675 words.
    // 690 for the Glossary (2026-09-27, the review of 260a76a, owner-requested round 5): Your APR (point 4) and Fees
    // ready to collect in the product's words, the operator named as Domino's automation service (point 6); Pool and
    // Receipt shortened to make room; measured at 689 words.
    // 480 for Positions (2026-09-27, the review of 260a76a, owner-requested round 5): a position's page gained Your APR
    // (point 4) and what automation added back (point 10), and Receipts its See all page (point 7); measured at 477 words
    // after the page was shortened elsewhere.
    const budget = entry.slug === 'glossary' ? 690 : entry.slug === 'non-custodial' || entry.slug === 'domino-compounder' || entry.slug === 'positions' ? 480 : 450;
    assert.ok(words <= budget, `${entry.slug} has ${words} words`);
  }
});

test('the docs source stays inside its budget in the entry bundle', (t) => {
  const dir = join(APP, 'src/lib/docs');
  const files = readdirSync(dir, { recursive: true }).map(String).filter((file) => file.endsWith('.ts')).sort();
  assert.ok(files.length >= 8, files.join(', '));
  const text = files.map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
  const size = gzipSync(text, { level: 9 }).length;
  t.diagnostic(`src/lib/docs: ${files.length} files, ${Buffer.byteLength(text)} bytes, ${size} bytes gzip (budget 24000)`);
  assert.ok(size <= 24_000, `the docs source is ${size} bytes gzip, over the 24,000 byte budget: move the docs to a lazy chunk (docs-design.md 9.3)`);
});

// ---------------------------------------------------------------------------
// 2026-09-27, the owner's point 8: pictures of the app for complete beginners.
// A picture is a screen shot from the test view with made-up figures, taken by
// scripts/docs-shots.mjs into public/docs/<id>.webp, its size and plain words
// in src/lib/docs/shots.ts; a drawing is components/docs/DocsDiagram.tsx.
// ---------------------------------------------------------------------------

const PICTURES = join(APP, 'public/docs');
const shotsOf = (entry) => blocksOf(entry).filter((block) => block.kind === 'shot');
const diagramsOf = (entry) => blocksOf(entry).filter((block) => block.kind === 'diagram');

/** A WebP file's canvas size, from its RIFF header (lossy VP8, lossless VP8L or extended VP8X), or null. */
function webpSize(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

test('every picture a page shows is a WebP in public/docs of the size shots.ts gives, with its phone picture, and every file there is shown', () => {
  const ids = Object.keys(SHOTS);
  assert.ok(ids.length >= 8, `${ids.length} pictures`);
  const used = new Set(DOC_PAGES.flatMap((entry) => shotsOf(entry).map((block) => block.shot)));
  for (const entry of DOC_PAGES) for (const block of shotsOf(entry)) assert.ok(Object.hasOwn(SHOTS, block.shot), `${entry.slug}: no picture ${block.shot}`);
  assert.deepEqual([...used].sort(), [...ids].sort(), 'every picture is on a page, and no page names one that is not there');
  // 2026-09-27 (review of 260a76a): a desktop crop shrunk into a phone's column is unreadable, so every picture has one
  // shot in a phone's window, served under 640 px (DocsContent.tsx).
  const pictures = ids.flatMap((id) => [[id, `${id}.webp`, SHOTS[id]], [id, `${id}-phone.webp`, SHOTS[id].phone]]);
  // First the files a failed scene deleted (scripts/docs-shots.mjs never leaves a stale picture), by name.
  for (const [id, name, size] of pictures) {
    assert.ok(size, `${id} has no phone picture in shots.ts: run scripts/docs-shots.mjs`);
    assert.ok(existsSync(join(PICTURES, name)), `${name} is missing: run scripts/docs-shots.mjs`);
  }
  assert.deepEqual(readdirSync(PICTURES).sort(), pictures.map(([, name]) => name).sort(), 'public/docs holds the pictures and nothing else');
  for (const [id, name, expected] of pictures) {
    assert.match(id, SLUG, id);
    const phone = name.endsWith('-phone.webp');
    assert.equal(shotSrc(id, phone), `/docs/${name}`, 'served from this site, as the CSP’s img-src allows');
    // The build marker guard reads file names too (vite.config.ts, render.test.mjs).
    assert.deepEqual(findForbidden(`docs/${name}`), [], name);
    const file = join(PICTURES, name);
    const size = webpSize(readFileSync(file));
    assert.ok(size, `${name} is not a WebP`);
    assert.deepEqual(size, { width: expected.width, height: expected.height }, `${name}: shots.ts has the file’s own size, so the page keeps its place while it loads`);
    // 2026-09-27 (the owner: "o enquadramento deve ser perfeito"): one width per kind, so every picture of a kind is
    // drawn at one size: its block (772 CSS px in an 820 px window, 358 in a 390 px phone's) with its frame on each side
    // (32 px, 16 on a phone), at twice its size and never resampled (scripts/docs-shots.mjs BLOCK, FRAME, SCALE).
    if (phone) assert.ok(size.width === 780 && size.height <= 2400, `${name}: ${size.width}×${size.height}, a phone's block and frame at twice their size`);
    else assert.ok(size.width === 1672 && size.height <= 2400, `${name}: ${size.width}×${size.height}, a desktop block and frame at twice their size`);
    assert.ok(statSync(file).size <= 160 * 1024, `${name} is ${statSync(file).size} bytes: compress it harder`);
  }
});

test('every picture and drawing has plain words: a description for those who cannot see it and a line under it', () => {
  for (const [id, shot] of Object.entries(SHOTS)) {
    assert.ok(shot.alt.length >= 30 && shot.alt.length <= 220, `${id}: its description is ${shot.alt.length} characters`);
    assert.ok(shot.alt.endsWith('.'), `${id}: its description is a sentence`);
    assert.doesNotMatch(shot.alt, /\b(image|picture|screenshot|screen shot) of\b/i, `${id}: the description says what is shown, not that it is a picture`);
  }
  for (const entry of DOC_PAGES) {
    for (const block of [...shotsOf(entry), ...diagramsOf(entry)]) {
      assert.ok(block.caption.length > 0 && block.caption.length <= 120 && block.caption.endsWith('.'), `${entry.slug}: the line under ${block.shot ?? block.name}`);
    }
    const names = diagramsOf(entry).map((block) => block.name);
    // A drawing carries an id of its own (the earning drawing's clip), so each is drawn at most once on a page.
    assert.equal(new Set(names).size, names.length, `${entry.slug} draws ${names.join(', ')}`);
    for (const block of diagramsOf(entry)) {
      assert.ok(['earning', 'three-ways'].includes(block.name), `${entry.slug}: no drawing ${block.name}`);
      assert.ok(block.alt.length >= 30 && block.alt.endsWith('.'), `${entry.slug}: ${block.name} needs its description`);
    }
  }
  // The pages a beginner reads to use Domino each show the screen they talk about.
  const shown = (slug) => shotsOf(page(slug)).map((block) => block.shot);
  assert.deepEqual(shown('markets'), ['markets', 'pool']);
  assert.deepEqual(shown('new-position'), ['new-pool', 'new-range', 'new-amount', 'new-review']);
  assert.deepEqual(shown('positions'), ['positions', 'position', 'receipts']);
  assert.deepEqual(shown('auto-compound'), ['automate']);
  assert.deepEqual(diagramsOf(page('what-is-domino')).map((block) => block.name), ['earning', 'three-ways']);
});

test('the screenshot script says how to run it again, and shows only made-up data', () => {
  const script = readFileSync(join(APP, 'scripts/docs-shots.mjs'), 'utf8');
  assert.match(script, /rm -rf \.wallet-test-dist && npm run build:wallet-test && npm run build:unit && node scripts\/docs-shots\.mjs/);
  // The test view only: the wallet-test build, the suites' fake chain, fake session and Test Wallet A.
  for (const needle of ['WALLET_DIST', 'createFakeSession', 'browserChain', 'installWallets', 'Connect Test Wallet A']) assert.ok(script.includes(needle), needle);
  // Never a real wallet's address: every address the made-up world holds is a test key's, a pattern, or a contract the app itself names.
  assert.doesNotMatch(script, /0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a|0x5290e7d1a3cb728cc497b455e2397b3ec31eab69|0x19ea/i);
  for (const id of Object.keys(SHOTS)) assert.ok(script.includes(`id: '${id}'`), `the script shoots ${id}`);
  // A scene that fails deletes its old pictures, so the check above fails instead of a stale picture shipping (review of
  // 260a76a: the redesigned position page and receipts would otherwise have kept main's pictures, raw hashes and all).
  assert.match(script, /rmSync\(join\(OUT, `\$\{fileOf\(scene\.id, phone\)\}\.webp`\), \{ force: true \}\)/);
  // Every scene in a phone's window too, and no hover or focus left on the screen it shoots.
  assert.match(script, /const phone = await shoot\(browser, scene, true\);/);
  // One block width per kind, checked on every scene; one margin on all four sides of the block's ink, never resampled.
  assert.match(script, /const BLOCK = \{ desktop: 772, phone: 358 \};/);
  assert.match(script, /const FRAME = \{ desktop: 32, phone: 16 \};/);
  assert.match(script, /if \(block\.width !== want\) throw new Error/);
  assert.match(script, /context2d\.drawImage\(source, left, top, inkWidth, inkHeight, pad, pad, inkWidth, inkHeight\);/);
  assert.match(script, /page\.mouse\.move\(0, 0\)/);
  // The blocks are found by what survives a redesign: the position page's key figures, the receipts card's title.
  for (const needle of ['[data-position-stats]', 'section[aria-labelledby="receipts-title"]', '[data-pool-workspace]']) assert.ok(script.includes(needle), needle);
  // 2026-09-27: the test build's banner is hidden by the script's own stylesheet, which only its server serves: the
  // app's stylesheets never name it (the build marker guard refuses it in a deployable build too).
  assert.match(script, /\[data-build-banner\] \{ display: none !important; \}/);
  for (const file of readdirSync(join(APP, 'src/styles'))) assert.doesNotMatch(readFileSync(join(APP, 'src/styles', file), 'utf8'), /data-build-banner/, file);
  // The made-up world is the script's own (scripts/docs-world.mjs): the tokens the app has artwork for, and no fixture
  // token or placeholder address on a picture.
  const world = readFileSync(join(APP, 'scripts/docs-world.mjs'), 'utf8');
  for (const token of ['ETH', 'WETH', 'USDG', 'MARLIN']) assert.ok(existsSync(join(APP, `public/tokens/${token.toLowerCase()}.${token === 'MARLIN' ? 'jpg' : 'svg'}`)), token);
  assert.doesNotMatch(`${script}\n${world}`, /FIXTURE_TOKEN|0x1{40}|symbol: 'TOKEN'/);
});
