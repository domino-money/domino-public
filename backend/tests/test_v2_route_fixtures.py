"""The V2 route suites run deployed Uniswap and Permit2 bytecode as fixtures.

contracts/test/v2/route/fixtures/*.sol each embed one runtime read on-chain,
with its address and codehash. The Solidity suites prove keccak256(RUNTIME)
equals CODEHASH; this test proves CODEHASH is the one the chain profile
recorded for that address, so the fixtures are the verified deployed code.
"""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'contracts/test/v2/route/fixtures'
PROFILE = ROOT / 'api-contracts/v2/chains/robinhood-4663.json'


def constant(source, name, pattern):
    match = re.search(rf'{name} = ({pattern});', source)
    if not match:
        raise AssertionError(f'{name} not found')
    return match.group(1)


class V2RouteFixtureTests(unittest.TestCase):
    def test_every_fixture_is_the_profiles_verified_runtime(self):
        profile = json.loads(PROFILE.read_text())
        verified = {c['address'].lower(): c['codehash'] for c in profile['verification']['contracts']}
        files = sorted(FIXTURES.glob('*.sol'))
        self.assertEqual(len(files), 4)
        for path in files:
            with self.subTest(fixture=path.name):
                source = path.read_text()
                address = constant(source, 'ADDRESS', r'0x[0-9a-fA-F]{40}')
                codehash = constant(source, 'CODEHASH', r'0x[0-9a-f]{64}')
                size = int(constant(source, 'SIZE', r'\d+'))
                runtime = re.search(r'RUNTIME =\s*hex"([0-9a-f]*)";', source).group(1)
                self.assertEqual(len(runtime), 2 * size)
                self.assertEqual(verified[address.lower()], codehash)


if __name__ == '__main__':
    unittest.main()
