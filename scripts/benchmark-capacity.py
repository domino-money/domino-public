#!/usr/bin/env python3
"""Bounded loopback capacity probe, never a public load generator.

No configuration changes or transaction methods. Production collectors stay on.
The node profile requires the infrastructure repository's load-health.py guard.
API profiles measure the real reader, excluding gateway/Access/Cloudflare.
JSON outputs contain aggregate diagnostics, never response bodies or credentials.
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import http.client
import importlib.util
import json
import math
from pathlib import Path
import re
import subprocess
import threading
import time

POOLS = ['0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6', '0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7', '0x94c62eebf6454231b2fcd0259ede448ae3c6ad8617718cd88dab20b30cfae48a', '0xf399bd1544377680d48c62fd85c2105b869e55906c4189cc5ab3b4e83446928c', '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e', '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a']
VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
DEAD = '0x000000000000000000000000000000000000dead'
MAX_BODY = 2_000_000
READ_METHODS = frozenset(('eth_call', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs'))
EDGE_LOG = re.compile(r'\[([^]]+)\].*"\s+(\d{3})\s+\d+\s+rt=([^ ]+)\s+urt=(.*)$')


def percentile(values, p):
    values = sorted(values)
    return round(values[max(0, math.ceil(len(values)*p)-1)], 3) if values else None


def describe(rows):
    good = [r for r in rows if r['outcome'] == 'ok']
    return {'n': len(rows), 'successes': len(good),
            'outcomes': dict(Counter(r['outcome'] for r in rows)),
            'httpStatuses': dict(Counter(str(r['status']) for r in rows)),
            'successLatencyMs': {f'p{int(p*100)}': percentile([r['ms'] for r in good], p) for p in (.5, .95, .99)},
            'maxSuccessMs': max((r['ms'] for r in good), default=None),
            'meanSuccessBytes': round(sum(r['bytes'] for r in good)/len(good), 1) if good else None}


def rpc_row(index, head, pools):
    pool = pools[(index // 10) % len(pools)]
    mode = index % 10
    if mode < 5:
        selector = ['c815641c', 'fa6793d5', '9ec538c8'][mode % 3]
        method, params = 'eth_call', [{'to': VIEW, 'data': '0x'+selector+pool[2:], 'gas': '0x249f0'}, 'latest']
    elif mode == 5:
        method, params = 'eth_call', [{'to': WETH, 'data': '0x70a08231'+MANAGER[2:].rjust(64, '0'), 'gas': '0x249f0'}, 'latest']
    elif mode < 8:
        method, params = 'eth_getBlockByNumber', ['latest', False]
    elif mode == 8:
        method, params = 'eth_getCode', [VIEW, 'latest']
    else:
        method, params = 'eth_getLogs', [{'address': MANAGER, 'topics': [None, pool], 'fromBlock': hex(max(0, head-99)), 'toBlock': hex(head)}]
    return {'jsonrpc': '2.0', 'id': index, 'method': method, 'params': params}


def validate_rpc(payload, requests):
    if not requests or (len(requests) > 1 and not isinstance(payload, list)) or (len(requests) == 1 and not isinstance(payload, dict)):
        return 'invalid_response'
    responses = payload if isinstance(payload, list) else [payload]
    if len(responses) != len(requests):
        return 'invalid_response'
    if any(not isinstance(r, dict) for r in responses):
        return 'invalid_response'
    # bool compares equal to integers in Python, but is not a JSON-RPC numeric ID.
    if any(type(r.get('id')) is not int for r in responses):
        return 'invalid_response'
    by_id = {r['id']: r for r in responses}
    if len(by_id) != len(requests) or set(by_id) != {r['id'] for r in requests}:
        return 'invalid_response'
    for request in requests:
        response = by_id[request['id']]
        if response.get('jsonrpc') != '2.0' or ('result' in response) == ('error' in response):
            return 'invalid_response'
        if 'error' in response:
            error = response['error']
            return 'jsonrpc_error' if isinstance(error, dict) and type(error.get('code')) is int and isinstance(error.get('message'), str) else 'invalid_response'
        value, method = response['result'], request['method']
        if method not in READ_METHODS:
            return 'invalid_result'
        if method in ('eth_call', 'eth_getCode') and (not isinstance(value, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', value)):
            return 'invalid_result'
        if method == 'eth_getBlockByNumber' and (not isinstance(value, dict) or not isinstance(value.get('hash'), str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', value['hash']) or not isinstance(value.get('number'), str) or not re.fullmatch(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)', value['number'])):
            return 'invalid_result'
        if method == 'eth_getLogs':
            if not isinstance(value, list):
                return 'invalid_result'
            low, high = (int(request['params'][0][k], 16) for k in ('fromBlock', 'toBlock'))
            for log in value:
                if not isinstance(log, dict) or not isinstance(log.get('address'), str) or log['address'].lower() != request['params'][0]['address'].lower() or not isinstance(log.get('topics'), list) or len(log['topics']) < 2 or log['topics'][1] != request['params'][0]['topics'][1] or log.get('removed') is not False:
                    return 'invalid_result'
                if not isinstance(log.get('blockNumber'), str) or not re.fullmatch(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)', log['blockNumber']) or not low <= int(log['blockNumber'], 16) <= high:
                    return 'invalid_result'
    return 'ok'


def edge_summary(log_text, *, now=None, window=20, tail_limit=3000):
    """Parse in memory; return only aggregates, never IPs, paths or raw lines."""
    now = time.time() if now is None else now
    rows, parsed_times = [], []
    lines = log_text.splitlines()
    for line in lines:
        match = EDGE_LOG.search(line)
        if not match:
            raise ValueError('edge_log_format')
        stamp, status, rt, urt = match.groups()
        timestamp = datetime.strptime(stamp, '%d/%b/%Y:%H:%M:%S %z').timestamp()
        parsed_times.append(timestamp)
        if not now-window <= timestamp <= now+2:
            continue
        duration = float(rt)
        upstream_parts = [float(v.strip()) for v in re.split(r'[, :]+', urt.strip()) if v and v != '-']
        if not math.isfinite(duration) or duration < 0 or any(not math.isfinite(v) or v < 0 for v in upstream_parts):
            raise ValueError('edge_log_duration')
        rows.append((int(status), duration*1000, sum(upstream_parts)*1000 if upstream_parts else None))
    if len(lines) >= tail_limit and parsed_times and min(parsed_times) > now-window:
        raise ValueError('edge_log_window_truncated')
    return {'windowSeconds': window, 'requests': len(rows),
            'statusCounts': dict(Counter(str(r[0]) for r in rows)),
            'http503Rate': sum(r[0] == 503 for r in rows)/len(rows) if rows else 0,
            'noUpstream503': sum(r[0] == 503 and r[2] is None for r in rows),
            'requestP95Ms': percentile([r[1] for r in rows], .95),
            'upstreamP95Ms': percentile([r[2] for r in rows if r[2] is not None], .95)}


def collect_edge():
    output = subprocess.run(['docker', 'exec', 'robinhood-edge', 'tail', '-n', '3000',
                             '/var/log/nginx/access.log'], capture_output=True, text=True,
                            timeout=3, check=True)
    return edge_summary(output.stdout)


class Guard:
    def __init__(self, path, data_dir, *, baseline_seconds=30, edge_collector=collect_edge):
        self.samples, self.reasons, self.state, self.counters = [], [], {}, None
        self.edge_collector, self.baseline_seconds = edge_collector, baseline_seconds
        self.edge_baseline = None
        self.edge_since = {}
        self.head = 0
        self.stop = threading.Event()
        self.path, self.data_dir = path, data_dir
        if path:
            spec = importlib.util.spec_from_file_location('infra_guard', path)
            self.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.module)

    def evaluate_edge(self, edge, now):
        if self.edge_baseline is None:
            return []
        tests = {'edge_503_growth': (edge['requests'] > 0 and edge['http503Rate'] > self.edge_baseline['http503Rate'] + .05, 30),
                 'edge_upstream_p95_above_200ms': (edge['upstreamP95Ms'] is not None and edge['upstreamP95Ms'] > 200, 15)}
        reasons = []
        for reason, (breached, seconds) in tests.items():
            if breached:
                since = self.edge_since.setdefault(reason, now)
                if now-since >= seconds:
                    reasons.append(reason)
            else:
                self.edge_since.pop(reason, None)
        return reasons

    def poll(self):
        try:
            metrics, self.counters = self.module.collect(self.counters, self.data_dir, 'https://rpc.mainnet.chain.robinhood.com')
            self.head = metrics['head']
            reasons, self.state = self.module.evaluate(metrics, self.state)
            if metrics['lag_blocks'] > 200:
                reasons.append('study_head_lag_above_200')
            edge = self.edge_collector()
            metrics = dict(metrics, edge=edge)
            reasons.extend(self.evaluate_edge(edge, time.monotonic()))
            self.samples.append(metrics)
            if reasons:
                self.reasons.extend(reasons)
                self.stop.set()
        except Exception as exc:
            self.reasons.append('guard_unavailable_'+type(exc).__name__)
            self.stop.set()

    def start(self):
        if not self.path:
            return
        self.poll()
        deadline = time.monotonic()+self.baseline_seconds
        while not self.stop.is_set() and time.monotonic() < deadline:
            if self.stop.wait(min(5, max(0, deadline-time.monotonic()))):
                break
            self.poll()
        if self.samples:
            self.edge_baseline = self.samples[-1]['edge']
        def loop():
            while not self.stop.wait(5):
                self.poll()
        self.thread = threading.Thread(target=loop, daemon=True)
        self.thread.start()

    def finish(self):
        self.stop.set()
        if hasattr(self, 'thread'):
            self.thread.join(timeout=10)


class Client:
    def __init__(self, profile, pools, batch, guard):
        self.profile, self.pools, self.batch, self.guard = profile, pools, batch, guard
        self.local = threading.local()
        self.connections = []
        self.lock = threading.Lock()

    def call(self, index):
        requests, methods = [], []
        if self.profile == 'node':
            requests = [rpc_row(index*self.batch+j, self.guard.head, self.pools) for j in range(self.batch)]
            body = requests if self.batch > 1 else requests[0]
            path, port, methods = '/', 8547, [r['method'] for r in requests]
        elif self.profile == 'wallet':
            path, port = '/v1/read/wallet-assets', 8876
            body = {'wallet': DEAD, 'tokens': [], 'autoDiscover': True}
            methods = ['wallet-assets']
        else:
            port = 8876
            # 80% home overview, 10% stored search, 10% persisted chart.
            mode = index % 10
            if mode < 8:
                path, body = '/v3/read/overview', {'poolIds': POOLS}
            elif mode == 8:
                path, body = '/v3/read/search', {'query': 'CRUMBS'}
            else:
                path, body = '/v3/read/history', {'poolId': POOLS[0], 'currency': WETH, 'windowSeconds': 86400, 'resolutionSeconds': 3600}
            methods = [path.rsplit('/', 1)[1]]
        started = time.monotonic()
        timeout = 20 if self.profile == 'wallet' else 3
        deadline = started+timeout
        def remaining():
            seconds = deadline-time.monotonic()
            if seconds <= 0:
                raise TimeoutError('request_deadline')
            return seconds
        status, size, outcome, extra = None, 0, 'transport', {}
        conn = getattr(self.local, 'connection', None)
        try:
            # Uvicorn closes idle keep-alives after five seconds. A worker may
            # remain unused while its peers handle traffic; discard its idle
            # socket before sending, without retrying an uncertain request.
            if conn is not None and started-getattr(self.local, 'last_used', started) > 4:
                conn.close()
                self.local.connection = None
                conn = None
            if conn is None:
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=timeout)
                self.local.connection = conn
                with self.lock:
                    self.connections.append(conn)
            if getattr(conn, 'sock', None) is not None:
                conn.sock.settimeout(remaining())
            conn.request('POST', path, json.dumps(body), {'Content-Type': 'application/json', 'User-Agent': 'domino-capacity-study/1'})
            wire_socket = getattr(conn, 'sock', None)
            if wire_socket is not None:
                wire_socket.settimeout(remaining())
            response = conn.getresponse()
            status = response.status
            raw = bytearray()
            # read1 makes at most one underlying read. Reapply the remaining
            # wall-clock budget, so a trickling response cannot reset it forever.
            while len(raw) <= MAX_BODY:
                seconds = remaining()
                if wire_socket is not None:
                    wire_socket.settimeout(seconds)
                chunk = response.read1(min(65536, MAX_BODY+1-len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
                if response.isclosed():
                    break
            size = len(raw)
            if size > MAX_BODY:
                outcome = 'response_too_large'
            elif status != 200:
                outcome = 'http_'+str(status)
            else:
                payload = json.loads(raw)
                outcome = validate_rpc(payload, requests) if requests else ('ok' if isinstance(payload, dict) and 'error' not in payload else 'invalid_response')
                if self.profile == 'wallet':
                    inv = payload.get('inventory') or {}
                    items = payload.get('items') or []
                    extra = {'inventorySource': inv.get('source'), 'candidateCount': inv.get('candidatesProbed'),
                             'inventoryStatus': inv.get('status'), 'itemCount': len(items),
                             'balanceStatuses': dict(Counter(item.get('balanceStatus', 'absent') for item in items))}
        except TimeoutError:
            outcome = 'timeout'
        except Exception as exc:
            outcome = 'transport_'+type(exc).__name__
        if outcome.startswith(('transport', 'timeout', 'invalid', 'response')):
            if conn:
                conn.close()
            self.local.connection = None
        self.local.last_used = time.monotonic()
        return {'ms': round((time.monotonic()-started)*1000, 3), 'status': status, 'outcome': outcome, 'bytes': size, 'methods': methods, **extra}

    def close(self):
        for connection in self.connections:
            connection.close()


def run_stage(client, rate, seconds, inflight_limit, guard, max_p95, *,
              clock=time.monotonic, wait=None, executor_factory=ThreadPoolExecutor):
    rows, lock, slots = [], threading.Lock(), threading.BoundedSemaphore(inflight_limit)
    abort = threading.Event()
    wait = abort.wait if wait is None else wait
    stop_reasons = set()
    slow_run = 0
    active, peak, dropped, scheduled = 0, 0, 0, 0
    start, cpu_start = clock(), time.process_time()
    def work(index):
        nonlocal active, slow_run
        try:
            try:
                row = client.call(index)
            except Exception as exc:
                row = {'ms': 0, 'status': None, 'outcome': 'worker_'+type(exc).__name__, 'bytes': 0, 'methods': []}
            with lock:
                rows.append(row)
                # Never retry or continue sending after uncertainty/overload.
                if row['outcome'] != 'ok':
                    stop_reasons.add(row['outcome'])
                    abort.set()
                slow_run = slow_run+1 if row['outcome'] == 'ok' and row['ms'] > max_p95 else 0
                recent = [r['ms'] for r in rows[-max(30, int(rate*5)):] if r['outcome'] == 'ok']
                if slow_run >= 3 or (len(recent) >= 30 and percentile(recent, .95) > max_p95):
                    stop_reasons.add('slo_p95')
                    abort.set()
        finally:
            with lock:
                active -= 1
            slots.release()
    with executor_factory(max_workers=inflight_limit) as pool:
        total = math.ceil(rate*seconds)
        index = 0
        while index < total and not abort.is_set() and not guard.stop.is_set():
            target = start+index/rate
            delay = target-clock()
            if delay > 0:
                wait(delay)
            if abort.is_set() or guard.stop.is_set():
                break
            late_slots = int(max(0, clock()-target)*rate)
            if late_slots:
                missed = min(late_slots, total-index)
                dropped += missed
                scheduled += missed
                index += missed
                continue
            scheduled += 1
            if slots.acquire(blocking=False):
                with lock:
                    active += 1
                    peak = max(peak, active)
                pool.submit(work, index)
            else:
                dropped += 1
            index += 1
            if scheduled >= 50 and dropped/scheduled > .05:
                stop_reasons.add('generator_drops')
                abort.set()
        # Include the last interarrival interval in a full stage's measurement.
        if index >= total and not abort.is_set() and not guard.stop.is_set():
            wait(max(0, start+seconds-clock()))
    elapsed = max(clock()-start, .000001)
    result = describe(rows)
    if result['successLatencyMs']['p95'] is not None and result['successLatencyMs']['p95'] > max_p95:
        stop_reasons.add('slo_p95')
        abort.set()
    if guard.stop.is_set():
        stop_reasons.add('health_guard')
    by_method = defaultdict(list)
    for row in rows:
        for method in set(row['methods']):
            by_method[method].append(row)
    result.update(offeredHttpPerSecond=rate, offeredRpcItemsPerSecond=rate*client.batch if client.profile=='node' else None,
                  plannedSeconds=seconds, elapsedSeconds=round(elapsed,3), scheduled=scheduled, dropped=dropped,
                  maxInflightHttp=peak, maxInflightRpcItems=peak*client.batch if client.profile=='node' else None,
                  successHttpPerSecond=round(result['successes']/elapsed,3),
                  generatorCpuSeconds=round(time.process_time()-cpu_start,3),
                  methodEnvelopeLatency={m:describe(r) for m,r in by_method.items()},
                  stopReasons=sorted(stop_reasons),
                  stoppedEarly=abort.is_set() or guard.stop.is_set() or bool(guard.reasons))
    if client.profile=='wallet':
        result['walletResponses']=[{k:v for k,v in r.items() if k!='methods'} for r in rows]
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--profile', choices=('node','stored','wallet'), required=True)
    p.add_argument('--rates', required=True, help='HTTP envelopes per second, comma separated')
    p.add_argument('--seconds', type=int, default=60)
    p.add_argument('--cooldown', type=int, default=30)
    p.add_argument('--concurrency', type=int, default=8)
    p.add_argument('--batch', type=int, choices=(1,8), default=1)
    p.add_argument('--pools', type=Path)
    p.add_argument('--health-module', type=Path)
    p.add_argument('--data-dir', type=Path, default=Path('/srv/robinhood-rpc/data'))
    p.add_argument('--output', type=Path, required=True)
    args=p.parse_args()
    rates=[float(x) for x in args.rates.split(',')]
    if not 10<=args.seconds<=300 or not 1<=args.concurrency<=32 or not 0<=args.cooldown<=60 or not rates or len(rates)>12 or any(not 0<r<=800/args.batch for r in rates):
        p.error('bounded experiment parameters required')
    if args.profile=='node' and not args.health_module:
        p.error('node requires infrastructure health module')
    if args.profile!='node' and args.batch!=1:
        p.error('batch is only valid for node')
    if args.profile=='wallet' and (max(rates)>1 or args.concurrency>2):
        p.error('wallet is bounded at 1/s and concurrency2')
    pools=json.loads(args.pools.read_text()) if args.pools else POOLS
    if not isinstance(pools,list) or not 1<=len(pools)<=64 or any(not isinstance(v,str) or not re.fullmatch('0x[0-9a-f]{64}',v) for v in pools):
        p.error('invalid public pool fixture')
    guard=Guard(args.health_module,args.data_dir)
    client=Client(args.profile,pools,args.batch,guard)
    result={'startedAt':datetime.now(timezone.utc).isoformat(),'profile':args.profile,'batch':args.batch,
            'scope':'loopback on production host; normal collectors active; unchanged production configuration',
            'poolCount':len(pools),'pools':pools,'stages':[],'guardModule':str(args.health_module) if args.health_module else None,
            'percentileEstimator':'nearest rank, successful responses only; batch method latency is full envelope latency'}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    def save():
        result.update(health=guard.samples,guardReasons=guard.reasons,edgeBaseline=guard.edge_baseline)
        args.output.write_text(json.dumps(result,indent=2)+'\n')
    try:
        guard.start()
        if guard.reasons:
            return
        for rate in rates:
            max_p95=3000 if args.profile=='wallet' else 100
            stage=run_stage(client,rate,args.seconds,args.concurrency,guard,max_p95)
            result['stages'].append(stage)
            save()
            print(json.dumps({k:v for k,v in stage.items() if k not in ('methodEnvelopeLatency','walletResponses')}),flush=True)
            if stage['stoppedEarly']:
                break
            if guard.stop.wait(args.cooldown):
                break
    finally:
        guard.finish()
        client.close()
        result['finishedAt']=datetime.now(timezone.utc).isoformat()
        save()


if __name__=='__main__':
    main()
