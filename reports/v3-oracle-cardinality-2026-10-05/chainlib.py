"""Read-only helpers for the v3 observation cardinality study (5 Oct 2026).

Every endpoint is a loopback port: Robinhood through the SSH tunnel to the own
node, Base and Arbitrum through the VM's credential-holding forwarders. No URL
with a key ever exists on this machine, and no provider message is printed.
"""
import json
import time
import urllib.request

from eth_abi import decode, encode
from eth_hash.auto import keccak

ENDPOINTS = {4663: 'http://127.0.0.1:18560', 8453: 'http://127.0.0.1:18650', 42161: 'http://127.0.0.1:18651'}
NAMES = {4663: 'Robinhood', 8453: 'Base', 42161: 'Arbitrum'}
V3_FACTORY = {4663: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA', 8453: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
              42161: '0x1F98431c8aD98523631AE4a59f267346ea31F984'}
INIT_CODE_HASH = 'e34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
ANCHOR = '0x8c1edc4280d9533f6336f760380ba329e1f81f43'  # DominoPriceAnchor, same address on the three chains
OPERATOR = '0x64b72517D8b0d72BE25F814b4e03985Cf15e098A'  # V2 operator (estimateGas `from`; nothing is sent)


def topic(signature):
    return '0x' + keccak(signature.encode()).hex()


def selector(signature):
    return '0x' + keccak(signature.encode())[:4].hex()


SWAP = topic('Swap(address,address,int256,int256,uint160,uint128,int24)')
MINT = topic('Mint(address,address,int24,int24,uint128,uint256,uint256)')
BURN = topic('Burn(address,int24,int24,uint128,uint256,uint256)')
GROW = topic('IncreaseObservationCardinalityNext(uint16,uint16)')


class RpcError(Exception):
    pass


class Rpc:
    def __init__(self, chain_id, timeout=60):
        self.chain_id, self.url, self.timeout = chain_id, ENDPOINTS[chain_id], timeout
        self.calls = 0

    def _post(self, payload):
        body = json.dumps(payload).encode()
        request = urllib.request.Request(self.url, body, {'Content-Type': 'application/json'})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return json.loads(response.read())
            except Exception:
                if attempt == 3:
                    raise RpcError('transport')
                time.sleep(1 + 2 * attempt)

    def request(self, method, params):
        self.calls += 1
        reply = self._post({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
        if 'error' in reply:
            error = reply['error'] if isinstance(reply['error'], dict) else {}
            raise RpcError(f"{method}:{error.get('code')}:{str(error.get('message', ''))[:80]}:{str(error.get('data', ''))[:80]}")
        return reply['result']

    def batch(self, items, size=40):
        out = []
        for start in range(0, len(items), size):
            chunk = items[start:start + size]
            self.calls += len(chunk)
            payload = [{'jsonrpc': '2.0', 'id': i, 'method': m, 'params': p} for i, (m, p) in enumerate(chunk)]
            replies = self._post(payload)
            if not isinstance(replies, list):
                raise RpcError('batch_refused')
            by_id = {r.get('id'): r for r in replies}
            for i in range(len(chunk)):
                r = by_id.get(i, {})
                out.append(RpcError('item') if 'error' in r or 'result' not in r else r['result'])
        return out

    def call(self, to, data, block='latest'):
        return self.request('eth_call', [{'to': to, 'data': data}, block])

    def head(self):
        b = self.request('eth_getBlockByNumber', ['latest', False])
        return {'number': int(b['number'], 16), 'timestamp': int(b['timestamp'], 16),
                'baseFee': int(b.get('baseFeePerGas') or '0x0', 16)}

    def block(self, number):
        b = self.request('eth_getBlockByNumber', [hex(number), False])
        return {'number': int(b['number'], 16), 'timestamp': int(b['timestamp'], 16)}


def pool_facts(rpc, pool, block='latest'):
    items = [('eth_call', [{'to': pool, 'data': selector(s)}, block]) for s in
             ('slot0()', 'token0()', 'token1()', 'fee()', 'liquidity()', 'factory()', 'tickSpacing()')]
    raw = rpc.batch(items)
    if any(isinstance(r, Exception) or r in (None, '0x') for r in raw):
        return None
    slot0 = decode(['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'], bytes.fromhex(raw[0][2:]))
    word = lambda r, t: decode([t], bytes.fromhex(r[2:]))[0]
    return {'pool': pool.lower(), 'sqrtPriceX96': slot0[0], 'tick': slot0[1], 'index': slot0[2], 'cardinality': slot0[3],
            'cardinalityNext': slot0[4], 'token0': word(raw[1], 'address'), 'token1': word(raw[2], 'address'),
            'fee': word(raw[3], 'uint24'), 'liquidity': word(raw[4], 'uint128'), 'factory': word(raw[5], 'address'),
            'tickSpacing': word(raw[6], 'int24')}


def v3_address(chain_id, token0, token1, fee):
    salt = keccak(encode(['address', 'address', 'uint24'], [token0, token1, fee]))
    raw = keccak(b'\xff' + bytes.fromhex(V3_FACTORY[chain_id][2:]) + salt + bytes.fromhex(INIT_CODE_HASH))
    return '0x' + raw[-20:].hex()


def observation(rpc, pool, index, block='latest'):
    raw = rpc.call(pool, selector('observations(uint256)') + encode(['uint256'], [index]).hex(), block)
    ts, cumulative, spl, initialized = decode(['uint32', 'int56', 'uint160', 'bool'], bytes.fromhex(raw[2:]))
    return ts, initialized


def observations(rpc, pool, indexes, block='latest'):
    items = [('eth_call', [{'to': pool, 'data': selector('observations(uint256)') + encode(['uint256'], [i]).hex()},
                           block]) for i in indexes]
    out = []
    for raw in rpc.batch(items):
        if isinstance(raw, Exception):
            out.append(None)
            continue
        ts, cumulative, spl, initialized = decode(['uint32', 'int56', 'uint160', 'bool'], bytes.fromhex(raw[2:]))
        out.append((ts, initialized))
    return out


def observe_reason(rpc, pool, seconds_ago, block='latest'):
    """'ok', or the pool's revert text (Uniswap's 'OLD'), for observe([secondsAgo, 0])."""
    data = selector('observe(uint32[])') + encode(['uint32[]'], [[seconds_ago, 0]]).hex()
    try:
        rpc.call(pool, data, block)
        return 'ok'
    except RpcError as error:
        text = str(error)
        return 'OLD' if 'OLD' in text or '4f4c44' in text.lower() else 'reverted'


def anchor_twap_reason(rpc, facts, seconds_ago, block='latest'):
    """'ok' or 'TwapUnavailable' (or another revert) for the deployed DominoPriceAnchor.twapSqrtPrice."""
    ref = (3, facts['token0'], facts['token1'], facts['fee'], facts['tickSpacing'], '0x' + '00' * 20)
    data = selector('twapSqrtPrice((uint8,address,address,uint24,int24,address),uint32)') + \
        encode(['(uint8,address,address,uint24,int24,address)', 'uint32'], [ref, seconds_ago]).hex()
    try:
        rpc.call(ANCHOR, data, block)
        return 'ok'
    except RpcError as error:
        text = str(error).lower()
        if selector('TwapUnavailable()')[2:] in text:
            return 'TwapUnavailable'
        if selector('PoolUnavailable()')[2:] in text:
            return 'PoolUnavailable'
        return 'reverted'


def estimate_grow(rpc, pool, target):
    data = selector('increaseObservationCardinalityNext(uint16)') + encode(['uint16'], [target]).hex()
    return int(rpc.request('eth_estimateGas', [{'from': OPERATOR, 'to': pool, 'data': data}]), 16)
