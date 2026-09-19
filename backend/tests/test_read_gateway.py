from copy import deepcopy
import json
from pathlib import Path
import sys
from threading import Event, Thread
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from bridge_state import ClientBudgets, OpaqueCursors
from discovery import DataError
from inventory import CursorCodec
from read_api import create_app, ReadGate
from read_contract import CONTRACT_VERSION
from read_gateway import Gateway, LocalReaderHTTP, create_gateway
from read_service import ReadService
from test_bridge_identity import IdentityFixtures
from test_discovery import FakeRpc, OWNER, TOKEN, POOL, candidate
from test_inventory import ProviderTransport, page, URL
from inventory import AlchemyInventory


class Upstream:
    def __init__(self, *, inventory=None, budget=15):
        self.rpc, self.calls, self.request_ids = FakeRpc(), [], []
        self.now = time.time()
        self.service = ReadService(rpc_factory=lambda: self.rpc, clock=lambda:1010,
                                  transport_factory=lambda:lambda url:[candidate()], inventory=inventory,
                                  cursor_codec=CursorCodec(clock=lambda:self.now))
        self.client = TestClient(create_app(self.service, gate=ReadGate(interval=0), read_budget_seconds=budget),
                                 base_url='http://127.0.0.1:8876')
        self.http = LocalReaderHTTP(client=self.client)
        self.change = None

    def request(self, route, body=None, *, deadline, request_id=None):
        self.calls.append((route,deepcopy(body)))
        self.request_ids.append(request_id)
        status,data,metadata = self.http.request(route,body,deadline=deadline,request_id=request_id)
        if self.change and route != 'health': return self.change(status,data,metadata)
        return status,data,metadata


class GatewayTests(IdentityFixtures, unittest.TestCase):
    def setUp(self):
        self.upstream = Upstream()
        self.gateway = Gateway(enabled=True,enabled_reads=('token','pools','wallet-assets','nft-positions','pool-market'),
                               verifier=self.verifier(),upstream=self.upstream,gate=ReadGate(interval=0),
                               budgets=ClientBudgets(burst=500))
        self.client = TestClient(create_gateway(self.gateway),base_url='http://127.0.0.1:8878',
                                 client=('127.0.0.1',40000))
        self.headers = {'Cf-Access-Jwt-Assertion':self.token(),'X-Domino-Client-Id':'192.0.2.1'}

    def post(self, path='token', body=None, **kwargs):
        return self.client.post('/internal/read/v1/'+path,json=body if body is not None else {'token':TOKEN},
                                headers=kwargs.pop('headers',self.headers),**kwargs)

    def test_every_gateway_hop_records_one_line_and_propagates_its_id(self):
        from contextlib import redirect_stderr
        import io, json as _json, re as _re
        import hop_log
        with redirect_stderr(io.StringIO()) as printed:
            served = self.post()
            refused = self.client.post('/internal/read/v1/' + TOKEN, json={}, headers=self.headers)
        records = [_json.loads(line) for line in printed.getvalue().splitlines() if line]
        # This harness runs a real reader behind the gateway, so one served read
        # leaves three lines: the reader's health and route hops, then the
        # gateway's own — all three carrying the one id, which is the point.
        served_lines = [record for record in records if record['route'] != 'unmatched']
        self.assertEqual(len({record['requestId'] for record in served_lines}), 1, printed.getvalue())
        self.assertEqual([record['service'] for record in served_lines],
                         ['read-api', 'read-api', 'read-gateway'])
        self.assertEqual(served_lines[-1]['requestId'], served.headers['X-Domino-Request-Id'])
        self.assertTrue(_re.fullmatch(r'[0-9a-f]{32}', served_lines[-1]['requestId']))
        for record in served_lines:
            self.assertEqual(record['status'], 200)
            self.assertNotIn('reason', record)
        self.assertEqual((served.status_code, served_lines[-1]['route']), (200, 'token'))
        self.assertEqual((served_lines[-1]['gate'], served_lines[-1]['admitted']), ('provider', True))
        # A path naming no declared route is never echoed, and gets its own id.
        unmatched, = [record for record in records if record['route'] == 'unmatched']
        self.assertEqual((refused.status_code, unmatched['service'], unmatched['reason']),
                         (404, 'read-gateway', 'route_not_available'))
        self.assertNotEqual(unmatched['requestId'], served_lines[-1]['requestId'])
        self.assertIsNone(_re.search(r'0x[0-9a-fA-F]{40}', printed.getvalue()))
        for record in records:
            self.assertLessEqual(set(record), hop_log.ALLOWED_KEYS)
            self.assertIn('durationMs', record)

    def test_the_reader_receives_the_gateways_own_request_id(self):
        response = self.post()
        forwarded = set(self.upstream.request_ids)
        self.assertEqual(forwarded, {response.headers['X-Domino-Request-Id']})

    def test_real_local_reader_pipeline_preserves_output_and_blocks_browser_direct_access(self):
        response = self.post()
        self.assertEqual(response.status_code,200,response.text)
        expected = self.upstream.service.token(TOKEN)
        self.assertEqual(response.json(),expected)
        self.assertEqual(response.headers['x-domino-read-contract'],CONTRACT_VERSION)
        self.assertTrue({'no-store', 'no-transform'} <= {value.strip().lower() for value in response.headers['cache-control'].split(',')})
        self.assertNotIn('content-encoding', response.headers)
        self.assertNotIn('x-domino-reader-generation',response.headers)
        self.assertNotIn('set-cookie',response.headers)
        direct = self.upstream.client.post('/v1/read/token',json={'token':TOKEN},headers={'Origin':'https://app.example'})
        self.assertEqual(direct.status_code,403)

    def test_missing_wrong_expired_identity_and_unknown_routes_make_no_reader_calls(self):
        for headers in [{}, {**self.headers,'Cf-Access-Jwt-Assertion':'wrong'},
                        {**self.headers,'Cf-Access-Jwt-Assertion':self.token(common_name='other.access')},
                        {**self.headers,'Cf-Access-Jwt-Assertion':self.token(exp=int(time.time())-1)}]:
            self.assertEqual(self.post(headers=headers).status_code,403)
        for path in ['health','execute','../token','token/extra','token?url=https://evil.example']:
            self.assertEqual(self.post(path).status_code,404)
        self.assertEqual(self.client.get('/internal/read/v1/token',headers=self.headers).status_code,405)
        self.assertEqual(self.upstream.calls,[])

    def test_access_transport_cookie_duplicates_verified_header_without_becoming_authentication(self):
        assertion = self.headers['Cf-Access-Jwt-Assertion']
        with patch.object(self.upstream.client, 'stream', wraps=self.upstream.client.stream) as reader_request:
            response = self.post(headers={**self.headers, 'Cookie': 'CF_Authorization=' + assertion})
        self.assertEqual(reader_request.call_count, 2)
        for call in reader_request.call_args_list:
            forwarded = {name.lower() for name in call.kwargs.get('headers', {})}
            self.assertTrue({'cookie', 'cf-access-jwt-assertion'}.isdisjoint(forwarded))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), self.upstream.service.token(TOKEN))
        self.assertEqual(response.headers['x-domino-read-contract'], CONTRACT_VERSION)
        self.assertNotIn('set-cookie', response.headers)
        self.assertEqual([route for route, _ in self.upstream.calls], ['health', 'token'])

        self.upstream.calls.clear()
        for label, invalid in [('malformed', 'invalid'),
                              ('signature', assertion[:-12] + 'AAAAAAAAAAAA'),
                              ('client', self.token(common_name='other.access')),
                              ('issuer', self.token(iss='https://other.cloudflareaccess.com')),
                              ('audience', self.token(aud=['b'*64])),
                              ('type', self.token(type='org')),
                              ('subject', self.token(sub='human')),
                              ('expired', self.token(exp=int(time.time())-1))]:
            with self.subTest(identity=label):
                headers = {**self.headers, 'Cf-Access-Jwt-Assertion': invalid,
                           'Cookie': 'CF_Authorization=' + invalid}
                self.assertEqual(self.post(headers=headers).status_code, 403)
        self.assertEqual(self.upstream.calls, [])

    def test_access_cookie_rejects_other_duplicate_malformed_or_browser_credentials(self):
        assertion = self.headers['Cf-Access-Jwt-Assertion']
        access = 'CF_Authorization=' + assertion
        for cookie in ('', 'CF_Authorization=', 'CF_Authorization=other',
                       'cf_authorization=' + assertion, 'session=' + assertion,
                       'CF_Authorization="' + assertion + '"',
                       access + '; session=private', 'session=private; ' + access,
                       access + '; ' + access, access + ',' + access, access + ';',
                       access.replace('.', '%2E'), access + '\n'):
            with self.subTest(cookie_shape=cookie.split('=', 1)[0]):
                response = self.post(headers={**self.headers, 'Cookie': cookie})
                self.assertEqual(response.status_code, 403)
        for extra in ({'Origin': 'https://app.example'}, {'Authorization': 'Bearer private'}):
            self.assertEqual(self.post(headers={**self.headers, 'Cookie': access, **extra}).status_code, 403)
        self.assertEqual(self.post(headers={'Cookie': access, 'X-Domino-Client-Id': '192.0.2.1'}).status_code, 403)
        duplicate = list(self.headers.items()) + [('Cookie', access), ('Cookie', access)]
        self.assertEqual(self.post(headers=duplicate).status_code, 422)
        nonascii = [(k.encode(), v.encode()) for k, v in self.headers.items()] + [(b'Cookie', access.encode() + b'\xff')]
        self.assertEqual(self.post(headers=nonascii).status_code, 403)
        # JWT decoders may ignore non-base64 signature characters. Matching
        # copies must still be one syntactically valid compact JWT cookie.
        for suffix in (',,,,', ';;;;', '=', '%3B', '\t'):
            malformed = assertion + suffix
            self.assertEqual(self.post(headers={**self.headers, 'Cf-Access-Jwt-Assertion': malformed,
                                              'Cookie': 'CF_Authorization=' + malformed}).status_code, 403)
        self.assertEqual(self.upstream.calls, [])

    def test_browser_headers_bad_identity_and_duplicate_headers_rejected(self):
        for extra in [{'Origin':'https://app.example'},{'Cookie':'private'},{'Authorization':'secret'},
                      {'X-Domino-Client-Id':'spoofed,192.0.2.1'}]:
            self.assertEqual(self.post(headers={**self.headers,**extra}).status_code,403)
        duplicate=list(self.headers.items())+[('X-Domino-Client-Id','192.0.2.2')]
        self.assertEqual(self.post(headers=duplicate).status_code,422)
        external = TestClient(create_gateway(self.gateway),base_url='https://gateway.example',client=('192.0.2.15',40000))
        self.assertEqual(external.post('/internal/read/v1/token',json={'token':TOKEN},headers=self.headers).status_code,403)
        self.assertEqual(self.upstream.calls,[])

    def test_strict_input_limits_and_unselected_fields_do_not_call_upstream(self):
        for body in [{'token':TOKEN,'rpcUrl':'https://evil.example'}, {'token':12}, {'token':TOKEN,'chainId':1}]:
            self.assertEqual(self.post(body=body).status_code,422)
        url='/internal/read/v1/token'
        for raw,extra,status in [(b' '*8193,{},413),(b'{"token":"a","token":"b"}',{},422),
                                 (b'{}',{'Content-Encoding':'gzip'},415),(b'{"token":1e309}',{},422)]:
            response=self.client.post(url,content=raw,headers={**self.headers,'Content-Type':'application/json',**extra})
            self.assertEqual(response.status_code,status)
        self.assertEqual(self.upstream.calls,[])

    def test_disabled_default_has_no_identity_or_provider_side_effects(self):
        client=TestClient(create_gateway(),base_url='http://127.0.0.1:8878',client=('127.0.0.1',1))
        self.assertEqual(client.post('/internal/read/v1/token',json={'token':TOKEN}).status_code,404)

    def test_schema_drift_version_and_generation_errors_are_sanitized(self):
        def renamed(status,data,metadata):
            data['asset']['renamedDecimals']=data['asset'].pop('decimals')
            return status,data,metadata
        for mutation,expected in [(renamed,502),
                (lambda s,d,m:(s,d,{**m,'contract':'9.0.0'}),502),
                (lambda s,d,m:(s,d,{**m,'generation':'b'*32}),503),
                (lambda s,d,m:(500,{'error':'https://secret.example/api-key'},m),503)]:
            self.upstream.change=mutation
            response=self.post()
            self.assertEqual(response.status_code,expected,response.text)
            self.assertNotIn('secret',response.text)
            self.assertEqual(set(response.json()),{'error'})

    def test_declines_reader_with_unbounded_development_budget(self):
        self.gateway.upstream=Upstream(budget=60)
        response=self.post()
        self.assertEqual(response.status_code,503)
        self.assertEqual([call[0] for call in self.gateway.upstream.calls],['health'])

    def test_cursor_is_opaque_and_invalid_context_never_reads_wallet_again(self):
        provider=AlchemyInventory(URL,transport=ProviderTransport([page([TOKEN],next_key='private-provider-page')]),clock=lambda:1010)
        upstream=Upstream(inventory=provider)
        self.gateway.upstream=upstream
        self.gateway.cursors=OpaqueCursors(clock=lambda:upstream.now)
        response=self.post('wallet-assets',{'wallet':OWNER,'tokens':[TOKEN]})
        self.assertEqual(response.status_code,200,response.text)
        handle=response.json()['inventory']['nextCursor']
        self.assertRegex(handle,'^[0-9a-f]{64}$')
        self.assertNotIn('private-provider',response.text)
        before=len(upstream.calls)
        response=self.post('wallet-assets',{'wallet':OWNER,'cursor':handle})
        self.assertEqual(response.status_code,400,response.text)
        self.assertEqual([name for name,_ in upstream.calls[before:]],['health'])

    def test_dispatch_failure_releases_admission_for_next_request(self):
        with patch('read_gateway.anyio.to_thread.run_sync', side_effect=RuntimeError('thread startup failed')):
            self.assertEqual(self.post().status_code, 503)
        self.assertEqual(self.post().status_code, 200)

    def test_expired_dispatch_does_not_start_identity_or_reader_work(self):
        self.gateway.verifier = Mock()
        self.assertTrue(self.gateway.gate.enter())
        status, data = self.gateway.execute('token', {'token':TOKEN}, 'unused', '192.0.2.1', self.gateway.clock()-1)
        self.assertEqual((status,data), (504, {'error':'upstream_timeout'}))
        self.gateway.verifier.verify.assert_not_called()
        self.assertEqual(self.upstream.calls, [])

    def test_identity_time_counts_against_total_request_budget(self):
        now = [100.]
        self.gateway.clock = lambda:now[0]
        def slow_verify(token): now[0] += 21
        self.gateway.verifier = Mock()
        self.gateway.verifier.verify.side_effect = slow_verify
        response = self.post()
        self.assertEqual(response.status_code, 504, response.text)
        self.assertEqual(self.upstream.calls, [])

    def test_timed_out_reader_must_be_idle_before_another_operation(self):
        original = self.upstream.request
        busy = [False]
        def interrupted(route, body=None, *, deadline, request_id=None):
            if route != 'health' and not busy[0]:
                busy[0] = True
                raise DataError('upstream_timeout')
            result = original(route, body, deadline=deadline, request_id=request_id)
            if route == 'health': result[1]['busy'] = busy[0]
            return result
        self.upstream.request = interrupted
        self.assertEqual(self.post().status_code, 504)
        count = len(self.upstream.calls)
        self.assertEqual(self.post().status_code, 429)
        self.assertEqual([route for route,_ in self.upstream.calls[count:]], ['health'])
        self.upstream.request = original
        self.assertEqual(self.post().status_code, 200)

    def test_a_reader_429_is_relayed_with_the_readers_own_retry_after(self):
        original = self.upstream.request
        _, health, _ = original('health', deadline=time.monotonic() + 5)
        def relayed(value):
            def request(route, body=None, *, deadline, request_id=None):
                if route == 'token':
                    return 429, {'error': 'read_capacity_busy'}, {'generation': health['generation'],
                                                                  'contract': CONTRACT_VERSION, 'retryAfter': value}
                return original(route, body, deadline=deadline, request_id=request_id)
            return request
        self.upstream.request = relayed('7')
        response = self.post()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers['retry-after'], '7')
        # A number the reader cannot justify is not relayed as-is: the gate's own bound stands in.
        for value in ('99', '0', 'soon', None, True):
            with self.subTest(value=value):
                self.upstream.request = relayed(value)
                response = self.post()
                self.assertEqual(response.status_code, 429)
                self.assertTrue(1 <= int(response.headers['retry-after']) <= 10)

    def test_a_busy_reader_relays_the_wait_it_reports(self):
        original = self.upstream.request
        def busy(route, body=None, *, deadline, request_id=None):
            result = original(route, body, deadline=deadline, request_id=request_id)
            if route == 'health':
                result[1]['busy'] = True
                result[1]['retryAfterSeconds'] = 6
            return result
        self.upstream.request = busy
        response = self.post()
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers['retry-after'], '6')

    def test_a_client_budget_refusal_says_when_a_token_returns(self):
        gateway = Gateway(enabled=True, enabled_reads=('token',), verifier=self.verifier(), upstream=self.upstream,
                          gate=ReadGate(interval=0), budgets=ClientBudgets(burst=1, per_minute=30))
        client = TestClient(create_gateway(gateway), base_url='http://127.0.0.1:8878', client=('127.0.0.1', 40000))
        first = client.post('/internal/read/v1/token', json={'token': TOKEN}, headers=self.headers)
        self.assertEqual(first.status_code, 200)
        second = client.post('/internal/read/v1/token', json={'token': TOKEN}, headers=self.headers)
        self.assertEqual(second.status_code, 429)
        # Thirty a minute is one token every two seconds: the budget's number, not the gate's.
        self.assertEqual(second.headers['retry-after'], '2')

    def test_actual_inflight_operation_holds_gateway_gate_until_exit(self):
        entered,release=Event(),Event()
        original=self.upstream.request
        def blocked(route,body=None,*,deadline,request_id=None):
            if route=='token':
                entered.set()
                if not release.wait(3): raise RuntimeError('test_timeout')
            return original(route,body,deadline=deadline,request_id=request_id)
        self.upstream.request=blocked
        results=[]
        worker=Thread(target=lambda:results.append(self.post()))
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            response=self.post()
            self.assertEqual(response.status_code,429)
            # The wait the gate can justify for the read still holding its slot,
            # bounded to ten seconds — not the constant this header used to carry.
            wait = int(response.headers['retry-after'])
            self.assertTrue(1 <= wait <= 10, wait)
            self.assertLessEqual(abs(wait - self.gateway.gate.retry_after('provider')), 1)
        finally:
            release.set();worker.join(4)
        self.assertEqual(results[0].status_code,200)


if __name__=='__main__':unittest.main()
