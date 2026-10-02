/**
 * Guard the reviewed deployment boundary without Actions, credentials or an
 * upload. This intentionally checks the small workflow policy literally:
 * changing a trusted trigger or credential scope requires updating its review.
 * Missing-configuration notices run in bash with synthetic values only.
 *
 * Reviewed again 2026-10-01 (audit H9): main runs are no longer cancelled or
 * folded into later ones, each main push being a concurrency group of its own;
 * uploads still go one at a time, an older commit never uploads over a newer
 * one, and a repository variable holds the preview without cancelling a run.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const GROUP = "ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.event_name == 'push' && github.sha || github.ref }}"
const UPLOAD_IF = "env.CLOUDFLARE_API_TOKEN != '' && env.CLOUDFLARE_ACCOUNT_ID != '' && steps.newest.outputs.current == 'true' && vars.GATED_PREVIEW_HOLD != 'true'"

function job(text, id) {
  const jobs = text.slice(text.indexOf('\njobs:\n') + 7)
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'm').exec(jobs)
  assert.ok(match, `missing ${id} job`)
  return match[1]
}

function steps(preview) {
  return preview.split(/^      - /m).slice(1)
}

function field(text, name, indent) {
  const match = new RegExp(`^${' '.repeat(indent)}${name}: (.+)$`, 'm').exec(text)
  assert.ok(match, `missing ${name}`)
  return match[1]
}

function policy(text) {
  const root = text.slice(0, text.indexOf('\njobs:\n'))
  assert.match(root, /^  push:\n    branches: \[main\]$/m)
  assert.match(root, /^  pull_request:$/m)
  assert.match(root, /^  workflow_dispatch:$/m)
  assert.doesNotMatch(root, /pull_request_target|workflow_run|repository_dispatch/)
  assert.match(root, /^permissions:\n  contents: read$/m)
  assert.equal(field(root, 'group', 2), GROUP)
  assert.equal(field(root, 'cancel-in-progress', 2), "${{ github.event_name == 'pull_request' }}")
  const preview = job(text, 'preview')
  assert.equal(field(preview, 'needs', 4), '[hygiene, frontend, read_bridge, frontend_browser, backend, contracts]')
  assert.equal(field(preview, 'if', 4), "github.event_name == 'push' && github.ref == 'refs/heads/main'")
  assert.equal(field(preview, 'group', 6), 'deploy-gated-preview')
  assert.equal(field(preview, 'cancel-in-progress', 6), 'false')
  assert.doesNotMatch(preview, /^    permissions:/m, 'preview inherits the read-only GitHub token')
  assert.doesNotMatch(root + preview, /^\s*queue:/m, 'documented default coalescing must be reviewed if changed')
  assert.match(job(text, 'frontend'), /run: node --test scripts\/preview-workflow\.test\.mjs/)

  const list = steps(preview)
  assert.match(list[0], /^uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1(?:\s|$)/)
  const build = list.findIndex(step => /run: npm --prefix app run release:build/.test(step))
  const newest = list.findIndex(step => /^        id: newest$/m.test(step))
  const upload = list.findIndex(step => /run: npm --prefix app run deploy:preview/.test(step))
  assert.ok(build >= 0 && upload > build, 'record this checkout before upload')
  assert.ok(newest > build && upload > newest, 'whether main has moved on is asked after the build, just before the upload')
  assert.match(list[newest], /newest=\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)/)
  assert.match(list[newest], /if \[ "\$newest" = "\$GITHUB_SHA" \]; then echo "current=true" >> "\$GITHUB_OUTPUT"; else echo "current=false" >> "\$GITHUB_OUTPUT"; fi/)
  assert.equal(field(list[upload], 'if', 8), UPLOAD_IF)
  const notice = list.find(step => step.startsWith('name: Say why nothing was deployed\n'))
  assert.ok(notice)
  assert.equal(field(notice, 'if', 8), "env.CLOUDFLARE_API_TOKEN == '' || env.CLOUDFLARE_ACCOUNT_ID == ''")
  const moved = list.find(step => step.startsWith('name: Say that a newer main commit uploads instead\n'))
  assert.ok(moved)
  assert.equal(field(moved, 'if', 8), "steps.newest.outputs.current != 'true'")
  const held = list.find(step => step.startsWith('name: Say that the preview is held\n'))
  assert.ok(held)
  assert.equal(field(held, 'if', 8), "vars.GATED_PREVIEW_HOLD == 'true'")
  for (const step of list) {
    if (step !== list[upload] && step !== notice) {
      assert.doesNotMatch(step, /CLOUDFLARE_|\$\{\{\s*secrets\./, 'setup/build must have no Cloudflare credentials')
    }
  }
  for (const step of [list[upload], notice]) {
    assert.equal(field(step, 'CLOUDFLARE_API_TOKEN', 10), '${{ secrets.CLOUDFLARE_API_TOKEN }}')
    assert.equal(field(step, 'CLOUDFLARE_ACCOUNT_ID', 10), '${{ vars.CLOUDFLARE_ACCOUNT_ID }}')
  }
  assert.equal((text.match(/secrets\.CLOUDFLARE_API_TOKEN/g) ?? []).length, 2)
  assert.doesNotMatch(text, /secrets\.CLOUDFLARE_ACCOUNT_ID|run:.*(?:run deploy\s*$|pages deploy)/m)
  return notice
}

test('preview has a read-only GitHub token, requires a main push and six checks, and isolates credentials', () => {
  policy(workflow)
})

test('obsolete PR checks can cancel; a main push never cancels or replaces another main run, nor an active preview upload', () => {
  assert.throws(() => policy(workflow.replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true')))
  // One group per ref again: a pending main run would be dropped when a later push arrives.
  assert.throws(() => policy(workflow.replace(GROUP, 'ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}')))
  assert.throws(() => policy(workflow.replace(GROUP, 'ci-${{ github.workflow }}-${{ github.ref }}')))
  assert.throws(() => policy(workflow.replace('      group: deploy-gated-preview\n      cancel-in-progress: false', '      group: deploy-gated-preview\n      cancel-in-progress: true')))
})

test('an older commit never uploads over a newer one, and the hold variable keeps a preview deployed by hand', () => {
  assert.throws(() => policy(workflow.replace(UPLOAD_IF, "env.CLOUDFLARE_API_TOKEN != '' && env.CLOUDFLARE_ACCOUNT_ID != '' && vars.GATED_PREVIEW_HOLD != 'true'")))
  assert.throws(() => policy(workflow.replace(UPLOAD_IF, "env.CLOUDFLARE_API_TOKEN != '' && env.CLOUDFLARE_ACCOUNT_ID != '' && steps.newest.outputs.current == 'true'")))
  assert.throws(() => policy(workflow.replace('name: Say that the preview is held\n', 'name: Say nothing\n')))
})

test('the guard rejects a PR deployment trigger or credentials moved into the build', () => {
  assert.throws(() => policy(workflow.replace("if: github.event_name == 'push' && github.ref == 'refs/heads/main'", 'if: always()')))
  assert.throws(() => policy(workflow.replace('run: npm --prefix app run release:build', 'run: npm --prefix app run release:build\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')))
})

test('missing settings identify secret versus variable without printing either value', () => {
  const notice = policy(workflow)
  const script = notice.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n')
  for (const token of ['', 'synthetic-token-value']) {
    for (const account of ['', 'synthetic-account-value']) {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        encoding: 'utf8', env: { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.includes('CLOUDFLARE_API_TOKEN as a repository secret'), token === '')
      assert.equal(result.stdout.includes('CLOUDFLARE_ACCOUNT_ID as a repository variable'), account === '')
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-token-value|synthetic-account-value/)
    }
  }
})
