import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {after, before, test} from 'node:test';

// Use the existing app toolchain; this contract adds no runtime dependency.
const require = createRequire(new URL('../../app/package.json', import.meta.url));
const {chromium} = require('playwright-core');
const read = name => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), 'utf8'));
const moduleUrl = 'data:text/javascript;base64,' + fs.readFileSync(new URL('runtime.mjs', import.meta.url)).toString('base64');
let browser, context, page;
const errors = [];

before(async () => {
  const launches = process.env.DOMINO_BROWSER_PATH ? [{executablePath: process.env.DOMINO_BROWSER_PATH}]
    : [{channel: 'chrome'}, {channel: 'chromium'}, {channel: 'msedge'}, {}];
  for (const launch of launches) {
    try { browser = await chromium.launch(launch); break; } catch { /* try the next installed browser */ }
  }
  if (!browser) throw new Error('No Chromium build could be launched. Set DOMINO_BROWSER_PATH.');
  context = await browser.newContext();
  await context.route(/^https?:\/\//u, route => route.abort());
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank');
});

after(async () => {
  try { await context?.close(); } finally { await browser?.close(); }
  assert.deepEqual(errors, []);
});

test('real browser matches the shared response/request corpus without network or mutation', async () => {
  const responses = read('fixtures/index.json').fixtures.map(entry => ({...entry, payload: read(entry.file)}));
  const requests = read('fixtures/request-boundaries.json');
  const actual = await page.evaluate(async ({moduleUrl, responses, requests}) => {
    const runtime = await import(moduleUrl);
    window.fetch = () => { throw new Error('validator attempted network'); };
    return [...responses.map(entry => {
      const before = JSON.stringify(entry.payload);
      return {name: entry.file, valid: runtime.validateResponse(entry.route, entry.payload), unchanged: before === JSON.stringify(entry.payload)};
    }), ...requests.map(entry => {
      const before = JSON.stringify(entry.payload);
      return {name: entry.name, valid: runtime.validateRequest(entry.route, entry.payload), unchanged: before === JSON.stringify(entry.payload)};
    })];
  }, {moduleUrl, responses, requests});
  const expected = [...responses.map(entry => ({name: entry.file, valid: entry.valid, unchanged: true})),
    ...requests.map(entry => ({name: entry.name, valid: entry.valid, unchanged: true}))];
  assert.deepEqual(actual, expected);
});
