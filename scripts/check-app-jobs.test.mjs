/**
 * CI runs `npm run check:app` in parts: its steps up to the build in the
 * frontend job, and its browser suites in frontend_browser jobs of their own,
 * side by side, since one job outgrew its time limit twice. A part that no job
 * runs would pass CI unnoticed, so this holds the jobs to check:app. Both sides
 * expand through the package scripts to the commands that do the work: each
 * one check:app runs must be run by a frontend job, and each suite of the
 * frontend_browser matrix must be part of check:app.
 *
 * The split lives in app/package.json (test:render is test:pages, then
 * test:finance): contracts/release-artifacts.json pins the root package.json
 * as a compiler build input, so check:app itself stays as it is.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const workflow = read('../.github/workflows/ci.yml')
const packages = { root: JSON.parse(read('../package.json')).scripts, app: JSON.parse(read('../app/package.json')).scripts }

function job(text, id) {
  const jobs = text.slice(text.indexOf('\njobs:\n') + 7)
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'm').exec(jobs)
  assert.ok(match, `missing ${id} job`)
  return match[1]
}

/** The commands `command` runs: `npm run x` expands in its own package, `npm --prefix app` in app/. */
function leaves(command, scripts, app) {
  const npm = /^npm (?:--prefix (\S+) )?(?:run (\S+)|(test))$/.exec(command)
  if (!npm || (npm[1] !== undefined && npm[1] !== 'app')) return [command]
  const where = npm[1] === 'app' ? app : scripts
  const script = where[npm[2] ?? npm[3]]
  assert.ok(script !== undefined, `no script behind ${command}`)
  return script.split('&&').flatMap(part => leaves(part.trim(), where, app))
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

function check(text, { root, app } = packages) {
  const expand = command => leaves(command, root, app)
  const wanted = expand('npm run check:app')
  const frontend = commands(job(text, 'frontend'))
  const browser = commands(job(text, 'frontend_browser'))
  const ran = [...frontend.ran, ...browser.ran].flatMap(expand)
  for (const command of wanted) assert.ok(ran.includes(command), `no frontend job runs ${command}`)
  for (const suite of browser.suites) {
    for (const command of expand(`npm --prefix app run test:${suite}`)) {
      assert.ok(wanted.includes(command), `check:app does not run ${command} (test:${suite})`)
    }
  }
}

test('the frontend jobs run everything check:app runs, and check:app every browser suite they run', () => {
  check(workflow)
})

test('the guard notices a part dropped from the jobs, or a suite added on one side only', () => {
  const { root, app } = packages
  assert.throws(() => check(workflow.replace('suite: [pages, finance, gate]', 'suite: [pages, gate]')), /finance\.browser/)
  assert.throws(() => check(workflow.replace('      - run: npm --prefix app run lint\n', '')), /oxlint/)
  assert.throws(() => check(workflow, { root: { ...root, 'check:app': `${root['check:app']} && npm --prefix app run test:local-live` }, app }), /local-live/)
  assert.throws(() => check(workflow, { root, app: { ...app, 'test:render': `${app['test:render']} && npm run test:local-live` } }), /local-live/)
  assert.throws(() => check(workflow.replace('suite: [pages, finance, gate]', 'suite: [pages, finance, gate, local-live]')), /test:local-live/)
  assert.throws(() => check(workflow.replace('suite: [pages, finance, gate]', 'suite: [pages, finanse, gate]')), /no script behind npm --prefix app run test:finanse/)
})
