"""The continuous-policy fragment: exact lines, and nothing from a private range."""
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from scripts.staging import continuous_egress_write as render

PROVIDER = ['40.160.64.137', '40.160.64.146']


def run(payload):
    with patch('sys.stdin', io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()))):
        return render.main()


class RenderTests(unittest.TestCase):
    def test_the_fragment_matches_the_applied_policy(self):
        lines = render.render('127.0.0.53', PROVIDER)
        self.assertEqual(lines, [
            'add set inet domino_continuous_reads write_ipv4 { type ipv4_addr; elements = '
            '{ 40.160.64.137, 40.160.64.146 }; }',
            'add rule inet domino_continuous_reads write oifname "lo" ip daddr 127.0.0.53 '
            'udp dport 53 counter accept comment "queue worker resolver"',
            'add rule inet domino_continuous_reads write oifname "lo" ip daddr 127.0.0.53 '
            'tcp dport 53 counter accept comment "queue worker resolver"',
            'add rule inet domino_continuous_reads write oifname != "lo" ip daddr @write_ipv4 '
            'tcp dport 443 counter accept comment "indexer provider egress"',
        ])

    def test_duplicate_provider_addresses_are_collapsed(self):
        self.assertEqual(render.checked({'resolver': '127.0.0.53',
                                         'providerIpv4': PROVIDER + PROVIDER})[1], PROVIDER)

    def test_a_non_loopback_resolver_is_refused(self):
        for resolver in ('10.0.0.53', '8.8.8.8', '127.0.0.53.5', 'localhost'):
            with self.subTest(resolver=resolver), self.assertRaises(ValueError):
                render.checked({'resolver': resolver, 'providerIpv4': PROVIDER})

    def test_private_loopback_or_metadata_provider_addresses_are_refused(self):
        for address in ('10.1.2.3', '192.168.0.1', '127.0.0.1', '169.254.169.254', '0.0.0.0'):
            with self.subTest(address=address), self.assertRaises(ValueError):
                render.checked({'resolver': '127.0.0.53', 'providerIpv4': [address]})

    def test_the_shape_is_exact(self):
        for payload in ({}, {'resolver': '127.0.0.53'}, {'resolver': '127.0.0.53',
                                                         'providerIpv4': []},
                        {'resolver': '127.0.0.53', 'providerIpv4': PROVIDER, 'extra': 1},
                        {'resolver': '127.0.0.53',
                         'providerIpv4': [f'11.0.0.{index}' for index in range(65)]}):
            with self.subTest(payload=sorted(payload)), self.assertRaises(ValueError):
                render.checked(payload)

    def test_the_cli_refuses_bad_input_and_renders_good_input(self):
        self.assertEqual(run({'resolver': '127.0.0.53', 'providerIpv4': PROVIDER}), 0)
        self.assertEqual(run({'resolver': '8.8.8.8', 'providerIpv4': PROVIDER}), 1)
        with patch('sys.stdin', io.TextIOWrapper(io.BytesIO(b'{not json'))):
            self.assertEqual(render.main(), 1)


if __name__ == '__main__':
    unittest.main()
