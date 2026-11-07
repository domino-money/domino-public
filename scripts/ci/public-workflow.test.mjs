import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/public-ci.yml', import.meta.url), 'utf8');

function check(text) {
  const root = text.slice(0, text.indexOf('\njobs:\n'));
  assert.match(root, /^  push:\n    branches: \[main\]$/m);
  assert.match(root, /^  pull_request:$/m);
  assert.match(root, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(text, /pull_request_target|workflow_run|repository_dispatch|self-hosted|secrets\.|id-token:|environment:/);
  assert.match(root, /^permissions:\n  contents: read$/m);
  assert.equal((text.match(/^\s*permissions:/gm) ?? []).length, 1);
  assert.doesNotMatch(text, /^\s+(?:[a-z-]+:\s*write|write-all|sudo\b|uses:\s*\.\/)/m);
  const jobs = text.slice(text.indexOf('\njobs:\n') + 7);
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]), ['offline']);
  assert.match(jobs, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(jobs, /^    timeout-minutes: 10$/m);
  // Keep the action set small and pinned; dependency installation and runtime
  // downloads are limited to the reviewed setup actions.
  assert.deepEqual([...text.matchAll(/^      - uses: ([^\s]+) /gm)].map(match => match[1]), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97',
  ]);
  assert.match(text, /uses: actions\/checkout@[^\n]+\n        with:\n          persist-credentials: false\n/);
  assert.doesNotMatch(text, /npm\b|pip install|\bcurl\b|\bwget\b|\bgh\b|run:\s*(?:sudo|bash.*https?:)|run:.*(?:deploy|publish-read-path\.mjs)/);
  assert.match(text, /run: python3 scripts\/check-repository\.py/);
  assert.match(text, /node --test scripts\/ci\/\*\.test\.mjs/);
  assert.match(text, /python3 -B -m unittest discover -s scripts\/ci/);
  assert.match(text, /node scripts\/check-contract-hygiene\.mjs/);
}

test('public PR checks use hosted compute, a read-only token and no deployment credentials', () => {
  check(workflow);
});

test('public policy rejects privileged triggers, runners, token writes and persisted checkout credentials', () => {
  for (const [before, after] of [
    ['  pull_request:', '  pull_request_target:'],
    ['runs-on: ubuntu-24.04', 'runs-on: [self-hosted, Linux]'],
    ['contents: read', 'contents: write'],
    ['persist-credentials: false', 'persist-credentials: true'],
    ['actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', 'actions/setup-node@main'],
    ['run: python3 scripts/check-repository.py', 'run: npm --prefix app run deploy'],
  ]) assert.throws(() => check(workflow.replace(before, after)));
  assert.throws(() => check(workflow + '        env:\n          TOKEN: ${{ secrets.PRODUCTION_TOKEN }}\n'));
});
