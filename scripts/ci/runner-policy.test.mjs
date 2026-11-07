import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

// The broker reads this reviewed v1 allowlist outside every guest. Job names
// are exact expanded Actions display names, never patterns supplied by a PR.
// labels = base_labels + rendered run_label_template + domino-ci-{profile}
//          + job_label. lifetime_seconds bounds VM startup and one job.
// resource_profile selects capacity separately from profile's guest privileges.
const root = fileURLToPath(new URL('../../', import.meta.url));
const policy = JSON.parse(readFileSync(path.join(root, 'scripts/ci/runner-policy.json'), 'utf8'));
const workflows = Object.fromEntries(readdirSync(path.join(root, '.github/workflows')).filter(name => name.endsWith('.yml')).map(name => {
  const file = `.github/workflows/${name}`;
  return [file, readFileSync(path.join(root, file), 'utf8')];
}));
const RUN_LABEL = 'domino-ci-${{ github.run_id }}-${{ github.run_attempt }}';
const PILOT = '.github/workflows/clawber-ci-pilot.yml';
const PUBLIC = '.github/workflows/public-ci.yml';
const PRIVATE_GUARD = "github.repository == 'domino-money/domino' && github.event.repository.private == true";
const RESOURCE_JOBS = {
  light: ['ci-hygiene', 'ci-changes', 'ci-read-worker', 'automation-off', 'execution-inspect', 'pilot-preflight', 'pilot-read-worker'],
  standard: ['ci-frontend', 'ci-preview', 'read-path-release'],
  browser: ['ci-browser-pages', 'ci-browser-finance-create', 'ci-browser-finance-automation', 'ci-browser-finance-positions', 'ci-browser-gate', 'funding', 'pilot-browser-finance-create'],
  heavy: ['ci-backend', 'ci-contracts-v1', 'ci-contracts-v2', 'ci-contracts-v2-audit', 'pilot-contracts-v1', 'pilot-contracts-v2-audit', 'pilot-backend'],
};
const RESOURCE_BY_LABEL = new Map(Object.entries(RESOURCE_JOBS).flatMap(([resource, labels]) => labels.map(label => [`domino-job-${label}`, resource])));

function blocks(text) {
  const jobs = text.slice(text.indexOf('\njobs:\n') + 7);
  return [...jobs.matchAll(/^  ([a-zA-Z_][a-zA-Z0-9_-]*):\n([\s\S]*?)(?=^  [a-zA-Z_][a-zA-Z0-9_-]*:|$(?![\s\S]))/gm)].map(([, id, body]) => ({ id, body }));
}

function field(body, name) {
  return new RegExp(`^    ${name}: (.+)$`, 'm').exec(body)?.[1];
}

function expandedJobs(file, text) {
  return blocks(text).flatMap(({ id, body }) => {
    const condition = field(body, 'if');
    assert.ok(condition === PRIVATE_GUARD || condition?.endsWith(' && ' + PRIVATE_GUARD), `${file}/${id} requires the original private repository`);
    assert.doesNotMatch(condition, /\|\|/, 'an alternative branch cannot bypass the private repository guard');
    const display = field(body, 'name') ?? id;
    const route = field(body, 'runs-on');
    const timeout = field(body, 'timeout-minutes');
    if (file === PILOT && id === 'compare') {
      assert.match(text, /compare_hosted:\n[\s\S]*?type: boolean\n        default: false/);
      assert.match(body, /pool: \$\{\{ fromJSON\(inputs\.compare_hosted && '\["clawber","github-hosted"\]' \|\| '\["clawber"\]'\) \}\}/);
      assert.ok(route.startsWith("${{ matrix.pool == 'github-hosted' && 'ubuntu-24.04' || "), 'hosted control is an explicit pilot leg only');
      const format = /fromJSON\(format\('(\[[^']+\])', github\.run_id, github\.run_attempt, inputs\.workload\)\)/.exec(route);
      assert.ok(format, 'pilot guest routing pins its run, attempt and workload');
      const labels = JSON.parse(format[1]);
      const choices = /^        options: \[([^\]]+)\]$/m.exec(text)[1].split(',').map(s => s.trim());
      return choices.map(workload => ({
        name: `${workload} (clawber)`, body,
        labels: labels.map(label => label.replace('{0}-{1}', '${{ github.run_id }}-${{ github.run_attempt }}').replace('{2}', workload)),
        timeout: workload.startsWith('contracts-') ? 75 : workload === 'backend' ? 40 : workload.startsWith('browser-') ? 25 : 5,
      }));
    }
    assert.match(route ?? '', /^\[self-hosted, /, `${file}/${id} cannot silently return to a hosted default`);
    const labels = route.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    const matrix = /^        (suite|part): \[([^\]]+)\]$/m.exec(body);
    const values = matrix ? matrix[2].split(',').map(s => s.trim()) : [null];
    return values.map(value => {
      const expand = text => matrix ? text.replaceAll('${{ matrix.' + matrix[1] + ' }}', value) : text;
      return { name: expand(display), labels: labels.map(expand), body, timeout: Number(timeout) };
    });
  });
}

function check(input = policy, files = workflows) {
  assert.equal(input.version, 1);
  assert.equal(input.repository, 'domino-money/domino');
  assert.equal(input.repository_id, 1363307729);
  assert.deepEqual(input.base_labels, ['self-hosted', 'Linux', 'X64', 'domino-ci']);
  assert.equal(input.run_label_template, 'domino-ci-{run_id}-{run_attempt}');
  const entries = new Map();
  const labels = new Set();
  for (const job of input.jobs) {
    assert.deepEqual(Object.keys(job).sort(), ['workflow', 'job_name', 'job_label', 'profile', 'resource_profile', 'lifetime_seconds'].sort(), 'v1 fields are explicit');
    assert.ok(['normal', 'systemd', 'deploy'].includes(job.profile));
    assert.ok(Object.hasOwn(RESOURCE_JOBS, job.resource_profile), 'new jobs require a named resource profile; legacy is reserved for active accounting');
    assert.match(job.job_label, /^domino-job-[a-z0-9-]+$/);
    assert.equal(job.resource_profile, RESOURCE_BY_LABEL.get(job.job_label), `reviewed resource class for ${job.job_label}`);
    assert.ok(Number.isInteger(job.lifetime_seconds) && job.lifetime_seconds > 0 && job.lifetime_seconds <= 5400);
    const key = `${job.workflow}:${job.job_name}`;
    assert.ok(!entries.has(key) && !labels.has(job.job_label), 'job display identity and routing label must both be unique');
    entries.set(key, job);
    labels.add(job.job_label);
  }
  let seen = 0;
  for (const [file, text] of Object.entries(files)) {
    assert.doesNotMatch(text, /github\.job/, 'github.job is unavailable when Actions resolves runs-on');
    // The public derivative has one separately checked hosted workflow; it
    // never receives a broker authorization or a self-hosted label.
    if (file === PUBLIC) {
      const jobs = blocks(text);
      assert.deepEqual(jobs.map(job => job.id), ['offline']);
      assert.equal(field(jobs[0].body, 'runs-on'), 'ubuntu-24.04');
      assert.doesNotMatch(text, /self-hosted|secrets\.|id-token:|environment:/);
      continue;
    }
    for (const job of expandedJobs(file, text)) {
      const key = `${file}:${job.name}`;
      const entry = entries.get(key);
      assert.ok(entry, `unmapped job ${key}`);
      assert.deepEqual(job.labels, [...input.base_labels, RUN_LABEL, `domino-ci-${entry.profile}`, entry.job_label], `exact routing for ${key}`);
      assert.ok(entry.lifetime_seconds >= (job.timeout + 5) * 60, `bounded startup headroom for ${key}`);
      if (/secrets\./.test(job.body)) assert.equal(entry.profile, 'deploy', 'credentialed jobs require the isolated deploy profile');
      if (entry.profile === 'deploy') {
        if (file.endsWith('/ci.yml')) {
          assert.equal(field(job.body, 'if'), "github.event_name == 'push' && github.ref == 'refs/heads/main' && " + PRIVATE_GUARD);
        } else {
          assert.doesNotMatch(text.split('\npermissions:')[0], /^  (?:push|pull_request|pull_request_target):/m);
          assert.equal(field(job.body, 'if'), "github.ref == 'refs/heads/main' && " + PRIVATE_GUARD);
        }
      }
      entries.delete(key);
      seen++;
    }
  }
  assert.equal(entries.size, 0, 'no stale or extra broker authorization remains');
  assert.equal(seen, 24, 'every expanded job is represented');
}

test('every workflow job has exact run/attempt, profile and job routing in the reviewed v1 broker policy', () => {
  check();
});

test('routing guard rejects an unlisted job, a hosted default, changed privilege or an overbroad duplicate label', () => {
  assert.throws(() => check({ ...policy, jobs: policy.jobs.slice(1) }), /unmapped job/);
  const ci = '.github/workflows/ci.yml';
  assert.throws(() => check(policy, { ...workflows, [ci]: workflows[ci].replace(/^    runs-on: .+$/m, '    runs-on: ubuntu-24.04') }), /hosted default/);
  assert.throws(() => check({ ...policy, jobs: policy.jobs.map((job, i) => i === 0 ? { ...job, profile: 'normal' } : job) }), /exact routing/);
  assert.throws(() => check({ ...policy, jobs: policy.jobs.map((job, i) => i === 1 ? { ...job, job_label: policy.jobs[0].job_label } : job) }), /both be unique/);
  assert.throws(() => check(policy, { ...workflows, [PILOT]: workflows[PILOT].replace('        default: false', '        default: true') }));
});

test('legacy jobs refuse another repository or public visibility before runner allocation', () => {
  const ci = '.github/workflows/ci.yml';
  for (const replacement of ["github.repository == 'somewhere/else' && github.event.repository.private == true", "github.repository == 'domino-money/domino'", 'true']) {
    assert.throws(() => check(policy, { ...workflows, [ci]: workflows[ci].replace(PRIVATE_GUARD, replacement) }), /requires the original private repository/);
  }
  assert.throws(() => check(policy, { ...workflows, [ci]: workflows[ci].replace(PRIVATE_GUARD, 'true || false && ' + PRIVATE_GUARD) }), /cannot bypass/);
});

test('resource profiles cover every workload independently of privileges and reject missing or changed capacity classes', () => {
  assert.equal(RESOURCE_BY_LABEL.size, 24);
  assert.deepEqual([...new Set(policy.jobs.filter(job => job.profile === 'normal').map(job => job.resource_profile))].sort(), ['browser', 'heavy', 'light', 'standard']);
  for (const resource_profile of ['legacy', 'unknown', 'normal']) {
    const jobs = policy.jobs.map((job, index) => index === 0 ? { ...job, resource_profile } : job);
    assert.throws(() => check({ ...policy, jobs }), /new jobs require a named resource profile/);
  }
  const jobs = policy.jobs.map((job, index) => index === 0 ? { ...job, resource_profile: 'heavy' } : job);
  assert.throws(() => check({ ...policy, jobs }), /reviewed resource class/);
  const missing = policy.jobs.map((job, index) => {
    if (index !== 0) return job;
    const { resource_profile, ...entry } = job;
    return entry;
  });
  assert.throws(() => check({ ...policy, jobs: missing }), /v1 fields are explicit/);
});

test('browser consumers install the lock-selected Chromium and export its exact executable before tests', () => {
  for (const [file, id] of [['.github/workflows/ci.yml', 'frontend'], ['.github/workflows/ci.yml', 'frontend_browser'], ['.github/workflows/funding-ui.yml', 'funding']]) {
    const { body } = blocks(workflows[file]).find(job => job.id === id);
    const install = body.indexOf('node app/node_modules/playwright-core/cli.js install chromium');
    assert.ok(install > body.indexOf('npm --prefix app ci --no-audit --no-fund'));
    assert.match(body, /export PLAYWRIGHT_BROWSERS_PATH="\$RUNNER_TEMP\/domino-browsers"/);
    assert.match(body, /chromium\.executablePath\(\)/);
    assert.match(body, /DOMINO_BROWSER_PATH=%s\\n/);
    const testAt = body.search(/(?:run: npm --prefix app test|run: npm --prefix app run test:|run: node --test --test-force-exit tests\/v2in-browser)/);
    assert.ok(testAt > install, `${file}/${id} installs its browser before tests`);
  }
});
