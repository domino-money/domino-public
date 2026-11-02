import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = readFileSync(path.join(root, '.github/workflows/clawber-ci-pilot.yml'), 'utf8');
const script = path.join(root, 'scripts/ci/run-pilot-workload.sh');

test('the pilot defaults to Clawber, with an explicit hosted control, and uses the same source and runtime identities', () => {
  const triggers = workflow.split('\non:\n')[1].split('\npermissions:')[0];
  assert.match(triggers, /^  workflow_dispatch:/m);
  assert.doesNotMatch(triggers, /^  (?:push|pull_request|pull_request_target|workflow_run|schedule):/m);
  assert.doesNotMatch(triggers, /source_sha|branch|repository|ref:/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /compare:[\s\S]*needs: trusted_main/);
  assert.equal((workflow.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []).length, 2);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(triggers, /compare_hosted:\n[\s\S]*?type: boolean\n        default: false/);
  assert.match(workflow, /pool: \$\{\{ fromJSON\(inputs\.compare_hosted && '\["clawber","github-hosted"\]' \|\| '\["clawber"\]'\) \}\}/);
  assert.match(workflow, /matrix\.pool == 'github-hosted' && 'ubuntu-24\.04'/);
  assert.match(workflow, /runs-on: \[self-hosted, Linux, X64, domino-ci, "domino-ci-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}", domino-ci-normal, "domino-job-pilot-preflight"\]/);
  assert.match(workflow, /"self-hosted","Linux","X64","domino-ci","domino-ci-\{0\}-\{1\}","domino-ci-normal","domino-job-pilot-\{2\}"/);
  assert.match(workflow, /github\.run_id, github\.run_attempt, inputs\.workload\)\)/);
  assert.match(workflow, /fail-fast: false/);
  assert.doesNotMatch(workflow, /secrets\.|id-token:|environment:|pull_request_target/);
  assert.match(workflow, /node-version: \$\{\{ needs\.trusted_main\.outputs\.node_version \}\}/);
  assert.match(workflow, /python-version: \$\{\{ needs\.trusted_main\.outputs\.python_version \}\}/);
  for (const match of workflow.matchAll(/key: (.+)/g)) {
    assert.match(match[1], /runner\.os/);
    assert.match(match[1], /runner\.arch/);
    assert.match(match[1], /matrix\.pool/);
    assert.match(match[1], /package-lock\.json/);
    assert.match(match[1], /solc-compile\.cjs/);
  }
  assert.doesNotMatch(workflow, /restore-keys:/);
  assert.match(workflow, /run-pilot-workload\.sh "\$WORKLOAD" prepare/);
  assert.match(workflow, /run-pilot-workload\.sh "\$WORKLOAD" run/);
  assert.doesNotMatch(workflow, /^\s*(?:run:\s*)?(?:sudo|npm .*(?:deploy:preview| run deploy))\b/m);
});

function rig(t, status = 0) {
  const dir = mkdtempSync(path.join(tmpdir(), 'domino-pilot-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const calls = path.join(dir, 'calls');
  // No repository command is executed: this stub is the entire test workload.
  writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PILOT_TEST_CALLS"\nsleep 0.03\nexit ${status}\n`, { mode: 0o755 });
  const metrics = path.join(dir, 'metrics.jsonl');
  const summary = path.join(dir, 'summary.md');
  return {
    calls, metrics, summary,
    run: (...args) => spawnSync('bash', [script, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PILOT_TEST_CALLS: calls, DOMINO_PILOT_TIMINGS: metrics, GITHUB_STEP_SUMMARY: summary } }),
  };
}

test('a failed workload keeps its nonzero status and measured duration for both environments', t => {
  const r = rig(t, 17);
  const run = r.run('read-worker', 'run');
  assert.equal(run.status, 17, run.stderr);
  assert.equal(readFileSync(r.calls, 'utf8').trim(), 'run check:read-bridge');
  const rows = readFileSync(r.metrics, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 17);
  assert.equal(rows[0].workload, 'read-worker');
  assert.ok(rows[0].durationMs >= 20 && rows[0].durationMs < 10_000, JSON.stringify(rows[0]));
  assert.match(readFileSync(r.summary, 'utf8'), /\| read-worker \| read-worker \| 17 \|/);
});

test('unknown workload or phase is refused before invoking an installer or test command', t => {
  const r = rig(t);
  assert.equal(r.run('read-worker;echo injected', 'run').status, 64);
  assert.equal(r.run('read-worker', 'deploy').status, 64);
  assert.equal(r.run('read-worker', 'prepare').status, 0);
  const run = r.run('read-worker', 'run');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(r.calls, 'utf8').trim(), 'run check:read-bridge');
});
