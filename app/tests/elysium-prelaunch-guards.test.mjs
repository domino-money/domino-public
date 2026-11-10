/**
 * Source guards for Elysium's pre-launch (added 2026-11-07, the owner's order: Elysium on the site before its network
 * opens). A pre-launch build draws two things, Home's "Open positions on" row with Elysium's chip, and What Domino is's
 * last section, "Elysium" (scripts/elysium-switch.mjs ELYSIUM_OPENS_ON, src/lib/elysiumIdentity.ts ELYSIUM_PRELAUNCH);
 * nothing of it may reach a screen that reads or writes a chain, so its names live in those few files alone, its date
 * rule reads nothing, the chip leads to the docs and never to the old testnet section (#/elysium), and its mark is drawn
 * as the owner's file is: never dimmed, filtered or tinted (the owner's rule: Elysium's logo on white).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..');
const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'node_modules' || name.startsWith('.')) return [];
  return statSync(path).isDirectory() ? walk(path) : [path];
}) : []);
const rel = (path) => relative(APP, path).replaceAll('\\', '/');
const read = (path) => readFileSync(join(APP, path), 'utf8').replace(/\r\n/g, '\n');
const SOURCES = [...walk(join(APP, 'src')), ...walk(join(APP, 'functions'))].filter((path) => /\.(?:ts|tsx|mjs|js|css)$/.test(path)).map((path) => ({ path: rel(path), text: readFileSync(path, 'utf8') }));
const BRIDGE = walk(join(REPO, 'bridge', 'src')).filter((path) => /\.(?:ts|mjs|js)$/.test(path)).map((path) => ({ path: relative(REPO, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }));
const naming = (pattern) => SOURCES.filter(({ text }) => pattern.test(text)).map(({ path }) => path).sort();

test('the pre-launch names live in the files that draw it alone: never in a screen that reads or writes a chain', () => {
  assert.ok(SOURCES.length > 500, `${SOURCES.length} files read`);
  assert.deepEqual(naming(/\bELYSIUM_PRELAUNCH\b/), [
    'src/components/docs/DocsContent.tsx',
    'src/components/home/HomeCapabilities.tsx',
    'src/lib/docs/elysium.ts',
    'src/lib/docs/pages/introduction.ts',
    'src/lib/elysiumIdentity.ts',
    'src/screens/Landing.tsx',
  ]);
  assert.deepEqual(naming(/\bELYSIUM_OPENING\b/), ['src/components/docs/DocsContent.tsx', 'src/lib/elysiumIdentity.ts', 'src/lib/elysiumOpening.ts', 'src/screens/Landing.tsx']);
  assert.deepEqual(naming(/\buseBeforeElysiumOpens\b/), ['src/components/docs/DocsContent.tsx', 'src/lib/elysiumOpening.ts', 'src/screens/Landing.tsx']);
  assert.deepEqual(naming(/__DOMINO_ELYSIUM_(?:PRELAUNCH|OPENING)__/), ['src/lib/elysiumIdentity.ts']);
  assert.deepEqual(naming(/\bbeforeElysiumOpens\b/), ['src/components/docs/DocsContent.tsx', 'src/lib/docs/pages/introduction.ts', 'src/lib/docs/types.ts']);
  assert.deepEqual(naming(/elysiumOpening'/), ['src/components/docs/DocsContent.tsx', 'src/screens/Landing.tsx']);
  const NAMES = /\bELYSIUM_PRELAUNCH\b|\bELYSIUM_OPENING\b|\buseBeforeElysiumOpens\b|\bbeforeElysiumOpens\b|elysiumOpening|__DOMINO_ELYSIUM_(?:PRELAUNCH|OPENING)__/;
  const forbidden = /^(?:src\/v2|src\/v2in|src\/finance|src\/wallet|src\/session|src\/chains|functions)\//;
  assert.deepEqual(SOURCES.filter(({ path, text }) => forbidden.test(path) && NAMES.test(text)).map(({ path }) => path), []);
  for (const path of ['src/components/HeaderMenu.tsx', 'src/components/Footer.tsx', 'src/config/chainIdentity.ts', 'src/config/chainElysium.ts']) assert.doesNotMatch(read(path), NAMES, path);
  assert.ok(BRIDGE.length > 0, 'the read Worker\'s sources are read');
  assert.deepEqual(BRIDGE.filter(({ text }) => NAMES.test(text)).map(({ path }) => path), []);
});

test('the date rule reads nothing and asks no chain: no network call, no RPC method, no storage', () => {
  const source = read('src/lib/elysiumOpening.ts');
  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon|eth_|wallet_|localStorage|sessionStorage|indexedDB/);
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'$/gm)].map((match) => match[1]), ['react', './elysiumIdentity']);
  // elysiumIdentity.ts stays literals and defines: it imports nothing, so the Pages Functions may bundle it (where no define
  // exists and pre-launch reads as off).
  assert.doesNotMatch(read('src/lib/elysiumIdentity.ts'), /^import /m);
  assert.match(read('src/lib/elysiumIdentity.ts'), /export const ELYSIUM_PRELAUNCH: boolean = !ELYSIUM_LIVE && typeof __DOMINO_ELYSIUM_PRELAUNCH__ === 'boolean' && __DOMINO_ELYSIUM_PRELAUNCH__/);
  assert.match(read('src/lib/elysiumIdentity.ts'), /export const ELYSIUM_OPENING: ElysiumOpening \| null = ELYSIUM_PRELAUNCH && typeof __DOMINO_ELYSIUM_OPENING__ === 'object' \? __DOMINO_ELYSIUM_OPENING__ : null/);
});

test('Home\'s Elysium chip in pre-launch: the row\'s own chip, leading to the docs\' Elysium section, never to New position or the old testnet section', () => {
  const landing = read('src/screens/Landing.tsx');
  const chip = landing.slice(landing.indexOf('function ElysiumNext()'), landing.indexOf('function Hero()'));
  assert.match(chip, /<a href=\{docsHref\('what-is-domino', 'elysium'\)\} aria-label=\{`\$\{ELYSIUM_NAME\}, \$\{when\}`\}><NetworkMark network=\{ELYSIUM_NAME\} variant="v4" \/><span>\{ELYSIUM_NAME\}<\/span><span className="dm-hero-when" data-elysium-when=\{dated \? 'dated' : 'next'\}>\{when\}<\/span><\/a>/);
  assert.match(chip, /const when = dated && ELYSIUM_OPENING \? `Opens \$\{ELYSIUM_OPENING\.short\}` : 'Opens next'/);
  assert.doesNotMatch(chip, /#\/new|#\/elysium|onClick|disabled|aria-disabled|role=/);
  // The row: drawn where Elysium is live or in pre-launch; its other chips lead to New position, as live.
  assert.match(landing, /\{\(ELYSIUM_PRELAUNCH \|\| ELYSIUM_LIVE\) && POSITION_ROW\.length > 0 && <div className="dm-hero-funding dm-hero-networks dm-k-up2" role="group" aria-label="Networks to open positions on">/);
  assert.match(landing, /\{ELYSIUM_PRELAUNCH && network === ELYSIUM_NAME \? <ElysiumNext \/> : <a href="\/new"><NetworkMark network=\{network\} variant="v4" \/><span>\{network\}<\/span><\/a>\}/);
  // "Bring funds from" keeps the five: no bridge serves Elysium.
  assert.match(landing, /FUNDING_ROW\.map\(network => <li key=\{network\}><a href="\/#funding">/);
  // The section the chip names exists in the pre-launch docs (tests/docs.test.mjs holds its words).
  assert.match(read('src/lib/docs/pages/introduction.ts'), /\.\.\.\(ELYSIUM_PRELAUNCH \? \[\{\n\s+id: 'elysium',\n\s+title: 'Elysium',/);
});

test('Elysium\'s mark on its white disc, as the owner\'s file is: no rule dims, filters or tints it, and the tag is V4\'s quiet tag', () => {
  const css = SOURCES.filter(({ path }) => path.endsWith('.css')).map(({ path, text }) => ({ path, rules: text.replace(/\/\*[\s\S]*?\*\//g, '').split('}') }));
  const touching = css.flatMap(({ path, rules }) => rules.filter((rule) => /dm-hero-when|data-network="Elysium"|dm-hero-networks/.test(rule)).map((rule) => `${path}: ${rule.trim()}`));
  assert.ok(touching.length >= 2, touching.join('\n'));
  for (const rule of touching) assert.doesNotMatch(rule, /opacity|filter|grayscale|mix-blend|saturate|brightness|text-transform|animation|letter-spacing/, rule);
  const tag = touching.find((rule) => rule.includes('.dm-hero-when'));
  assert.match(tag, /\.dm-home \.dm-hero-networks \.dm-hero-when \{ display: inline-block; margin-left: -0\.125rem; padding: 0\.125rem 0\.4375rem; border-radius: 0\.375rem; background: var\(--v4-w055\); color: var\(--subtle\); font-size: 0\.75rem; line-height: 1\.2; white-space: nowrap;/);
  // The mark is the existing NetworkMark branch: the owner's file, alt="" beside the name, hidden only if it fails to load.
  assert.match(read('src/components/home/HomeCapabilities.tsx'), /<img src=\{ELYSIUM_MARK\} alt="" width=\{20\} height=\{20\} draggable=\{false\} onError=\{\(event\) => \{ event\.currentTarget\.hidden = true \}\} \/>/);
});
