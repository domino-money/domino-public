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
 *
 * 2026-10-01 (audit H2): a `node --test` command counts file by file, since a
 * job may run some of the files of one check:app command (test:finance runs
 * every finance file, each finance-* job some of them). finance.browser.test.mjs
 * itself runs in parts (app/tests/support/parts.mjs): every part it names has
 * its entry file, which check:app runs, and the suite never runs whole beside
 * them.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const workflow = read('../.github/workflows/ci.yml')
const packages = { root: JSON.parse(read('../package.json')).scripts, app: JSON.parse(read('../app/package.json')).scripts }
const SUITE = 'tests/finance.browser.test.mjs'
const suite = read(`../app/${SUITE}`)
const ENTRY = /^finance-([a-z]+)\.browser\.test\.mjs$/
const entries = Object.fromEntries(readdirSync(new URL('../app/tests/', import.meta.url)).filter(name => ENTRY.test(name)).map(name => [`tests/${name}`, read(`../app/tests/${name}`)]))

function job(text, id) {
  const jobs = text.slice(text.indexOf('\njobs:\n') + 7)
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'm').exec(jobs)
  assert.ok(match, `missing ${id} job`)
  return match[1]
}

/** A `node --test` command as one command per file it runs, with its flags; any other command as it is. */
function perFile(command) {
  const words = command.split(/\s+/)
  if (words[0] !== 'node' || words[1] !== '--test') return [command]
  const flags = words.slice(1).filter(word => word.startsWith('--'))
  return words.slice(1).filter(word => !word.startsWith('--')).map(file => ['node', ...flags, file].join(' '))
}

/** The commands `command` runs: `npm run x` expands in its own package, `npm --prefix app` in app/. */
function leaves(command, scripts, app) {
  const npm = /^npm (?:--prefix (\S+) )?(?:run (\S+)|(test))$/.exec(command)
  if (!npm || (npm[1] !== undefined && npm[1] !== 'app')) return perFile(command)
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

/** The parts the finance suite names, each held to an entry file that runs it and that check:app runs. */
function checkParts(source = suite, files = entries, { root, app } = packages) {
  const wanted = leaves('npm run check:app', root, app)
  const parts = [...new Set([...source.matchAll(/^part\('([a-z]+)'\);$/gm)].map(match => match[1]))]
  assert.ok(parts.length > 1, 'the suite names its parts')
  for (const name of parts) {
    const entry = `tests/finance-${name}.browser.test.mjs`
    assert.match(files[entry] ?? '', new RegExp(`^await runPart\\('${name}', \\(\\) => import\\('\\./finance\\.browser\\.test\\.mjs'\\)\\);$`, 'm'), `${entry} runs part ${name}`)
    assert.ok(wanted.some(command => command.endsWith(` ${entry}`)), `check:app does not run ${entry}`)
  }
  for (const entry of Object.keys(files)) assert.ok(parts.includes(ENTRY.exec(entry.slice('tests/'.length))[1]), `${entry} runs a part the suite does not name`)
  assert.ok(!wanted.some(command => command.endsWith(` ${SUITE}`)), 'the suite runs through its parts, never also whole')
}

test('the frontend jobs run everything check:app runs, and check:app every browser suite they run', () => {
  check(workflow)
})

test('the guard notices a part dropped from the jobs, or a suite added on one side only', () => {
  const { root, app } = packages
  const matrix = 'suite: [pages, finance-create, finance-automation, finance-positions, gate]'
  assert.ok(workflow.includes(matrix))
  assert.throws(() => check(workflow.replace(matrix, 'suite: [pages, finance-create, finance-automation, gate]')), /finance-positions\.browser/)
  assert.throws(() => check(workflow.replace('      - run: npm --prefix app run lint\n', '')), /oxlint/)
  assert.throws(() => check(workflow, { root: { ...root, 'check:app': `${root['check:app']} && npm --prefix app run test:local-live` }, app }), /local-live/)
  assert.throws(() => check(workflow, { root, app: { ...app, 'test:render': `${app['test:render']} && npm run test:local-live` } }), /local-live/)
  assert.throws(() => check(workflow.replace(matrix, matrix.replace(']', ', local-live]'))), /test:local-live/)
  assert.throws(() => check(workflow.replace(matrix, matrix.replace('finance-create', 'finance-creat'))), /no script behind npm --prefix app run test:finance-creat/)
  // A file a finance job runs that test:finance does not, and the reverse, file by file.
  assert.throws(() => check(workflow, { root, app: { ...app, 'test:finance-positions': `${app['test:finance-positions']} tests/extra.browser.test.mjs` } }), /check:app does not run node --test --test-force-exit tests\/extra\.browser\.test\.mjs/)
  assert.throws(() => check(workflow, { root, app: { ...app, 'test:finance': `${app['test:finance']} tests/extra.browser.test.mjs` } }), /no frontend job runs node --test --test-force-exit tests\/extra\.browser\.test\.mjs/)
})

test('every part of the finance suite has its entry file, which check:app runs, and the suite never runs whole too', () => {
  checkParts()
})

test('the parts guard notices a part with no entry, an entry check:app skips, and the suite run whole beside its parts', () => {
  const { root, app } = packages
  assert.throws(() => checkParts(`${suite}\npart('extra');\n`), /tests\/finance-extra\.browser\.test\.mjs runs part extra/)
  assert.throws(() => checkParts(suite, entries, { root, app: { ...app, 'test:finance': app['test:finance'].replace(' tests/finance-positions.browser.test.mjs', '') } }), /check:app does not run tests\/finance-positions\.browser\.test\.mjs/)
  assert.throws(() => checkParts(suite, entries, { root, app: { ...app, 'test:finance': `${app['test:finance']} ${SUITE}` } }), /never also whole/)
  assert.throws(() => checkParts(suite, { ...entries, 'tests/finance-other.browser.test.mjs': "await runPart('other', () => import('./finance.browser.test.mjs'));\n" }), /runs a part the suite does not name/)
})

test('a browser job warns at 80% of the time limit it has', () => {
  const body = job(workflow, 'frontend_browser')
  const limit = /^    timeout-minutes: (\d+)$/m.exec(body)?.[1]
  assert.ok(limit, 'frontend_browser has a time limit')
  assert.equal(/^          LIMIT_MINUTES: (\d+)$/m.exec(body)?.[1], limit, 'the warning reads the limit the job has')
  assert.match(body, /if \[ \$\(\( used \* 100 \)\) -gt \$\(\( LIMIT_MINUTES \* 60 \* 80 \)\) \]; then/)
})
