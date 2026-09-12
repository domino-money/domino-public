import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright-core'
import { createGuardedVite } from '../scripts/local-live-vite.mjs'

async function unusedPort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise((done) => server.close(done))
  return port
}
test('real Vite HMR connects through the admission gate; UI is read-only and reload works', { timeout: 60000 }, async () => {
  const port = await unusedPort()
  let admitted = 0
  const shell = await createGuardedVite({ port, handleRead: async (_req, res) => { admitted++; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"bridge_unavailable"}') } })
  let browser
  try {
    browser = await chromium.launch(process.env.DOMINO_BROWSER_PATH ? { executablePath: process.env.DOMINO_BROWSER_PATH, headless: true } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const connected = new Promise((done) => shell.vite.ws.on('connection', done))
    await page.goto(`${shell.origin}/#/pools`)
    await page.getByRole('heading', { name: 'Explore pools', exact: true }).waitFor()
    await page.getByText('Local real-data development', { exact: true }).waitFor()
    await connected
    assert.equal(await page.getByRole('button', { name: 'Connect wallet', exact: true }).isDisabled(), true)
    assert.equal(admitted, 0, 'opening pool explorer does not issue reads')
    const status = await page.evaluate(async () => (await fetch('/api/read/v1/capabilities')).status)
    assert.equal(status, 503)
    assert.equal(admitted, 1, 'same-origin actual browser GET reaches the handler')
    const result = await page.evaluate(async () => (await fetch('/api/read/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status)
    assert.equal(result, 503)
    assert.equal(admitted, 2, 'actual browser POST Origin passes')
    const navigation = page.waitForEvent('load')
    shell.vite.ws.send({ type: 'full-reload', path: '*' })
    await navigation
    await page.getByText('Local real-data development', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    assert.equal((await fetch(shell.origin)).status, 403, 'missing Fetch Metadata is refused before Vite')
    assert.equal((await fetch(`${shell.origin}/api/read/v1/capabilities`)).status, 403)
    assert.equal(admitted, 2)
    const privateDir = mkdtempSync(join(tmpdir(), 'domino-vite-canary-'))
    const canary = 'OFFLINE-NOT-A-CREDENTIAL-132'
    const privateFile = join(privateDir, 'renamed-private-canary.txt')
    const alias = resolve(import.meta.dirname, '../public/.local-live-canary-link')
    writeFileSync(privateFile, canary)
    try {
      // Created after the server is running: a startup-only scan would miss it.
      symlinkSync(privateDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
      for (const path of ['/.local-live-canary-link/renamed-private-canary.txt', `/@fs/${privateFile.replaceAll('\\', '/')}`, `/@fs/${encodeURIComponent(privateFile.replaceAll('\\', '/'))}`, '/scripts/setup-local-live.ps1', '/scripts/check-local-live-acl.ps1', '/scripts/local-live-credentials.mjs']) {
        const check = await page.evaluate(async (url) => { const res = await fetch(url); return { status: res.status, text: await res.text() } }, path)
        assert.equal(check.status, 403, path)
        assert.equal(check.text.includes(canary), false)
      }
    } finally { try { unlinkSync(alias) } finally { rmSync(privateDir, { recursive: true, force: true }) } }
    await assert.rejects(createGuardedVite({ port, handleRead: async () => {} }), /port may already be occupied/)
  } finally { await browser?.close(); await shell.close() }
})
