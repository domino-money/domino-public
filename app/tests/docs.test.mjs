/**
 * The in-app documentation (#/docs), checked as data before a browser sees it:
 * every page, section and term id, every link, every sentence, the numbers
 * that must match the contracts and the addresses that must match the
 * backend, and the size the pages add to the entry bundle. The render suite
 * drives the built pages themselves.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { findForbidden } from '../scripts/deploy-markers.mjs';

const require = createRequire(import.meta.url);
const docs = require('../.test-build/app/src/lib/docs/registry.js');
const { ROADMAP, ROADMAP_PILL } = require('../.test-build/app/src/lib/capabilities.js');

const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..');
/** The verified record of Domino V1 on Robinhood Chain (docs/V1_MAINNET_FRONTEND_HANDOFF_0XDECIMAL.md §3): the pages name its contracts and its state. */
const DEPLOYMENT = JSON.parse(readFileSync(join(REPO, 'docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json'), 'utf8'));
const { DOC_GROUPS, DOC_PAGES } = docs;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS = new Set(['p', 'list', 'steps', 'note', 'facts', 'addresses', 'split', 'terms']);

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
  const screens = new Set(['#/', '#/markets', '#/positions', '#/automate', '#/new', '#/settings', '#/#learn', '#/#ranges', '#/#limits']);
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
  const all = strings([DOC_GROUPS, docs.DOCS_HOME]);
  assert.ok(all.length > 300, `${all.length} strings`);
  for (const text of all) {
    assert.deepEqual(findForbidden(text), [], text);
    assert.doesNotMatch(text, /(https?|wss?):\/\//, text);
    assert.doesNotMatch(text, /\balpha\b|\bbeta\b|\bv4\b|\bpreview\b|not enabled yet|not connected yet|read-only|coming soon/i, text);
    assert.doesNotMatch(text, /\$\s?\d/, text);
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
  for (const id of ['domino-compounder', 'sequence', 'self-managing', 'auto-compound', 'operator']) assert.ok(glossary.includes(id), id);
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
  assert.match(text, /earned fees not yet reinvested, are held by your own sequence vault until you withdraw them/);
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
  assert.match(sectionText(custody, 'your-wallet'), /the tokens you fund wait in a setup operation until you mint or refund\. Only your wallet can do either, and a refund carries no Domino fee\./);
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
  // Risks and the glossary say the same, and no page still calls TVL or volume a provider's figure only.
  assert.match(sectionText(page('risks'), 'figures-describe-pools'), /TVL and 24h volume come from Domino history where the deployment provides it, and otherwise from a market data provider that Domino does not reconcile\./);
  const glossary = page('glossary');
  assert.equal(termText(glossary, 'domino-history'), 'Domino’s own record of a pool’s last 24 hours, where the deployment provides it. Figures from it are marked Domino history.');
  assert.match(termText(glossary, 'tvl'), /from Domino history or, where it has none, a market data provider\.$/);
  assert.match(termText(glossary, 'volume-24h'), /from Domino history or, where it has none, a market data provider\.$/);
  assert.match(termText(glossary, 'estimated-apr'), /24h volume and TVL, its fee tier and its protocol fee\. It describes the pool, not a position, and is shown where Domino history gives no APR\.$/);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /as a market data provider reports it|reported by a provider and not reconciled by Domino/, entry.slug);
});

test('Auto-compound sets up on any position NFT you hold with two wallet transactions; activation is a separate conditional third step', () => {
  const auto = page('auto-compound');
  const start = sectionText(auto, 'where-it-starts');
  assert.match(start, /Auto-compound runs on a position NFT you hold, wherever you opened it\. Setup takes two wallet transactions: approve that one NFT to its sequence vault, then create the sequence, which starts paused\. Activation is a separate wallet transaction when the service is ready for your sequence\./);
  assert.match(start, /Custody is the same as for Domino Compounder: the NFT stays in your wallet, and your sequence vault holds earned fees not yet reinvested until you withdraw them\./);
  assert.match(start, /Changes made to that NFT outside Domino can stop it: see Risks\./);
  // New position offers no automation choice any more, so the page no longer says choosing it there records anything.
  assert.doesNotMatch(textOf(auto), /New position|records the choice/);
  const links = linksOf(auto).map((link) => link.to);
  for (const to of ['#/docs/non-custodial#sequence-vault', '#/docs/non-custodial#pause-revoke-withdraw', '#/docs/risks#automation-stops']) assert.ok(links.includes(to), to);
  // No screen is named as the place a compound-only sequence starts: the owner has not chosen one.
  assert.doesNotMatch(textOf(auto), /opened in Setup|Automate|Create or manage a sequence|Open a position/);
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
  assert.equal(termText(glossary, 'sequence'), 'The vault contract created for your wallet that holds the positions automation opens and earned fees not yet reinvested. Only your wallet can withdraw from it.');
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /50% by default/, entry.slug);
});

test('the wallet, pools, fees, markets, new position, positions, risks and what Domino is pages say what the app and contracts do', () => {
  const wallet = page('wallet');
  const needs = blocksOf(wallet).find((block) => block.kind === 'list').items.map(inlineText);
  // Changed on purpose (owner, 2026-09-22): Review's deposit-amount estimate was deleted, so it needs no sign-in any more.
  assert.deepEqual(needs, [
    'Deposit drafts kept by the deposit service, and their receipts.',
    'The assisted swap quote in Setup.',
    'Managed positions and automation receipts, on Positions.',
    'Checking whether the automation service is ready for your sequence before activation.',
  ]);
  assert.match(sectionText(wallet, 'what-needs-sign-in'), /Neither do a setup operation’s steps \(fund, swap, mint and refund\), sequence creation, pause, revocation, repair or withdrawal: they work with your wallet alone\. Activation also requires a live service check bound to your signed-in address and your sequence vault\./);
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
  assert.match(poolPage, /hourly candles of either token’s USD price, with volume/);
  assert.match(poolPage, /pool id, tokens, fee, protocol fee, tick spacing, hooks, 24h volume over TVL and the block the pool was verified at/);
  assert.match(poolPage, /Where available, the page also shows the pool’s on-chain activity over the last 24 hours and the positions in the pool\./);
  assert.doesNotMatch(poolPage, /hourly USD price and volume/);

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
  assert.match(sectionText(positions, 'your-positions'), /Positions lists the positions it created with Domino, read from the chain for your address: there is no ID to type, and nothing is kept in your browser\./);
  assert.match(sectionText(positions, 'your-positions'), /Position NFTs made elsewhere are not listed\./);
  assert.doesNotMatch(sectionText(positions, 'your-positions'), /Look up by NFT id|enter up to 10 IDs/);
  assert.doesNotMatch(textOf(positions), /always looked up by its ID|cannot list the positions a wallet holds/);
  assert.match(termText(page('glossary'), 'position-nft'), /Positions lists the ones your wallet created with Domino\./);

  assert.match(sectionText(page('risks'), 'tokens-and-contracts'), /Positions and automation run on smart contracts, and a contract can have defects\./);
  const intro = page('what-is-domino');
  assert.match(sectionText(intro, 'your-wallet-signs'), /^Your wallet signs every step you take\n/);
  assert.match(sectionText(intro, 'your-wallet-signs'), /Once you activate automation, its operator sends automation transactions within the limits you signed\./);
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
  for (const name of ['Compound', 'Fee-balancing swaps', 'Domino']) {
    const entry = ROADMAP.find((row) => row.name === name);
    assert.equal(entry.status, 'owner-scoped');
    assert.equal(ROADMAP_PILL[entry.status], 'Per sequence');
    assert.doesNotMatch(entry.note, /not running|not in operation/i);
  }
  for (const [slug, section] of [['auto-compound', 'where-it-starts'], ['domino-compounder', 'start-and-stop']]) {
    const copy = sectionText(page(slug), section);
    assert.match(copy, /Per sequence\nAutomation availability is checked for each owner and sequence\./);
    assert.match(copy, /signed-in owner can review activation only when the live service confirms readiness for that vault/);
    assert.match(copy, /does not offer activation when the check fails/);
  }
  const activate = blocksOf(page('domino-compounder')).find((block) => block.kind === 'steps').items.find((step) => step.title === 'Activate it');
  assert.match(inlineText(activate.body), /After the service confirms readiness for your sequence, a separate wallet transaction takes it out of pause\. Signing in or opening a page never does\./);
  assert.match(sectionText(page('what-is-domino'), 'your-wallet-signs'), /offers activation only to its signed-in owner after the live service confirms readiness for that exact sequence/);
  assert.match(sectionText(page('what-is-domino'), 'built-on-uniswap'), /Domino’s own contracts, Domino V1, are deployed there as well: Setup opens positions, and a factory creates your sequence vault\./);
  assert.match(sectionText(page('contracts'), 'domino-contracts'), /deployed on Robinhood Chain as Domino V1\.[\s\S]*Service readiness is checked for each owner and vault/);
  assert.match(sectionText(page('wallet'), 'what-needs-sign-in'), /Checking whether the automation service is ready for your sequence before activation/);
  for (const entry of DOC_PAGES) {
    const text = textOf(entry);
    assert.doesNotMatch(text, /automation is (?:now )?(?:active|running|live|on|in operation)\b|active automation|automation (?:now )?runs\b|automation is not running|service (?:that carries it out )?is not in operation/i, entry.slug);
    // No date and no promise; the public name is Domino V1, and the implementation's own version number stays out of the client's docs.
    assert.doesNotMatch(text, /\bsoon\b|\bshortly\b|\bwill be\b|\bplanned\b|\broadmap\b|version 4|implementation version/i, entry.slug);
  }
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
    const budget = entry.slug === 'glossary' ? 600 : entry.slug === 'non-custodial' || entry.slug === 'domino-compounder' ? 480 : 450;
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
