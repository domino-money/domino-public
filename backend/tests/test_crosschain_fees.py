"""The operator fee view: Relay balances and records, and Across ERC-20 fees from bounded log windows."""
import io
import json
import os
import unittest
from unittest.mock import patch

from crosschain_support import FEE, OWNER, PRIVATE, RELAY_REQUEST, USDC_ARBITRUM, USDG, FakeHttp, relay_record
from crosschain_across import ERC20_TRANSFER, MAX_LOG_BLOCKS
from crosschain_config import load_settings
from crosschain_fees import across_fees, main, relay_balance, relay_requests

HANDLER = '0xa8ad2e87e2043711d8bec77e8bc3e2683c0ab6bd'
SETTINGS = load_settings({'DOMINO_CROSSCHAIN_FEE_RECIPIENT': FEE, 'DOMINO_RELAY_API_KEY': PRIVATE[0]})


def lines(out):
    return [json.loads(line) for line in out.getvalue().splitlines()]


class WindowRpc:
    def __init__(self, logs_by_window):
        self.windows, self.logs_by_window = [], logs_by_window

    def logs(self, addresses, topics, start, end):
        self.windows.append((start, end, topics))
        return self.logs_by_window.get(start, [])


class FeeViewTests(unittest.TestCase):
    def test_across_fees_read_at_most_10000_blocks_per_call(self):
        transfer = {'address': USDG, 'data': '0x' + (349695).to_bytes(32, 'big').hex(), 'transactionHash': '0x' + 'f1' * 32,
                    'blockNumber': hex(15_000)}
        rpc = WindowRpc({10_000: [transfer, transfer]})
        out = io.StringIO()
        across_fees(SETTINGS, rpc, out, chain=4663, from_block=0, to_block=25_000)
        self.assertEqual([(start, end) for start, end, _ in rpc.windows], [(0, 9_999), (10_000, 19_999), (20_000, 25_000)])
        self.assertTrue(all(end - start + 1 <= MAX_LOG_BLOCKS for start, end, _ in rpc.windows))
        topics = rpc.windows[0][2]
        self.assertEqual(topics[0], '0x' + ERC20_TRANSFER.hex())
        self.assertIn('0x' + '00' * 12 + HANDLER[2:], topics[1])
        self.assertEqual(topics[2], '0x' + '00' * 12 + FEE[2:])
        rows = lines(out)
        self.assertEqual(rows[-1], {'kind': 'across_total_collected', 'chainId': 4663, 'token': USDG, 'amountRaw': '699390',
                                    'fromBlock': 0, 'toBlock': 25_000})

    def test_relay_requests_total_what_was_actually_collected(self):
        page = relay_record()
        page['continuation'] = 'next'
        second = relay_record(request_id='0x' + '18' * 32, actual='100')
        answers = iter([page, second])
        http = FakeHttp('relay', {('GET', '/requests/v3'): lambda params: next(answers)})
        out = io.StringIO()
        relay_requests(SETTINGS, http, out, key_id='0' * 8 + '-0000-0000-0000-' + '0' * 12, since=1, until=None, pages=5)
        self.assertEqual([call['params'].get('continuation') for call in http.calls], [None, 'next'])
        self.assertEqual(http.calls[0]['params']['features'], 'app_fees')
        rows = lines(out)
        self.assertEqual([row['requestId'] for row in rows[:2]], [RELAY_REQUEST, '0x' + '18' * 32])
        self.assertEqual(rows[-1], {'kind': 'relay_total_collected', 'chainId': 42161, 'token': USDC_ARBITRUM, 'amountRaw': '350100'})

    def test_relay_balance(self):
        http = FakeHttp('relay', {('GET', f'/app-fees/{FEE}/balances'): {'balances': [{
            'currency': {'chainId': 8453, 'address': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'symbol': 'USDC', 'decimals': 6},
            'amount': '30754920', 'amountUsd': '30.901612'}]}})
        out = io.StringIO()
        relay_balance(SETTINGS, http, out)
        self.assertEqual(lines(out)[0]['amountRaw'], '30754920')

    def test_the_cli_names_missing_settings_without_values(self):
        stderr = io.StringIO()
        with patch.dict(os.environ, {'DOMINO_CROSSCHAIN_FEE_RECIPIENT': FEE, 'DOMINO_RELAY_API_KEY': PRIVATE[0]}, clear=True), \
             patch('sys.stderr', stderr), self.assertRaises(SystemExit) as exit_:
            main(['across-fees', '--chain', '8453', '--from-block', '1'], out=io.StringIO())
        self.assertEqual(exit_.exception.code, 2)
        self.assertIn('crosschain_config_rpc_url_8453', stderr.getvalue())
        with patch.dict(os.environ, {'DOMINO_CROSSCHAIN_FEE_RECIPIENT': FEE, 'DOMINO_RELAY_API_KEY': PRIVATE[0]}, clear=True), \
             patch('sys.stderr', stderr), self.assertRaises(SystemExit):
            main(['relay-requests', '--since', '1'], out=io.StringIO())
        self.assertIn('crosschain_config_relay_api_key_id', stderr.getvalue())
        self.assertNotIn(PRIVATE[0], stderr.getvalue())
        self.assertNotIn(OWNER, stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
