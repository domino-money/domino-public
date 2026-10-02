"""Offline doubles and recorded provider answers for the cross-chain deposit tests. No network.

The provider fixtures in fixtures/crosschain are live keyless answers recorded on
1-2 October 2026 (Relay /quote/v2, /chains, /intents/status/v3; Across
/swap/approval, /available-routes, /deposit) with synthetic wallets: the user is
0x1111…1111 and the app-fee recipient 0x2222…2222. The Across /deposit record is
a real answer used as a shape template, its people's addresses and transactions
replaced. Relay /requests/v3 needs a key, so its record here follows the
documented schema.
"""
from copy import deepcopy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import decode, encode
from eth_hash.auto import keccak

from crosschain_across import DEPOSIT, DEPOSIT_NATIVE, ERC20_TRANSFER, FILLED_RELAY, FILLED_RELAY_DATA, AcrossProvider
from crosschain_common import load_destinations, load_pins
from crosschain_http import ProviderError
from crosschain_relay import RelayProvider
from crosschain_service import CrosschainService

FIXTURES = Path(__file__).resolve().parent / 'fixtures' / 'crosschain'
OWNER = '0x' + '11' * 20
FEE = '0x' + '22' * 20
OTHER = '0x' + '33' * 20
ZERO = '0x' + '00' * 20
USDC_ARBITRUM = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
WETH_ROBINHOOD = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
PRIVATE = ('relay-offline-key-canary', 'across-offline-key-canary', '0xdead')
SESSION, CSRF = 's' * 43, 'c' * 43
DEPOSIT_HASH = '0x' + 'd1' * 32
FILL_HASH = '0x' + 'f1' * 32
RELAY_REQUEST = '0x17909043250328e5f8f2ae0821aaa72bdd1aa0b373c81bdf0b7996f4545b05af'


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


def quote_request(origin=42161, origin_token=USDC_ARBITRUM, destination=4663, destination_token=USDG,
                  amount='100000000', slippage=50, gas=False):
    return {'originChainId': origin, 'originToken': origin_token, 'destinationChainId': destination,
            'destinationToken': destination_token, 'amountRaw': amount, 'slippageBps': slippage, 'destinationGas': gas}


def provider_request(**changes):
    """The normalized call an adapter receives."""
    body = quote_request(**changes)
    return {'owner': OWNER, 'originChainId': body['originChainId'], 'originToken': body['originToken'].lower(),
            'destinationChainId': body['destinationChainId'], 'destinationToken': body['destinationToken'].lower(),
            'amount': int(body['amountRaw']), 'slippageBps': body['slippageBps'], 'destinationGas': body['destinationGas']}


def across_deposit(payload):
    """The decoded deposit of an Across quote: what the SpokePool will record."""
    data = payload['swapTx']['data']
    if payload['inputToken']['address'] == ZERO:
        values = decode(list(DEPOSIT_NATIVE[1]), bytes.fromhex(data[10:]))
        (_spoke, depositor, recipient, _in, _amount, output_token, output_amount, destination, _relayer,
         quoted_at, _deadline, _exclusive, message) = values
        depositor = depositor.lower()
    else:
        values = decode(list(DEPOSIT[1]), bytes.fromhex(data[10:]))
        (depositor, recipient, _in, output_token, _amount, output_amount, destination, _relayer,
         quoted_at, _deadline, _exclusive, message) = values
        depositor = '0x' + depositor[12:].hex()
    return {'depositor': depositor, 'recipient': '0x' + recipient[12:].hex(), 'outputToken': '0x' + output_token[12:].hex(),
            'outputAmount': output_amount, 'destinationChainId': destination, 'quotedAt': quoted_at,
            'message': '0x' + message.hex()}


def across_record(quote_fixture, *, origin, status='filled', deposit_id=4242, fill=FILL_HASH, refund=None, **changes):
    """An Across /deposit answer for the deposit a quote fixture would create."""
    deposit = across_deposit(fixture(quote_fixture))
    record = deepcopy(fixture('across-deposit-template.json'))
    row = record['deposit']
    row.update(depositId=str(deposit_id), originChainId=str(origin), destinationChainId=str(deposit['destinationChainId']),
               depositor=deposit['depositor'], recipient=deposit['recipient'], outputToken=deposit['outputToken'],
               outputAmount=str(deposit['outputAmount']), message=deposit['message'],
               messageHash='0x' + keccak(bytes.fromhex(deposit['message'][2:])).hex(), status=status,
               depositTxHash=DEPOSIT_HASH, depositTxnRef=DEPOSIT_HASH,
               fillTx=fill if status == 'filled' else None, fillTxnRef=fill if status == 'filled' else None,
               depositRefundTxHash=refund, depositRefundTxnRef=refund)
    row.update(changes)
    return record


def fill_receipt(record, *, spoke_pool, fee, fee_recipient=FEE, updated=None, status='0x1', transfer=True):
    """A destination receipt for the fill of this /deposit record: FilledRelay, the fee transfer, the drain."""
    row = record['deposit']
    word = lambda value: bytes.fromhex(value[2:].rjust(64, '0'))
    message = bytes.fromhex(row['message'][2:])
    hashed = keccak(message)
    recipient, output_amount = word(row['recipient']), int(row['outputAmount'])
    info = updated or (recipient, hashed, output_amount, 0)
    data = encode(FILLED_RELAY_DATA, [word(USDC_ARBITRUM), word(row['outputToken']), 100, output_amount, 42161,
                                      0, 0, word(ZERO), word(row['depositor']), recipient, hashed, info])
    topics = ['0x' + FILLED_RELAY.hex(), '0x' + int(row['originChainId']).to_bytes(32, 'big').hex(),
              '0x' + int(row['depositId']).to_bytes(32, 'big').hex(), '0x' + '00' * 12 + '55' * 20]
    logs = [{'address': spoke_pool, 'topics': topics, 'data': '0x' + data.hex()}]
    transfer_topic = '0x' + ERC20_TRANSFER.hex()
    if transfer:
        logs.append({'address': row['outputToken'], 'data': '0x' + fee.to_bytes(32, 'big').hex(),
                     'topics': [transfer_topic, '0x' + word(row['recipient']).hex(), '0x' + word(fee_recipient).hex()]})
    logs.append({'address': row['outputToken'], 'data': '0x' + (output_amount - fee).to_bytes(32, 'big').hex(),
                 'topics': [transfer_topic, '0x' + word(row['recipient']).hex(), '0x' + word(row['depositor']).hex()]})
    return {'status': status, 'logs': logs, 'transactionHash': FILL_HASH}


def relay_record(*, request_id=RELAY_REQUEST, status='success', user=OWNER, actual='350000', quoted='350000',
                 recipient=FEE, currency=(42161, USDC_ARBITRUM)):
    fees = {'quoted': [{'recipient': recipient, 'bps': '35', 'amount': quoted, 'amountFormatted': '0.35'}],
            'currency': {'chainId': currency[0], 'address': currency[1], 'symbol': 'USDC', 'decimals': 6}}
    if actual is not None:
        fees['actual'] = [{'recipient': recipient, 'bps': '35', 'amount': actual, 'amountFormatted': '0.35', 'amountUsd': '0.35'}]
    return {'requests': [{'id': request_id, 'status': status, 'user': user, 'recipient': user, 'data': {'appFees': fees}}],
            'continuation': None}


class FakeHttp:
    """Routes (method, path) to a recorded answer, a callable or an exception; keeps every call."""
    def __init__(self, provider, routes=None):
        self.provider, self.routes, self.calls = provider, dict(routes or {}), []

    def _answer(self, method, path, params, body):
        self.calls.append({'method': method, 'path': path, 'params': params, 'body': body})
        answer = self.routes.get((method, path))
        if answer is None:
            raise ProviderError(f'{self.provider}_unavailable')
        if callable(answer):
            answer = answer(params or body)
        if isinstance(answer, BaseException):
            raise answer
        return deepcopy(answer)

    def get(self, path, params=None, *, timeout, retry=False):
        return self._answer('GET', path, params, None)

    def post(self, path, body, *, timeout, retry=False):
        return self._answer('POST', path, None, body)


class FakeRpc:
    def __init__(self, receipt):
        self.receipt_value, self.calls = receipt, []

    def receipt(self, transaction_hash):
        self.calls.append(transaction_hash)
        if isinstance(self.receipt_value, BaseException):
            raise self.receipt_value
        return deepcopy(self.receipt_value)


class FakeAuth:
    def __init__(self, owner=OWNER):
        self.owner, self.begun, self.finished, self.error = owner, 0, 0, None

    def begin(self, client, session, csrf):
        self.begun += 1
        if self.error is not None:
            raise self.error
        return {'owner': self.owner, 'session': session, 'csrf': csrf}

    def finish(self, context):
        self.finished += 1


def quote_time(name='across-quote-usdc-arbitrum-usdg-robinhood.json'):
    """A clock a minute after the Across fixture was quoted, so its timestamps are current."""
    return across_deposit(fixture(name))['quotedAt'] + 60


def make_service(*, relay_routes=None, across_routes=None, clock=None, relay_key=True, rpc=None, auth=None):
    pins, destinations = load_pins(), load_destinations()
    relay_http, across_http = FakeHttp('relay', relay_routes), FakeHttp('across', across_routes)
    relay = RelayProvider(relay_http, pins, fee_recipient=FEE, has_key=relay_key)
    across = AcrossProvider(across_http, pins, destinations, fee_recipient=FEE, integrator_id='0xdead',
                            rpc_factory=(lambda chain: rpc) if rpc is not None else None)
    now = quote_time() if clock is None else clock
    service = CrosschainService(auth or FakeAuth(), relay, across, fee_recipient=FEE,
                                clock=lambda: now, private_values=PRIVATE)
    return service, relay_http, across_http


def default_routes():
    """Both providers answering the fixture route: 100 USDC from Arbitrum to USDG on Robinhood."""
    return ({('POST', '/quote/v2'): fixture('relay-quote-usdc-arbitrum-usdg.json'),
             ('GET', '/chains'): fixture('relay-chains.json'),
             ('GET', '/intents/status/v3'): fixture('relay-status-success.json')},
            {('GET', '/swap/approval'): fixture('across-quote-usdc-arbitrum-usdg-robinhood.json'),
             ('GET', '/available-routes'): fixture('across-routes.json')})
