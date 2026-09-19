"""Offline F2 probe. Synthetic stored rows/RPC latency; real read pipeline and JS helper.

Run from the repository test environment with unittest discovery.
No PostgreSQL, external provider, credentials, or persistent application state.
This is code-level admission evidence, NOT staging throughput qualification.
"""
from collections import Counter
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
import json
import queue
import shutil
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from eth_abi import encode
from eth_hash.auto import keccak
from fastapi.testclient import TestClient
import httpx
import uvicorn
from bridge_http import LocalReaderHTTP
from bridge_state import ClientBudgets
from discovery import ReadRpc, POSITION_MANAGER, POOL_MANAGER, KEY_TYPES, ZERO
from position_accounting import core_position_id
from read_api import ReadGate, create_app
from read_gateway import Gateway, create_gateway
from read_service import ReadService

TOKEN = '0x' + '11' * 20
OWNER = '0x' + '33' * 20
KEY = (ZERO, TOKEN, 3000, 60, ZERO)
POOL = '0x' + keccak(encode(KEY_TYPES, KEY)).hex()
HASH = '0x' + 'ab' * 32
HEAD_HASH = '0x' + 'cd' * 32
TIMESTAMP = 87410
SELECTORS = {keccak(name.encode())[:4].hex(): name for name in (
    'poolManager()', 'getPoolAndPositionInfo(uint256)', 'ownerOf(uint256)',
    'getPositionLiquidity(uint256)', 'decimals()', 'symbol()')}


def stored_activity(count=128):
    raw = json.loads((ROOT / 'api-contracts/read-v1/fixtures/producer/pool-activity.success.json').read_text())
    positions = raw['liquidity']['positionAccounting']
    positions['corePositionCount'] = positions['nonzeroLiquidityPositionCount'] = count
    positions['knownTickCount'] = 2
    positions['onchainReconciliation'].update(corePositions=count, ticks=2, ranges=1)
    positions['items'] = []
    for number in range(1, count + 1):
        salt = '0x' + number.to_bytes(32, 'big').hex()
        positions['items'].append({'coreOwner': POSITION_MANAGER,
            'corePositionId': core_position_id(POSITION_MANAGER, -60, 60, salt),
            'salt': salt, 'tickLower': -60, 'tickUpper': 60, 'liquidityRaw': '1000000',
            'lastInsideX128': ['0', '0'], 'settledFeesRaw': ['0', '0'],
            'principalRaw': ['0', '0'], 'unsettledFeesRaw': ['0', '0']})
    return raw


class SyntheticTransport:
    def __init__(self, *, delay=0, block=False, hold_seconds=4):
        self.delay, self.block, self.hold_seconds = delay, block, hold_seconds
        self.entered, self.release = threading.Event(), threading.Event()
        self.lock = threading.Lock()
        self.counts, self.calls, self.rpc_objects = Counter(), [], []
        self.active = self.peak = 0

    def rpc(self):
        rpc = ReadRpc('https://synthetic.invalid', transport=self)
        self.rpc_objects.append(rpc)
        return rpc

    def __call__(self, url, body):
        assert url == 'https://synthetic.invalid'
        method, params = body['method'], body['params']
        assert method in ReadRpc.METHODS
        signature = SELECTORS.get(params[0]['data'][2:10]) if method == 'eth_call' else None
        with self.lock:
            self.counts[signature or method] += 1
            self.calls.append((method, deepcopy(params)))
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            if signature in ('getPoolAndPositionInfo(uint256)', 'ownerOf(uint256)', 'getPositionLiquidity(uint256)'):
                self.entered.set()
                if self.block and not self.release.wait(self.hold_seconds):
                    raise AssertionError('probe_release_timeout')
                time.sleep(self.delay)
            if method == 'eth_chainId': result = hex(4663)
            elif method == 'eth_getBlockByNumber':
                head = params[0] in ('latest', '0x2bd')
                result = {'number': hex(701 if head else 700), 'hash': HEAD_HASH if head else HASH,
                          'timestamp': hex(TIMESTAMP + 10 if head else TIMESTAMP)}
            elif method == 'eth_getCode': result = '0x6000'
            elif signature == 'poolManager()': result = self.abi(['address'], [POOL_MANAGER])
            elif signature == 'getPoolAndPositionInfo(uint256)':
                info = ((int(POOL, 16) >> 56) << 56) | (60 << 32) | (((-60) & 0xffffff) << 8) | 1
                result = self.abi(['(address,address,uint24,int24,address)', 'uint256'], [KEY, info])
            elif signature == 'ownerOf(uint256)': result = self.abi(['address'], [OWNER])
            elif signature == 'getPositionLiquidity(uint256)': result = self.abi(['uint128'], [1000000])
            elif signature == 'decimals()': result = self.abi(['uint8'], [18])
            elif signature == 'symbol()': result = self.abi(['string'], ['SYNTH'])
            else: raise AssertionError('unexpected_synthetic_rpc')
            return {'jsonrpc': '2.0', 'id': body['id'], 'result': result}
        finally:
            with self.lock: self.active -= 1

    @staticmethod
    def abi(types, values): return '0x' + encode(types, values).hex()


class Identity:
    def __init__(self): self.calls = 0
    def verify(self, token):
        assert token == 'synthetic-identity'
        self.calls += 1


@contextmanager
def serve(app):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0)); sock.listen(32)
    server = uvicorn.Server(uvicorn.Config(app, log_level='critical', access_log=False,
        server_header=False, proxy_headers=False, timeout_graceful_shutdown=5))
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()
    until = time.monotonic() + 5
    while not server.started:
        if not thread.is_alive() or time.monotonic() > until:
            raise AssertionError('probe_server_start_failed')
        time.sleep(.005)
    try: yield f'http://127.0.0.1:{sock.getsockname()[1]}'
    finally:
        server.should_exit = True; thread.join(6); sock.close()
        if thread.is_alive(): raise AssertionError('probe_server_shutdown_failed')


class Pipeline:
    def __init__(self, *, delay=0, budget=15, block=False, hold_seconds=4):
        self.transport = SyntheticTransport(delay=delay, block=block, hold_seconds=hold_seconds)
        self.reader_gate = ReadGate(interval=0)
        self.identity = Identity()
        self.service = ReadService(catalogue=object(), rpc_factory=self.transport.rpc,
            clock=lambda: TIMESTAMP + 10, transport_factory=lambda: None)
        self.reader = TestClient(create_app(self.service, gate=self.reader_gate, read_budget_seconds=budget),
                                 base_url='http://127.0.0.1:8876')
        self.gateway = Gateway(enabled=True, enabled_reads=('token', 'pool-activity', 'pool-positions'),
            verifier=self.identity, upstream=LocalReaderHTTP(client=self.reader),
            gate=ReadGate(interval=1), budgets=ClientBudgets(burst=100))
        self.app = create_gateway(self.gateway)
        self.rows = stored_activity()
        self.patch = patch('activity_store.PgActivity.read', side_effect=self.read_rows)

    def read_rows(self, pool, *, include_positions=False):
        assert pool == POOL
        result = deepcopy(self.rows)
        if not include_positions: result['liquidity']['positionAccounting'].pop('items')
        return result

    def __enter__(self): self.patch.start(); return self
    def __exit__(self, *args):
        self.transport.release.set(); self.patch.stop(); self.reader.close()

    @staticmethod
    def headers(client=1):
        return {'Cf-Access-Jwt-Assertion': 'synthetic-identity', 'X-Domino-Client-Id': f'192.0.2.{client}'}

    def post(self, origin, route='pool-positions', body=None, client=1):
        with httpx.Client(trust_env=False) as client_:
            return client_.post(origin + '/internal/read/v1/' + route,
                json=body or {'poolId': POOL}, headers=self.headers(client), timeout=20)


NODE_PROBE = r'''
import { pathToFileURL } from 'node:url';
const [modulePath, origin, pool, token] = process.argv.slice(1);
const { createProgressiveReader } = await import(pathToFileURL(modulePath));
const metrics = [];
const start = performance.now();
const pages = await Promise.all(Array.from({length:5}, async (_, i) => {
  const attempts = [];
  // One retry, not the default two: a refusal now carries the wait the gate
  // can justify (up to ten seconds), so two retries would outlast the
  // controlled stall and the last attempt would succeed instead of being
  // refused. One still exhausts the budget, which is what this measures.
  const reader = createProgressiveReader({random:()=>0, maxRetries:1, fetch:async (url, options)=>{
    const route = url.split('/').at(-1);
    const response = await fetch(origin + '/internal/read/v1/' + route, {...options,
      headers: {'Content-Type':'application/json', 'Cf-Access-Jwt-Assertion':'synthetic-identity',
                'X-Domino-Client-Id':'192.0.2.'+(i+2)}});
    attempts.push({route, status:response.status, atMs:Math.round(performance.now()-start)});
    return response;
  }});
  const result = [];
  try {
    for (const [route, body] of [['token',{token}],['pool-activity',{poolId:pool}]]) {
      try { await reader.read(route, body); result.push({route,status:200}); }
      catch(error) {result.push({route,status:error.status ?? 0,code:error.code ?? error.name});}
      if (route === 'token') console.log(JSON.stringify({event:'token-finished',page:i,result:result.at(-1)}));
    }
  } finally {reader.dispose();}
  return {page:i, result, attempts};
}));
console.log(JSON.stringify({event:'complete',pages,elapsedMs:Math.round(performance.now()-start)}));
'''


class ExpensiveCapacityTests(unittest.TestCase):
    def assert_free(self, gate):
        self.assertTrue(gate.slot.acquire(blocking=False))
        gate.slot.release()

    def test_actual_128_nft_read_and_five_progressive_pages_show_retry_exhaustion(self):
        if not shutil.which('node'):
            self.fail('Node required for actual progressive helper probe')
        # Deliberate controlled stall; no real/provider throughput inference.
        # Release after all five actual helpers exhaust their first panel. No
        # assertion depends on a narrow elapsed-time range or scheduler speed.
        with Pipeline(block=True, hold_seconds=12) as pipeline, serve(pipeline.app) as origin:
            responses = []
            thread = threading.Thread(target=lambda: responses.append(pipeline.post(origin)))
            process = collector = None
            thread.start()
            try:
                self.assertTrue(pipeline.transport.entered.wait(3))
                process = subprocess.Popen(['node', '--input-type=module', '-e', NODE_PROBE,
                    str(ROOT/'api-contracts/read-v1/progressive.mjs'), origin, POOL, TOKEN],
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                events = queue.Queue()
                def read_events():
                    for line in process.stdout:
                        try: events.put(json.loads(line))
                        except ValueError: events.put({'event':'invalid-output'})
                    events.put({'event':'closed'})
                collector = threading.Thread(target=read_events, daemon=True)
                collector.start()
                completed = []
                until = time.monotonic() + 14
                while len(completed) < 5:
                    event = events.get(timeout=max(.01, until-time.monotonic()))
                    self.assertEqual(event.get('event'), 'token-finished', event)
                    completed.append(event)
                self.assertEqual({row['page'] for row in completed}, set(range(5)))
                self.assertTrue(all(row['result'] == {'route':'token', 'status':429,
                    'code':'read_capacity_busy'} for row in completed), completed)
                self.assertFalse(pipeline.gateway.gate.slot.acquire(blocking=False))
                self.assertFalse(pipeline.reader_gate.slot.acquire(blocking=False))
                # No rejected page reached identity/provider while the first
                # owner's read was held. Two snapshot passes and one NFT call.
                self.assertEqual(pipeline.identity.calls, 1)
                self.assertEqual(pipeline.transport.counts['getPoolAndPositionInfo(uint256)'], 1)
                self.assertEqual(pipeline.transport.counts['ownerOf(uint256)'], 0)
                pipeline.transport.release.set()
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(responses[0].status_code, 200, responses[0].text[:500])
                process.wait(timeout=12)
                collector.join(2)
                self.assertEqual(process.returncode, 0, process.stderr.read())
                final = events.get(timeout=2)
                self.assertEqual(final.get('event'), 'complete', final)
                # One initial attempt plus the one retry the probe allows: every
                # page exhausted its budget against the stall, none succeeded.
                self.assertTrue(all(len([attempt for attempt in page['attempts']
                    if attempt['route']=='token']) == 2 for page in final['pages']), final)
                items=responses[0].json()['positionAccounting']['items']
                self.assertEqual(len(items),128)
                self.assertTrue(all(item['nft']['owner']==OWNER for item in items))
                for signature in ('ownerOf(uint256)', 'getPoolAndPositionInfo(uint256)',
                                  'getPositionLiquidity(uint256)'):
                    self.assertEqual(pipeline.transport.counts[signature],128)
                self.assertEqual(pipeline.transport.peak,1)
                self.assert_free(pipeline.gateway.gate);self.assert_free(pipeline.reader_gate)
                time.sleep(1.02)
                self.assertEqual(pipeline.post(origin,'token',{'token':TOKEN},30).status_code,200)
            finally:
                pipeline.transport.release.set()
                thread.join(5)
                if process is not None:
                    if process.poll() is None: process.kill()
                    process.wait(timeout=3)
                    if collector is not None: collector.join(2)
                    process.stdout.close();process.stderr.close()

    def test_expensive_deadline_stops_further_rpc_then_releases_both_gates(self):
        with Pipeline(delay=.025,budget=.20) as pipeline, serve(pipeline.app) as origin:
            started=time.monotonic(); response=pipeline.post(origin)
            self.assertEqual(response.status_code,504,response.text)
            self.assertEqual(response.json(),{'error':'read_deadline_exceeded'})
            self.assertLess(time.monotonic()-started,3)
            self.assertLess(pipeline.transport.counts['ownerOf(uint256)'],128)
            count=len(pipeline.transport.calls);time.sleep(.07)
            self.assertEqual(len(pipeline.transport.calls),count)
            self.assert_free(pipeline.reader_gate);self.assert_free(pipeline.gateway.gate)
            time.sleep(1.02)
            self.assertEqual(pipeline.post(origin,'token',{'token':TOKEN}).status_code,200)

    def test_actual_client_disconnect_does_not_release_an_active_expensive_worker(self):
        with Pipeline(block=True) as pipeline, serve(pipeline.app) as origin:
            port=int(origin.rsplit(':',1)[1]); raw=json.dumps({'poolId':POOL}).encode()
            headers=(f'POST /internal/read/v1/pool-positions HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
                     f'Content-Type: application/json\r\nContent-Length: {len(raw)}\r\n'
                     'Cf-Access-Jwt-Assertion: synthetic-identity\r\nX-Domino-Client-Id: 192.0.2.1\r\n\r\n').encode()
            with socket.create_connection(('127.0.0.1',port)) as sock:
                sock.sendall(headers+raw)
                self.assertTrue(pipeline.transport.entered.wait(3))
            before=len(pipeline.transport.calls);identities=pipeline.identity.calls
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(max_workers=5) as pool:
                responses=list(pool.map(lambda i:pipeline.post(origin,'token',{'token':TOKEN},i+2),range(5)))
            self.assertEqual([r.status_code for r in responses],[429]*5)
            # Each refusal reports the wait its gate can justify, bounded to ten
            # seconds, and they agree with each other: not a constant.
            waits={int(r.headers['retry-after']) for r in responses}
            self.assertTrue(all(1<=w<=10 for w in waits),waits)
            self.assertLessEqual(max(waits)-min(waits),1,waits)
            self.assertEqual(len(pipeline.transport.calls),before)
            self.assertEqual(pipeline.identity.calls,identities)
            self.assertFalse(pipeline.reader_gate.slot.acquire(blocking=False))
            self.assertFalse(pipeline.gateway.gate.slot.acquire(blocking=False))
            pipeline.transport.release.set()
            until=time.monotonic()+3
            while pipeline.transport.counts['ownerOf(uint256)']<128 and time.monotonic()<until:time.sleep(.01)
            time.sleep(1.05)
            self.assertEqual(pipeline.post(origin,'token',{'token':TOKEN},20).status_code,200)
            self.assert_free(pipeline.reader_gate);self.assert_free(pipeline.gateway.gate)


if __name__=='__main__': unittest.main()
