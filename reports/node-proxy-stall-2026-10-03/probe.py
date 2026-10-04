#!/usr/bin/env python3
"""Time JSON-RPC calls to a node endpoint by request shape and write pattern.

A request that reaches clawber's systemd-socket-proxyd in more than one TCP
segment waits ~40 ms for the node's delayed ACK (../NODE_PROXY_STALL_2026-10-03.md).
Each case sends one request N times on a kept connection, written as:

  one      headers and body in one write;
  two      headers, then body, back to back, as http.client and urllib write them;
  two-gap  headers, then body 2 ms later: two segments every time.

`--http-client` also times http.client itself. Read-only calls; one JSON line per
case, timings and sizes only. Endpoints are plain host:port, so a URL carrying a
token cannot be given. Provide each approved endpoint explicitly; there is
no default target. Keep operational addresses in private local configuration.

Run (services host, standard library only; set DIRECT_RPC_ENDPOINT privately
to the approved direct host:port first):
  python3 probe.py 127.0.0.1:18547 "${DIRECT_RPC_ENDPOINT:?set approved host:port}" 127.0.0.1:18548 --http-client
"""
import argparse
import http.client
import json
import socket
import time

ARBSYS_BLOCK = {'to': '0x0000000000000000000000000000000000000064', 'data': '0xa3b1b31d'}  # arbBlockNumber()
POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'  # Uniswap v4, ~24 KB of code


def batch(size):
    return [{'jsonrpc': '2.0', 'id': i, 'method': 'eth_call', 'params': [ARBSYS_BLOCK, 'latest']} for i in range(size)]


# With headers: tiny 151 bytes; batch8 1,187 (one segment at the tailnet's 1,228-byte
# MSS); batch10 1,461 (two segments); code 201, answered with ~48 KB.
SHAPES = {
    'tiny': {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_blockNumber', 'params': []},
    'batch8': batch(8),
    'batch10': batch(10),
    'code': {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getCode', 'params': [POSITION_MANAGER, 'latest']},
}
PATTERNS = ('one', 'two', 'two-gap')
SLOW_MS = 25


def body(shape):
    return json.dumps(SHAPES[shape], separators=(',', ':')).encode()


def head(payload):
    return (b'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
            b'Content-Length: %d\r\n\r\n' % len(payload))


class Connection:
    def __init__(self, address):
        self.sock = socket.create_connection(address, timeout=10)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.buffer = b''

    def fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise EOFError('peer_closed')
        self.buffer += chunk

    def take(self, size):
        while len(self.buffer) < size:
            self.fill()
        data, self.buffer = self.buffer[:size], self.buffer[size:]
        return data

    def line(self):
        while b'\r\n' not in self.buffer:
            self.fill()
        line, _, self.buffer = self.buffer.partition(b'\r\n')
        return line

    def response(self):
        """Status line, body and the time the header ended; Content-Length or chunked."""
        while b'\r\n\r\n' not in self.buffer:
            self.fill()
        first = time.perf_counter()
        header, _, self.buffer = self.buffer.partition(b'\r\n\r\n')
        lines = header.split(b'\r\n')
        fields = {key.strip().lower(): value.strip() for key, _, value in (line.partition(b':') for line in lines[1:])}
        if b'content-length' in fields:
            return lines[0], self.take(int(fields[b'content-length'])), first
        assert fields.get(b'transfer-encoding', b'').lower() == b'chunked', 'unframed_response'
        chunks = []
        while True:
            size = int(self.line().split(b';')[0], 16)
            chunks.append(self.take(size))
            self.take(2)
            if size == 0:
                return lines[0], b''.join(chunks), first

    def call(self, payload, pattern):
        start = time.perf_counter()
        if pattern == 'one':
            self.sock.sendall(head(payload) + payload)
        else:
            self.sock.sendall(head(payload))
            if pattern == 'two-gap':
                time.sleep(0.002)
            self.sock.sendall(payload)
        status, answer, first = self.response()
        end = time.perf_counter()
        assert status.endswith(b' 200 OK') and b'"result"' in answer, 'unexpected_answer'
        return (end - start) * 1000, (first - start) * 1000, len(answer)


def percentile(values, share):
    return round(values[min(len(values) - 1, int(share * len(values)))], 1)


def report(endpoint, shape, pattern, payload, samples):
    totals, firsts = sorted(s[0] for s in samples), sorted(s[1] for s in samples)
    print(json.dumps({'endpoint': endpoint, 'shape': shape, 'pattern': pattern,
                      'requestBytes': len(head(payload)) + len(payload), 'answerBytes': samples[0][2],
                      'calls': len(samples), 'p50': percentile(totals, .5), 'p90': percentile(totals, .9),
                      'max': round(totals[-1], 1), f'slowOver{SLOW_MS}ms': sum(t > SLOW_MS for t in totals),
                      'headerP50': percentile(firsts, .5) if firsts[-1] else None}), flush=True)


def raw_case(endpoint, address, shape, pattern, calls, pause):
    payload, connection = body(shape), Connection(address)
    try:
        connection.call(payload, 'one')  # opens the path; not counted
        samples = []
        for _ in range(calls):
            samples.append(connection.call(payload, pattern))
            time.sleep(pause)
        report(endpoint, shape, pattern, payload, samples)
    finally:
        connection.sock.close()


def http_client_case(endpoint, address, shape, calls, pause):
    payload, connection, samples = body(shape), http.client.HTTPConnection(*address, timeout=10), []
    try:
        for index in range(calls + 1):
            start = time.perf_counter()
            connection.request('POST', '/', payload, {'Content-Type': 'application/json'})
            response = connection.getresponse()
            answer = response.read()
            assert response.status == 200 and b'"result"' in answer, 'unexpected_answer'
            if index:
                samples.append(((time.perf_counter() - start) * 1000, 0.0, len(answer)))
            time.sleep(pause)
        report(endpoint, shape, 'http.client', payload, samples)
    finally:
        connection.close()


def endpoint_address(text):
    host, _, port = text.rpartition(':')
    if not host or not port.isdigit() or '/' in text:
        raise argparse.ArgumentTypeError('expected host:port')
    return text, (host, int(port))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('endpoints', nargs='+', type=endpoint_address, metavar='host:port')
    parser.add_argument('--calls', type=int, default=60)
    parser.add_argument('--pause', type=float, default=0.02, help='seconds between calls')
    parser.add_argument('--shapes', default='tiny,batch8,batch10')
    parser.add_argument('--patterns', default=','.join(PATTERNS))
    parser.add_argument('--http-client', action='store_true')
    args = parser.parse_args(argv)
    shapes, patterns = args.shapes.split(','), args.patterns.split(',')
    if not set(shapes) <= set(SHAPES) or not set(patterns) <= set(PATTERNS):
        parser.error(f'shapes: {",".join(SHAPES)}; patterns: {",".join(PATTERNS)}')
    for endpoint, address in args.endpoints:
        if args.http_client:
            for shape in shapes:
                http_client_case(endpoint, address, shape, args.calls, args.pause)
        for shape in shapes:
            for pattern in patterns:
                raw_case(endpoint, address, shape, pattern, args.calls, args.pause)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
