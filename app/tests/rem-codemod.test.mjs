/**
 * Changed on purpose 2026-10-03 (the owner: the site looks too big at 100%; at 80% it looks right): the site's lengths are
 * rem, 16 design px to the rem, so the root's font-size (styles/tokens.css) scales the whole page at once
 * (scripts/rem-codemod.mjs; lengths written in script follow through src/lib/rootScale.ts). These pin the codemod's
 * rules, and that nothing under src is left for it to convert: a px length added later would not scale with the rest of
 * the page, so `node scripts/rem-codemod.mjs` converts it, or the rules above it say why it stays px.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { convertClasses, convertCss, run, svgKeyframes } from '../scripts/rem-codemod.mjs';

/** The container query at-rule, its name in two pieces: Tailwind scans this file and would build it as a utility. */
const CONTAINER = `@${'container'}`;

/** A stand-in for what the JSX says: these classes sit on an outer <svg> (`roots`) or inside one (`parts`). */
const model = (roots = [], parts = []) => ({ isRoot: (name) => roots.includes(name), isPart: (name) => parts.includes(name) });

test('nothing under src is left to convert: every CSS length over 2px and every Tailwind arbitrary px value is rem', () => {
  const { changed } = run({ check: true });
  assert.deepEqual(changed, [], `run \`node scripts/rem-codemod.mjs\` in app/: ${changed.join(', ')}`);
});

test('a length becomes rem at 16px to the rem; hairlines, pills, media queries, comments, strings and url() keep their px', () => {
  const css = [
    '@media (min-width: 768px) { .a { padding: 24px 2px 1.5px 10.5px; } }',
    '.b { border: 1px solid red; border-radius: 9999px; box-shadow: inset 0 0 0 1px var(--x), 0 6px 20px -8px #000; }',
    `.c { /* 24px wide */ width: calc(100% - 24px); background: url("data:image/svg+xml,%3Csvg width='24px'%3E") 0 0 / 16px 16px; content: '12px'; }`,
  ].join('\n');
  const out = convertCss(css, { model: model() });
  assert.match(out, /@media \(min-width: 768px\)/);
  assert.match(out, /padding: 1\.5rem 2px 1\.5px 0\.65625rem;/);
  assert.match(out, /border: 1px solid red; border-radius: 9999px; box-shadow: inset 0 0 0 1px var\(--x\), 0 0\.375rem 1\.25rem -0\.5rem #000;/);
  assert.match(out, /\/\* 24px wide \*\/ width: calc\(100% - 1\.5rem\);/);
  assert.match(out, /url\("data:image\/svg\+xml,%3Csvg width='24px'%3E"\) 0 0 \/ 1rem 1rem; content: '12px';/);
  assert.equal(convertCss(out, { model: model() }), out, 'a second run changes nothing');
});

test('container queries are converted (they measure a box the scale already shrank); @property, @font-face and the root font-size are not', () => {
  const css = [
    `${CONTAINER} card (max-width: 359px) { .d { gap: 8px; } }`,
    "@property --fade { syntax: '<length>'; inherits: false; initial-value: 32px; }",
    '@font-face { font-family: X; src: url(x.woff2); size-adjust: 100%; ascent-override: 90%; }',
    '@media (min-width: 1024px) { html { font-size: 12.8px; } }',
    ':root { --gutter: 40px; }',
  ].join('\n');
  const out = convertCss(css, { model: model() });
  assert.ok(out.includes(`${CONTAINER} card (max-width: 22.4375rem) { .d { gap: 0.5rem; } }`), out);
  assert.match(out, /initial-value: 32px;/, 'an @property initial value must not depend on the root');
  assert.match(out, /html \{ font-size: 12\.8px; \}/, 'the root font-size is the scale itself');
  assert.match(out, /--gutter: 2\.5rem;/);
});

test("lengths in an SVG drawing's own units keep their px: parts under an <svg>'s class, SVG element selectors and the keyframes they run", () => {
  const css = [
    '.art .tip { transform-origin: 8px 8px; animation: tip-in 1s linear; }',
    '.art { width: 320px; }',
    '.box > svg { width: 14px; }',
    '.chart text { font-size: 12px; }',
    '.axis { font-size: 12px; }',
    '@keyframes tip-in { from { translate: 0 10px; } }',
    '@keyframes rise { from { translate: 0 8px; } }',
    '.card { animation: rise 1s; }',
  ].join('\n');
  const svg = model(['art'], ['axis']);
  const keyframes = svgKeyframes([{ css }], svg);
  assert.deepEqual([...keyframes], ['tip-in']);
  const out = convertCss(css, { model: svg, keyframesInSvg: keyframes });
  assert.match(out, /\.art \.tip \{ transform-origin: 8px 8px;/);
  assert.match(out, /\.art \{ width: 20rem; \}/, 'the <svg> itself is a box in the page');
  assert.match(out, /\.box > svg \{ width: 0\.875rem; \}/);
  assert.match(out, /\.chart text \{ font-size: 12px; \}/);
  assert.match(out, /\.axis \{ font-size: 12px; \}/);
  assert.match(out, /@keyframes tip-in \{ from \{ translate: 0 10px; \} \}/);
  assert.match(out, /@keyframes rise \{ from \{ translate: 0 0\.5rem; \} \}/);
});

test('Tailwind arbitrary px values become rem; variants (media queries), hairlines and url() keep their px', () => {
  // Every class is written in pieces: Tailwind scans this file too, and would build a whole one into the site's stylesheet.
  const tw = (utility, value) => `${utility}-[${value}]`;
  const classes = (values) => `<p className="${values.join(' ')}" />`;
  const before = [tw('text', '13px'), tw('leading', '18px'), tw('md:text', '30px'), tw('-ml', '10px'), tw('max-w', 'calc(100%-24px)'), tw('shadow', 'inset_0_0_0_1px_var(--b)'), tw('align', '-2px'), `${tw('min', '640px')}:grid`, tw('bg', 'url(/x-12px.png)')];
  const after = [tw('text', '0.8125rem'), tw('leading', '1.125rem'), tw('md:text', '1.875rem'), tw('-ml', '0.625rem'), tw('max-w', 'calc(100%-1.5rem)'), tw('shadow', 'inset_0_0_0_1px_var(--b)'), tw('align', '-2px'), `${tw('min', '640px')}:grid`, tw('bg', 'url(/x-12px.png)')];
  assert.equal(convertClasses(classes(before)), classes(after));
  assert.equal(convertClasses(classes(after)), classes(after), 'a second run changes nothing');
});

test('the root font-size follows browser text preferences: compact from 768px with a fine pointer, full size on touch', () => {
  const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  assert.match(tokens, /html \{ font-size: 100%; \}/);
  assert.match(tokens, /@media \(min-width: 768px\) and \(pointer: fine\) \{\s*html \{ font-size: 67\.5%; \}\s*\}/);
  assert.doesNotMatch(tokens, /html \{[^}]*font-size: (?!100%|67\.5%)/, 'no other root font-size');
  const scale = readFileSync(new URL('../src/lib/rootScale.ts', import.meta.url), 'utf8');
  assert.match(scale, /ROOT_SCALE_QUERIES = \['\(min-width: 768px\)', '\(min-width: 768px\) and \(pointer: fine\)'\]/);
});

test('SVG subscribers see a fine-to-touch pointer change at 900px without a viewport resize or reload', () => {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = readFileSync(new URL('../src/lib/rootScale.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let fine = true;
  let updates = 0;
  const queries = new Map();
  const matches = (query) => Number(query.match(/min-width: (\d+)px/)[1]) <= 900 && (!query.includes('pointer: fine') || fine);
  const window = { matchMedia: (query) => {
    if (!queries.has(query)) queries.set(query, { matches: matches(query), listeners: [], addEventListener(type, listener) { assert.equal(type, 'change'); this.listeners.push(listener); } });
    return queries.get(query);
  } };
  const document = { documentElement: {}, readyState: 'complete' };
  const module = { exports: {} };
  const mockRequire = (name) => {
    assert.equal(name, 'react');
    return { useSyncExternalStore(subscribe, snapshot) { subscribe(() => { updates += 1; }); return snapshot(); } };
  };
  new Function('require', 'module', 'exports', 'window', 'document', 'getComputedStyle', compiled)(mockRequire, module, module.exports, window, document, () => ({ fontSize: fine ? '10.8px' : '16px' }));
  const setPointer = (next) => {
    fine = next;
    for (const [query, media] of queries) {
      const nextMatch = matches(query);
      if (nextMatch !== media.matches) {
        media.matches = nextMatch;
        for (const listener of media.listeners) listener({ matches: nextMatch });
      }
    }
  };
  assert.equal(module.exports.useRootScale(), 0.675);
  setPointer(false);
  assert.equal(module.exports.rootScale(), 1, 'switching to touch updates the cached scale');
  assert.equal(updates, 1, 'chart subscribers redraw once');
  setPointer(true);
  assert.equal(module.exports.rootScale(), 0.675, 'switching back restores the compact scale');
  assert.equal(updates, 2);
});
