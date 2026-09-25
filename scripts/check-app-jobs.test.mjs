/**
 * CI runs `npm run check:app` in parts: its steps up to the build in the
 * frontend job, and each browser suite in a frontend_browser job of its own,
 * side by side, since one job outgrew its time limit twice. A part that no job
 * runs would pass CI unnoticed, so this holds the jobs to check:app literally:
 * every command check:app chains is a step of the frontend job or a suite of
 * the frontend_browser matrix, and every suite of the matrix is in check:app.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const checkApp = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts['check:app']

function job(text, id) {
  const jobs = text.slice(text.indexOf('\njobs:\n') + 7)
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'm').exec(jobs)
  assert.ok(match, `missing ${id} job`)
  return match[1]
}

/** The commands a job's one-line `run:` steps chain, one per matrix suite where a step names it. */
function commands(body) {
  const suites = /^        suite: \[(.+)\]$/m.exec(body)?.[1].split(',').map(suite => suite.trim()) ?? []
  const ran = []
  for (const [, run] of body.matchAll(/^ +(?:- )?run: (.+)$/gm)) {
    for (const command of run.split('&&').map(part => part.trim())) {
      if (command.includes('${{ matrix.suite }}')) ran.push(...suites.map(suite => command.replace('${{ matrix.suite }}', suite)))
      else ran.push(command)
    }
  }
  return { suites, ran }
}

function check(text, script) {
  const parts = script.split('&&').map(part => part.trim())
  const frontend = commands(job(text, 'frontend'))
  const browser = commands(job(text, 'frontend_browser'))
  for (const part of parts) {
    assert.ok([...frontend.ran, ...browser.ran].includes(part), `no frontend job runs ${part}`)
  }
  for (const suite of browser.suites) {
    assert.ok(parts.includes(`npm --prefix app run test:${suite}`), `check:app does not run test:${suite}`)
  }
}

test('the frontend jobs run every part of check:app, and check:app every browser suite they run', () => {
  check(workflow, checkApp)
})

test('the guard notices a part dropped from the jobs, or a suite added on one side only', () => {
  assert.throws(() => check(workflow.replace('suite: [render, finance, gate]', 'suite: [render, gate]'), checkApp), /test:finance/)
  assert.throws(() => check(workflow.replace('      - run: npm --prefix app run lint\n', ''), checkApp), /run lint/)
  assert.throws(() => check(workflow, `${checkApp} && npm --prefix app run test:local-live`), /test:local-live/)
  assert.throws(() => check(workflow.replace('suite: [render, finance, gate]', 'suite: [render, finance, gate, read]'), checkApp), /test:read/)
})
