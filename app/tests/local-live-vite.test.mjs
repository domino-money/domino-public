import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright-core'
import { closeBrowser } from './support/close-browser.mjs'
import { createGuardedVite } from '../scripts/local-live-vite.mjs'
import { installWallets } from './support/mock-wallet.mjs'

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
  const apiPaths = []
  const shell = await createGuardedVite({ port, handleRead: async (req, res) => { admitted++; apiPaths.push(req.url); res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"bridge_unavailable"}') } })
  let browser
  try {
    browser = await chromium.launch(process.env.DOMINO_BROWSER_PATH ? { executablePath: process.env.DOMINO_BROWSER_PATH, headless: true } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true })
    const context = await browser.newContext()
    const wallets = await installWallets(context, [
      { id: 'a', name: 'Rabby Wallet', rdns: 'io.rabby', uuid: '8f2a7d1c-0000-4000-8000-00000000000a' },
      { id: 'b', name: 'Second Wallet', rdns: 'io.rabby', uuid: '8f2a7d1c-0000-4000-8000-00000000000b' },
    ])
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const connected = new Promise((done) => shell.vite.ws.on('connection', done))
    // The docs, not Markets or Positions: Markets shows the selected pools and
    // asks for them on mount, and Positions reads a connected wallet's public
    // token balances by design (DESIGN.md E.5), while the docs read nothing, so
    // every request counted below is the wallet flow's own, or the two probes.
    // (Changed on purpose, 2026-09-27: this was Settings, which the owner removed.)
    await page.goto(`${shell.origin}/#/docs`)
    await page.getByRole('heading', { name: 'Docs', exact: true }).waitFor()
    await page.getByText('Local real-data development', { exact: true }).waitFor()
    await connected
    const connect = page.getByRole('button', { name: 'Connect wallet', exact: true })
    await connect.click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Connect Rabby Wallet', exact: true }).waitFor()
    assert.equal(await dialog.locator('img[src="/wallets/rabby.svg"]').count(), 2)
    assert.equal(await dialog.locator('img[src^="data:"]').count(), 0)
    await page.keyboard.press('Shift+Tab')
    assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true)
    // The current injected connector obtains account permission first, then
    // reads eth_accounts. Reject the actual permission prompt, not an unused
    // eth_requestAccounts fallback which would let this connection succeed.
    wallets.rejectNext('b', 'wallet_requestPermissions')
    await dialog.getByRole('button', { name: 'Connect Second Wallet', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: 'declined' }).waitFor()
    await dialog.getByRole('button', { name: 'Connect Second Wallet', exact: true }).click()
    await dialog.getByText('Connected · Not signed in', { exact: true }).waitFor()
    assert.equal(wallets.calls('wallet_requestPermissions').filter((call) => call.id === 'a').length, 0, 'same-rdns selection uses the selected connector instance')
    assert.equal(wallets.calls('wallet_requestPermissions').filter((call) => call.id === 'b').length, 2, 'only the selected wallet receives both explicit permission attempts')
    assert.equal(await dialog.getByTestId('local-wallet-address').textContent(), wallets.address(0))
    await wallets.switchAccount('b', 1)
    await page.waitForFunction((address) => document.querySelector('[data-testid="local-wallet-address"]')?.textContent === address, wallets.address(1))
    await wallets.switchChain('b', 1)
    await dialog.getByText('Wallet network: 1. Public reads remain on Robinhood Chain.').waitFor()
    await page.keyboard.press('Escape')
    const connectedWallet = page.getByRole('button', { name: /^Connected wallet / })
    assert.equal(await connectedWallet.evaluate((node) => node === document.activeElement), true)
    await connectedWallet.click()
    await dialog.getByRole('button', { name: 'Disconnect wallet', exact: true }).click()
    await dialog.getByRole('heading', { name: 'Connect', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(wallets.calls('personal_sign').length, 0)
    assert.equal(wallets.calls('wallet_switchEthereumChain').length, 0)
    assert.deepEqual(wallets.state.refused, [])
    assert.equal(admitted, 0, 'opening the docs and the wallet dialog does not issue reads')
    assert.deepEqual(apiPaths, [], 'wallet discovery, connection, account/network events and disconnection make no session or other API request')
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
    assert.deepEqual(apiPaths, ['/api/read/v1/capabilities', '/api/read/v1/token'], 'only the two explicit read probes ran; no session request on reload')
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
  } finally { await closeBrowser(browser); await shell.close() }
})
