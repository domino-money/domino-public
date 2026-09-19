import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readOnlyRpc, verificationRpcEndpoint } from './prepare-financial-release.mjs';

const endpoint = 'https://rpc.example.invalid/synthetic-rpc-auth/';

function privateFile(t, contents = endpoint) {
  const directory = mkdtempSync(join(tmpdir(), 'domino-release-rpc-'));
  const path = join(directory, 'private-rpc-url');
  writeFileSync(path, contents, { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path };
}

test('verification accepts exactly one RPC source and preserves legacy public --rpc', () => {
  assert.equal(verificationRpcEndpoint({ rpc: 'https://rpc.mainnet.chain.robinhood.com' }), 'https://rpc.mainnet.chain.robinhood.com');
  for (const options of [{}, { rpc: endpoint, 'rpc-file': '/not/read' }]) {
    assert.throws(() => verificationRpcEndpoint(options), { message: 'exactly_one_rpc_source_required' });
  }
  assert.throws(() => verificationRpcEndpoint({ rpc: 'invalid synthetic-private-value' }), { message: 'public_rpc_url_required' });
});

test('private RPC file accepts one URL with an optional LF or CRLF', t => {
  const { path } = privateFile(t);
  for (const ending of ['', '\n', '\r\n']) {
    writeFileSync(path, endpoint + ending);
    assert.equal(verificationRpcEndpoint({ 'rpc-file': path }), endpoint);
  }
});

test('private RPC file refuses broad permissions, foreign ownership, links and non-files', t => {
  const { path, directory } = privateFile(t);
  const read = value => verificationRpcEndpoint({ 'rpc-file': value });
  chmodSync(path, 0o640);
  assert.throws(() => read(path), { message: 'invalid_private_rpc_file' });
  chmodSync(path, 0o600);
  const uid = process.getuid();
  const getuid = t.mock.method(process, 'getuid', () => uid + 1);
  assert.throws(() => read(path), { message: 'invalid_private_rpc_file' });
  getuid.mock.restore();
  const symlink = join(directory, 'linked');
  symlinkSync(path, symlink);
  assert.throws(() => read(symlink), { message: 'invalid_private_rpc_file' });
  const hardlink = join(directory, 'hardlinked');
  linkSync(path, hardlink);
  assert.throws(() => read(path), { message: 'invalid_private_rpc_file' });
  assert.throws(() => read(hardlink), { message: 'invalid_private_rpc_file' });
  for (const invalid of [directory, join(directory, 'missing'), undefined]) {
    assert.throws(() => read(invalid), { message: 'invalid_private_rpc_file' });
  }
});

test('private RPC file refuses empty, oversized, multiline, malformed and credential-query input without reflecting it', t => {
  const { path } = privateFile(t);
  // Construct rejected userinfo from clearly synthetic fields, never a credential literal.
  const basicAuth = new URL(endpoint);
  basicAuth.username = 'synthetic-user';
  basicAuth.password = 'synthetic-private-value';
  const invalid = ['', endpoint + '\n\n', endpoint + '\n' + endpoint, endpoint + ' ', ' ' + endpoint,
    endpoint + '?api_key=synthetic-private-value', endpoint + '#synthetic-private-value',
    basicAuth.href, endpoint + '\0', endpoint + '\uFFFD',
    'https://rpc.example.invalid/' + 'x'.repeat(1539), 'synthetic-private-value'];
  for (const contents of invalid) {
    writeFileSync(path, contents);
    assert.throws(() => verificationRpcEndpoint({ 'rpc-file': path }), error => {
      assert.equal(error.message, 'invalid_private_rpc_file');
      assert.equal(error.cause, undefined);
      assert.ok(!error.stack.includes(path));
      assert.ok(!error.stack.includes('synthetic-private-value'));
      return true;
    });
  }
});

test('private file URL reaches the read-only transport with its path intact and cannot send', async t => {
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ path: request.url, method: request.method, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x1237' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { path } = privateFile(t, `http://127.0.0.1:${server.address().port}/synthetic-rpc-auth/\n`);
  const rpc = readOnlyRpc(verificationRpcEndpoint({ 'rpc-file': path }));
  assert.equal(await rpc('eth_chainId', []), '0x1237');
  await assert.rejects(() => rpc('eth_sendRawTransaction', ['0x00']), { message: 'readonly_rpc_budget' });
  assert.deepEqual(received, [{ path: '/synthetic-rpc-auth/', method: 'POST',
    body: { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] } }]);
});

test('CLI failures never print private file paths, contents or raw parsing errors', t => {
  const { path } = privateFile(t, 'synthetic-private-value');
  const script = new URL('./prepare-financial-release.mjs', import.meta.url);
  for (const args of [['--rpc-file', path], ['--rpc', 'invalid-synthetic-private-value'],
    ['--rpc-file', path, '--rpc', endpoint]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(script), 'verify', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Financial release preparation/verification failed; no transaction was signed or sent.\n');
  }
});
