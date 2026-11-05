"""Operator view of the 35 bps app fee the bridge providers collected for Domino. Read-only; never a signer.

  relay-balance            Relay's off-chain app balance of the fee recipient (what a claim would pay).
  relay-requests           Relay requests made with Domino's key, quoted vs actually collected app fee
                           (needs DOMINO_RELAY_API_KEY and DOMINO_RELAY_API_KEY_ID; /requests/v3).
  across-fees              ERC-20 app fees Across fills paid the fee recipient on one destination chain,
                           from Transfer logs (handler -> recipient), at most 10,000 blocks per eth_getLogs.

Claiming the Relay balance is the owner's act: POST /app-fees/{recipient}/claim
returns a message the fee recipient signs (EIP-191) and posts to /execute/permits;
docs/v2/F5_BRIDGE.md has the procedure. Native-ETH Across fees leave no log (a
plain value transfer inside the fill); each one is proven per deposit by the
status route, or seen in the recipient's balance.

Output: one JSON object per line on stdout. Settings: crosschain_config.py.
"""
import argparse
import json
import os
import re
import sys

from discovery import DataError
from crosschain_across import ERC20_TRANSFER, MAX_LOG_BLOCKS, ChainRpc, EndpointsChainRpc, destination_endpoints
from crosschain_common import address, bytes32, chain_id, load_pins, raw
from crosschain_config import DESTINATION_RPC_CHAINS, ConfigError, load_settings
from crosschain_http import ProviderHttp
from crosschain_relay import RELAY_API, RelayProvider, parse_request_record

MAX_PAGES = 50


def _emit(row, out):
    out.write(json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n')


def relay_balance(settings, http, out):
    provider = RelayProvider(http, load_pins(), fee_recipient=settings.fee_recipient)
    for row in provider.app_fee_balances(settings.fee_recipient):
        _emit({'kind': 'relay_app_balance', **row}, out)


def relay_requests(settings, http, out, *, key_id, since, until, pages):
    totals = {}
    continuation = None
    for _ in range(pages):
        params = {'apiKeyId': key_id, 'features': 'app_fees', 'limit': '100', 'startTimestamp': str(since)}
        if until is not None:
            params['endTimestamp'] = str(until)
        if continuation:
            params['continuation'] = continuation
        payload = http.get('/requests/v3', params, timeout=10, retry=True)
        for row in payload.get('requests') or []:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str):
                continue
            record = parse_request_record({'requests': [row]}, row['id'].lower(), settings.fee_recipient)
            if record is None:
                continue
            _emit({'kind': 'relay_request', 'requestId': bytes32(row['id']), **record}, out)
            if record['currency'] is not None and record['actualRaw'] is not None:
                key = (record['currency']['chainId'], record['currency']['token'])
                totals[key] = totals.get(key, 0) + record['actualRaw']
        continuation = payload.get('continuation')
        if not isinstance(continuation, str) or not continuation:
            break
    for (chain, token), amount in sorted(totals.items()):
        _emit({'kind': 'relay_total_collected', 'chainId': chain, 'token': token, 'amountRaw': str(amount)}, out)


def across_fees(settings, rpc, out, *, chain, from_block, to_block):
    pins = load_pins()
    pin = pins['destinations'].get(chain, {}).get('across')
    if pin is None:
        raise DataError('across_destination_not_pinned')
    handlers = ['0x' + '00' * 12 + handler[2:] for handler in pin['multicallHandlers']]
    recipient = '0x' + '00' * 12 + settings.fee_recipient[2:]
    totals = {}
    start = from_block
    while start <= to_block:
        end = min(to_block, start + MAX_LOG_BLOCKS - 1)
        # Any token contract: the Transfer must come from a pinned handler and reach the fee recipient.
        for log in rpc.logs([], ['0x' + ERC20_TRANSFER.hex(), handlers, recipient], start, end):
            data = log.get('data')
            if not isinstance(data, str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', data):
                raise DataError('across_log_invalid')
            token, amount = address(log.get('address')), raw(int(data, 16))
            totals[token] = totals.get(token, 0) + amount
            _emit({'kind': 'across_fee_transfer', 'chainId': chain, 'token': token, 'amountRaw': str(amount),
                   'transactionHash': bytes32(log.get('transactionHash')),
                   'blockNumber': int(log.get('blockNumber'), 16)}, out)
        start = end + 1
    for token, amount in sorted(totals.items()):
        _emit({'kind': 'across_total_collected', 'chainId': chain, 'token': token, 'amountRaw': str(amount),
               'fromBlock': from_block, 'toBlock': to_block}, out)


def main(argv=None, out=sys.stdout):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('relay-balance')
    requests = commands.add_parser('relay-requests')
    requests.add_argument('--since', type=int, required=True, help='Unix seconds')
    requests.add_argument('--until', type=int)
    requests.add_argument('--pages', type=int, default=10)
    fees = commands.add_parser('across-fees')
    fees.add_argument('--chain', type=int, required=True, choices=DESTINATION_RPC_CHAINS)
    fees.add_argument('--from-block', type=int, required=True)
    fees.add_argument('--to-block', type=int)
    args = parser.parse_args(argv)
    try:
        settings = load_settings()
        if args.command in ('relay-balance', 'relay-requests'):
            headers = {'x-api-key': settings.relay_api_key} if settings.relay_api_key else None
            http = ProviderHttp('relay', RELAY_API, headers=headers, per_minute=settings.relay_per_minute)
            if args.command == 'relay-balance':
                relay_balance(settings, http, out)
            else:
                key_id = os.environ.get('DOMINO_RELAY_API_KEY_ID', '')
                if not settings.relay_api_key or not re.fullmatch(r'[0-9a-fA-F-]{36}', key_id):
                    raise ConfigError('crosschain_config_relay_api_key_id')
                if not 1 <= args.pages <= MAX_PAGES:
                    raise ConfigError('crosschain_config_pages')
                relay_requests(settings, http, out, key_id=key_id, since=args.since, until=args.until, pages=args.pages)
        else:
            url = settings.rpc_urls.get(args.chain)
            if url is not None:
                rpc = ChainRpc(url, chain_id(args.chain))
            else:
                endpoints = destination_endpoints(settings.chain_rpc_file).get(args.chain)
                if endpoints is None:
                    raise ConfigError(f'crosschain_config_rpc_url_{args.chain}')
                rpc = EndpointsChainRpc(endpoints, chain_id(args.chain))
            to_block = args.to_block if args.to_block is not None else rpc.block_number()
            across_fees(settings, rpc, out, chain=args.chain, from_block=args.from_block, to_block=to_block)
    except ConfigError as error:
        parser.exit(2, f'{error}\n')
    except DataError as error:
        # A fixed code; never a URL, key or provider text.
        parser.exit(1, f'{error}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
