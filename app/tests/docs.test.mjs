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

// Source checks use LF on every checkout; byte budgets still measure the original files.
const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const require = createRequire(import.meta.url);
const docs = require('../.test-build/app/src/lib/docs/registry.js');
const { ROADMAP, ROADMAP_PILL } = require('../.test-build/app/src/lib/capabilities.js');
const { SHOTS } = require('../.test-build/app/src/lib/docs/shots.js');
const { shotSrc } = require('../.test-build/app/src/lib/docs/blocks.js');
const { CREATE } = require('../.test-build/app/src/lib/create/copy.js');

const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..');
/** The verified record of Domino V1 on Robinhood Chain (docs/V1_MAINNET_FRONTEND_HANDOFF_0XDECIMAL.md §3): the pages name its contracts and its state. */
const DEPLOYMENT = JSON.parse(readText(join(REPO, 'docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json')));
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
  assert.ok(docs.findDocPage('domino-compound'));
  // Changed on purpose 2026-10-01 (the 2026-10 package, live note L12): the page took the product's one name; its older
  // slug, linked from outside, still opens it, and is no page of its own.
  assert.equal(docs.findDocPage('domino-compounder'), docs.findDocPage('domino-compound'), 'the older slug opens the renamed page');
  assert.equal(DOC_PAGES.some((entry) => entry.slug === 'domino-compounder'), false);
  assert.equal(docs.docGroupOf('domino-compounder'), docs.docGroupOf('domino-compound'));
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
  for (const file of files) for (const match of readText(join(APP, file)).matchAll(/\bid="([^"]+)"/g)) shell.add(match[1]);
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
  // Changed on purpose 2026-10-01 (audit C1, the owner's OK): the one place a URL is written out, as text and never as a
  // link: Robinhood Chain's details for adding it to a wallet by hand, in Wallet and sign-in. The chain's RPC and the
  // explorer, the same the wallet is handed (src/wallet/chain.ts; tests/wallet-compat.test.mjs). Changed on purpose
  // 2026-10-01 (RPC-SPEC §7.6): the chain's official RPC alone; the public fallback offered beside it is gone.
  const network = new Set(['https://rpc.mainnet.chain.robinhood.com', 'https://robinhoodchain.blockscout.com']);
  const networkRows = page('wallet').sections.find((section) => section.id === 'robinhood-chain').blocks.find((block) => block.kind === 'facts').rows;
  assert.deepEqual(new Set(strings(networkRows).filter((text) => /:\/\//.test(text))), network);
  for (const text of all) {
    assert.deepEqual(findForbidden(text), [], text);
    if (!network.has(text)) assert.doesNotMatch(text, /(https?|wss?):\/\//, text);
    // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Domino's new contracts open positions in Uniswap
    // v3 and v4 pools, so a pool's kind is a fact the docs state, named as "Uniswap v4" (or "v3 and v4"). The rule of
    // 2026-09-13 stays: nothing describes Domino itself as a version, an alpha or a preview.
    assert.doesNotMatch(text, /\balpha\b|\bbeta\b|(?<!Uniswap |v3 and )\bv4\b|\bpreview\b|not enabled yet|not connected yet|read-only|coming soon/i, text);
    assert.doesNotMatch(text, /\$\s?\d/, text);
    // Nor in words (2026-09-28): "1 million dollars" states a figure as surely as "$1M", and the pictures cannot keep up with it.
    assert.doesNotMatch(text, /\d[\d,.]*\s*(?:thousand|million|billion)?\s*dollars?\b|\b(?:hundred|thousand|million|billion)\s+dollars?\b/i, text);
    assert.doesNotMatch(
      text,
      /personal_sign|eth_[a-z]|wallet_[a-zA-Z]|\/api\/|fetch\(|innerHTML|127\.0\.0\.1|\.create\(|\.prepare\(|\.send\(|approve\s*\(|sendTransaction|writeContract|signTypedData|Wallet sending isn|Synthetic fixture|live-preview|swap-preview/,
      text,
    );
    // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): the exit order's mandatory warnings (spec F7 §4.7)
    // read as the order's review says them: "The trigger price is not guaranteed" and "If Domino stops automation for
    // safety". A promise is still refused: nothing is guaranteed, safe or risk-free.
    assert.doesNotMatch(text, /(?<!not )guarantee|risk-free|will earn|\bsafe(?:ly)?\b|(?<!for )\bsafety\b|maximum return|impermanent loss|\bprofitable\b/i, text);
    assert.doesNotMatch(text, /GeckoTerminal|DexScreener|CoinGecko|Alchemy/i, text);
    assert.doesNotMatch(text, /Domino token|Domino sequences?\b/i, text);
  }
  // Figures are described by where they come from, never as current, live, updated or qualified.
  for (const text of strings(page('figures'))) assert.doesNotMatch(text, /\b(current|live|updated|qualified)\b/i, text);
});

// Changed on purpose 2026-10-01 (the 2026-10 package, live note L12): one name everywhere, the product's. The docs called the
// automation Domino Compounder and said "In the app you choose it as Domino-compound"; now they call it what the app does.
// Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): the contract behind Auto-compound, Domino-compound
// and Protection only is "your automation" (the owner: never a product of its own); "vault" is said only on Contracts,
// as the contract's name, and "sequence" only of Domino-compound's positions.
test('the automation is Domino-compound in the docs as in the app; the reader meets "your automation", and "vault" only on Contracts', () => {
  const compounder = page('domino-compound');
  assert.equal(compounder.title, 'Domino-compound');
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /Domino Compounder/, entry.slug);
  // New position creates a plain position and offers no automation choice: its page names none of the three, and says where the choice is made.
  assert.doesNotMatch(textOf(page('new-position')), /Self-managing|Auto-compound|Domino-compound|Automation step/);
  assert.match(textOf(page('new-position')), /Automation is set up afterwards, from Automate, on the position you opened\./);
  const glossary = termIds(page('glossary'));
  // Changed on purpose (2026-09-24, the three features joined up): the choice with no automation is named Plain position
  // everywhere it is offered (Automate, New position's success, a position's state), so the glossary names it so too.
  // Changed on purpose 2026-10-06 (the owner's point 5): Auto-exit's term, in place of Stop-loss / take-profit and Protection only.
  for (const id of ['domino-compound', 'your-automation', 'auto-exit', 'plain-position', 'auto-compound', 'operator']) assert.ok(glossary.includes(id), id);
  for (const id of ['stop-loss', 'protection-only']) assert.equal(glossary.includes(id), false, id);
  assert.equal(glossary.includes('domino-sequence'), false);
  assert.equal(glossary.includes('sequence'), false);
  // "vault" as a word only on Contracts, once or twice; a contract's own name (DominoV2VaultFactory) is a name, not the word.
  for (const entry of DOC_PAGES) {
    const said = textOf(entry).match(/\bvaults?\b/gi) ?? [];
    if (entry.slug === 'contracts') assert.ok(said.length >= 1 && said.length <= 2, `contracts says vault ${said.length} times`);
    else assert.equal(said.length, 0, `${entry.slug} says vault`);
  }
  assert.equal(docs.findDocPage('your-vault'), null);
  // Wherever a reader meets "sequence", it is Domino-compound's positions in one.
  const lines = DOC_PAGES.flatMap((entry) => textOf(entry).split('\n')).filter((line) => /\bsequences?\b/i.test(line));
  assert.ok(lines.length >= 1, `${lines.length} lines name the sequence`);
  for (const line of lines) {
    for (const [phrase] of line.matchAll(/(?:\S+\s+){0,4}sequences?\b(?:\s+\S+)?/gi)) {
      assert.match(phrase, /Positions in the sequence/i, `"${phrase}" in: ${line}`);
    }
  }
});

// Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): custody as Domino's new contracts keep it (spec F7
// §1.5): an action keeps nothing afterwards, Domino's permission on a position, what the automation holds, what the
// operator can and cannot do (auto-exit, the one power over principal, only as signed), and the owner's controls on the
// position's page and Managed positions. Domino V1's setup operation and sequence controls left with V1's automation.
test('the custody page opens with the approved sentence, word for word, then says who holds what, the operator’s limits and the owner’s controls', () => {
  const custody = page('non-custodial');
  assert.equal(
    custody.lead,
    'When you create an automation using Domino, you are the sole owner and only you can control it. Every step is fully automated by a contract whose controller is your signed wallet.',
  );
  // The ids stay, so the links to them still land: a V1 receipt's How to pause opens pause-revoke-withdraw.
  assert.deepEqual(sectionIds(custody), ['your-wallet', 'sequence-vault', 'operator', 'pause-revoke-withdraw']);
  const text = textOf(custody);
  assert.match(text, /that NFT stays in your wallet/);
  assert.match(sectionText(custody, 'your-wallet'), /Each action on it is a single transaction, and Domino’s contract keeps nothing afterwards\./);
  assert.ok(linksOf(custody).some((link) => link.to === '#/docs/manage-position#permission'), 'Domino’s permission is explained where it is given');
  // Changed on purpose (2026-09-28, the owner's round 6, point 1): one plain phrase for what automation puts back, "added back".
  assert.match(text, /earned fees not yet added back, are held by your automation until you withdraw them/);
  assert.match(text, /Only your wallet controls its withdrawals, limits and pause, and every withdrawal goes to your wallet\./);
  assert.match(text, /The operator cannot[\s\S]*Withdraw positions or fees, except to close a position as your Auto-exit says\./);
  // src/v2in/automate (VaultCard.tsx, VaultDialog.tsx): the owner's own controls, each a transaction with no Domino fee.
  const controls = rowsOf(custody, 'facts');
  assert.deepEqual(controls.map((row) => row.label), ['Pause', 'Turn back on', 'Withdraw to wallet', 'Withdraw a next position', 'Leave automation', 'Turn off Auto-exit']);
  const control = (label) => controls.find((row) => row.label === label);
  // pause() is the owner's or a registry operator's; resume() the owner's alone; a pause leaves Auto-exit on (F7 §5.3).
  assert.equal(control('Pause').value, 'You, or Domino');
  assert.match(control('Pause').note, /Auto-exit stays on\. Only you can resume\./);
  for (const label of ['Turn back on', 'Withdraw to wallet', 'Withdraw a next position', 'Leave automation', 'Turn off Auto-exit']) assert.equal(control(label).value, 'You', label);
  assert.match(sectionText(custody, 'pause-revoke-withdraw'), /Each is a transaction your wallet signs, with no Domino fee, and none waits on Domino’s service\./);
  assert.match(sectionText(page('wallet'), 'sign-in'), /This request does not authorize transactions or automation\./);
  assert.ok(linksOf(custody).some((link) => link.to === '#/docs/wallet#sign-in'), 'signing in grants none of them');
  // The owner kept the lead; the operator section opens by squaring it with an operator that can act and pause.
  const operator = custody.sections.find((section) => section.id === 'operator');
  assert.deepEqual(operator.blocks[0], { kind: 'p', text: ['Your wallet stays the only owner. Domino’s automation service, the operator, can only run fee-only steps within your limits, pause, and carry out an Auto-exit you turned on.'] });
  // Both automations leave the NFT in the wallet, approved one by one (spec F7 §1.5: an individual approval).
  assert.match(sectionText(custody, 'your-wallet'), /When you start Auto-compound or Domino-compound from it, that NFT stays in your wallet\. You approve that one NFT to your automation, never all of your NFTs\./);
  assert.doesNotMatch(text, /setup operation|Setup contract/);
  // Earned fees only, and auto-exit the one power over principal (spec F7 §1.5).
  const holds = sectionText(custody, 'sequence-vault');
  assert.match(holds, /Your permission covers earned fees only, including fees your position had not collected when you set it up\. Principal is never used, except by an Auto-exit you turned on\./);
  assert.match(holds, /Positions it opens are standard Uniswap position NFTs too\./);
  const can = operator.blocks.find((block) => block.kind === 'split').columns.find((column) => column.title === 'The operator can').items.map(inlineText);
  assert.deepEqual(can, [
    'Add a position’s earned fees back into it.',
    'Open or fund the next position from earned fees, within your limits.',
    'Swap earned fees within your slippage and price-gap limits.',
    'Pause automation.',
    'Carry out an Auto-exit you turned on, exactly as you signed it.',
    'Return the fees it holds to your wallet once your position is closed.',
  ]);
  const cannot = operator.blocks.find((block) => block.kind === 'split').columns.find((column) => column.title === 'The operator cannot').items.map(inlineText);
  assert.deepEqual(cannot, ['Withdraw positions or fees, except to close a position as your Auto-exit says.', 'Change your limits, or resume automation after a pause.', 'Pull tokens from your wallet.', 'Send anything to anyone but you.']);
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

// Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): the new automation's setup (src/v2in/automate
// SetupFlow.tsx; spec F7 §5.1, §5.2): the position, its limits and the consent on uncollected fees, then the approval and
// the creation in one confirmation where the wallet sends both, and automation running at once (decision #12). Domino V1's
// two transactions, its paused start and its separate activation are gone with V1's automation.
test('Auto-compound sets up on a position from Automate or its page: limits, consent, one approval and the creation, and it starts at once', () => {
  const auto = page('auto-compound');
  const start = sectionText(auto, 'where-it-starts');
  assert.match(start, /On Automate, Set up Auto-compound opens the setup: choose the position, check its limits, and tick that the fees it has already earned and not collected are reinvested too, with the fee\. Set up automation then asks your wallet to approve that one position and create its automation, in one confirmation when your wallet can send both together\. Automate on a plain position opens the setup with that position chosen\./);
  assert.match(start, /Automation starts at once\. The NFT stays in your wallet, and your automation keeps the fees it collected and hasn’t reinvested yet: withdraw them any time, with no fee\./);
  assert.match(start, /Changes made to that position outside your automation stop it until you turn it back on: see Risks\./);
  assert.doesNotMatch(textOf(auto), /starts paused|activation|Activate|two wallet transactions|sequence/i);
  // New position offers no automation choice any more, so the page no longer says choosing it there records anything.
  assert.doesNotMatch(textOf(auto), /New position|records the choice/);
  const links = linksOf(auto).map((link) => link.to);
  for (const to of ['#/docs/your-automation', '#/docs/risks#automation-stops', '#/docs/auto-exit', '#/docs/positions#managed-positions']) assert.ok(links.includes(to), to);
  assert.ok(links.every((to) => to.startsWith('#/docs/')), links.join(', '));
  // The limits of spec F7 §5.2 as the setup says them (src/v2in/automate/constants.ts, LimitsFields.tsx, form.ts): slippage
  // and the band 1% at first and at most 5%, the band's warning above 2%, the reference age and the run interval fixed.
  const choices = sectionText(auto, 'choices');
  assert.match(choices, /Two limits, each 1% at first and at most 5%: the most a swap may lose to slippage, on top of the pool’s own fee, and the widest gap between the pool price and the reference price/);
  assert.match(choices, /Two settings are fixed: a reference price no older than 5 minutes, and at most one automated run every 10 minutes\./);
  const src = (path) => readText(join(APP, 'src', path));
  const constants = src('v2in/automate/constants.ts');
  assert.match(constants, /export const VAULT_AUTOMATION_START_PAUSED = false/, 'the automation starts running');
  assert.match(constants, /maxSlippageBps: 100,\n  maxPriceImpactBps: 100,/, '1% at first');
  assert.match(constants, /VAULT_UI_MAX_SLIPPAGE_BPS = 500/);
  assert.match(constants, /VAULT_UI_MAX_PRICE_GAP_BPS = 500/);
  assert.match(constants, /VAULT_OBSERVATION_AGE_SECONDS = 300/);
  assert.match(constants, /VAULT_MINIMUM_INTERVAL_SECONDS = 600/);
  assert.match(constants, /aboveBps: 200, text: "Risky:/, 'risky above 2%');
});

// Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Domino-compound on the new automation: its limits
// with what each starts at (VAULT_DEFAULT_DOMINO, Domino V1's own defaults), its next positions held by the automation and
// withdrawable one by one, three steps with no pause or activation, and what stops it until it is turned back on.
test('Domino-compound names its setup, its limits and what they start at, and Risks says what stops automation and how it is turned back on', () => {
  const compounder = page('domino-compound');
  const start = sectionText(compounder, 'start-and-stop');
  const steps = blocksOf(compounder).find((block) => block.kind === 'steps').items.map((step) => step.title);
  assert.deepEqual(steps, ['Choose', 'Approve and create', 'It runs']);
  assert.match(start, /On Automate, Set up Domino-compound: pick the position, check its limits, and tick that fees it has already earned and not collected are reinvested too\./);
  assert.match(start, /Automation starts at once\. The position’s page has Pause, Resume and Leave automation\./);
  assert.match(start, /Collect fees, Close position and changes made outside Domino stop it too, until you turn it back on: see Risks\./);
  assert.ok(linksOf(compounder).some((link) => link.to === '#/docs/risks#automation-stops'));
  assert.match(sectionText(compounder, 'sequence-vault'), /Each next position can be withdrawn to your wallet any time, as a plain position\./);
  assert.match(readText(join(APP, 'src/v2in/automate/constants.ts')), /VAULT_DEFAULT_DOMINO = Object\.freeze\(\{ triggerDistanceBps: 500, maxOverlapBps: 2000, maxPositions: 3, upsideBps: 5000 \}/, 'the limits start where the page says');
  // Spec F7 §1.5, §2.13, §5.3: a change outside the automation stops it until the owner turns it back on, consenting again.
  const stops = sectionText(page('risks'), 'automation-stops');
  assert.match(stops, /Automation stops for a position if you change it, move it or approve another app on it\. Collect fees, Close position, Add liquidity and Withdraw count as changes too\./);
  assert.match(stops, /It stays stopped until you turn it back on: Turn back on, on the position’s page, consents again to the fees the position has not collected, exactly as setting it up did\./);
  assert.match(stops, /Automation can also wait without stopping, for example until fees cover the network cost; its card says why\./);
  // The setup's own field names and what each starts at.
  const glossary = page('glossary');
  assert.equal(termText(glossary, 'upside'), 'How far above the previous top a next position’s top sits, at least. 50% at first.');
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /New position draws|50% by default/, entry.slug);
  assert.equal(termText(glossary, 'your-automation'), 'The contract made for your wallet that runs one position’s automation or Auto-exit.');
});

test('the wallet, pools, fees, markets, new position, positions, risks and what Domino is pages say what the app and contracts do', () => {
  const wallet = page('wallet');
  const needs = blocksOf(wallet).find((block) => block.kind === 'list').items.map(inlineText);
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): a quote from Domino's planning service
  // (position-plan-v1) and a deposit from another network (crosschain-v1) are asked for the signed-in wallet only
  // (src/finance/v2/http.ts: session_required); Domino V1's automation cards still need a session. V1's readiness check
  // before activation left with V1's automation.
  assert.deepEqual(needs, [
    'A quote: for New position, and for Add liquidity, Change range or a withdrawal in one token on a position’s page.',
    'Bringing funds from another network.',
    'What Domino V1’s automation did, in Managed positions and Receipts on Positions.',
  ]);
  assert.match(sectionText(wallet, 'what-needs-sign-in'), /Public pages need no sign-in, and neither does a step without a quote, such as collecting fees, closing a position, or setting up automation or Auto-exit\./);
  assert.match(readText(join(APP, 'src/v2/plan/httpTransport.ts')), /throw new Error\('session_required'\)/, 'a quote is refused without a session');
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /Setup’s advanced section|assisted swap quote in Setup/, entry.slug);
  // Changed on purpose 2026-10-01 (audit E16): an account turned into a smart account signs in (components/wallet/copy.ts
  // FAILURE.account_unsupported); only a contract wallet cannot.
  assert.match(sectionText(wallet, 'sign-in'), /Standard wallet accounts can sign in, including ones turned into a smart account; a contract wallet, such as a multisig, cannot\./);
  // 2026-10-04: the session is kept across the three networks (session/machine.ts keptChains) and the wallet dialog shows the
  // address, not the wallet app's name (the owner's UI round of 2026-10-03). Changed on purpose 2026-10-06 (the review of
  // the next update): and across the networks a deposit may come from; any other network still signs it out.
  assert.match(sectionText(wallet, 'session'), /Moving between networks Domino uses or brings funds from keeps the session; changing account, or moving to any other network, signs it out\./);
  assert.match(sectionText(wallet, 'connect'), /Once connected, its dialog shows your address, with Copy, and whether you are signed in\./);
  assert.match(sectionText(wallet, 'robinhood-chain'), /Domino works on Robinhood Chain, chain ID 4663, Base, 8453, and Arbitrum One, 42161/);

  // Outside its range a position holds one token, so the sentence says in range, and is written here, not imported.
  const pools = page('pools');
  assert.match(sectionText(pools, 'two-tokens'), /and a position in range holds some of each\./);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /a position holds some of each/, entry.slug);
  assert.match(sectionText(pools, 'fee-tiers'), /A pool can also carry Uniswap’s protocol fee, taken from what a swap sells into the pool before the fee tier\. It does not go to liquidity providers\./);
  assert.match(termText(page('glossary'), 'protocol-fee'), /taken from what a swap sells into the pool before the fee tier/);
  // 2026-10-04 (spec F7 §1.4, §2.7): two kinds of pool, a hook only on v4, and WETH on v3.
  assert.match(sectionText(pools, 'versions'), /a v3 pool holds WETH, never ETH\. ETH you pay with goes in as WETH, and what the range doesn’t use comes back as WETH\./);
  const fees = page('fees');
  const trading = rowsOf(fees, 'facts').find((row) => row.label === 'Pool trading fee');
  assert.equal(trading.note, 'Paid by swappers to the pool’s liquidity providers, on each trade. Not a charge on your deposit; a swap you make pays it.');
  assert.match(sectionText(fees, 'pool-trading-fee'), /A swap you make, such as the one Create position makes when your wallet holds one token, pays it, and any protocol fee, like any other\./);

  const markets = page('markets');
  // Changed on purpose 2026-10-01 (audit E19, live note L12): there is no Find pools button, and a name finds a token beyond
  // the selected pools. And the 2026-10 package's token page: one list from two sources, flagged pools behind Show all,
  // look-alikes called out (the markets workstream's V2, V3, I1).
  const find = sectionText(markets, 'find-a-token');
  assert.match(find, /Search the pool catalogue, under the table, reaches every other pool\. Type a token’s name or paste its address; its pools are listed, each verified on chain\./);
  assert.match(find, /Pools with a very high fee, or that Domino can’t open positions in, are flagged and kept behind Show all\./);
  assert.match(find, /one posing as USDG, WETH or ETH is called out; a pool holding one shows a warning instead of Create a position\./);
  assert.doesNotMatch(textOf(markets), /Find pools|from the selected pools/);
  // Changed on purpose 2026-10-01: a pool's page has a docs page of its own, so Markets keeps to its 450 words.
  const poolPage = textOf(page('pool-page'));
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

  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): New position on Domino's new contracts
  // (src/v2in/journey): Review shows the plan, and Create position is one transaction after any exact approval, Domino's
  // contract keeping nothing; no deposit into V1's Setup contract, no separate swap step, no refund to wait for.
  const create = page('new-position');
  assert.match(sectionText(create, 'review'), /^Review\nReview shows what you put in, any swap Domino makes and its fee, what goes into the position, what comes back to your wallet, and the network fee\. Automation is set up afterwards, from Automate, on the position you opened\./);
  assert.match(sectionText(create, 'review'), /Its quote needs sign-in and lasts 3 minutes\. If the price moves within your slippage, the position can come out smaller and the rest returns to your wallet: Review says by how much at most\./);
  const made = sectionText(create, 'create');
  assert.match(made, /your wallet allows each token for the exact amount, if needed, then one transaction puts your tokens in, makes any swap and sends you the position NFT, with anything the range doesn’t use\. Domino’s contract keeps nothing afterwards\./);
  assert.match(made, /No Domino fee unless a swap is needed: then 0\.65% of the amount swapped, shown on Review\. Network gas still applies\./);
  // 2026-10-05 (the owner: his New position screens, as he built them): today's Create position again, so its steps again.
  assert.match(made, /Domino V1 on Robinhood Chain lists approval, deposit and creation as separate wallet steps\./);
  assert.doesNotMatch(textOf(create), /Setup|deposit of both tokens|refunded|deposit-amount estimate|expected to take, and the most it may take|Hover a figure to see until when/);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /deposit-amount estimate|expected to take, and the most it may take|Hover a figure to see until when/, entry.slug);
  // The zap journey's constants: the quote's life and the deadline, the slippage (src/v2in/journey/constants.ts).
  const journey = readText(join(APP, 'src/v2in/journey/constants.ts'));
  assert.match(journey, /JOURNEY_QUOTE_LIFETIME_S = 180/);
  assert.match(journey, /SETUP_STAYS_WHILE_PREVIEW = true/, 'the docs preserve the V1 wallet steps while the new-contract gate is preview');
  assert.match(journey, /JOURNEY_STAYS_ON_ROBINHOOD = true/, 'and on Robinhood Chain whatever the gate says (the owner, 2026-10-05)');
  assert.match(journey, /JOURNEY_DEFAULT_SLIPPAGE_BPS = 50\nexport const JOURNEY_MIN_SLIPPAGE_BPS = 10\nexport const JOURNEY_MAX_SLIPPAGE_BPS = 500/);
  assert.match(journey, /NEW_POOL_TITLE = 'Create a new pool \(advanced\)'/);
  assert.match(sectionText(create, 'step-pool'), /Create a new pool \(advanced\)/);
  // Four steps, none of them Automation, and the summary counts them; New position is Robinhood Chain's (no network choice).
  // Changed on purpose 2026-10-05 (the owner: the search across the three networks, each result with its network's tag):
  // still no network choice, and the search finds Base's and Arbitrum One's tokens too.
  assert.match(create.summary, /^Plan a position in four steps,/);
  assert.deepEqual(blocksOf(create).find((block) => block.kind === 'steps').items.map((step) => step.title), ['Pool', 'Range', 'Amount', 'Review']);
  assert.match(sectionText(create, 'four-steps'), /New position works on Robinhood Chain, Base and Arbitrum One\./);
  assert.match(readText(join(APP, 'src/v2in/journey/model/routing.ts')), /No network choice exists \(the owner, 2026-10-02 night\): New position is Robinhood Chain's journey, whose search also finds\n \* Base's and Arbitrum One's tokens since 2026-10-05/);

  const positions = page('positions');
  // Changed on purpose (owner, 2026-09-24): the list is the positions the wallet created with Domino, read from chain; no lookup by NFT id.
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): on any of Domino's networks, each row with its own.
  assert.match(sectionText(positions, 'your-positions'), /Positions lists the positions it created with Domino, on any of its networks, read from the chain: there is no ID to type\./);
  assert.match(sectionText(positions, 'your-positions'), /Position NFTs made elsewhere are not listed\./);
  assert.doesNotMatch(sectionText(positions, 'your-positions'), /Look up by NFT id|enter up to 10 IDs/);
  assert.doesNotMatch(textOf(positions), /always looked up by its ID|cannot list the positions a wallet holds/);
  assert.match(termText(page('glossary'), 'position-nft'), /Positions lists the ones your wallet created with Domino\./);

  assert.match(sectionText(page('risks'), 'tokens-and-contracts'), /Positions and automation run on smart contracts, and a contract can have defects\./);
  const intro = page('what-is-domino');
  assert.match(sectionText(intro, 'your-wallet-signs'), /^Your wallet signs every step you take\n/);
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): what runs automation, in the owner's words ("your
  // automation"), starting at once; the operator is still Domino's automation service, bound by the signed limits.
  const signs = sectionText(intro, 'your-wallet-signs');
  assert.match(signs, /Automation works through a contract made for your wallet alone, which only your wallet controls, and Domino’s automation service acts only within the limits you signed\. It starts once your wallet sets it up\./);
  assert.match(signs, /Domino never holds your keys, and only your wallet can take your tokens out\./);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /never holds your keys or your tokens/, entry.slug);
  // Words the first page used with no explanation: revocation, the factory and Setup are for Contracts.
  assert.doesNotMatch(textOf(intro), /revocation|\bfactory\b|\bSetup\b/);
  // 2026-10-04: three networks, and the pools Domino works with.
  assert.match(intro.summary, /Robinhood Chain, Base and Arbitrum One/);
  assert.match(sectionText(intro, 'built-on-uniswap'), /Domino works with Uniswap v3 and v4 pools\./);
});

// 2026-09-27, the review of 260a76a: statements that were wrong or contradicted another page, and the words the
// position page and Positions use since round 5 (points 2, 4, 6, 7 and 10).
test('the docs use the product’s words for a position’s figures, say what automation did and where, and state the fees and the dialogs as they are', () => {
  const positions = page('positions');
  const all = DOC_PAGES.map(textOf).join('\n');
  // Principal and Unclaimed fees are Position value (Value on the list) and Fees ready to collect on every screen.
  assert.doesNotMatch(all, /Unclaimed fees|unclaimed fees|the principal \(/);
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): the rows read from Domino's new contracts name
  // their network and show tokens (no USD or APR without a qualified source, decision #22); a Domino V1 row keeps dollars
  // and Your APR, or "on its page" (components/positions/PositionRow.tsx).
  // Changed on purpose 2026-10-06 (read-v6 1.1.0-rc.1's qualified USD): dollars on the new contracts' rows too.
  assert.match(sectionText(positions, 'your-positions'), /Each row shows the pair, its network, whether the price is in range, what it holds and its fees ready to collect, in dollars when priced, else in tokens\. Domino V1 rows add Your APR since opening, or “on its page”\./);
  assert.doesNotMatch(readText(join(APP, 'src/components/positions/PositionRow.tsx')), />est\.</);
  assert.ok(readText(join(APP, 'src/components/positions/PositionRow.tsx')).includes('>on its page<'));
  const details = sectionText(positions, 'position-details');
  for (const label of ['Position value', 'Fees ready to collect', 'Your APR', 'Current price']) assert.match(details, new RegExp(`\\n${label}: `), label);
  assert.match(details, /Your APR: this position’s own fees as a yearly rate, from its history\. Not the pool’s APR, and not a promise\./);
  assert.match(details, /the actions available for this position: see Manage a position\./);
  assert.doesNotMatch(details, /···|for more/, 'actions are visible, not hidden in the former menu');
  // 2026-10-04 (the owner's point 10 of 2026-10-03): the Price range chart in its own words (lib/chart/priceFacts.ts,
  // components/positions/visual/PriceVsRange.tsx).
  const chart = sectionText(positions, 'price-range');
  assert.match(chart, /Earning fees while the price is inside your range, Not earning outside it, with how far the price must move to come back, or Closed\./);
  assert.match(chart, /History starts when this position opened, up to 7 days: green inside the range, red outside\. Unread history is not filled in\./);
  assert.match(chart, /Fees earned offers 24H, 7D and All/);
  const facts = readText(join(APP, 'src/lib/chart/priceFacts.ts'));
  for (const words of ["title: 'Earning fees'", "title: 'Not earning'"]) assert.ok(facts.includes(words), words);
  const rangeSource = readText(join(APP, 'src/components/positions/visual/PriceVsRange.tsx'));
  assert.match(rangeSource, /'Since opened' : 'Last 7 days'/);
  assert.match(rangeSource, /Hourly prices/);
  assert.match(sectionText(page('earned-fees'), 'unsettled-fees'), /^Fees ready to collect\n/);
  const glossary = page('glossary');
  assert.ok(termIds(glossary).includes('fees-ready-to-collect') && termIds(glossary).includes('your-apr') && !termIds(glossary).includes('unclaimed-fees'));
  assert.match(termText(glossary, 'your-apr'), /Not the pool’s APR, and not a promise\./);
  assert.match(termText(glossary, 'principal'), /its Position value\./);
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): what the new automation did is in Receipts and on
  // its card, read from Domino's record of its contracts with no sign-in (src/v2in/lists/Receipts.tsx, VaultCard.tsx).
  assert.match(sectionText(page('auto-compound'), 'what-it-did'), /Receipts, on Positions, lists each automated run with the fees it used and its service fee\. The position’s page shows its automation: its state, what it waits for, and the fees it collected and hasn’t reinvested yet\. No sign-in is needed\./);
  assert.ok(linksOf(page('auto-compound')).some((link) => link.to === '#/docs/positions#managed-positions'));
  const managed = sectionText(positions, 'managed-positions');
  assert.match(managed, /Managed positions lists each automated position, on any network: its state, the fees it collected and hasn’t reinvested yet, and the one button it needs, such as Withdraw to wallet\./);
  assert.match(managed, /For the full list, select Receipts beside New position or the card’s See all\./);
  assert.match(readText(join(APP, 'src/screens/Positions.tsx')), /href=\{receiptsHref\} variant="outline" data-positions-receipts/, 'the connected wallet has a direct receipt entrance');
  assert.match(managed, /Neither needs sign-in, except for what Domino V1’s automation did\./);
  // Moved on purpose 2026-10-04 (the owner: docs revalidated for V2) to Manage a position, word for word: only Close has an
  // "At least" row and a slippage choice (PositionActions.tsx).
  assert.match(sectionText(page('manage-position'), 'collect-and-close'), /Each shows what you receive and the network fee before you sign; Close also shows the least you receive within your slippage tolerance\./);
  // The service fee is 2% of the fees used: of 100 used, 2 are the fee and 98 go back (FeeAccounting.sol).
  assert.match(sectionText(page('auto-compound'), 'service-fee'), /2% of the earned fees it uses, taken once: of 100 USDG of fees it uses, 2 go to the service fee and 98 back into your position\./);
  assert.match(sectionText(page('fees'), 'service-fee'), /of 100 USDG of fees Auto-compound uses, 2 go to the service fee and 98 back into your position\./);
  assert.doesNotMatch(all, /fees it puts back, taken once|of fees put back by Auto-compound/);
  // A pair can have several pools of one fee tier, apart by their other settings.
  assert.match(sectionText(page('pools'), 'fee-tiers'), /The same two tokens can have several pools, for example one per fee tier\./);
  // Domino's own Collect fees and Close position stop automation, on each page that says what stops it.
  assert.match(sectionText(page('domino-compound'), 'start-and-stop'), /Collect fees, Close position and changes made outside Domino stop it too, until you turn it back on: see Risks\./);
});

// 2026-10-04 (the owner: docs revalidated for V2): the new pages say what the screens do, in their words.
test('the V2 pages: Manage a position, Bring funds from another network, Auto-exit and Your automation, in the screens’ own words', () => {
  const src = (path) => readText(join(APP, 'src', path))
  // Manage a position (src/v2in/position): the visible action groups, the dialogs, the shares, the range choices, the permission, the
  // rules under automation (decision #5).
  const manage = page('manage-position');
  assert.deepEqual(sectionIds(manage), ['from-its-page', 'add-liquidity', 'change-range', 'withdraw', 'collect-and-close', 'permission', 'with-automation']);
  const copy = src('v2in/position/copy.ts');
  for (const words of ["add: 'Add liquidity'", "changeRange: 'Change range'", "withdraw: 'Withdraw'", "youReceive: 'You receive'", "zapApproved: 'Domino can manage this position for you when you ask.'", "rearm: 'Turn automation back on'"]) assert.ok(copy.includes(words), words);
  assert.match(sectionText(manage, 'from-its-page'), /The available actions are shown below the position’s title: Collect fees, Add liquidity, Change range, Withdraw and Auto-exit\./);
  assert.doesNotMatch(sectionText(manage, 'from-its-page'), /···|menu/, 'the docs describe the visible actions');
  // v2/f7 ca70c056 (the owner, 2026-10-04: stop-loss and take-profit inside the position): the visible action; its name is
  // Auto-exit since 2026-10-06 (the owner's point 5).
  assert.ok(copy.includes("protect: 'Auto-exit'"), 'the action names it');
  assert.match(src('v2in/position/MoreActions.tsx'), /key: 'protect' as const, label: COPY\.button\.protect/);
  assert.match(sectionText(manage, 'change-range'), /Narrow ±1%, Medium ±5% or Wide ±20%/);
  assert.match(src('v2in/position/constants.ts'), /'Narrow ±1%'[\s\S]*'Medium ±5%'[\s\S]*'Wide ±20%'/);
  assert.match(src('v2in/position/constants.ts'), /SHARES = \['100', '50', '25'\]/);
  assert.match(sectionText(manage, 'permission'), /Domino can manage this position for you when you ask\./);
  assert.match(sectionText(manage, 'with-automation'), /Change range isn’t available/);
  assert.match(src('v2in/position/constants.ts'), /ROOT_BLOCKS_CHANGE_RANGE = true/);
  // Bring funds (src/v2in/funds; spec F7 §3): Relay or Across, 0.35% charged by the bridge, two steps for a token, refunds.
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15; F7 delta of 6 Oct §1 and §2):
  // the token's two steps in one confirmation where the wallet batches; Domino's fee and the network fee on the quote.
  const bring = page('bring-funds');
  assert.match(sectionText(bring, 'cost'), /0\.35% of what you deposit, charged by the bridge as Domino’s fee: Relay takes it from what you send, Across from what arrives\./);
  assert.match(sectionText(bring, 'how'), /a token takes an approval of the exact amount and then the deposit, in one confirmation when your wallet can send both together; ETH takes one\./);
  assert.match(sectionText(bring, 'how'), /The quote shows what you receive, the least you receive, about how long it takes, Domino’s fee and the network fee\./);
  assert.match(sectionText(bring, 'refunds'), /Across in full, usually 2\.5 to 3 hours after your deposit; Relay minus the refund’s gas\./);
  assert.match(src('v2/crosschain/copy.ts'), /usually 2\.5 to 3 hours after your deposit/);
  assert.match(src('v2in/funds/constants.ts'), /FUNDS_BATCH_APPROVAL_AND_DEPOSIT = true/);
  assert.match(src('v2in/funds/copy.ts'), /gasOffer: \(destination: string\) => `Get gas on \$\{destination\}`/);
  // Auto-exit (src/v2in/autoexit; spec F7 §4; Changed on purpose 2026-10-06, the owner's point 5): where it is, that no
  // price is typed (the range's ends), its one-batch activation, its fee, the warnings word for word, the old slug kept.
  const exit = page('auto-exit');
  assert.equal(docs.findDocPage('stop-loss'), exit, 'the old slug opens Auto-exit');
  assert.equal(DOC_PAGES.some((entry) => entry.slug === 'stop-loss'), false);
  assert.match(sectionText(exit, 'what-it-is'), /When the price reaches the end of its range, Domino closes the position and sends the tokens to your wallet\. You don’t type a price: the range’s ends are where it closes\./);
  assert.match(sectionText(exit, 'what-it-is'), /only the far end counts/);
  // Changed on purpose 2026-10-06 (the review of point 5): every network's position page, and New position's success on
  // every network (components/create/CreatedNext.tsx on Robinhood Chain's own journey, src/v2in/journey/ReviewStage.tsx
  // CreatedExit elsewhere).
  assert.match(sectionText(exit, 'turn-it-on'), /Select Auto-exit below a position’s title, on any network, or right after you create a position\. The dialog shows where it closes, the price now and its fee\./);
  assert.match(sectionText(exit, 'turn-it-on'), /Turn on Auto-exit asks your wallet for one signature, then one confirmation when your wallet can send the calls together\./);
  assert.match(sectionText(exit, 'separate'), /A position has compounding or Auto-exit, never both, and one Auto-exit at a time\./);
  assert.doesNotMatch(textOf(exit), /stop-loss|take-profit|order|Protection only/i);
  const mandate = src('v2in/autoexit/MandateDialog.tsx');
  assert.match(mandate, /Turn on Auto-exit/);
  assert.doesNotMatch(mandate, /data-mandate-shortcut|data-mandate-input/, 'no price is typed');
  assert.match(src('v2in/autoexit/form.ts'), /triggerBelowSqrtPriceX96 = sqrtPriceAtTick\(tickLower\)/);
  const warnings = blocksOf(exit).find((block) => block.kind === 'list').items.map(inlineText);
  assert.equal(warnings.length, 6);
  const sources = [src('finance/v2/autoExit.ts'), mandate].join('\n')
  for (const warning of warnings) {
    // The docs write apostrophes as the docs do; the words are the dialog's own (the first ones above its button since
    // 2026-10-06, rugged's spec delta of 6 Oct §2; the rest under its Details).
    const said = warning.replaceAll('’', "'");
    assert.ok(sources.includes(said), `the warning is the dialog's own: ${warning}`);
  }
  const constants = src('v2in/autoexit/constants.ts');
  assert.match(constants, /AUTO_EXIT_DEFAULT_SLIPPAGE_BPS = 100/);
  assert.match(constants, /AUTO_EXIT_MAX_VALIDITY_DAYS = 365/);
  assert.match(constants, /AUTO_EXIT_DEFAULT_VALIDITY_DAYS = AUTO_EXIT_MAX_VALIDITY_DAYS/, 'a year, the app\'s longest');
  assert.match(sectionText(exit, 'turn-it-on'), /a 1% slippage limit on top of the pool fee, valid for a year\./);
  assert.match(sectionText(exit, 'cost'), /0\.2% of the position’s value when it closes, only if it does: the only fee\./);
  // Your automation (src/v2in/automate): the three ways, its card's states, the fees it holds, how to leave, V1's end.
  const yours = page('your-automation');
  assert.match(sectionText(yours, 'three-ways'), /Nothing is chosen for you\./);
  assert.match(src('v2in/automate/constants.ts'), /VAULT_DEFAULT_MODE: 1 \| 2 \| null = null/);
  const card = src('v2in/automate/VaultCard.tsx');
  for (const words of ["'Auto-exit'", "'Automation off'", "'Automation on'", "withdraw: 'Withdraw to wallet'", "return: 'Return my reserves'", "rearm: 'Turn back on'", "leave: 'Leave automation'"]) assert.ok(card.includes(words), words);
  assert.match(sectionText(yours, 'waiting-fees'), /Withdraw to wallet sends them to your wallet any time, whatever its state, with no Domino fee\./);
  assert.match(sectionText(yours, 'domino-v1'), /Domino V1’s automation ends when the new one starts, with no migration/);
});

// Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): ROADMAP's pill, "Starts paused", described Domino
// V1's sequence, which started paused; the new automation starts at once (decision #12, src/v2in/automate/constants.ts
// VAULT_AUTOMATION_START_PAUSED), so no docs page wears it. A status, should one come back, still names a ROADMAP entry.
test('a status names a ROADMAP entry, so the pill beside the title always comes from ROADMAP; no automation page wears "Starts paused" any more', () => {
  const names = new Set(ROADMAP.map((entry) => entry.name));
  const statuses = DOC_PAGES.filter((entry) => entry.status !== undefined).map((entry) => [entry.slug, entry.status]);
  assert.deepEqual(statuses, []);
  for (const [, status] of statuses) assert.ok(names.has(status), status);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /Starts paused|starts paused/, entry.slug);
});

test('the limits and fees match the contracts: 20% trigger and overlap, a positions cap, an upside the owner sets, 2% simple / 4% Domino service, 0.65% swap, 0.35% deposit and 0.2% auto-exit', () => {
  const contract = (name) => readText(join(REPO, 'contracts/src', name));
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
  // 2026-10-04 (the owner: docs revalidated for V2): Domino's new contracts' constants (spec F7 §1.6) and the policies their
  // deployment records carry on the three networks (the 2026-10-02 rehearsal's, the format a production record keeps),
  // the bridge's 35 bps among them.
  const v2 = contract('v2/DominoV2Types.sol');
  for (const line of [/FEE_ASSISTED_SWAP_BPS = 65;/, /FEE_AUTOMATION_SIMPLE_BPS = 200;/, /FEE_AUTOMATION_DOMINO_BPS = 400;/, /FEE_AUTO_EXIT_BPS = 20;/]) assert.match(v2, line);
  const rehearsals = join(REPO, 'docs/deployments/v2-rehearsal-2026-10-02');
  for (const name of ['robinhood-4663-deployment.json', 'base-8453-deployment.json', 'arbitrum-42161-deployment.json']) {
    const record = JSON.parse(readText(join(rehearsals, name)));
    assert.deepEqual(
      [record.policies.assistedSwapFeeBps, record.policies.bridgeAppFeeBps, record.policies.simpleCompoundFeeBps, record.policies.dominoCompoundFeeBps, record.policies.autoExitFeeBps],
      [65, 35, 200, 400, 20],
      name,
    );
  }

  // Changed on purpose 2026-10-01 (audit E21): the rows are named as the setup's own fields name them.
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): each with what it starts at.
  const limits = Object.fromEntries(rowsOf(page('domino-compound'), 'facts').map((row) => [row.label, row]));
  assert.deepEqual(Object.keys(limits), ['Trigger distance', 'Maximum overlap', 'Next range higher by', 'Positions in the sequence']);
  assert.equal(limits['Trigger distance'].value, 'Up to 20%');
  assert.equal(limits['Maximum overlap'].value, 'Up to 20%');
  assert.equal(limits['Next range higher by'].value, 'You set it; 50% at first');
  assert.equal(limits['Positions in the sequence'].value, 'A cap you set; 3 at first');
  assert.match(limits['Positions in the sequence'].note, /Counts the position it starts from/);
  assert.match(limits['Trigger distance'].note, /5% at first/);
  assert.match(limits['Maximum overlap'].note, /20% at first/);

  const fees = Object.fromEntries(rowsOf(page('fees'), 'facts').map((row) => [row.label, row]));
  // Changed on purpose 2026-10-01 (audit E4): "of the earned fees it uses", not "consumed".
  assert.equal(fees['Domino service fee'].value, 'Auto-compound 2%; Domino-compound 4% of the earned fees it uses');
  assert.match(fees['Domino service fee'].note, /Never on principal, never on a direct deposit/);
  assert.equal(fees['Assisted swap fee'].value, '0.65% of the amount swapped');
  assert.equal(fees['Deposit from another network'].value, '0.35% of the amount deposited');
  assert.equal(fees['Auto-exit fee'].value, '0.2% of the position’s value at exit');
  assert.equal(fees['Network gas'].value, 'Paid by the wallet that sends it');
  assert.deepEqual(Object.keys(fees), ['Assisted swap fee', 'Deposit from another network', 'Domino service fee', 'Auto-exit fee', 'Network gas', 'Pool trading fee']);
  // Spec F7 §1.6 "Sem tarifa Domino": what carries no Domino fee, said once.
  assert.match(sectionText(page('fees'), 'no-fee'), /No Domino fee for finding pools, connecting your wallet, creating or adding without a swap, changing a range without a swap, withdrawing in both tokens, collecting fees, withdrawing from your automation, pausing, turning off Auto-exit or revoking a permission\./);
});

test('the Uniswap addresses are the ones the backend is configured with and the chain profiles name, the Domino V1 addresses the ones the record verified, each a lowercase address', () => {
  const backend = (file) => readText(join(REPO, 'backend', file));
  const constant = (text, name) => new RegExp(`^${name} = '(0x[0-9a-f]{40})'`, 'm').exec(text)?.[1];
  const discovery = backend('discovery.py');
  const expected = [
    ['PoolManager', constant(discovery, 'POOL_MANAGER')],
    ['PositionManager', constant(discovery, 'POSITION_MANAGER')],
    ['StateView', constant(discovery, 'STATE_VIEW')],
    ['Permit2', constant(backend('deposit_prepare.py'), 'PERMIT2')],
    // 2026-10-01 (audit E17, E20): the swap through Uniswap's router, as the wallet client pins it.
    ['Universal Router', /^export const UNIVERSAL_ROUTER = '(0x[0-9a-f]{40})'/m.exec(readText(join(APP, 'src/finance/pin.ts')))?.[1]],
  ];
  for (const [name, address] of expected) assert.match(address ?? '', /^0x[0-9a-f]{40}$/, `backend ${name}`);
  const contracts = page('contracts');
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Domino's new contracts first, then V1, then the
  // Uniswap contracts on Robinhood Chain, each network's position NFTs, and the three networks.
  assert.deepEqual(sectionIds(contracts), ['new-contracts', 'domino-contracts', 'uniswap-contracts', 'position-nfts', 'network']);
  const rows = (id) => contracts.sections.find((section) => section.id === id).blocks.filter((block) => block.kind === 'addresses').flatMap((block) => block.rows.map((row) => [row.label, row.address]));
  assert.deepEqual(rows('uniswap-contracts'), expected);
  const roles = Object.fromEntries(contracts.sections.find((section) => section.id === 'uniswap-contracts').blocks.filter((block) => block.kind === 'addresses').flatMap((block) => block.rows.map((row) => [row.label, row.role])));
  assert.match(roles.Permit2, /only when Review shows one/);
  assert.doesNotMatch(roles.Permit2, /deposit/i);
  // The record's Uniswap dependencies are the backend's, so the Robinhood Chain section describes one chain.
  assert.deepEqual([DEPLOYMENT.dependencies.poolManager, DEPLOYMENT.dependencies.positionManager, DEPLOYMENT.dependencies.stateView], expected.slice(0, 3).map(([, address]) => address));
  // Each network's position NFT contracts, as the chain profiles name them (api-contracts/v2/chains, which src/v2/chains.ts reads).
  const profile = (name) => JSON.parse(readText(join(REPO, 'api-contracts/v2/chains', name)));
  const [robinhood, base, arbitrum] = ['robinhood-4663.json', 'base-8453.json', 'arbitrum-42161.json'].map(profile);
  const lower = (address) => address.toLowerCase();
  assert.deepEqual(rows('position-nfts'), [
    ['NonfungiblePositionManager', lower(robinhood.uniswap.v3.positionManager)],
    ['PositionManager', lower(base.uniswap.v4.positionManager)],
    ['NonfungiblePositionManager', lower(base.uniswap.v3.positionManager)],
    ['PositionManager', lower(arbitrum.uniswap.v4.positionManager)],
    ['NonfungiblePositionManager', lower(arbitrum.uniswap.v3.positionManager)],
  ]);
  assert.equal(lower(robinhood.uniswap.v4.positionManager), expected[1][1], 'Robinhood Chain’s v4 position NFTs are the backend’s');
  for (const chain of [robinhood, base, arbitrum]) assert.equal(lower(chain.permit2), expected[3][1], `${chain.slug}: Permit2 has one address on every network`);
  // Domino V1: only the two contracts a wallet meets, under the names the record and the explorer give them, exactly as
  // before. Its automation contracts are clones made per owner and the implementation is their template (handoff §2), so
  // neither has an address here.
  assert.deepEqual(rows('domino-contracts'), [
    [DEPLOYMENT.contractNames.setup, DEPLOYMENT.contracts.setup],
    [DEPLOYMENT.contractNames.factory, DEPLOYMENT.contracts.factory],
  ]);
  assert.deepEqual([DEPLOYMENT.contractNames.setup, DEPLOYMENT.contractNames.factory], ['DominoSetupV1', 'DominoVaultFactoryV1']);
  // Spec F7 §1.1: V1's automation ends when the new one starts, and there is no migration flow.
  assert.match(sectionText(contracts, 'domino-contracts'), /Its automation ends when the new automation starts, and nothing moves from V1 to it by itself: there is no migration\./);
  // Changed on purpose 2026-10-04 (V2 deployed, #327; the owner: the docs show the V2 contracts): Domino's contracts with
  // their addresses, exactly the verified records the app pins (spec F7 §7.3: addresses only from that record), the same
  // on every network (CREATE3, §1.3), each row under its contract's own name; nothing "published when deployed" is left.
  const pinned = ['robinhood-4663', 'base-8453', 'arbitrum-42161'].map((slug) => JSON.parse(readText(join(REPO, `docs/deployments/v2-${slug}-2026-10-04/deployment.json`))));
  for (const record of pinned.slice(1)) assert.deepEqual(record.contracts, pinned[0].contracts, 'one address on every network');
  const v2Rows = rows('new-contracts');
  assert.equal(v2Rows.length, 13);
  assert.deepEqual(new Set(v2Rows.map(([, address]) => address)), new Set(Object.values(pinned[0].contracts)), 'every V2 contract, and only them');
  for (const [label, address] of v2Rows) {
    const key = Object.keys(pinned[0].contracts).find((name) => pinned[0].contracts[name] === address);
    assert.equal(label, pinned[0].contractNames[key], `${address} is ${pinned[0].contractNames[key]}`);
  }
  assert.match(sectionText(contracts, 'new-contracts'), /each at one address on every network, so check the network as well as the address\./);
  assert.doesNotMatch(textOf(contracts), /Published when deployed/);
  // The networks.
  const networks = Object.fromEntries(rowsOf(contracts, 'facts').map((row) => [row.label, row.value]));
  assert.deepEqual(networks, { 'Robinhood Chain': `Chain ID ${DEPLOYMENT.chain.chainId}`, Base: 'Chain ID 8453', 'Arbitrum One': 'Chain ID 42161', 'Gas token': 'ETH, on each' });
  assert.equal(DEPLOYMENT.chain.chainId, 4663);
  assert.deepEqual([robinhood.chainId, base.chainId, arbitrum.chainId], [4663, 8453, 42161]);
  for (const entry of DOC_PAGES) for (const row of rowsOf(entry, 'addresses')) assert.match(row.address, /^0x[0-9a-f]{40}$/, `${entry.slug}: ${row.label}`);
});

// Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Domino V1 is deployed and stays so; its automation,
// with its paused start, its readiness check and its Turn on, ends when the new automation starts, which starts at once.
test('Domino V1 is deployed; the docs describe the new automation, which starts at once, and V1’s, which ends with no migration', () => {
  assert.equal(DEPLOYMENT.publicReleaseVersion, 1);
  assert.equal(DEPLOYMENT.contractsDeployed, true);
  // Changed on purpose (2026-09-27, the owner's round 6, point 6): the Settings page that listed ROADMAP with a note per
  // row is gone, and the notes with it; ROADMAP names only the two automations whose pill Automate shows.
  assert.deepEqual(ROADMAP.map((row) => row.name), ['Compound', 'Domino']);
  for (const entry of ROADMAP) {
    assert.equal(entry.status, 'owner-scoped');
    assert.equal(ROADMAP_PILL[entry.status], 'Starts paused');
    assert.deepEqual(Object.keys(entry), ['name', 'status'], `${entry.name} carries no note`);
  }
  assert.match(sectionText(page('what-is-domino'), 'your-wallet-signs'), /It starts once your wallet sets it up\./);
  assert.match(sectionText(page('your-automation'), 'domino-v1'), /Domino V1’s automation ends when the new one starts, with no migration: withdraw what V1 holds for you with Withdraw to wallet, then set up the new automation\./);
  assert.match(sectionText(page('what-is-domino'), 'built-on-uniswap'), /Domino’s own contracts run beside them on each of its three networks: one acts on your positions, one runs your automation, one carries out Auto-exit\./);
  for (const entry of DOC_PAGES) {
    const text = textOf(entry);
    assert.doesNotMatch(text, /offers? activation|review activation|may activate|remain available through your wallet|Activation|readiness/i, entry.slug);
    assert.doesNotMatch(text, /No Domino screen makes them today|Each step shows its amounts/, entry.slug);
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
    assert.doesNotMatch(text, /re-?⁠?add/i, `"re-add" in: ${text}`);
    // 2026-09-28 (review): the Settings page by its name. The plain word "settings", as in a pool's own settings, stays;
    // the link check below rejects any #/settings link.
    assert.doesNotMatch(text, /\bSettings\b/, `Settings in: ${text}`);
  }
  for (const entry of DOC_PAGES) for (const link of linksOf(entry)) assert.doesNotMatch(link.to, /settings/, `${entry.slug}: ${link.to}`);
  const positions = page('positions');
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Receipts lists what you and your automation did.
  assert.match(sectionText(positions, 'managed-positions'), /Receipts lists what you and your automation did, each action with its fees and what came back\./);
  assert.match(SHOTS.receipts.alt, /added a position’s fees back, with what it added back\.$/);
  // Point 3: the table's own APR, beside how each row's fees are used. Point 4: the Wallet card, every token in dollars,
  // the three worth the most always shown.
  assert.match(sectionText(positions, 'your-positions'), /Open rows also say how their fees are used, or offer Automate\./);
  assert.match(sectionText(positions, 'wallet-balances'), /The Wallet card shows the tokens of the connected wallet, or any address, in dollars: the three largest first, the rest under Show all\./);
  // Point 3: the simulator in plain words. Point 7: Plan a range left the pool page, and its typical range took the place.
  const ranges = page('ranges');
  assert.match(sectionText(ranges, 'try-a-range'), /range simulator on Home lets you move the price and see, in plain words, whether a position earns fees and what it holds\./);
  assert.match(sectionText(ranges, 'try-a-range'), /On a pool’s page, Price range draws the band New position starts on against that pool’s price\. Nothing is saved or sent\./);
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
  assert.equal(rowsOf(page('contracts'), 'facts').find((row) => row.label === 'Robinhood Chain').value, 'Chain ID 4663');
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
    // Wallet and sign-in is back under 450 (2026-10-01, the copy workstream): what this browser keeps and who sees the
    // address moved to Privacy, and the dated exception of 480 from integration pass 2a is gone.
    const budget = entry.slug === 'glossary' ? 690 : entry.slug === 'non-custodial' || entry.slug === 'domino-compound' || entry.slug === 'positions' ? 480 : 450;
    assert.ok(words <= budget, `${entry.slug} has ${words} words`);
  }
});

test('the docs source stays inside its budget in the entry bundle', (t) => {
  const dir = join(APP, 'src/lib/docs');
  const files = readdirSync(dir, { recursive: true }).map(String).filter((file) => file.endsWith('.ts')).sort();
  assert.ok(files.length >= 8, files.join(', '));
  const text = files.map((file) => readFileSync(join(dir, file), 'utf8')).join('\n');
  const size = gzipSync(text, { level: 9 }).length;
  // Changed on purpose 2026-10-02 (the fee chart's periods back): 24,000 -> 24,100 for Privacy's sentence on who reads a
  // past moment (an archive node, by the position's number); measured at 24,040 bytes. 24,059 after the tabs review's
  // finding 2 (2026-10-02: the past moment's archive provider is outside Domino), within the same budget.
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): 24,100 -> 30,300 for Domino's new contracts: four
  // new pages (Bring funds from another network, Manage a position, Stop-loss / take-profit, Your automation), the fees and
  // contracts pages rewritten, every page's V2 changes; measured at 30,195 bytes after the pages were cut back to their word
  // budgets. The docs are a route chunk of their own since 2026-10-01 (the platform workstream), outside the entry, which
  // tests/session.bundle.test.mjs measures with the route screens.
  // Changed on purpose 2026-10-04 (V2 deployed, #327; the owner: the docs show the V2 contracts): 30,300 -> 30,800 for the
  // 13 V2 contract addresses on Contracts, hex that hardly compresses, in place of "Published when deployed"; measured at
  // 30,707 bytes.
  // Changed on purpose 2026-10-05 (New position on the three networks, #351; rugged97's F7 delta of 5 Oct, §5.5: the
  // successors' rules and the code comments that date them): 30,800 -> 31,000; measured at 30,870 bytes.
  // Changed on purpose 2026-10-06 (rugged97's delta of 5 Oct: the balances Domino reads on the other networks, and dollars
  // on the new contracts' rows): 31,000 -> 31,100; measured at 31,033 bytes.
  t.diagnostic(`src/lib/docs: ${files.length} files, ${Buffer.byteLength(text)} bytes, ${size} bytes gzip (budget 31100)`);
  assert.ok(size <= 31_100, `the docs source is ${size} bytes gzip, over the 31,100 byte budget`);
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
  // Changed on purpose 2026-10-01: a pool's page has its own docs page, with its picture.
  assert.deepEqual(shown('markets'), ['markets']);
  assert.deepEqual(shown('pool-page'), ['pool']);
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): no Review picture. The one shot showed Domino V1's
  // review (a deposit into its Setup contract, then the mint), which New position no longer has on Domino's new contracts,
  // and the builds the script shoots carry none of them (scripts/docs-shots.mjs).
  assert.deepEqual(shown('new-position'), ['new-pool', 'new-range', 'new-amount']);
  assert.deepEqual(shown('positions'), ['positions', 'position', 'receipts']);
  assert.deepEqual(shown('auto-compound'), ['automate']);
  assert.deepEqual(diagramsOf(page('what-is-domino')).map((block) => block.name), ['earning', 'three-ways']);
});

test('the screenshot script says how to run it again, and shows only made-up data', () => {
  const script = readText(join(APP, 'scripts/docs-shots.mjs'));
  assert.match(script, /npm run build:wallet-test-v2 -- --configLoader runner && npm run build:unit && node scripts\/docs-shots\.mjs --offline/);
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
  for (const file of readdirSync(join(APP, 'src/styles'))) assert.doesNotMatch(readText(join(APP, 'src/styles', file)), /data-build-banner/, file);
  // The made-up world is the script's own (scripts/docs-world.mjs): the tokens the app has artwork for, and no fixture
  // token or placeholder address on a picture.
  const world = readText(join(APP, 'scripts/docs-world.mjs'));
  for (const token of ['ETH', 'WETH', 'USDG', 'MARLIN']) assert.ok(existsSync(join(APP, `public/tokens/${token.toLowerCase()}.${token === 'MARLIN' ? 'jpg' : 'svg'}`)), token);
  assert.doesNotMatch(`${script}\n${world}`, /FIXTURE_TOKEN|0x1{40}|symbol: 'TOKEN'/);
});

// ---------------------------------------------------------------------------
// 2026-10-01, the 2026-10 package (the copy workstream): the docs say what the package changed, in the words the screens
// use, and each new claim is held to the code that makes it true.
// ---------------------------------------------------------------------------

test('the 2026-10 package: one-sided ranges, the history read at chosen blocks, phones and requests, Markets’ lists, Privacy', () => {
  const src = (path) => readText(join(APP, 'src', path));
  // One-sided ranges (audit E13): which token a range beside the price starts with, and no sentence that says the token
  // left is always "the one that lost value".
  const ranges = page('ranges');
  assert.match(sectionText(ranges, 'one-sided'), /One above starts with only the token being priced, such as ETH, and sells it as the price climbs through the range\. One below starts with only the other, such as USDG, and buys as the price falls into it\./);
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /the one that lost value/, entry.slug);
  assert.doesNotMatch(src('screens/Landing.tsx'), /the one that lost value/);
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): on Domino's new contracts what you pay with is
  // swapped into that one token (src/v2in/journey).
  assert.match(sectionText(page('new-position'), 'step-amount'), /A range beside today’s price takes its one token only/);
  assert.match(sectionText(page('ranges'), 'one-sided'), /New position puts in that one token only, and swaps what you pay with into it when needed./);
  // Prices are written as every screen writes them (audit E21).
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /USDG per ETH/, entry.slug);
  // The fees history (lib/fees/points.ts read it at chosen blocks until 2026-10-01), and who sees those reads (item I4).
  // Changed on purpose 2026-10-01 (RPC-SPEC D5): no reads at chosen blocks (no archive is asked); the replay of its logs.
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2): no replay of the pool's swaps; the position's own
  // ledger, and the card's own words where it is not exact (components/positions/FeesCard.tsx).
  const earned = sectionText(page('earned-fees'), 'where-fees-come-from');
  // Changed on purpose 2026-10-02, later (the owner: the chart's 24H / 7D / 30D / All went missing): its periods are back,
  // each from a measured moment, a day or a week ago among them (lib/fees/periods.ts, pastReads.ts).
  assert.match(earned, /those paid out each time they were collected or compounded, read from its own records, and those ready to collect now\. Its chart shows measured moments, including about a day and a week ago\./);
  assert.match(readText(join(APP, 'src/lib/fees/periods.ts')), /'24h': \{ seconds: DAY,[\s\S]*'7d': \{ seconds: 7 \* DAY,/, 'a day and a week');
  assert.match(earned, /Some positions’ Fees earned can’t be measured, such as one whose liquidity changed after it opened; Fees ready to collect is always exact\./);
  assert.ok(src('components/positions/visual/FeesCard.tsx').includes('Fees earned can’t be measured for this position. Fees ready to collect is exact.'));
  assert.doesNotMatch(textOf(page('earned-fees')), /chosen moments|replayed|est\./);
  const privacy = page('privacy');
  // Changed on purpose 2026-10-01 (fix round 1): your own Positions list reads them too, for its rows' APR
  // (components/positions/useAprPrefetch.ts, off for a viewed address), so "only once that page is open" was wrong.
  // Changed on purpose 2026-10-01 (RPC-SPEC §7.6, the owner's rule: nothing is read from a public RPC): the chain is read by
  // Domino's own servers from Domino's own node; the browser asks only Domino, and no public node sees the address.
  // Changed on purpose 2026-10-02 (review of the chart's tabs, finding 2): "as the chain has them now", so it does not read
  // as covering the past moments below.
  assert.match(sectionText(privacy, 'who-sees'), /Your positions, their fees and their history, as the chain has them now, are read by Domino’s own servers, from Domino’s own Robinhood Chain node\. Your browser asks only Domino, so no other node sees your address\. Your wallet signs and sends through its own connection to the chain\./);
  assert.match(sectionText(privacy, 'who-sees'), /Token pictures and prices come from a public market data provider\. Like any site it sees your internet address, never your wallet’s\./);
  // 2026-10-02 (the fee chart's periods back): a moment past the node's ~25 minutes of state is read through Domino's read
  // service (read-v1 nft-positions at a block). Changed on purpose the same day (review of the chart's tabs, finding 2):
  // rugged97's VM reads state older than ~25 minutes from Alchemy (RUGGED_RPC_SITE_2026-10-02.md §4), a provider outside
  // Domino, which is given the position's number and the block alone.
  assert.match(sectionText(privacy, 'who-sees'), /A position’s fees at a past moment, for its chart, are read by Domino’s read service through an archive provider outside Domino\. It is given only the position’s number and the block, never your address\./);
  assert.doesNotMatch(sectionText(privacy, 'who-sees'), /archive node|half an hour/);
  assert.match(readText(join(APP, 'src/lib/fees/spawn.ts')), /readWithin\(source, 'nft-positions', \{ tokenIds: \[id\], blockNumber: block \}/, 'one position, by its number, at one block');
  assert.doesNotMatch(textOf(privacy), /public nodes?|only once that page is open/);
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the rows' ledgers, still for your own wallet only.
  assert.match(src('components/positions/OwnedPositions.tsx'), /useRowAprs\(measured, !readOnly && /, 'the list reads them for your own wallet only');
  // What this browser keeps, row by row, as lib/browserCopies.ts and the fees history keep it (items I6, A17).
  const kept = Object.fromEntries(rowsOf(privacy, 'facts').map((row) => [row.label, row.value]));
  // Changed on purpose 2026-10-01 (fix round 1): token balances are kept for a viewed address too (lib/walletMemory.ts).
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): a deposit from another network is kept until the
  // person removes it (finance/v2/crosschain.ts createDepositJournal: public data only, dropped by "Remove from this list").
  assert.deepEqual(kept, { 'Your positions': 'A day', 'Token balances': 'A day', 'Managed positions': '6 hours', Receipts: '30 days', 'A position’s fee history': '7 days', 'Token names': '30 days', 'Deposits from another network': 'Until you remove one' });
  assert.match(src('finance/v2/crosschain.ts'), /drop\(owner, entry\) \{/);
  assert.match(src('v2in/funds/copy.ts'), /remove: 'Remove from this list'/);
  assert.match(src('lib/walletMemory.ts'), /WALLET_MEMORY_MAX_AGE_MS = 86_400_000|WALLET_MEMORY_MAX_AGE_MS = 24 \* 60 \* 60 \* 1_?000/, 'the Wallet card keeps a day');
  assert.match(src('lib/fees/historyCache.ts'), /HISTORY_MAX_AGE_MS = 7 \* 24 \* 60 \* 60 \* 1_000\n/, 'the fees history is kept 7 days');
  // Phones (audit C3, C4): the dialog's wallet apps, and WalletConnect only where the dialog offers it.
  const connect = sectionText(page('wallet'), 'connect');
  assert.match(connect, /offers MetaMask, Coinbase Wallet and Trust Wallet to open it in\./);
  const dialog = src('components/wallet/WalletSessionDialog.tsx');
  for (const app of ['MetaMask', 'Coinbase Wallet', 'Trust Wallet', 'Rabby']) assert.ok(dialog.includes(`>${app}<`), app);
  const walletConnect = /^[0-9a-f]{32}$/.test(/WALLETCONNECT_PROJECT_ID = '([^']*)'/.exec(src('config/walletConnect.ts'))[1]);
  assert.equal(/WalletConnect/.test(connect), walletConnect, 'WalletConnect is named where the dialog offers it, and only there');
  // Wallet requests: the buttons by the words they wear (components/create/CreatePosition.tsx, lib/create/copy.ts).
  const requests = textOf(page('wallet-requests'));
  const create = src('components/create/CreatePosition.tsx');
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): New position runs on Domino's new contracts, whose
  // steps say "I rejected it in my wallet" too (src/v2in/journey/errors.ts); Domino V1's "I set up this smart account:
  // continue" is not where a position is created any more, so the docs no longer name it. A signature that carries the plan
  // ("Sign the deposit", 5 minutes) and its cancellation are the new contracts' own words.
  for (const words of ['I rejected it in my wallet']) {
    assert.ok(create.includes(words), `CreatePosition says ${words}`);
    assert.ok(src('v2in/journey/errors.ts').includes(words), `the new journey says ${words}`);
    assert.ok(requests.includes(words), `the docs say ${words}`);
  }
  // Changed on purpose 2026-10-06 (the owner's point 4: the wallet's steps by their titles only): the line that explained
  // "Sign the deposit" under the step is gone from the app; the docs still say what it signs and for how long.
  for (const words of ["signPermit: 'Sign the deposit'", "cancelSignature: 'Cancel the signature'"]) assert.ok(src('v2in/journey/copy.ts').includes(words), words);
  assert.ok(src('v2in/journey/copy.ts').includes("signedFor: (span: string) => `What you sign stays valid for ${span}.`"), 'Review’s Details says how long what is signed stays valid');
  assert.match(requests, /Sign the deposit signs one message that carries the whole plan, valid for 5 minutes/);
  assert.ok(requests.includes(CREATE.review.batchOffer), CREATE.review.batchOffer);
  assert.match(requests, /your address stays the same, your key stays in control/i);
  // Markets (audit E14, B1, B5): the list can shrink during the day, its count, Pinned and the fixed selection, by the
  // words the table wears.
  const table = sectionText(page('markets'), 'pools-table');
  // Changed on purpose 2026-10-03 (the owner): the table says no count any more ("4 of 6 today"), and the docs say why a
  // list can be shorter instead.
  assert.match(table, /some days fewer than six pools pass every check, so the list can be shorter until the next one\. Pinned marks a pool Domino chose itself\. When the list is unavailable, a fixed selection, Selected pools, takes its place\./);
  assert.ok(!src('components/MarketsTable.tsx').includes('data-featured-count'), 'no count over the table');
  assert.ok(src('components/MarketsTable.tsx').includes('>\n      Pinned\n'));
  assert.ok(src('lib/read/featuredList.ts').includes(": 'Selected pools')"));
  // Stand-in figures (item V1): labelled and dated in their titles.
  assert.match(sectionText(page('figures'), 'reported-by-a-provider'), /a figure may stand in: the last one this browser saw, a second provider’s, or the one today’s list was chosen with, its title saying which and when\./);
  // Contracts: deposit approvals go to the Setup contract (audit E17); the network fee is the wallet's to show (audit E24).
  for (const entry of DOC_PAGES) assert.doesNotMatch(textOf(entry), /gas limit/, entry.slug);
});

// 2026-10-01, the package's follow-ups (merged after the copy workstream, described as shipped): a step replaced in the
// wallet (audit C14), one line for the two automation cards with nothing to show (D2), another address's positions (V7)
// and the blocks the fees history keeps (A1).
test('the docs say what the follow-ups ship: replaced wallet steps, one line for both cards, another address’s positions, the blocks kept', () => {
  const requests = sectionText(page('wallet-requests'), 'before-you-sign');
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): said of every step, Domino V1's and the new
  // contracts' ("Nothing more will be sent from here: check your wallet’s activity", src/v2in/journey/errors.ts).
  assert.match(requests, /If you press Speed up or Cancel in your wallet while Domino waits for a step, or its answer goes missing, Domino reads the network again and sends nothing more on its own: it tells you what happened, or asks you to check your wallet’s activity\./);
  assert.doesNotMatch(requests, /a step of Create position in your wallet/);
  const positions = page('positions');
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): the new automation's rows and receipts need no
  // sign-in; Domino V1's history still does.
  assert.match(sectionText(positions, 'managed-positions'), /Neither needs sign-in, except for what Domino V1’s automation did\./);
  // Changed on purpose 2026-10-01 (integration pass 3): "read-only" is a word the docs never use (the words, above), and
  // only the list of a viewed address is never kept (its positions' start blocks are, as any position's, with no address).
  assert.match(sectionText(positions, 'wallet-balances'), /View address also lists that address’s positions, just to look at\./);
  const kept = sectionText(page('privacy'), 'this-browser');
  // Changed on purpose 2026-10-01 (fix round 1): the positions of a viewed address; its token balances are in the table.
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): no start blocks are kept any more; the fee chart's own points are.
  // Changed on purpose 2026-10-02, later (the chart's periods): a read at a past moment is kept too (readings.ts insert).
  assert.match(kept, /it also keeps that position’s fees ready to collect each time this browser reads them, now or at a past moment, for 30 days: public chain data, no wallet address\. The positions of an address you view are never kept\./);
  assert.match(readText(join(APP, 'src/lib/fees/readings.ts')), /READING_EVERY_SECONDS = 3_?600\b[\s\S]*READING_MAX_AGE_SECONDS = 30 \* 86_?400\b/, 'hourly, 30 days');
  assert.doesNotMatch(kept, /The list of an address you view is never kept/);
});

// Fix round 1 (2026-10-01): only a live row of Markets has the info button with its figures; a listed pool whose live row
// has not arrived has none, so the docs promise it for a row that has one, and that row's name no longer says its figures
// are unavailable while stand-in figures are shown beside it.
test('Missing figures: the info button where a row has one; a listed pool’s name says unavailable only with no stand-in', () => {
  assert.match(sectionText(page('markets'), 'unavailable-figures'), /Its title says why; on a phone, so does the info button at the end of a row that has one\./);
  const table = readText(join(APP, 'src/components/MarketsTable.tsx'));
  const catalogue = table.slice(table.indexOf('function CatalogueRow('), table.indexOf('\n}\n', table.indexOf('function CatalogueRow(')));
  assert.match(catalogue, /const standing = tvl !== null \|\| volume !== null \|\| apr !== null/);
  assert.match(catalogue, /title=\{standing \? 'Listed on Uniswap\. Its live figures are not in yet; each figure shown stands in, with its source and time\.' : 'Listed on Uniswap\. Pool figures are unavailable\.'\}/);
  assert.doesNotMatch(catalogue, /data-pool-figures/, 'no info button there, as the docs now say');
});
