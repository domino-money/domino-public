"""Read-only Robinhood discovery. No personal-bot imports, signer or wallet writes.

Provider metrics are untrusted observations, not reconciled APR or permissions.
Dependencies: eth-abi and eth-hash, pinned in requirements-readonly.txt.
"""
from dataclasses import dataclass, asdict
from decimal import Decimal, InvalidOperation
from functools import partial
import http.client
import io
import json
import re
import socket
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from eth_abi import encode, decode
from eth_hash.auto import keccak
from read_deadline import check_read_deadline, current_read_deadline, read_deadline

CHAIN_ID = 4663
RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'
POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
ZERO = '0x' + '00' * 20
KEY_TYPES = ('address', 'address', 'uint24', 'int24', 'address')
MAX_RESPONSE_BYTES = 2_000_000
TRADING_QUOTE_ENDPOINT = 'https://trade-api.gateway.uniswap.org/v1/quote'
TRADING_QUOTE_HEADERS = {
    'x-universal-router-version': '2.1.1',
    'x-agent-info': '{"integration_name":"swap-integration","decision_origin":"human_mediated","version":"1.5.0"}',
}
# A read consumes node computation, never wallet gas. Keep a finite ceiling even
# for arbitrary token contracts. Smaller profiles are useful for trusted probes.
MAX_READ_CALL_GAS = 500_000
DEFAULT_READ_CALL_GAS = MAX_READ_CALL_GAS


class DataError(ValueError):
    """A fixed safe code; never include provider URLs, payloads or credentials."""


def rpc_error_code(method, error):
    """Recognize explicit eth_call failures; ambiguous provider text stays generic.

    A revert reason may itself contain 'out of gas'. Revert data/code takes
    precedence, and no arbitrary message, revert bytes or URL leaves this layer.
    """
    if (method != 'eth_call' or not isinstance(error, dict)
            or type(error.get('code')) is not int):
        return 'rpc_error'
    message = error.get('message')
    if not isinstance(message, str) or len(message) > 512:
        return 'rpc_error'
    message = message.strip().lower()
    data = error.get('data')
    if (error['code'] == 3 or message == 'execution reverted'
            or message.startswith('execution reverted:')
            or (isinstance(data, str) and re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', data))):
        return 'rpc_call_reverted'
    # Structured/unknown data may contain a nested revert: do not guess.
    if data not in (None, '0x'):
        return 'rpc_error'
    if (message in ('out of gas', 'intrinsic gas too low', 'execution ran out of gas',
                    'evm error outofgas')
            or re.fullmatch(r'gas required exceeds allowance \([0-9]{1,10}\)', message)):
        return 'rpc_call_gas_limit'
    return 'rpc_error'


def address(value):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', value):
        raise DataError('invalid_address')
    return value.lower()


def bytes32(value):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', value):
        raise DataError('invalid_bytes32')
    return value.lower()


def quantity(value):
    if not isinstance(value, str) or not re.fullmatch(r'0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)', value):
        raise DataError('invalid_quantity')
    if len(value) > 66:
        raise DataError('quantity_too_large')
    return int(value, 16)


def decimal_metric(value):
    """Preserve zero versus missing; reject NaN, negatives and unbounded values."""
    if value is None or isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        return None
    if len(str(value)) > 128:
        return None
    try:
        parsed = Decimal(str(value))
        if not parsed.is_finite() or parsed < 0 or parsed > Decimal('1e30'):
            return None
        if not -36 <= parsed.as_tuple().exponent <= 30:
            return None
        if parsed and parsed.adjusted() < -36:
            return None
        return format(parsed, 'f')
    except (InvalidOperation, ValueError):
        return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None  # Never forward wallet queries or credential-bearing routes.


class _DeadlineSocketReader(io.RawIOBase):
    """Clamp every recv, including those used to parse slow HTTP headers/chunks."""
    def __init__(self, sock, deadline):
        self.socket, self.deadline = sock, deadline
        self.raw = sock.makefile('rb', buffering=0)

    def readable(self):
        return True

    def readinto(self, buffer):
        self.socket.settimeout(self.deadline.remaining())
        result = self.raw.readinto(buffer)
        self.deadline.remaining()
        return result

    def close(self):
        try:
            self.raw.close()
        finally:
            super().close()


class _DeadlineSocket:
    def __init__(self, sock, deadline):
        self.socket, self.deadline = sock, deadline

    def makefile(self, mode):
        assert mode == 'rb'
        return io.BufferedReader(_DeadlineSocketReader(self.socket, self.deadline))


class _DeadlineHTTPResponse(http.client.HTTPResponse):
    def __init__(self, sock, *args, deadline, **kwargs):
        super().__init__(_DeadlineSocket(sock, deadline), *args, **kwargs)


def _deadline_connect(address, timeout, source_address=None, *, deadline):
    if deadline is None:
        return socket.create_connection(address, timeout, source_address)
    deadline.remaining()
    host, port = address
    addresses = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    deadline.remaining()  # DNS itself is synchronous; do not connect after late resolution.
    last_error = None
    for family, kind, protocol, _, target in addresses:
        remaining = deadline.timeout(timeout)
        connection = socket.socket(family, kind, protocol)
        try:
            connection.settimeout(remaining)
            if source_address:
                connection.bind(source_address)
            connection.connect(target)
            deadline.remaining()
            return connection
        except OSError as error:
            last_error = error
            connection.close()
            deadline.remaining()
        except BaseException:
            connection.close()
            raise
    raise last_error or OSError('no_resolved_addresses')


class _DeadlineHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        self.deadline = current_read_deadline()
        super().__init__(*args, **kwargs)
        self._create_connection = partial(_deadline_connect, deadline=self.deadline)
        if self.deadline is not None:
            self.response_class = partial(_DeadlineHTTPResponse, deadline=self.deadline)

    def connect(self):
        if self.deadline is not None:
            self.timeout = self.deadline.timeout(self.timeout)
        # Match HTTPSConnection's TLS setup, but deduct TCP/tunnel time before
        # the handshake as well as before any subsequent socket operation.
        http.client.HTTPConnection.connect(self)
        if self.deadline is not None:
            self.sock.settimeout(self.deadline.remaining())
        self.sock = self._context.wrap_socket(
            self.sock, server_hostname=self._tunnel_host or self.host)
        if self.deadline is not None:
            self.sock.settimeout(self.deadline.remaining())

    def send(self, data):
        if self.deadline is not None:
            remaining = self.deadline.remaining()
            if self.sock is not None:
                self.sock.settimeout(remaining)
        super().send(data)
        if self.deadline is not None:
            self.deadline.remaining()


class _DeadlineHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        return self.do_open(_DeadlineHTTPSConnection, request, context=self._context)


_JSON_OPENER = urllib.request.build_opener(NoRedirect(), _DeadlineHTTPSHandler()).open


def _strict_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_json_key')
        result[key] = value
    return result


def _reject_json_constant(value):
    raise ValueError('nonfinite_json_number')


def json_http(url, body=None, *, timeout=12, opener=_JSON_OPENER, headers=None):
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme == 'https' and parsed.hostname and not parsed.fragment
                 and not parsed.username and not parsed.password
                 and (parsed.port is None or 1 <= parsed.port <= 65535)
                 and not any(ord(char) < 32 or ord(char) == 127 for char in url))
    except ValueError:
        valid = False
    if not valid:
        raise DataError('https_endpoint_required')
    extra = {} if headers is None else headers
    fixed = TRADING_QUOTE_HEADERS if url == TRADING_QUOTE_ENDPOINT else {}
    if (not isinstance(extra, dict) or any(name != "x-api-key" and
            (name not in fixed or value != fixed[name]) for name, value in extra.items()) or
            any(not isinstance(value, str) or not 1 <= len(value) <= 512 or
                any(not 33 <= ord(char) <= 126 for char in value) for value in extra.values())):
        raise DataError("invalid_private_api_header")
    try:
        with read_deadline(timeout) as deadline:
            request = urllib.request.Request(
                url, data=json.dumps(body, allow_nan=False).encode() if body is not None else None,
                headers={'Content-Type': 'application/json', 'User-Agent': 'DominoReadOnlyDiscovery/0.1', **extra},
            )
            with opener(request, timeout=deadline.remaining()) as response:
                chunks, size = [], 0
                read = getattr(response, 'read1', response.read)
                while True:
                    deadline.remaining()
                    chunk = read(min(64 * 1024, MAX_RESPONSE_BYTES + 1 - size))
                    deadline.remaining()
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise DataError('response_too_large')
                    chunks.append(chunk)
            return json.loads(b''.join(chunks), parse_float=Decimal,
                              parse_constant=_reject_json_constant, object_pairs_hook=_strict_json_object)
    except urllib.error.HTTPError as error:
        code = error.code
        # Close the error response before discarding its private URL/reason;
        # delayed resource warnings must not expose provider credentials.
        try:
            error.close()
        except Exception:
            pass
        raise DataError(f'http_{code}') from None
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
        check_read_deadline()
        raise DataError('network_unavailable') from None
    except DataError:
        raise
    except (UnicodeError, ValueError, RecursionError, InvalidOperation):
        raise DataError('invalid_json') from None


class ReadRpc:
    """Local-only transport with bounded requests and an explicit read allowlist."""
    METHODS = frozenset({'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode',
                         'eth_getBalance', 'eth_call'})
    MAX_BATCH_ITEMS = 8
    MAX_BATCH_BYTES = 65_536

    def __init__(self, url=RPC_URL, *, transport=json_http, max_requests=160,
                 call_gas_limit=DEFAULT_READ_CALL_GAS, batch_reads=False):
        if type(call_gas_limit) is not int or not 21_000 <= call_gas_limit <= MAX_READ_CALL_GAS:
            raise DataError('invalid_read_call_gas_limit')
        if type(batch_reads) is not bool:
            raise DataError('invalid_rpc_batch')
        self.url, self.transport = url, transport
        self.count, self.max_requests = 0, max_requests
        self.call_gas_limit = call_gas_limit
        self.batch_reads = batch_reads

    def request(self, method, params=()):
        if method not in self.METHODS:
            raise DataError('method_not_read_only')
        check_read_deadline()
        if self.count >= self.max_requests:
            raise DataError('request_budget_exhausted')
        self.count += 1
        payload = self.transport(self.url, {'jsonrpc': '2.0', 'id': self.count,
                                          'method': method, 'params': list(params)})
        check_read_deadline()
        if (not isinstance(payload, dict) or payload.get('jsonrpc') != '2.0'
                or type(payload.get('id')) is not int or payload['id'] != self.count):
            raise DataError('invalid_rpc_envelope')
        if 'error' in payload:
            raise DataError(rpc_error_code(method, payload['error']))
        if 'result' not in payload:
            raise DataError('missing_rpc_result')
        return payload['result']

    def _batch_specs(self, calls):
        """Only bounded independent reads, never state overrides or writes."""
        check_read_deadline()
        if not isinstance(calls, (list, tuple)) or not 1 <= len(calls) <= self.MAX_BATCH_ITEMS:
            raise DataError('invalid_rpc_batch')
        result = []
        for call in calls:
            if not isinstance(call, (list, tuple)) or len(call) != 2:
                raise DataError('invalid_rpc_batch')
            method, params = call
            if not isinstance(method, str) or method not in ReadRpc.METHODS:
                raise DataError('method_not_read_only')
            if not isinstance(params, (list, tuple)):
                raise DataError('invalid_rpc_batch')
            params = list(params)
            if method == 'eth_chainId':
                valid = not params
            elif method == 'eth_getBlockByNumber':
                valid = (len(params) == 2 and params[1] is False and isinstance(params[0],str)
                         and (params[0] == 'latest' or re.fullmatch(r'0x(?:0|[1-9a-f][0-9a-f]*)',params[0])))
            else:
                valid = (len(params) == 2 and isinstance(params[-1],str)
                         and re.fullmatch(r'0x(?:0|[1-9a-f][0-9a-f]*)',params[-1]))
                if valid and method == 'eth_call':
                    tx = params[0]
                    valid = (isinstance(tx,dict) and set(tx)=={'to','data','gas'}
                             and isinstance(tx['to'],str) and address(tx['to'])==tx['to']
                             and isinstance(tx['data'],str) and len(tx['data'])<=16_386
                             and re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*',tx['data']))
                    if valid:
                        gas = quantity(tx['gas'])
                        if not 21_000 <= gas <= self.call_gas_limit:
                            raise DataError('invalid_read_call_gas_limit')
                    params[0] = dict(tx) if isinstance(tx,dict) else tx
                elif valid:
                    valid = isinstance(params[0],str) and address(params[0])==params[0]
            if not valid:
                raise DataError('invalid_rpc_batch')
            result.append((method,params))
        return result

    def batch(self, calls):
        """One bounded envelope; every attempted item spends the RPC budget.

        No partial results or sequential retry are returned after a batch fails.
        The HTTPS transport retains its aggregate response-byte/deadline limits.
        """
        calls = self._batch_specs(calls)
        if self.count + len(calls) > self.max_requests:
            raise DataError('request_budget_exhausted')
        bodies = [{'jsonrpc':'2.0','id':self.count+i+1,'method':method,'params':params}
                  for i,(method,params) in enumerate(calls)]
        if len(json.dumps(bodies,allow_nan=False,separators=(',',':')).encode()) > self.MAX_BATCH_BYTES:
            raise DataError('invalid_rpc_batch')
        self.count += len(calls)
        payload = self.transport(self.url,bodies)
        check_read_deadline()
        if not isinstance(payload,list) or len(payload)!=len(bodies):
            raise DataError('invalid_rpc_envelope')
        expected = {body['id'] for body in bodies}
        by_id = {}
        for item in payload:
            if (not isinstance(item,dict) or item.get('jsonrpc')!='2.0'
                    or type(item.get('id')) is not int or item['id'] not in expected
                    or item['id'] in by_id
                    or set(item) not in ({'jsonrpc','id','result'},{'jsonrpc','id','error'})):
                raise DataError('invalid_rpc_envelope')
            by_id[item['id']] = item
        if set(by_id)!=expected:
            raise DataError('invalid_rpc_envelope')
        for body in bodies:
            item = by_id[body['id']]
            if 'error' in item:
                raise DataError(rpc_error_code(body['method'],item['error']))
        return [by_id[body['id']]['result'] for body in bodies]

    def call_params(self, target, signature, inputs=(), values=(), *, block):
        calldata = '0x' + (keccak(signature.encode())[:4] + encode(inputs, values)).hex()
        return [{'to':address(target),'data':calldata,'gas':hex(self.call_gas_limit)},block]

    def call_raw(self, target, signature, inputs=(), values=(), *, block):
        return self.request('eth_call',self.call_params(target,signature,inputs,values,block=block))

    def call(self, target, signature, inputs=(), values=(), outputs=(), *, block):
        return decode_result(outputs, self.call_raw(target, signature, inputs, values, block=block))

    def symbol(self, target, *, block):
        raw = self.call_raw(target, 'symbol()', block=block)
        if isinstance(raw, str) and len(raw) == 66:
            value, = decode_result(['bytes32'], raw)
            try:
                return value.rstrip(b'\x00').decode('utf-8')
            except UnicodeError:
                raise DataError('invalid_symbol_text') from None
        value, = decode_result(['string'], raw)
        return value


def decode_result(types, raw):
    if (not isinstance(raw, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', raw)
            or len(raw) > 16_386):
        raise DataError('invalid_abi_response')
    try:
        return decode(types, bytes.fromhex(raw[2:]))
    except Exception:
        raise DataError('invalid_abi_response') from None


@dataclass(frozen=True)
class Block:
    number: int
    hash: str
    timestamp: int

    @property
    def tag(self):
        return hex(self.number)


def parse_block(raw):
    if not isinstance(raw, dict):
        raise DataError('block_unavailable')
    return Block(quantity(raw.get('number')), bytes32(raw.get('hash')), quantity(raw.get('timestamp')))


@dataclass(frozen=True)
class PoolKey:
    currency0: str
    currency1: str
    fee_pips: int
    tick_spacing: int
    hooks: str

    @classmethod
    def checked(cls, raw, expected_id):
        if not isinstance(raw, (tuple, list)) or len(raw) != 5:
            raise DataError('invalid_pool_key')
        c0, c1, fee, spacing, hooks = raw
        c0, c1, hooks = address(c0), address(c1), address(hooks)
        if c0 >= c1 or type(fee) is not int or not (0 <= fee <= 1_000_000 or fee == 0x800000):
            raise DataError('invalid_pool_key')
        if type(spacing) is not int or not 1 <= spacing <= 32767:
            raise DataError('invalid_tick_spacing')
        if '0x' + keccak(encode(KEY_TYPES, (c0, c1, fee, spacing, hooks))).hex() != bytes32(expected_id):
            raise DataError('pool_id_mismatch')
        return cls(c0, c1, fee, spacing, hooks)


def provider_candidates(payload, selected_token, retrieved_at):
    """DEX Screener is a discovery seed, with no completeness guarantee."""
    token = address(selected_token)
    if not isinstance(payload, list) or len(payload) > 1000:
        raise DataError('invalid_discovery_response')
    candidates, rejected, seen, conflicts = [], 0, {}, set()
    for raw in payload:
        try:
            if not isinstance(raw, dict):
                raise DataError('invalid_candidate')
            if raw.get('chainId') != 'robinhood' or raw.get('dexId') != 'uniswap':
                rejected += 1
                continue
            if not isinstance(raw.get('labels'), list) or 'v4' not in raw['labels']:
                rejected += 1
                continue
            pool = bytes32(raw.get('pairAddress'))
            base, quote = raw.get('baseToken'), raw.get('quoteToken')
            if not isinstance(base, dict) or not isinstance(quote, dict):
                raise DataError('invalid_candidate')
            currencies = sorted((address(base.get('address')), address(quote.get('address'))))
            if currencies[0] == currencies[1] or token not in currencies:
                raise DataError('token_mismatch')
            if pool in seen:
                if seen[pool] != currencies:
                    conflicts.add(pool)
                continue
            seen[pool] = currencies
            volume, liquidity = raw.get('volume'), raw.get('liquidity')
            volume = volume if isinstance(volume, dict) else {}
            liquidity = liquidity if isinstance(liquidity, dict) else {}
            candidates.append({
                'poolId': pool, 'currencies': currencies,
                'providerMetrics': {
                    'source': 'dexscreener', 'retrievedAt': retrieved_at,
                    'status': 'external_unreconciled', 'asOfBlock': None,
                    'volume24hUsd': decimal_metric(volume.get('h24')),
                    'reportedLiquidityUsd': decimal_metric(liquidity.get('usd')),
                },
            })
        except DataError:
            rejected += 1
    return [x for x in candidates if x['poolId'] not in conflicts], rejected + len(conflicts)


class DiscoveryReader:
    def __init__(self, rpc, *, clock=time.time, max_age=120):
        self.rpc, self.clock, self.max_age = rpc, clock, max_age

    def snapshot(self):
        batched = getattr(self.rpc,'batch_reads',False) is True
        if batched:
            chain, raw_block = self.rpc.batch([('eth_chainId',[]),('eth_getBlockByNumber',['latest',False])])
        else:
            chain = self.rpc.request('eth_chainId')
            raw_block = None
        if quantity(chain) != CHAIN_ID:
            raise DataError('wrong_chain')
        block = parse_block(raw_block if batched else self.rpc.request('eth_getBlockByNumber',['latest',False]))
        self._fresh(block)
        contracts = (POOL_MANAGER,POSITION_MANAGER,STATE_VIEW)
        if batched:
            # All state calls use the parsed numeric block; no metadata trust is
            # cached, and code/link checks still gate every snapshot publication.
            observed = self.rpc.batch([('eth_getCode',[contract,block.tag]) for contract in contracts]+[
                ('eth_call',self.rpc.call_params(contract,'poolManager()',block=block.tag))
                for contract in (POSITION_MANAGER,STATE_VIEW)])
        for index,contract in enumerate(contracts):
            code = observed[index] if batched else self.rpc.request('eth_getCode',[contract,block.tag])
            if not isinstance(code, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', code):
                raise DataError('missing_contract_code')
        for index,contract in enumerate((POSITION_MANAGER,STATE_VIEW)):
            linked, = (decode_result(['address'],observed[index+3]) if batched else
                       self.rpc.call(contract,'poolManager()',outputs=['address'],block=block.tag))
            if address(linked) != POOL_MANAGER:
                raise DataError('manager_mismatch')
        return block

    def _fresh(self, block):
        age = self.clock() - block.timestamp
        if age < -15 or age > self.max_age:
            raise DataError('stale_or_future_block')

    def assert_canonical(self, block):
        current = parse_block(self.rpc.request('eth_getBlockByNumber', [block.tag, False]))
        if current != block:
            raise DataError('snapshot_reorganized')
        self._fresh(block)

    def token(self, currency, block):
        currency = address(currency)
        if currency == ZERO:
            return {'address': ZERO, 'kind': 'native', 'decimals': 18, 'symbol': 'ETH',
                    'readStatus': 'available', 'metadataIssues': {}, 'displayUnitsAvailable': True,
                    'executionAvailable': False}
        code = self.rpc.request('eth_getCode', [currency, block.tag])
        if code == '0x':
            raise DataError('token_has_no_code')
        if not isinstance(code, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', code):
            raise DataError('token_code_unavailable')
        decimals, symbol, issues = None, None, {}
        try:
            decimals, = self.rpc.call(currency, 'decimals()', outputs=['uint8'], block=block.tag)
            if type(decimals) is not int or not 0 <= decimals <= 255:
                raise DataError('invalid_token_decimals')
        except DataError as error:
            if str(error) == 'rpc_call_gas_limit':
                raise
            decimals, issues['decimals'] = None, str(error)
        try:
            raw_symbol = self.rpc.symbol(currency, block=block.tag)
            if not isinstance(raw_symbol, str) or not raw_symbol or len(raw_symbol) > 40 or not raw_symbol.isprintable():
                raise DataError('invalid_symbol_text')
            symbol = raw_symbol
        except DataError as error:
            if str(error) == 'rpc_call_gas_limit':
                raise
            issues['symbol'] = str(error)
        return {'address': currency, 'kind': 'erc20_candidate', 'decimals': decimals, 'symbol': symbol,
                'readStatus': 'partial' if issues else 'available', 'metadataIssues': issues,
                'displayUnitsAvailable': decimals is not None, 'executionAvailable': False}

    def token_lookup(self, currency, block):
        """Address lookup is useful even if optional metadata is absent.

        A contract exposing these methods is only a candidate, not proven ERC-20.
        """
        currency = address(currency)
        try:
            return self.token(currency, block)
        except DataError as error:
            return {'address': currency, 'kind': 'unknown', 'decimals': None, 'symbol': None,
                    'readStatus': 'no_contract' if str(error) == 'token_has_no_code' else 'unavailable',
                    'reason': str(error), 'metadataIssues': {}, 'displayUnitsAvailable': False,
                    'executionAvailable': False}

    def pool(self, candidate, block):
        pool_id = bytes32(candidate['poolId'])
        if candidate.get('poolKey') is not None:
            value = candidate['poolKey']
            if not isinstance(value,dict) or set(value)!={'currency0','currency1','fee_pips','tick_spacing','hooks'}:
                raise DataError('invalid_pool_key')
            raw_key = tuple(value[field] for field in ('currency0','currency1','fee_pips','tick_spacing','hooks'))
        else:
            # PositionManager's cache uses bytes25; verify the complete hash afterward.
            raw_key = self.rpc.call(POSITION_MANAGER, 'poolKeys(bytes25)', ['bytes25'],
                                   [bytes.fromhex(pool_id[2:52])], KEY_TYPES, block=block.tag)
        key = PoolKey.checked(raw_key, pool_id)
        if candidate.get('currencies') is not None and [key.currency0, key.currency1] != candidate['currencies']:
            raise DataError('provider_currency_mismatch')
        sqrt, tick, protocol, lp_fee = self.rpc.call(
            STATE_VIEW, 'getSlot0(bytes32)', ['bytes32'], [bytes.fromhex(pool_id[2:])],
            ['uint160', 'int24', 'uint24', 'uint24'], block=block.tag,
        )
        if not 0 < sqrt < 2**160 or not -887272 <= tick <= 887272 or lp_fee > 1_000_000:
            raise DataError('invalid_pool_state')
        if key.fee_pips != 0x800000 and lp_fee != key.fee_pips:
            raise DataError('fixed_fee_mismatch')
        return {
            **candidate, 'currencies': [key.currency0, key.currency1],
            'poolKey': asdict(key), 'identityStatus': 'verified_at_block',
            'snapshot': asdict(block), 'sqrtPriceX96': str(sqrt), 'tick': tick,
            'currentLpFeePips': lp_fee, 'protocolFeeRaw': protocol,
            'integrationClass': ('hookless_fixed_fee' if key.hooks == ZERO and key.fee_pips != 0x800000
                                 else 'requires_separate_adapter'),
            'feeApr24h': None, 'aprReason': 'reconciled_fee_history_unavailable',
            'suggested': False, 'suggestionReason': 'metrics_and_policy_not_qualified',
            'executionAvailable': False, 'executionReason': 'public_execution_not_implemented',
        }

    def position_owner(self, token_id, block):
        if type(token_id) is not int or not 0 < token_id < 2**256:
            raise DataError('invalid_position_id')
        owner, = self.rpc.call(POSITION_MANAGER, 'ownerOf(uint256)', ['uint256'], [token_id],
                              ['address'], block=block.tag)
        owner = address(owner)
        if owner == ZERO:
            raise DataError('invalid_position_owner')
        return owner

    def balances(self, owner, currencies, block):
        """Address-list fallback, not enumeration of everything in a wallet."""
        owner = address(owner)
        currencies = list(dict.fromkeys([ZERO] + [address(x) for x in currencies]))
        if len(currencies) > 32:
            raise DataError('too_many_currencies')
        result = []
        for currency in currencies:
            if currency == ZERO:
                value = quantity(self.rpc.request('eth_getBalance', [owner, block.tag]))
            else:
                value, = self.rpc.call(currency, 'balanceOf(address)', ['address'], [owner],
                                       ['uint256'], block=block.tag)
            result.append({'currency': currency, 'amountRaw': str(value)})
        return {'coverage': 'requested_addresses_only', 'snapshot': asdict(block), 'items': result}


def discover(token, *, rpc=None, transport=json_http, clock=time.time, max_pools=12,
             wallet=None, position_id=None, probe_inventory=False, pool_ids=(),
             catalogue_candidates=(), catalogue_status=None, paired_token=None):
    token = address(token)
    paired_token = address(paired_token) if paired_token is not None else None
    if paired_token==token:
        raise DataError('invalid_pair')
    if type(max_pools) is not int or not 1 <= max_pools <= 20 or (wallet and position_id is not None):
        raise DataError('invalid_probe_options')
    if not isinstance(pool_ids, (list, tuple)) or len(pool_ids) > min(10, max_pools):
        raise DataError('invalid_pool_ids')
    pool_ids = list(dict.fromkeys(bytes32(pool) for pool in pool_ids))
    if not isinstance(catalogue_candidates,(list,tuple)) or len(catalogue_candidates)>100:
        raise DataError('invalid_catalogue_candidates')
    reader = DiscoveryReader(rpc or ReadRpc(), clock=clock)
    block = reader.snapshot()
    report = {'mode': 'read_only_qualification', 'schemaVersion': 2, 'chainId': CHAIN_ID,
              'selectedToken': token, 'snapshot': asdict(block), 'tokens': [], 'pools': [],
              'unverifiedCandidates': [], 'metricsQualified': False, 'liveExecution': False}
    token_cache = {token: reader.token_lookup(token, block)}
    try:
        check_read_deadline()
        payload = transport(f'https://api.dexscreener.com/token-pairs/v1/robinhood/{token}')
        check_read_deadline()
        candidates, rejected = provider_candidates(payload, token, int(clock()))
        report['discovery'] = {'source': 'dexscreener', 'status': 'received',
            'coverage': 'provider_candidates_only', 'returned': len(payload), 'v4Candidates': len(candidates),
            'rejectedOrOtherMarkets': rejected}
    except DataError as error:
        candidates = []
        report['discovery'] = {'source': 'dexscreener', 'status': 'unavailable', 'reason': str(error),
            'coverage': 'unknown', 'returned': None, 'v4Candidates': None, 'rejectedOrOtherMarkets': None}
    by_id = {candidate['poolId']: candidate for candidate in candidates}
    known = {}
    for cached in catalogue_candidates:
        pool_id = bytes32(cached['poolId'])
        observed = by_id.pop(pool_id,None)
        candidate = dict(cached)
        if observed is not None:
            if observed['currencies']==cached['currencies']:
                candidate['providerMetrics']=observed['providerMetrics']
            else:
                candidate['providerMetrics']=None
                candidate['providerCurrencyConflict']=True
        known[pool_id]=candidate
    explicit = []
    for pool_id in pool_ids:
        candidate = known.pop(pool_id,None)
        if candidate is None:
            candidate=by_id.pop(pool_id, {'poolId': pool_id, 'providerMetrics': None})
        explicit.append({**candidate, 'requestedById': True})
    # Explicit IDs are still verified (and rejected if the pair is wrong).
    remaining = list(known.values()) + list(by_id.values())
    candidates = explicit + [c for c in remaining if paired_token is None or paired_token in c['currencies']]
    report['catalogue'] = catalogue_status or {'status':'not_configured','completeHistory':False}
    report['discovery'].update(requestedPoolIds=len(pool_ids), notProbed=max(0, len(candidates) - max_pools))
    report['pairedToken'] = paired_token
    for candidate in candidates[:max_pools]:
        try:
            pool = reader.pool(candidate, block)
            if token not in pool['currencies']:
                raise DataError('selected_token_mismatch')
            if paired_token is not None and paired_token not in pool['currencies']:
                raise DataError('selected_pair_mismatch')
        except DataError as error:
            report['unverifiedCandidates'].append({'poolId': candidate['poolId'], 'reason': str(error)})
            continue
        for currency in pool['currencies']:
            if currency not in token_cache:
                token_cache[currency] = reader.token_lookup(currency, block)
        pool['tokenMetadataStatus'] = ('available' if all(token_cache[c]['readStatus'] == 'available'
                                                        for c in pool['currencies']) else 'partial')
        report['pools'].append(pool)
    report['tokens'] = list(token_cache.values())
    report['selectedTokenReadStatus'] = token_cache[token]['readStatus']
    report['walletInventory'] = {'status': 'not_probed', 'coverage': 'unqualified'}
    if wallet or position_id is not None:
        owner = address(wallet) if wallet else reader.position_owner(position_id, block)
        balances = reader.balances(owner, list(token_cache), block)
        # Shareable report intentionally excludes wallet identity and quantities.
        report['walletBalanceProbe'] = {'status': 'read_at_block',
            'coverage': balances['coverage'], 'currenciesRead': len(balances['items']),
            'walletIdentityAndAmountsOmitted': True}
        if probe_inventory:
            try:
                check_read_deadline()
                inventory = transport('https://robinhoodchain.blockscout.com/api/v2/addresses/'
                                      + owner + '/tokens?type=ERC-20')
                check_read_deadline()
                if not isinstance(inventory, dict) or not isinstance(inventory.get('items'), list):
                    raise DataError('invalid_inventory_response')
                report['walletInventory'] = {'status': 'provider_page_received',
                    'itemsOnFirstPage': len(inventory['items']), 'coverage': 'unqualified',
                    'hasMore': bool(inventory.get('next_page_params'))}
            except DataError as error:
                report['walletInventory'] = {'status': 'unavailable', 'reason': str(error),
                                            'coverage': 'unqualified'}
    reader.assert_canonical(block)
    return report
