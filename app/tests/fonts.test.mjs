/**
 * The site's fonts are its own files, and they are Google's (speed wave, item 35, 2026-09-28).
 *
 * Until 2026-09-28 index.html linked Google Fonts' stylesheet, a cross-origin stylesheet in <head> that held back the
 * app's script until it arrived. The same three families are now served from this site: src/styles/fonts.css is the
 * stylesheet Google served for that link (kept as tests/support/google-fonts-2026-09-28.css) with each url() pointed at
 * the same file in src/fonts/, byte for byte (src/fonts/PROVENANCE.md). Same files, same @font-face
 * rules: the pages render as they did. tests/render.test.mjs checks the built site; tests/gate.test.mjs the CSP.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const APP = resolve(import.meta.dirname, '..');
const STYLES = join(APP, 'src/styles');
const FONTS = join(APP, 'src/fonts');
const GOOGLE = readFileSync(join(APP, 'tests/support/google-fonts-2026-09-28.css'), 'utf8');
const LOCAL = readFileSync(join(STYLES, 'fonts.css'), 'utf8');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** PROVENANCE.md's table: each local file, its size, the gstatic URL it came from and its SHA-256. */
function provenance() {
  const rows = [...readFileSync(join(FONTS, 'PROVENANCE.md'), 'utf8').matchAll(/^\| `([\w.-]+\.woff2)` \| ([\d,]+) \| `(https:\/\/fonts\.gstatic\.com\/s\/[^`]+)` \| `([0-9a-f]{64})` \|$/gm)];
  return rows.map(([, file, bytes, source, hash]) => ({ file, bytes: Number(bytes.replaceAll(',', '')), source, hash }));
}

test('every font file is Google’s, byte for byte, and each is recorded once', () => {
  const rows = provenance();
  assert.equal(rows.length, 15, 'Geist (5 scripts), Geist Mono (6) and Instrument Serif (2 scripts, regular and italic)');
  assert.equal(new Set(rows.map((row) => row.file)).size, rows.length);
  assert.equal(new Set(rows.map((row) => row.source)).size, rows.length);
  const files = readdirSync(FONTS).filter((name) => name !== 'PROVENANCE.md').sort();
  assert.deepEqual(files, rows.map((row) => row.file).sort(), 'no file that is not recorded, none missing');
  for (const row of rows) {
    const bytes = readFileSync(join(FONTS, row.file));
    assert.equal(bytes.length, row.bytes, row.file);
    assert.equal(sha256(bytes), row.hash, row.file);
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${row.file} is a woff2 file`);
    // A file under 4 KiB would be inlined as a data: URL by a build without the rule in vite.config.ts; none is.
    assert.ok(statSync(join(FONTS, row.file)).size > 4096, row.file);
  }
});

test('fonts.css is Google’s stylesheet with each url() pointed at the same file here, and nothing else changed', () => {
  const rows = provenance();
  // The stylesheet as Google served it, with each gstatic URL replaced by its local file.
  let expected = GOOGLE;
  for (const row of rows) {
    assert.ok(expected.includes(`url(${row.source})`), `Google's stylesheet names ${row.source}`);
    expected = expected.replaceAll(`url(${row.source})`, `url('../fonts/${row.file}')`);
  }
  assert.doesNotMatch(expected, /gstatic|googleapis/, 'every file Google’s stylesheet names is here');
  // fonts.css is one comment, a blank line, then exactly that.
  const body = LOCAL.replace(/^\/\*[\s\S]*?\*\/\n\n/, '');
  assert.notEqual(body, LOCAL, 'fonts.css opens with its comment');
  assert.equal(body, expected);
  // What the rules declare: the three families, the weights index.html asked for, and Instrument Serif's italic.
  const faces = [...LOCAL.matchAll(/@font-face \{\n {2}font-family: '([^']+)';\n {2}font-style: (\w+);\n {2}font-weight: (\d+);\n {2}font-display: swap;\n/g)].map(([, family, style, weight]) => `${family} ${style} ${weight}`);
  assert.equal(faces.length, (body.match(/@font-face/g) ?? []).length, 'every rule has the same four descriptors, in order');
  assert.deepEqual([...new Set(faces)].sort(), ['Geist Mono normal 400', 'Geist Mono normal 500', 'Geist normal 400', 'Geist normal 500', 'Geist normal 600', 'Geist normal 650', 'Instrument Serif italic 400', 'Instrument Serif normal 400']);
});

test('the pages link no font or stylesheet from another host, and the app’s stylesheet carries the fonts', () => {
  for (const page of ['index.html', 'read-lab.html']) {
    const html = readFileSync(join(APP, page), 'utf8');
    assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/, page);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/, `${page} links nothing from another host`);
  }
  const tokens = readFileSync(join(STYLES, 'tokens.css'), 'utf8');
  // A cascade-order declaration may precede imports; no style block or unrelated import may delay the local fonts.
  assert.match(tokens, /^(?:@layer [\w-]+(?:,\s*[\w-]+)*;\r?\n)?@import 'tailwindcss';\r?\n@import '\.\/fonts\.css';/, 'tokens.css imports the local fonts immediately after Tailwind, allowing only a layer-order prelude');
  const config = readFileSync(join(APP, 'vite.config.ts'), 'utf8');
  assert.match(config, /assetsInlineLimit: \(file: string\) => \(file\.endsWith\('\.woff2'\) \? false : undefined\)/, 'a font is never inlined as a data: URL, which the CSP refuses');
});

// 2026-10-01 (platform workstream, I5): the access page, which the gate serves before any cookie, loads its two fonts
// from this site too, never from Google: public/__beta/fonts/ holds the same files as src/fonts/, byte for byte, and the
// gate serves exactly those two without the cookie (functions/_lib/gate.ts GATE_FONTS, tests/gate.test.mjs).
test('the access page’s two fonts are src/fonts/’s own files, byte for byte, and nothing else is there', () => {
  const gateFonts = join(APP, 'public/__beta/fonts');
  assert.deepEqual(readdirSync(gateFonts).sort(), ['geist-latin.woff2', 'instrument-serif-latin.woff2']);
  for (const file of readdirSync(gateFonts)) assert.equal(sha256(readFileSync(join(gateFonts, file))), sha256(readFileSync(join(FONTS, file))), file);
  const gate = readFileSync(join(APP, 'functions/_lib/gate.ts'), 'utf8');
  assert.doesNotMatch(gate, /fonts\.googleapis\.com|fonts\.gstatic\.com/, 'the access page names no Google host');
  assert.match(gate, /export const GATE_FONTS = Object\.freeze\(\['\/__beta\/fonts\/geist-latin\.woff2', '\/__beta\/fonts\/instrument-serif-latin\.woff2'\]\)/);
});
