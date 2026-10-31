/**
 * Added 2026-10-31 (QA round 2 follow-ups, R23): a rolling-digit figure (components/figures.tsx LiveFigure, mode
 * "digits": the position's value, the fees hero, the wallet total, the portfolio band) is one figure for a screen reader.
 * It drew one span per character with no name of its own, and where those spans are flex items (the position's
 * overview) a screen reader read "$", "0", ".", "2" one per line. The page's text stays exactly what the eye reads.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
const root = resolve(import.meta.dirname, '../..');
const cache = new Map();
// ./ui is the shared primitives module; LiveFigure needs only its class joiner from it.
const ui = { cx: (...names) => names.filter(Boolean).join(' '), Segmented: () => null };

// The actual TSX, transpiled in memory (no emitted files), as tests/picker-presentation.test.mjs does.
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const local = (name) => {
    if (!name.startsWith('.')) return createRequire(file)(name);
    if (name === './ui') return ui;
    const path = resolve(dirname(file), name);
    const typed = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map((suffix) => path + suffix).find(existsSync);
    return typed ? load(typed) : createRequire(file)(name);
  };
  new Function('require', 'module', 'exports', code)(local, mod, mod.exports);
  return mod.exports;
}

const { LiveFigure } = load(resolve(root, 'src/components/figures.tsx'));
const html = (props) => renderToStaticMarkup(React.createElement(LiveFigure, props));
const textOf = (markup) => markup.replace(/<[^>]+>/g, '');

test('a rolling-digit figure is one named figure for a screen reader, and its text is what the eye reads, once', () => {
  const markup = html({ value: '$0.2408', mode: 'digits', dimCents: true, className: 'dm-fig-lg' });
  const outer = markup.match(/^<span([^>]*)>/)[1];
  assert.match(outer, /\brole="img"/, 'one figure, its characters presentational');
  assert.match(outer, /\baria-label="\$0\.2408"/, 'named by its whole value');
  assert.match(outer, /\bclass="dm-tick-fig dm-tick-fig--digits dm-fig-lg"/, 'the classes the page and its tests find it by');
  assert.equal((markup.match(/class="dm-tick-d[^"]*"/g) ?? []).length, 7, 'still one span per character, for the roll');
  assert.equal(textOf(markup), '$0.2408', 'the value is in the text once: no second, hidden copy');
  assert.doesNotMatch(markup, /sr-only|aria-hidden/);
});

test('the name follows the value, cents dimmed or not, and a figure in whole mode keeps its plain text', () => {
  const dollars = html({ value: '$1,234.56', mode: 'digits', dimCents: true });
  assert.match(dollars, /aria-label="\$1,234\.56"/);
  assert.equal((dollars.match(/dm-amount-tail/g) ?? []).length, 3, 'the cents are still dimmed: the point and two digits');
  assert.equal(textOf(dollars), '$1,234.56');
  const dash = html({ value: '—', mode: 'digits' });
  assert.match(dash, /role="img" aria-label="—"/);
  const whole = html({ value: '$23.96' });
  assert.doesNotMatch(whole, /role=|aria-label=/, 'one text node already reads as one figure');
  assert.equal(textOf(whole), '$23.96');
});
