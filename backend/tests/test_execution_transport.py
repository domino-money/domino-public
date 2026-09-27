"""Actual loopback HTTP transport: no keys, production endpoints or fallback."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import os
import sys
from threading import Thread
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from execution_signer import ExecutionRpc,ExecutionError
from read_deadline import read_deadline


class ExecutionTransportTests(unittest.TestCase):
    def setUp(self):
        self.requests=[];self.body=b'{"jsonrpc":"2.0","id":1,"result":"0x1237"}';self.delay=0;self.status=200
        test=self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                test.requests.append(self.rfile.read(int(self.headers['Content-Length'])))
                time.sleep(test.delay)
                self.send_response(test.status)
                if test.status==302:self.send_header('Location','http://127.0.0.1:1/forbidden')
                self.send_header('Content-Length',str(len(test.body)));self.end_headers()
                try:self.wfile.write(test.body)
                except BrokenPipeError:pass
            def log_message(self,*args):pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.stop)
        self.rpc=ExecutionRpc('http://127.0.0.1:'+str(self.server.server_port),timeout=1,max_bytes=1024)
    def stop(self):
        self.server.shutdown();self.server.server_close();self.thread.join(2)
    def test_valid_read_and_closed_method_registry(self):
        self.assertEqual(self.rpc.request('eth_chainId',[]),'0x1237')
        self.assertEqual(len(self.requests),1)
        for method in ('eth_sendTransaction','personal_unlockAccount','debug_traceCall'):
            with self.assertRaisesRegex(ExecutionError,'execution_rpc_method'):self.rpc.request(method,[])
        self.assertEqual(len(self.requests),1)
    def test_duplicate_boolean_id_error_oversize_and_redirect_fail_without_retry(self):
        for body in (b'{"jsonrpc":"2.0","id":1,"id":1,"result":"0x1"}',
                     b'{"jsonrpc":"2.0","id":true,"result":"0x1"}',
                     b'{"jsonrpc":"2.0","id":1,"error":{"message":"private diagnostic"}}',b'x'*1025):
            self.body=body
            with self.assertRaisesRegex(ExecutionError,'^execution_rpc_unavailable$'):self.rpc.request('eth_chainId',[])
        self.status=302
        with self.assertRaisesRegex(ExecutionError,'^execution_rpc_unavailable$'):self.rpc.request('eth_chainId',[])
        self.assertEqual(len(self.requests),5)
    def test_a_call_the_chain_reverted_is_named_not_unavailable(self):
        # 27 September 2026: an execution simulation reverted InvalidAmount and
        # was logged as an unreachable node, hiding why the plan failed.
        self.body=b'{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x2c5211c6"}}'
        for method in ('eth_call','eth_estimateGas'):
            with self.assertRaisesRegex(ExecutionError,'^execution_call_reverted$') as caught:self.rpc.request(method,[])
            self.assertEqual(caught.exception.revert,'0x2c5211c6')
        self.body=b'{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}'
        with self.assertRaisesRegex(ExecutionError,'^execution_call_reverted$') as caught:self.rpc.request('eth_call',[])
        self.assertEqual(caught.exception.revert,'0x')
        # Only calls revert. Anything else, or a malformed revert, stays unavailable.
        for method,body in (('eth_chainId',b'{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x2c5211c6"}}'),
                            ('eth_call',b'{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"header not found"}}'),
                            ('eth_call',b'{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x2c5"}}'),
                            ('eth_call',b'{"jsonrpc":"2.0","id":2,"error":{"code":3,"message":"execution reverted","data":"0x2c5211c6"}}')):
            self.body=body
            with self.subTest(method=method,body=body),self.assertRaisesRegex(ExecutionError,'^execution_rpc_unavailable$'):
                self.rpc.request(method,[])
    def test_shared_deadline_caps_real_http_and_prevents_later_request(self):
        self.delay=.06
        with self.assertRaises(Exception):
            with read_deadline(.01):self.rpc.request('eth_chainId',[])
        self.assertEqual(len(self.requests),1)
        with self.assertRaises(Exception):
            with read_deadline(.001):
                time.sleep(.005);self.rpc.request('eth_chainId',[])
        self.assertEqual(len(self.requests),1)
    def test_endpoint_configuration_is_explicit_and_bounded(self):
        # Construct fake userinfo so repository credential scans do not mistake
        # this rejected URL fixture for a saved connection credential.
        userinfo = 'https://' + 'user' + ':' + 'pass' + '@example.com'
        for endpoint in ('http://example.com','https://',userinfo,'https://example.com/#secret',
                         'http://localhost:1234','https://example.com/\nsecret'):
            with self.assertRaises(ValueError):ExecutionRpc(endpoint)
    def test_environment_cannot_change_the_explicit_transport_route(self):
        with patch.dict(os.environ,{'HTTP_PROXY':'http://127.0.0.1:1','http_proxy':'http://127.0.0.1:1','NO_PROXY':'','no_proxy':''}):
            rpc=ExecutionRpc('http://127.0.0.1:'+str(self.server.server_port))
            self.assertEqual(rpc.request('eth_chainId',[]),'0x1237')
        self.assertEqual(len(self.requests),1)
