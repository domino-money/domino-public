/**
 * The words the copy keeps out, on the text written inside components too (audit H6, 2026-10-01). The rules had run
 * only on the docs' data (docs.test.mjs, "the words") and on Create position's strings (create-journey.test.mjs, "the
 * copy never promises"), so "guaranteed minimum", "improving your fees APR" and "Unclaimed at snapshot" reached the
 * screens from inside components.
 *
 * What counts as text written inside a component (app/src/**\/*.tsx, the read lab aside): JSX text; a string a JSX
 * child expression shows (a literal, a template, either side of a choice); and the strings of the props that carry
 * words (title, aria-label, alt, placeholder, label, description, points and the like). The copy modules (copy.ts,
 * words.ts) are read whole, every string in them. Strings that are code (class names, keys, data attributes, routes)
 * are not text and are not read.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const ROOT = fileURLToPath(new URL('../src/', import.meta.url));

/** Promises, the names of the market data providers, retired names and links: never anywhere a reader can meet them. */
const EVERYWHERE = [
  ['a promise', /guarantee|risk-free|will earn|maximum return|\bprofitable\b|improv\w*\s+(?:your\s+)?(?:fees?\s+)?(?:APR|returns?|earnings|yield)/i],
  ['a market data provider’s name', /GeckoTerminal|DexScreener|CoinGecko|Alchemy/i],
  ['a retired name', /Domino token|Domino sequences?\b/i],
  ['a link', /(?:https?|wss?):\/\//],
];
/**
 * On the screens themselves (not in a title or a label for assistive technology, where the technical detail goes):
 * nothing saying it is not ready, and no word a beginner does not know (the owner's beginner-first rule).
 */
const ON_SCREEN = [
  ['words that say it is not ready', /coming soon|not enabled yet|not connected yet|in this release|not available on this deployment|\balpha\b|\bbeta\b|\bv4\b|read-only/i],
  ['a technical word', /\bsnapshot\b/i],
];

/**
 * Known, each with what removes it. One that matches nothing any more fails this test: delete it then, so the list never
 * outlives its reason.
 */
// Changed on purpose 2026-10-01 (the copy workstream): the routed swap's Review lines are CREATE's plain words (audit E20),
// the Auto-compound card is rewritten (audit E4), the Fees card's saved copy is "Saved copy" and the token picker's line
// "Balance:" (audit H6, E10), so their four entries are gone. What is left is the local development build's.
const KNOWN = [
  ['components/read/LocalDevelopmentBanner.tsx', 'Read-only', 'the local development build only (npm run dev:live), never deployed'],
  ['components/wallet/LocalWalletIsland.tsx', 'read-only', 'the local development build only (npm run dev:live), never deployed'],
];

/**
 * Props whose strings are words a reader meets. On an HTML element a title is a hover title and alt stands in for an
 * image, so they are off the screen with what is for assistive technology; on a component a title is its heading.
 */
const WORDS_PROP = /^(?:title|alt|placeholder|aria-label|aria-description|aria-valuetext|label|description|lead|hint|notes?|summary|heading|caption|points|text|tooltip|message|subtitle|sentence|legend|backLabel|nextLabel)$/;
const offScreen = (prop, element) => prop.startsWith('aria-') || ((prop === 'title' || prop === 'alt') && /^[a-z]/.test(element));
const COPY_MODULE = /(?:^|\/)(?:copy|words)\.ts$/;

function sources() {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== 'lab') walk(path); continue; }
      const rel = relative(ROOT, path).split('\\').join('/');
      if (rel.endsWith('.tsx') || COPY_MODULE.test(rel)) files.push(rel);
    }
  })(ROOT);
  return files.sort();
}

/** The strings an expression shows: a literal, a template (its fixed parts), either side of a choice, an array's items. */
function shown(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'StringLiteral': out.push(node.value); return;
    case 'TemplateLiteral': out.push(node.quasis.map(part => part.value.cooked).join('…')); return;
    case 'ConditionalExpression': shown(node.consequent, out); shown(node.alternate, out); return;
    case 'LogicalExpression': if (node.operator !== '&&') shown(node.left, out); shown(node.right, out); return;
    case 'ArrayExpression': for (const item of node.elements) shown(item, out); return;
    case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': case 'ParenthesizedExpression': shown(node.expression, out); return;
    default:
  }
}

/** Every piece of text in one source file: [text, line, whether it is on the screen itself]. */
function textsOf(rel) {
  const ast = parse(readFileSync(join(ROOT, rel), 'utf8'), { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const texts = [];
  const add = (text, node, onScreen) => { const clean = text.replace(/\s+/g, ' ').trim(); if (clean) texts.push([clean, node.loc.start.line, onScreen]); };
  const copy = COPY_MODULE.test(rel);
  (function visit(node, parent) {
    if (!node || typeof node.type !== 'string') return;
    if (copy) {
      if (node.type === 'StringLiteral' && !/^(?:Import|Export\w*)Declaration$/.test(parent?.type ?? '') && !(parent?.type === 'ObjectProperty' && parent.key === node)) add(node.value, node, false);
      if (node.type === 'TemplateLiteral') add(node.quasis.map(part => part.value.cooked).join('…'), node, false);
    } else if (node.type === 'JSXText') {
      add(node.value, node, true);
    } else if (node.type === 'JSXExpressionContainer' && (parent?.type === 'JSXElement' || parent?.type === 'JSXFragment')) {
      const out = []; shown(node.expression, out);
      for (const text of out) add(text, node, true);
    } else if (node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier' && WORDS_PROP.test(node.name.name)) {
      const out = [];
      if (node.value?.type === 'StringLiteral') out.push(node.value.value);
      else if (node.value?.type === 'JSXExpressionContainer') shown(node.value.expression, out);
      const element = parent?.name?.type === 'JSXIdentifier' ? parent.name.name : 'Component';
      for (const text of out) add(text, node, !offScreen(node.name.name, element));
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) visit(item, node);
      else if (child && typeof child.type === 'string') visit(child, node);
    }
  })(ast.program, null);
  return texts;
}

/** Every rule a piece of text breaks, but the known ones; the known ones it matched go into `used`. */
function broken(rel, [text, line, onScreen], used) {
  const out = [];
  for (const [what, rule] of [...EVERYWHERE, ...(onScreen ? ON_SCREEN : [])]) {
    if (!rule.test(text)) continue;
    const known = KNOWN.find(([file, phrase]) => file === rel && text.includes(phrase) && rule.test(phrase));
    if (known) used.add(known);
    else out.push(`${rel}:${line}: ${what} in "${text}"`);
  }
  return out;
}

const FILES = sources();

test('the text written inside components says no promise, no provider’s name, no retired name and no link; on screen, nothing not ready and no technical word', () => {
  assert.ok(FILES.length > 100, `${FILES.length} files`);
  const used = new Set();
  let count = 0;
  const found = [];
  for (const rel of FILES) {
    for (const piece of textsOf(rel)) { count += 1; found.push(...broken(rel, piece, used)); }
  }
  assert.ok(count > 1500, `${count} pieces of text read`);
  assert.deepEqual(found, [], 'move the words to plain ones (and into a copy module where they can be checked)');
  const stale = KNOWN.filter(entry => !used.has(entry));
  assert.deepEqual(stale.map(([file, phrase, why]) => `${file}: "${phrase}" (${why})`), [], 'a known exception no longer needed: delete it from KNOWN');
});

test('the reading finds each kind of text the rules are for, so a rule cannot pass for having read nothing', () => {
  const read = rel => textsOf(rel).map(([text, , onScreen]) => [text, onScreen]);
  const automate = read('screens/Automate.tsx');
  assert.ok(automate.some(([text, onScreen]) => text === 'Automate' && onScreen), 'a prop’s words (PageHeader title="Automate" is a heading, not a hover title)');
  // Changed on purpose 2026-10-01 (audit E4): the card's words, rewritten. Changed on purpose 2026-10-04 (the owner's
  // ChatGPT UI round): the Auto-compound card's points reworded; the reading is checked on the first of them.
  assert.ok(read('components/automate/copy.ts').some(([text]) => text === 'Adds earned fees back into the same position, in the same range.'), 'the shared automation card’s copy');
  assert.ok(!automate.some(([text]) => /improving your fees APR|consumed/.test(text)), 'no promise, no "consumed"');
  const fees = read('components/positions/visual/FeesCard.tsx');
  assert.ok(fees.some(([text, onScreen]) => text === 'Ready to collect' && onScreen), 'either side of a choice in a JSX child');
  // The collection label survives refresh; provenance stays in Details and hover text rather than a generic notice.
  assert.ok(!fees.some(([text, onScreen]) => /taking longer to update/.test(text) && onScreen));
  assert.ok(!fees.some(([text]) => text === 'Ready to collect (saved)'));
  // Changed on purpose 2026-10-01 (audit E20): the routed swap's words are CREATE's now; the one-token line is JSX text.
  assert.ok(read('components/create/StageReview.tsx').some(([text]) => text.startsWith('You put in')), 'JSX text');
  assert.ok(!read('components/create/StageReview.tsx').some(([text]) => /guaranteed|router/i.test(text)), 'no "guaranteed", no "router"');
  assert.ok(read('lib/create/copy.ts').some(([text]) => text === 'Swap through Uniswap'), 'the routed swap’s words in the copy module');
  assert.ok(read('lib/create/copy.ts').length > 100, 'a copy module, every string');
  assert.ok(!FILES.some(rel => rel.startsWith('lab/')), 'the read lab is a development page, not a screen');
  // Each rule catches what it is for.
  const catches = (rules, text) => rules.some(([, rule]) => rule.test(text));
  for (const text of ['Fees are guaranteed.', 'This position will earn 4%.', 'Improves your APR.', 'improving your fees APR', 'Prices from GeckoTerminal', 'Your Domino token', 'See https://example.com']) assert.ok(catches(EVERYWHERE, text), text);
  for (const text of ['Coming soon', 'Not enabled yet', 'v4 pool', 'Read-only mode', 'Unclaimed at snapshot']) assert.ok(catches(ON_SCREEN, text), text);
  for (const text of ['Ready to collect', 'Fees added back', 'Set up Auto-compound', 'Your APR', 'A market data provider']) assert.ok(!catches([...EVERYWHERE, ...ON_SCREEN], text), text);
});
